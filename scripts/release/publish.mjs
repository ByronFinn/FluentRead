#!/usr/bin/env node
/**
 * @file scripts/release/publish.mjs
 * 先核对本地发行清单与校验和，再通过无 shell 的 gh 调用建立草稿、补齐附件并发布。
 * 仅恢复具有相同 tag、源码提交和清单摘要的草稿；已公开发行只能在附件完全相同时返回。
 * 不创建 Git tag、不替换附件、不处理商店签名；调用流水线负责确认远端 tag 对应源码提交。
 */
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const WORKFLOW = 'automatic-release-packages';
const MANIFEST = 'release-manifest.json';
const CHECKSUMS = 'SHA256SUMS.txt';
const NOTES = 'release-notes.md';
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

export function parsePublishArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index], value = argv[index + 1];
    requireValue(['--tag', '--assets-dir'].includes(name) && !values.has(name)
      && typeof value === 'string' && value.length > 0 && !value.startsWith('--'), 'Expected --tag <vX.Y.Z> --assets-dir <directory>');
    values.set(name, value);
  }
  requireValue(values.size === 2, 'Expected --tag <vX.Y.Z> --assets-dir <directory>');
  return {tag: values.get('--tag'), assetsDir: values.get('--assets-dir')};
}

export function validatePreparedRelease({tag, assetsDir, env = process.env}) {
  requireValue(typeof tag === 'string' && TAG.test(tag), 'Release tag must be vX.Y.Z without a prerelease suffix');
  requireValue(typeof assetsDir === 'string' && assetsDir.trim().length > 0, 'An explicit assets directory is required');
  const repository = env.GITHUB_REPOSITORY;
  requireValue(typeof repository === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(repository), 'GITHUB_REPOSITORY must be owner/repository');
  requireValue(typeof env.GH_TOKEN === 'string' && env.GH_TOKEN.trim().length > 0, 'GH_TOKEN is required');
  requireValue(typeof env.GITHUB_SHA === 'string' && /^[a-f0-9]{40}$/u.test(env.GITHUB_SHA), 'GITHUB_SHA must identify the prepared source commit');
  const directory = path.resolve(assetsDir);
  requireValue(lstatSync(directory).isDirectory(), 'Assets directory must be an ordinary directory');
  const files = readdirSync(directory);
  for (const name of files) {
    requireValue(NAME.test(name) && lstatSync(path.join(directory, name)).isFile(), 'Release assets must be ordinary files with safe basenames');
  }
  const manifestBytes = readFileSync(path.join(directory, MANIFEST));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  requireValue(manifest.schemaVersion === 1 && manifest.workflow === WORKFLOW
    && manifest.repository === repository && manifest.tag === tag
    && manifest.sourceCommit === env.GITHUB_SHA, 'Prepared manifest does not match this release, repository, workflow or source commit');
  requireValue(Array.isArray(manifest.assets) && manifest.assets.length > 0, 'Manifest must list the release packages');
  const assets = new Map();
  for (const asset of manifest.assets) {
    requireValue(asset && typeof asset.name === 'string' && NAME.test(asset.name)
      && ![MANIFEST, CHECKSUMS, NOTES].includes(asset.name) && !assets.has(asset.name)
      && typeof asset.sha256 === 'string' && SHA256.test(asset.sha256)
      && Number.isSafeInteger(asset.bytes) && asset.bytes > 0, 'Manifest contains an invalid or duplicate package');
    const absolute = path.join(directory, asset.name);
    const bytes = readFileSync(absolute);
    requireValue(bytes.length === asset.bytes && sha256(bytes) === asset.sha256, `Prepared package does not match its manifest: ${asset.name}`);
    assets.set(asset.name, {name: asset.name, absolute, bytes: asset.bytes, sha256: asset.sha256});
  }
  const manifestSha256 = sha256(manifestBytes);
  assets.set(MANIFEST, {name: MANIFEST, absolute: path.join(directory, MANIFEST), bytes: manifestBytes.length, sha256: manifestSha256});
  const checksumBytes = readFileSync(path.join(directory, CHECKSUMS));
  const checksumEntries = new Map();
  for (const line of checksumBytes.toString('utf8').trimEnd().split(/\r?\n/u)) {
    const match = /^([a-f0-9]{64}) {2}([A-Za-z0-9][A-Za-z0-9._-]*)$/u.exec(line);
    requireValue(match && !checksumEntries.has(match[2]), 'SHA256SUMS.txt contains invalid or duplicate entries');
    checksumEntries.set(match[2], match[1]);
  }
  requireValue(checksumEntries.size === assets.size && [...assets.values()].every(asset => checksumEntries.get(asset.name) === asset.sha256), 'SHA256SUMS.txt must match all packages and release-manifest.json');
  assets.set(CHECKSUMS, {name: CHECKSUMS, absolute: path.join(directory, CHECKSUMS), bytes: checksumBytes.length, sha256: sha256(checksumBytes)});
  requireValue(files.length === assets.size + 1 && files.every(name => assets.has(name) || name === NOTES), 'Assets directory contains missing or unexpected files');
  const notes = readFileSync(path.join(directory, NOTES), 'utf8');
  requireValue(notes.trim().length > 0 && !notes.includes('\0'), 'release-notes.md must contain installation and version notes');
  const marker = `<!-- fluentread-release ${JSON.stringify({schemaVersion: 1, workflow: WORKFLOW, repository, tag,
    sourceCommit: manifest.sourceCommit, manifestSha256})} -->`;
  return {tag, repository, sourceCommit: manifest.sourceCommit, assets: [...assets.values()], marker, notes: `${marker}\n\n${notes}`};
}

function executeGh(args, {env, maxBuffer = 16 * 1024 * 1024} = {}) {
  return spawnSync('gh', args, {env: {...env, GH_PROMPT_DISABLED: '1'}, encoding: null,
    shell: false, timeout: 180_000, maxBuffer});
}

export function publishRelease(options, {runGh = executeGh, env = process.env} = {}) {
  // 所有本地输入必须先验证完，不能在清单损坏时提前查询或改写远端。
  const prepared = validatePreparedRelease({...options, env});
  const base = `repos/${prepared.repository}/releases`;
  function invoke(args, extra = {}) {
    const result = runGh(args, {env, ...extra});
    requireValue(result && !result.error && !result.signal && Number.isInteger(result.status), `Unable to execute gh ${args[0]}`);
    return result;
  }
  function api(endpoint, {allowMissing = false} = {}) {
    const result = invoke(['api', '--include', '--method', 'GET', endpoint]);
    const output = String(result.stdout ?? '');
    const header = /^HTTP\/[\d.]+ (\d{3})[^\r\n]*\r?\n/u.exec(output);
    requireValue(header, 'GitHub API response did not include an HTTP status');
    const status = Number(header[1]);
    if (allowMissing && status === 404) return null;
    requireValue(result.status === 0 && status === 200, `GitHub API read failed with HTTP ${status}`);
    const bodyStart = /\r?\n\r?\n/u.exec(output);
    requireValue(bodyStart, 'GitHub API response headers are incomplete');
    return JSON.parse(output.slice(bodyStart.index + bodyStart[0].length));
  }
  function assertOwned(release) {
    requireValue(release && Number.isSafeInteger(release.id) && release.id > 0 && release.tag_name === prepared.tag
      && typeof release.draft === 'boolean' && typeof release.body === 'string' && release.body.includes(prepared.marker),
    'Existing release does not belong to this exact prepared pipeline output');
  }
  function findRelease() {
    const published = api(`${base}/tags/${prepared.tag}`, {allowMissing: true});
    if (published) return published;
    // tag 端点只保证返回公开发行；已认证列表才能可靠发现失败后保留的草稿。
    const matches = [];
    for (let page = 1; page <= 100; page++) {
      const releases = api(`${base}?per_page=100&page=${page}`);
      requireValue(Array.isArray(releases), 'GitHub returned an invalid release list');
      matches.push(...releases.filter(release => release.tag_name === prepared.tag));
      requireValue(matches.length <= 1, 'Multiple existing releases use this tag; refusing an ambiguous draft');
      if (releases.length < 100) return matches[0] ?? null;
    }
    throw new Error('Release listing exceeded the supported page limit');
  }
  function remoteAssets(release) {
    const collected = [];
    for (let page = 1; page <= 100; page++) {
      const assets = api(`${base}/${release.id}/assets?per_page=100&page=${page}`);
      requireValue(Array.isArray(assets), 'GitHub returned an invalid asset list');
      collected.push(...assets);
      if (assets.length < 100) return collected;
    }
    throw new Error('Release asset listing exceeded the supported page limit');
  }
  function verifyAssets(release, {complete}) {
    const remote = remoteAssets(release);
    const expected = new Map(prepared.assets.map(asset => [asset.name, asset]));
    const present = new Set();
    for (const asset of remote) {
      const local = expected.get(asset.name);
      requireValue(local && !present.has(asset.name) && asset.state === 'uploaded' && asset.size === local.bytes
        && Number.isSafeInteger(asset.id) && asset.id > 0, 'Existing release contains unexpected, incomplete or different assets');
      if (typeof asset.digest === 'string' && asset.digest.startsWith('sha256:')) {
        requireValue(asset.digest === `sha256:${local.sha256}`, `Existing release asset digest differs: ${asset.name}`);
      } else {
        const download = invoke(['api', '--method', 'GET', `${base}/assets/${asset.id}`, '--header', 'Accept: application/octet-stream'],
          {maxBuffer: Math.max(1024, local.bytes + 1)});
        const bytes = Buffer.isBuffer(download.stdout) ? download.stdout : Buffer.from(download.stdout ?? '');
        requireValue(download.status === 0 && bytes.length === local.bytes && sha256(bytes) === local.sha256,
          `Unable to verify existing release asset bytes: ${asset.name}`);
      }
      present.add(asset.name);
    }
    requireValue(!complete || present.size === expected.size, 'Published release is missing prepared assets; refusing to modify it');
    return prepared.assets.filter(asset => !present.has(asset.name));
  }
  function mutation(args) {
    const result = invoke(args);
    requireValue(result.status === 0, `gh ${args[0]} ${args[1]} failed; release remains unmodified or draft`);
  }

  let release = findRelease();
  if (release) {
    assertOwned(release);
    if (!release.draft) {
      verifyAssets(release, {complete: true});
      return {status: 'already-published', tag: prepared.tag};
    }
  } else {
    const temporary = mkdtempSync(path.join(os.tmpdir(), 'fluentread-release-notes-'));
    try {
      const notes = path.join(temporary, NOTES);
      writeFileSync(notes, prepared.notes, {mode: 0o600});
      mutation(['release', 'create', prepared.tag, '--repo', prepared.repository, '--draft', '--verify-tag', '--generate-notes',
        '--target', prepared.sourceCommit, '--title', prepared.tag, '--notes-file', notes]);
    } finally {rmSync(temporary, {recursive: true, force: true});}
    release = findRelease();
    assertOwned(release);
    requireValue(release.draft, 'New release must remain a draft until all assets are verified');
  }
  const missing = verifyAssets(release, {complete: false});
  for (const asset of missing) mutation(['release', 'upload', prepared.tag, asset.absolute, '--repo', prepared.repository]);
  release = findRelease();
  assertOwned(release);
  verifyAssets(release, {complete: true});
  if (!release.draft) return {status: 'already-published', tag: prepared.tag};
  mutation(['release', 'edit', prepared.tag, '--repo', prepared.repository, '--draft=false']);
  release = findRelease();
  assertOwned(release);
  requireValue(release.draft === false, 'GitHub has not confirmed the release is published');
  return {status: 'published', tag: prepared.tag, assets: prepared.assets.length};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {console.log(JSON.stringify(publishRelease(parsePublishArgs(process.argv.slice(2)))));}
  catch (error) {console.error(`[release-publish] ${error.message}`);process.exitCode = 1;}
}
