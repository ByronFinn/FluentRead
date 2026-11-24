#!/usr/bin/env node
// 用 Mozilla 官方校验器检查已有 Firefox 目录或 ZIP，保留完整报告，不构建、不屏蔽规则。
import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, open, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

async function executeLinter(executable, args) {
    const directory = await mkdtemp(path.join(tmpdir(), 'fluentread-amo-output-'));
    const stdoutPath = path.join(directory, 'stdout.txt');
    const stderrPath = path.join(directory, 'stderr.txt');
    let stdout;
    let stderr;
    try {
        stdout = await open(stdoutPath, 'w', 0o600);
        stderr = await open(stderrPath, 'w', 0o600);
        // addons-linter 10.15 的 CLI 输出 JSON 后立即 process.exit()；POSIX 管道可能只收到
        // 前 8192 字节。常规文件的 Node stdout 写入为同步行为，完整落盘后再读取，不改规则。
        const status = await new Promise((resolve, reject) => {
            const child = spawn(executable, args, {
                cwd: PROJECT_ROOT,
                stdio: ['ignore', stdout.fd, stderr.fd],
            });
            const timeout = setTimeout(() => child.kill('SIGTERM'), 5 * 60 * 1000);
            timeout.unref();
            child.once('error', error => {clearTimeout(timeout); reject(error);});
            child.once('close', (code, signal) => {clearTimeout(timeout); resolve({code, signal});});
        });
        return {...status, stdout: await readFile(stdoutPath, 'utf8'), stderr: await readFile(stderrPath, 'utf8')};
    } finally {
        await Promise.all([stdout?.close(), stderr?.close()]);
        await rm(directory, {recursive: true, force: true});
    }
}

function optionsFrom(argv) {
    const options = {input: '.output/firefox-mv2', linter: process.env.FLUENTREAD_AMO_LINTER || 'addons-linter'};
    let hasInput = false;
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--help' || argument === '-h') return {help: true};
        if (argument === '--linter' || argument === '--report') {
            const value = argv[++index];
            if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
            options[argument.slice(2)] = value;
        } else if (argument.startsWith('-') || hasInput) {
            throw new Error(`Unexpected argument: ${argument}`);
        } else {
            options.input = argument;
            hasInput = true;
        }
    }
    return options;
}

function parseReport(stdout) {
    let report;
    try {
        report = JSON.parse(stdout);
    } catch {
        throw new Error('Mozilla addons-linter did not return a JSON report');
    }
    if (!report || ['errors', 'warnings', 'notices'].some(key => !Array.isArray(report[key]))) {
        throw new Error('Mozilla addons-linter report must contain errors, warnings and notices arrays');
    }
    return report;
}

function groupWarnings(warnings) {
    const groups = new Map();
    for (const warning of warnings) {
        const code = String(warning.code ?? 'UNKNOWN');
        const group = groups.get(code) ?? {code, count: 0, files: new Set()};
        group.count += 1;
        if (warning.file) group.files.add(warning.file);
        groups.set(code, group);
    }
    return [...groups.values()].map(group => ({...group, files: [...group.files].sort()}))
        .sort((left, right) => left.code.localeCompare(right.code));
}

export async function main(argv = process.argv.slice(2)) {
    const options = optionsFrom(argv);
    if (options.help) {
        console.log('Usage: node scripts/testing/lint-firefox-amo.mjs [directory-or-zip] [--linter executable] [--report report.json]\n'
            + 'Install Mozilla addons-linter separately and record its version. Warnings remain visible; errors fail validation.');
        return 0;
    }
    const input = path.resolve(PROJECT_ROOT, options.input);
    const result = await executeLinter(options.linter, [input, '--output=json', '--boring', '--warnings-as-errors=false']);
    const failure = result.code !== 0 || result.signal ? {code: result.code, signal: result.signal} : undefined;
    let report;
    try {
        report = parseReport(result.stdout);
    } catch (error) {
        let diagnosticPath;
        if (options.report) {
            diagnosticPath = `${path.resolve(PROJECT_ROOT, options.report)}.diagnostics.json`;
            await mkdir(path.dirname(diagnosticPath), {recursive: true});
            await writeFile(diagnosticPath, `${JSON.stringify({input, linter: options.linter, ...result}, null, 2)}\n`, {mode: 0o600});
        }
        throw new Error(`${error.message}; child exit=${result.code}, signal=${result.signal ?? 'none'}; `
            + `stdout=${JSON.stringify(result.stdout.slice(0, 240))}; stderr=${JSON.stringify(result.stderr.slice(0, 240))}`
            + (diagnosticPath ? `; full diagnostics: ${diagnosticPath}` : ''), {cause: error});
    }
    if (options.report) {
        const reportPath = path.resolve(PROJECT_ROOT, options.report);
        await mkdir(path.dirname(reportPath), {recursive: true});
        await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    }
    const failed = report.errors.length > 0 || Boolean(failure);
    console.log(JSON.stringify({
        input,
        linter: options.linter,
        passed: !failed,
        errors: report.errors.length,
        warnings: report.warnings.length,
        notices: report.notices.length,
        warningGroups: groupWarnings(report.warnings),
        ...(report.errors.length ? {errorDetails: report.errors} : {}),
        ...(failure ? {processFailure: {code: failure.code, signal: failure.signal ?? null}} : {}),
        ...(result.stderr ? {stderr: result.stderr} : {}),
        ...(options.report ? {report: path.resolve(PROJECT_ROOT, options.report)} : {}),
    }, null, 2));
    return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().then(code => {process.exitCode = code;}).catch(error => {
        console.error(`[firefox-amo] ${error.message}`);
        process.exitCode = 1;
    });
}
