import {execFileSync, spawnSync} from 'node:child_process';
import {chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

const script = resolve('scripts/testing/lint-firefox-amo.mjs');
const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true});
});

function fakeLinter(report: unknown, exitCode = 0, options: {immediateExit?: boolean; stderr?: string} = {}) {
    const directory = mkdtempSync(resolve(tmpdir(), 'fluentread-amo-test-'));
    directories.push(directory);
    const executable = resolve(directory, 'fake linter.mjs');
    const argumentsPath = resolve(directory, 'arguments.json');
    writeFileSync(executable, `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';\n`
        + `writeFileSync(${JSON.stringify(argumentsPath)}, JSON.stringify(process.argv.slice(2)));\n`
        + `process.stdout.write(${JSON.stringify(typeof report === 'string' ? report : JSON.stringify(report))});\n`
        + `process.stderr.write(${JSON.stringify(options.stderr ?? '')});\n`
        + (options.immediateExit ? `process.exit(${exitCode});\n` : `process.exitCode = ${exitCode};\n`));
    chmodSync(executable, 0o755);
    return {directory, executable, argumentsPath};
}

describe('Firefox AMO local validation', () => {
    it('keeps repeated warnings and full evidence while invoking every Mozilla rule without a shell', () => {
        const warning = {code: 'UNSAFE_VAR_ASSIGNMENT', file: 'chunks/client.js', message: 'Unsafe assignment'};
        const report = {errors: [], warnings: [warning, warning], notices: [{code: 'NOTICE'}], metadata: {version: '0.0.40'}};
        const fake = fakeLinter(report);
        const reportPath = resolve(fake.directory, 'reports', 'amo.json');
        const inputPath = resolve(fake.directory, 'firefox package $(never execute).zip');
        const result = spawnSync(process.execPath, [script, inputPath, '--linter', fake.executable, '--report', reportPath], {encoding: 'utf8'});
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({passed: true, errors: 0, warnings: 2, notices: 1,
            warningGroups: [{code: warning.code, count: 2, files: [warning.file]}]});
        expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toEqual(report);
        expect(JSON.parse(readFileSync(fake.argumentsPath, 'utf8'))).toEqual([
            inputPath, '--output=json', '--boring', '--warnings-as-errors=false',
        ]);
    });

    it('fails on reported errors even if the child exits successfully', () => {
        const fake = fakeLinter({errors: [{code: 'MANIFEST_INVALID'}], warnings: [], notices: []});
        const result = spawnSync(process.execPath, [script, '--linter', fake.executable], {encoding: 'utf8'});
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({passed: false, errors: 1, errorDetails: [{code: 'MANIFEST_INVALID'}]});
    });

    it('preserves a failing Mozilla report and its child exit status', () => {
        const report = {errors: [{code: 'MANIFEST_INVALID'}], warnings: [], notices: []};
        const fake = fakeLinter(report, 1);
        const reportPath = resolve(fake.directory, 'amo.json');
        const result = spawnSync(process.execPath, [script, '--linter', fake.executable, '--report', reportPath], {encoding: 'utf8'});
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({passed: false, errors: 1, processFailure: {code: 1}});
        expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toEqual(report);
    });

    it('fails when the linter process fails with an otherwise empty report', () => {
        const fake = fakeLinter({errors: [], warnings: [], notices: []}, 7);
        const result = spawnSync(process.execPath, [script, '--linter', fake.executable], {encoding: 'utf8'});
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({passed: false, processFailure: {code: 7}});
    });

    it('captures complete reports beyond the POSIX pipe buffer when the Mozilla CLI exits immediately', () => {
        const warnings = Array.from({length: 300}, (_, index) => ({code: 'VENDOR_WARNING', file: `chunk-${index}.js`, message: 'x'.repeat(300)}));
        const report = {errors: [], warnings, notices: []};
        const fake = fakeLinter(report, 0, {immediateExit: true});
        const reportPath = resolve(fake.directory, 'large-report.json');
        const result = spawnSync(process.execPath, [script, '--linter', fake.executable, '--report', reportPath], {encoding: 'utf8'});
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({passed: true, warnings: 300});
        expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toEqual(report);
    });

    it('preserves full invalid stdout, stderr and exit status with useful failure diagnostics', () => {
        const output = `invalid report ${'x'.repeat(20000)}`;
        const fake = fakeLinter(output, 9, {immediateExit: true, stderr: 'validator dependency failed'});
        const reportPath = resolve(fake.directory, 'failed-report.json');
        const result = spawnSync(process.execPath, [script, '--linter', fake.executable, '--report', reportPath], {encoding: 'utf8'});
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('child exit=9');
        expect(result.stderr).toContain('validator dependency failed');
        expect(result.stderr).toContain(`${reportPath}.diagnostics.json`);
        expect(JSON.parse(readFileSync(`${reportPath}.diagnostics.json`, 'utf8'))).toMatchObject({
            stdout: output, stderr: 'validator dependency failed', code: 9, signal: null,
        });
    });

    it.each(['not JSON', {warnings: [], notices: []}, {errors: [], warnings: {}, notices: []}])('rejects an invalid validator response: %j', report => {
        const fake = fakeLinter(report);
        const result = spawnSync(process.execPath, [script, '--linter', fake.executable], {encoding: 'utf8'});
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/JSON report|must contain/);
    });

    it('rejects missing executables and invalid options without reporting validation success', () => {
        const result = spawnSync(process.execPath, [script, '--linter', '/does-not-exist/addons-linter'], {encoding: 'utf8'});
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('ENOENT');
        expect(spawnSync(process.execPath, [script, '--report'], {encoding: 'utf8'}).status).toBe(1);
        expect(spawnSync(process.execPath, [script, '--disable-linter-rules', 'all'], {encoding: 'utf8'}).status).toBe(1);
        expect(execFileSync(process.execPath, [script, '--help'], {encoding: 'utf8'})).toContain('Warnings remain visible');
    });
});
