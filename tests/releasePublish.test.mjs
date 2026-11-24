import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {parsePublishArgs, publishRelease, validatePreparedRelease} from '../scripts/release/publish.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceCommit = 'a'.repeat(40);
const env = {GITHUB_REPOSITORY: 'example/FluentRead', GITHUB_SHA: sourceCommit, GH_TOKEN: 'fixture-only-no-network'};

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'fluentread-release-'));
  const packages = [{name: 'FluentRead-1.2.3-chrome.zip', contents: Buffer.from('chrome fixture')},
    {name: 'FluentRead-1.2.3-firefox.zip', contents: Buffer.from('firefox fixture')}];
  const manifest = {schemaVersion: 1, repository: env.GITHUB_REPOSITORY, tag: 'v1.2.3', sourceCommit,
    workflow: 'automatic-release-packages', productVersion: '1.2.3',
    assets: packages.map(({name, contents}) => ({name, bytes: contents.length, sha256: hash(contents)}))};
  for (const asset of packages) writeFileSync(path.join(directory, asset.name), asset.contents);
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(path.join(directory, 'release-manifest.json'), manifestBytes);
  writeFileSync(path.join(directory, 'SHA256SUMS.txt'), [
    ...manifest.assets.map(asset => `${asset.sha256}  ${asset.name}`),
    `${hash(manifestBytes)}  release-manifest.json`, '',
  ].join('\n'));
  writeFileSync(path.join(directory, 'release-notes.md'), '# Installation\n\nUse the package for your browser.\n');
  const options = {tag: 'v1.2.3', assetsDir: directory};
  return {directory, manifest, options, prepared: validatePreparedRelease({...options, env}), cleanup() {rmSync(directory, {recursive: true, force: true});}};
}

function fakeGitHub(f, {published = false, existing = false, missingDigests = false} = {}) {
  const calls = [], remote = new Map();
  let release = existing ? {id: 71, tag_name: f.options.tag, draft: !published, body: f.prepared.notes} : null;
  let nextId = 100, failUpload = null, failRead = null, failCreate = false;
  function add(local) {
    const contents = readFileSync(local.absolute);
    remote.set(local.name, {id: nextId++, name: local.name, state: 'uploaded', size: contents.length,
      ...(missingDigests ? {} : {digest: `sha256:${hash(contents)}`}), contents});
  }
  if (published) for (const asset of f.prepared.assets) add(asset);
  function response(body, status = 200) {
    return {status: status === 200 ? 0 : 1, stdout: `HTTP/2.0 ${status} Fixture\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`, stderr: ''};
  }
  function runGh(args, options) {
    calls.push([...args]);
    assert.equal(options.env.GH_TOKEN, env.GH_TOKEN);
    if (args[0] === 'api') {
      if (!args.includes('--include')) {
        assert.ok(args.includes('Accept: application/octet-stream'));
        const id = Number(args[3].split('/').at(-1));
        const asset = [...remote.values()].find(entry => entry.id === id);
        return {status: asset ? 0 : 1, stdout: asset?.contents ?? '', stderr: ''};
      }
      const endpoint = args.at(-1);
      if (failRead) return typeof failRead === 'number' ? response({message: 'fixture read failure'}, failRead)
        : {status: 1, stdout: '', stderr: 'fixture transport unavailable'};
      // REST 的 tag 入口只保证公开发行；恢复草稿须走已认证的 list releases。
      if (endpoint.includes('/tags/')) return response(release, release && !release.draft ? 200 : 404);
      if (/\/releases\?per_page=100&page=1$/u.test(endpoint)) return response(release ? [release] : []);
      assert.match(endpoint, /\/releases\/71\/assets\?per_page=100&page=1$/);
      return response([...remote.values()].map(({contents, ...asset}) => asset));
    }
    assert.equal(args[0], 'release');
    assert.equal(args.includes('--clobber'), false);
    if (args[1] === 'create') {
      if (failCreate) return {status: 1, stdout: '', stderr: 'fixture create failure'};
      assert.equal(release, null);
      for (const flag of ['--draft', '--verify-tag', '--generate-notes']) assert.ok(args.includes(flag));
      assert.equal(args[args.indexOf('--target') + 1], sourceCommit);
      release = {id: 71, tag_name: f.options.tag, draft: true, body: readFileSync(args[args.indexOf('--notes-file') + 1], 'utf8')};
      return {status: 0, stdout: 'created', stderr: ''};
    }
    if (args[1] === 'upload') {
      assert.equal(release.draft, true, 'never upload assets into a public release');
      const local = f.prepared.assets.find(asset => asset.absolute === args[3]);
      assert.ok(local);
      assert.equal(remote.has(local.name), false, 'never overwrite uploaded assets');
      if (failUpload === local.name) return {status: 1, stdout: '', stderr: 'fixture upload failure'};
      add(local);
      return {status: 0, stdout: '', stderr: ''};
    }
    assert.equal(args[1], 'edit');
    assert.ok(args.includes('--draft=false'));
    assert.equal(remote.size, f.prepared.assets.length, 'all assets must exist before publishing');
    release.draft = false;
    return {status: 0, stdout: '', stderr: ''};
  }
  return {calls, remote, add, runGh, get release() {return release;},
    set failUpload(name) {failUpload = name;}, set failRead(value) {failRead = value;}, set failCreate(value) {failCreate = value;}};
}

test('release publisher validates arguments and prepared bytes before any gh call', () => {
  const f = fixture();let calls = 0;
  const runGh = () => {calls++;throw new Error('unexpected network');};
  try {
    assert.deepEqual(parsePublishArgs(['--tag', 'v1.2.3', '--assets-dir', f.directory]), f.options);
    for (const args of [[], ['--tag', 'v1.2.3'], ['--tag', 'v1.2.3', '--tag', 'v1.2.3'], ['--unknown', 'x', '--assets-dir', 'x']]) {
      assert.throws(() => parsePublishArgs(args));
    }
    for (const changed of [{tag: 'v1.2.3-rc.1'}, {tag: 'v01.2.3'}, {assetsDir: ''}]) {
      assert.throws(() => publishRelease({...f.options, ...changed}, {runGh, env}));
    }
    for (const changed of [{GH_TOKEN: ''}, {GITHUB_SHA: 'b'.repeat(40)}, {GITHUB_REPOSITORY: 'other/repository'}, {GITHUB_REPOSITORY: '../repository'}]) {
      assert.throws(() => publishRelease(f.options, {runGh, env: {...env, ...changed}}));
    }
    writeFileSync(f.prepared.assets[0].absolute, 'altered');
    assert.throws(() => publishRelease(f.options, {runGh, env}), /does not match its manifest/);
    assert.equal(calls, 0);
  } finally {f.cleanup();}
});

test('release publisher rejects unlisted files, symlinks and checksum drift locally', () => {
  for (const change of ['extra', 'symlink', 'checksum', 'duplicate-checksum', 'manifest-shape']) {
    const f = fixture();let calls = 0;
    try {
      if (change === 'extra') writeFileSync(path.join(f.directory, 'unexpected.zip'), 'unexpected');
      if (change === 'symlink') {rmSync(f.prepared.assets[0].absolute);symlinkSync(f.prepared.assets[1].absolute, f.prepared.assets[0].absolute);}
      if (change === 'checksum') writeFileSync(path.join(f.directory, 'SHA256SUMS.txt'), `${'0'.repeat(64)}  release-manifest.json\n`);
      if (change === 'duplicate-checksum') writeFileSync(path.join(f.directory, 'SHA256SUMS.txt'), readFileSync(path.join(f.directory, 'SHA256SUMS.txt'), 'utf8').repeat(2));
      if (change === 'manifest-shape') writeFileSync(path.join(f.directory, 'release-manifest.json'), JSON.stringify({...f.manifest, assets: [{name: '../escape.zip'}]}));
      assert.throws(() => publishRelease(f.options, {runGh() {calls++;}, env}), change);
      assert.equal(calls, 0);
    } finally {f.cleanup();}
  }
});

test('only a confirmed 404 creates a draft, which becomes public after every asset is verified', () => {
  const f = fixture();const github = fakeGitHub(f);
  try {
    assert.deepEqual(publishRelease(f.options, {runGh: github.runGh, env}), {status: 'published', tag: 'v1.2.3', assets: 4});
    assert.equal(github.release.draft, false);
    assert.match(github.release.body, /fluentread-release/);
    assert.match(github.release.body, /# Installation/);
    assert.equal(github.calls.filter(args => args[1] === 'upload').length, 4);
    assert.equal(github.calls.filter(args => args[1] === 'edit').length, 1);
  } finally {f.cleanup();}
});

test('403, 500 and transport failures never create, upload or publish a release', () => {
  for (const failure of [403, 500, 'transport']) {
    const f = fixture();const github = fakeGitHub(f);github.failRead = failure;
    try {
      assert.throws(() => publishRelease(f.options, {runGh: github.runGh, env}));
      assert.equal(github.calls.some(args => args[0] === 'release'), false);
    } finally {f.cleanup();}
  }
});

test('an interrupted upload leaves a draft, and a retry uploads only the missing exact assets', () => {
  const f = fixture();const github = fakeGitHub(f);github.failUpload = f.prepared.assets[1].name;
  try {
    assert.throws(() => publishRelease(f.options, {runGh: github.runGh, env}), /failed/);
    assert.equal(github.release.draft, true);
    assert.equal(github.remote.size, 1);
    assert.equal(github.calls.some(args => args[1] === 'edit'), false);
    const firstCalls = github.calls.length;github.failUpload = null;
    assert.equal(publishRelease(f.options, {runGh: github.runGh, env}).status, 'published');
    const resumed = github.calls.slice(firstCalls);
    assert.equal(resumed.filter(args => args[1] === 'upload').length, 3);
    assert.equal(resumed.some(args => args[1] === 'create'), false);
  } finally {f.cleanup();}
});

test('a matching published release is read-only and falls back to downloaded bytes when digest metadata is absent', () => {
  const f = fixture();const github = fakeGitHub(f, {existing: true, published: true, missingDigests: true});
  try {
    assert.equal(publishRelease(f.options, {runGh: github.runGh, env}).status, 'already-published');
    assert.equal(github.calls.some(args => args[0] === 'release'), false);
    assert.equal(github.calls.filter(args => args[0] === 'api' && !args.includes('--include')).length, 4);
    github.remote.get(f.prepared.assets[0].name).contents = Buffer.from('changed bytes!');
    assert.throws(() => publishRelease(f.options, {runGh: github.runGh, env}), /verify existing release asset bytes/);
    assert.equal(github.calls.some(args => args[0] === 'release'), false);
  } finally {f.cleanup();}
});

test('unrelated drafts and public missing or changed assets are rejected without replacement', () => {
  for (const change of ['marker', 'draft-digest', 'public-digest', 'public-missing', 'draft-extra', 'draft-incomplete']) {
    const f = fixture();const github = fakeGitHub(f, {existing: true, published: change.startsWith('public')});
    try {
      if (change === 'marker') github.release.body = github.release.body.replace(sourceCommit, 'b'.repeat(40));
      if (change === 'draft-digest') github.add(f.prepared.assets[0]);
      if (change.endsWith('digest')) github.remote.get(f.prepared.assets[0].name).digest = `sha256:${'0'.repeat(64)}`;
      if (change === 'public-missing') github.remote.delete(f.prepared.assets[0].name);
      if (change === 'draft-extra') github.remote.set('unrelated.zip', {id: 999, name: 'unrelated.zip', size: 1, state: 'uploaded'});
      if (change === 'draft-incomplete') {github.add(f.prepared.assets[0]);github.remote.get(f.prepared.assets[0].name).state = 'starter';}
      assert.throws(() => publishRelease(f.options, {runGh: github.runGh, env}), change);
      assert.equal(github.calls.some(args => args[0] === 'release'), false);
    } finally {f.cleanup();}
  }
});

test('draft creation failure never uploads or publishes', () => {
  const f = fixture();const github = fakeGitHub(f);github.failCreate = true;
  try {
    assert.throws(() => publishRelease(f.options, {runGh: github.runGh, env}), /failed/);
    assert.equal(github.calls.filter(args => args[0] === 'release').length, 1);
    assert.equal(github.release, null);
  } finally {f.cleanup();}
});

test('draft discovery paginates and refuses ambiguous drafts or unreadable draft listings', () => {
  for (const scenario of ['later-page', 'duplicate', 'list-forbidden']) {
    const f = fixture();const github = fakeGitHub(f, {existing: true});
    const response = (body, status = 200) => ({status: status === 200 ? 0 : 1,
      stdout: `HTTP/2.0 ${status} Fixture\nContent-Type: application/json\n\n${JSON.stringify(body)}`});
    let firstPage = true;
    const runGh = (args, options) => {
      const endpoint = args.at(-1);
      if (args[0] === 'api' && /\/releases\?per_page=100&page=1$/u.test(endpoint)) {
        if (scenario === 'list-forbidden') return response({message: 'forbidden'}, 403);
        if (scenario === 'duplicate') return response([github.release, {...github.release, id: 72}]);
        firstPage = false;
        return response(Array.from({length: 100}, (_, index) => ({id: 1000 + index, tag_name: `v0.0.${index}`})));
      }
      if (args[0] === 'api' && /\/releases\?per_page=100&page=2$/u.test(endpoint)) {
        assert.equal(firstPage, false);
        return response([github.release]);
      }
      return github.runGh(args, options);
    };
    try {
      if (scenario === 'later-page') assert.equal(publishRelease(f.options, {runGh, env}).status, 'published');
      else {
        assert.throws(() => publishRelease(f.options, {runGh, env}));
        assert.equal(github.calls.some(args => args[0] === 'release'), false);
      }
    } finally {f.cleanup();}
  }
});
