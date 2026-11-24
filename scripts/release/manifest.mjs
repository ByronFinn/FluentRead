#!/usr/bin/env node
/** 汇总已验证的各端安装包；校验版本、目标完整性与字节摘要，不构建或发布。 */
import {createHash} from 'node:crypto';
import {appendFile, lstat, readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const EXPECTED_TARGETS = ['chrome', 'edge', 'firefox', 'thunderbird', 'zotero', 'obsidian', 'userscript', 'userscript-standalone', 'safari'];
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function assert(condition, message) {if (!condition) throw new Error(message);}
const json = async filename => JSON.parse(await readFile(filename, 'utf8'));

export async function validateReleaseVersion({root = ROOT, tag}) {
    const pkg = await json(path.join(root, 'package.json'));
    assert(VERSION.test(pkg.version), 'Product version must be a numeric X.Y.Z version');
    assert(tag === `v${pkg.version}`, `Tag ${tag} must match package.json version v${pkg.version}`);
    assert(VERSION.test(pkg.userscriptVersion), 'Userscript version must be a numeric X.Y.Z version');
    const zotero = await json(path.join(root, 'integrations/zotero/manifest.json'));
    const obsidian = await json(path.join(root, 'integrations/obsidian/manifest.json'));
    assert(VERSION.test(zotero.version) && VERSION.test(obsidian.version), 'Plugin manifests must declare numeric X.Y.Z versions');
    return {productVersion: pkg.version, componentVersions: {userscript: pkg.userscriptVersion, zotero: zotero.version, obsidian: obsidian.version}};
}

async function regularFile(filename) {
    const info = await lstat(filename);
    assert(info.isFile() && !info.isSymbolicLink() && info.size > 0, `Expected nonempty regular file: ${filename}`);
    return readFile(filename);
}

export async function finalizeRelease({root = ROOT, directory = path.join(root, 'reports/release'), tag, repository, sourceCommit}) {
    const versions = await validateReleaseVersion({root, tag});
    assert(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository), 'Invalid release repository');
    assert(/^[a-f0-9]{40}$/u.test(sourceCommit), 'Release source commit must be a full Git SHA');
    const assetsDir = path.join(directory, 'assets');
    const fragmentsDir = path.join(directory, 'fragments');
    for (const dir of [directory, assetsDir, fragmentsDir]) {
        assert((await lstat(dir)).isDirectory(), `Expected regular directory: ${dir}`);
    }
    const fragments = (await readdir(fragmentsDir)).sort();
    assert(JSON.stringify(fragments) === JSON.stringify(EXPECTED_TARGETS.map(target => `${target}.json`).sort()), 'Missing or unexpected release target fragments');
    const assets = [];
    const names = new Set();
    for (const target of EXPECTED_TARGETS) {
        const fragment = JSON.parse((await regularFile(path.join(fragmentsDir, `${target}.json`))).toString('utf8'));
        assert(fragment.productVersion === versions.productVersion && fragment.userscriptVersion === versions.componentVersions.userscript,
            `Mixed source versions in ${target} build`);
        assert(Array.isArray(fragment.assets) && fragment.assets.length > 0, `No assets for ${target}`);
        for (const asset of fragment.assets) {
            assert(asset.target === target && typeof asset.fileName === 'string' && BASENAME.test(asset.fileName) && !asset.fileName.includes('..'), `Unsafe asset metadata for ${target}`);
            assert(!['release-manifest.json', 'SHA256SUMS.txt', 'release-notes.md'].includes(asset.fileName), 'Package cannot replace release metadata');
            assert(!names.has(asset.fileName), `Duplicate release asset: ${asset.fileName}`);
            names.add(asset.fileName);
            const expectedVersion = target.startsWith('userscript') ? versions.componentVersions.userscript
                : target === 'zotero' || target === 'obsidian' ? versions.componentVersions[target] : versions.productVersion;
            assert(asset.version === expectedVersion && asset.signed === false && typeof asset.kind === 'string', `Invalid version or signing metadata for ${target}`);
            const bytes = await regularFile(path.join(assetsDir, asset.fileName));
            assets.push({name: asset.fileName, target, version: asset.version, kind: asset.kind, signed: false, bytes: bytes.length, sha256: sha256(bytes)});
        }
    }
    // 完整性按本次全部构建的集合判断，不将旧目录中的同名/额外文件静默发出去。
    const allowed = new Set([...names, 'release-manifest.json', 'SHA256SUMS.txt', 'release-notes.md']);
    assert((await readdir(assetsDir)).every(name => allowed.has(name)), 'Unexpected file in release assets directory');
    assets.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    const manifest = {schemaVersion: 1, workflow: 'automatic-release-packages', repository, tag, sourceCommit, ...versions, assets};
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    for (const name of ['release-manifest.json', 'SHA256SUMS.txt', 'release-notes.md']) {
        try {assert((await lstat(path.join(assetsDir, name))).isFile(), `Release metadata must be a regular file: ${name}`);}
        catch (error) {if (error.code !== 'ENOENT') throw error;}
    }
    await writeFile(path.join(assetsDir, 'release-manifest.json'), manifestBytes);
    const checksums = [...assets.map(asset => `${asset.sha256}  ${asset.name}`), `${sha256(manifestBytes)}  release-manifest.json`].sort();
    await writeFile(path.join(assetsDir, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`);
    const notes = [
        `FluentRead ${versions.productVersion}`, '',
        `Source commit: \`${sourceCommit}\``, '',
        '### Downloads / 下载说明', '',
        '- Chrome / Edge: ZIP archives for unpacked installation or preparing an existing store submission.',
        '- Firefox: unsigned ZIP plus matching source ZIP; ordinary Firefox installations require Mozilla signing.',
        '- Thunderbird / Zotero: unsigned XPI integration packages; Obsidian: extract its ZIP into the plugin directory.',
        '- Userscript: install the standard or standalone .user.js file in a userscript manager; supporting resources are included where required.',
        '- Safari: unsigned web-extension source ZIP, requiring Apple packaging/signing before normal installation; this is not a signed Safari app.',
        '- Browser stores, Greasy Fork and Apple App Store are not updated by this Release.', '',
        `Component versions: userscript ${versions.componentVersions.userscript}; Zotero ${versions.componentVersions.zotero}; Obsidian ${versions.componentVersions.obsidian}.`,
        'Component versions are independent and are preserved in each package.', '',
        'Verify downloads with SHA256SUMS.txt. release-manifest.json records the target, internal version, source commit and checksum of every asset.', '',
    ].join('\n');
    await writeFile(path.join(assetsDir, 'release-notes.md'), notes);
    return manifest;
}

async function main() {
    const args = process.argv.slice(2);
    const options = {};
    for (let i = 0; i < args.length; i++) {
        const flag = args[i];
        assert(['--check', '--finalize', '--tag', '--directory', '--repository', '--commit'].includes(flag) && !Object.hasOwn(options, flag), `Unknown or repeated option: ${flag}`);
        if (flag === '--check' || flag === '--finalize') options[flag] = true;
        else {assert(args[i + 1] && !args[i + 1].startsWith('--'), `Missing value: ${flag}`);options[flag] = args[++i];}
    }
    assert(Boolean(options['--check']) !== Boolean(options['--finalize']), 'Choose --check or --finalize');
    const tag = options['--tag'];
    const versions = await validateReleaseVersion({tag});
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `tag=${tag}\nproduct_version=${versions.productVersion}\n`);
    if (options['--finalize']) {
        const manifest = await finalizeRelease({tag, directory: path.resolve(options['--directory'] || path.join(ROOT, 'reports/release')),
            repository: options['--repository'] || process.env.GITHUB_REPOSITORY, sourceCommit: options['--commit'] || process.env.GITHUB_SHA});
        if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
            `## Release ${tag}\n\nSource: ${manifest.sourceCommit}\n\n| Asset | Internal version | Bytes |\n| --- | --- | ---: |\n${manifest.assets.map(asset => `| ${asset.name} | ${asset.version} | ${asset.bytes} |`).join('\n')}\n`);
        console.log(`Verified ${manifest.assets.length} release assets for ${tag}`);
    } else console.log(JSON.stringify(versions));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => {console.error(error.message);process.exitCode = 1;});
