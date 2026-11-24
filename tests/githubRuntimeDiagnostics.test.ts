/** GitHub 原生逐请求归属测试：真实无扩展调用栈的无损字典、明确上限及原 collector 同 session/entry 绑定。 */
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import {describe, expect, it, vi} from 'vitest';
import nativeStacks from './fixtures/github-native-request-stacks.json';

const require = createRequire(import.meta.url);
const {POLICY, canonicalStack, stackHash, classifyRequest, explicitArguments, createGithubRuntimeDiagnostics} =
    require('../scripts/testing/github-runtime-diagnostics.cjs');
const artifactHash = 'a'.repeat(64);
const extensionId = 'fixture-extension';

function initiator(index = 0) {
    const saved = nativeStacks.requests[index]!;
    return {type: 'script', stack: {callFrames: saved.frameIndexes.map((position, i) =>
        ({...saved.frames[position]!, scriptId: `opaque-${i}`}))}};
}

function facts(index = 0): Record<string, any> {
    const requestUrl = nativeStacks.requests[index]!.requestUrl;
    return {artifactHash, extensionId,
        entry: {id: 7, ownership: 'unattributed', type: 'browser-log', browserSource: 'network',
            targetType: 'page', level: 'error', targetUrl: POLICY.pageUrl, sourceUrl: requestUrl,
            message: 'Failed to load resource: the server responded with a status of 404 ()',
            contextOrigin: '', contextName: '', stack: []},
        binding: {networkRequestId: 'request-1', entryIds: [7], targetId: 'target-1', sessionKey: 'session-1',
            loaderId: 'loader-1', frameId: 'frame-1', pageUrl: POLICY.pageUrl, captureConfigured: true, captureSize: 2048},
        request: {requestId: 'request-1', targetId: 'target-1', sessionKey: 'session-1', loaderId: 'loader-1',
            frameId: 'frame-1', pageUrl: POLICY.pageUrl, documentURL: POLICY.pageUrl,
            requestCount: 1, responseCount: 1, finishCount: 1, logCount: 1, captureConfigured: true, captureSize: 2048,
            method: 'GET', url: requestUrl, responseUrl: requestUrl, status: 404, type: 'Fetch',
            hasPostData: false, redirected: false, fromServiceWorker: false, initiator: initiator(index)},
    };
}

describe('GitHub exact native request policy', () => {
    it.each([0, 1, 2])('losslessly restores and matches saved native request stack %i', index => {
        const saved = nativeStacks.requests[index]!;
        expect(nativeStacks.sourceSha256).toBe(POLICY.baselineSha256);
        expect(stackHash(initiator(index).stack)).toBe(saved.stackSha256);
        expect(classifyRequest(facts(index))).toMatchObject({matched: true, requestId: 'request-1',
            frames: saved.frameIndexes.length, captureSize: 2048, stackSha256: saved.stackSha256});
    });

    it('removes opaque scriptId alone; no parent or extra stack information is silently dropped', () => {
        const stack = initiator().stack;
        const expected = stackHash(stack);
        stack.callFrames.forEach(frame => {frame.scriptId = 'a-new-isolate-id';});
        expect(stackHash(stack)).toBe(expected);
        expect(canonicalStack({description: 'retained', callFrames: [], parentId: {id: 'retained'}}))
            .toEqual({description: 'retained', callFrames: [], parentId: {id: 'retained'}});
        expect(stackHash({...stack, description: 'new description'})).not.toBe(expected);
    });

    it.each<[string, (value: Record<string, any>) => void]>([
        ['missing Log.requestId', v => {v.binding.networkRequestId = '';}],
        ['wrong actual entry ID', v => {v.binding.entryIds = [8];}],
        ['ambiguous added entries', v => {v.binding.entryIds.push(8);}],
        ['ambiguous binding', v => {v.binding.ambiguous = true;}],
        ['another target', v => {v.binding.targetId = 'other';}],
        ['another session', v => {v.binding.sessionKey = 'other';}],
        ['another loader', v => {v.binding.loaderId = 'other';}],
        ['another frame', v => {v.binding.frameId = 'other';}],
        ['another request ID', v => {v.request.requestId = 'other';}],
        ['an absent loader', v => {v.request.loaderId = v.binding.loaderId = '';}],
        ['a changed native page', v => {v.entry.targetUrl += '#other';}],
        ['a changed document', v => {v.request.documentURL += '?other';}],
        ['a changed active page', v => {v.request.pageUrl += '#other';}],
        ['a fourth exact same-origin endpoint', v => {v.entry.sourceUrl = v.request.url = v.request.responseUrl = 'https://github.com/unknown-native-endpoint';}],
        ['new query parameters', v => {v.entry.sourceUrl += '&unknown=1';}],
        ['POST', v => {v.request.method = 'POST';}],
        ['GET data', v => {v.request.hasPostData = true;}],
        ['a redirected request', v => {v.request.redirected = true;}],
        ['a service-worker response', v => {v.request.fromServiceWorker = true;}],
        ['missing SW evidence', v => {delete v.request.fromServiceWorker;}],
        ['a failed request', v => {v.request.failed = true;}],
        ['a changed response URL', v => {v.request.responseUrl += '?other';}],
        ['status500', v => {v.request.status = 500;}],
        ['a preflight', v => {v.request.type = 'Preflight';}],
        ['duplicate request', v => {v.request.requestCount = 2;}],
        ['duplicate response', v => {v.request.responseCount = 2;}],
        ['unfinished request', v => {v.request.finishCount = 0;}],
        ['duplicate log', v => {v.request.logCount = 2;}],
        ['capture command not successful', v => {v.request.captureConfigured = false;}],
        ['capture command absent on binding', v => {delete v.binding.captureConfigured;}],
        ['old default200 capture', v => {v.request.captureSize = v.binding.captureSize = 200;}],
        ['a truncated200-frame long stack', v => {v.request.initiator.stack.callFrames.length = 200;}],
        ['a stack reaching2048cap', v => {v.request.initiator.stack.callFrames = Array.from({length: 2048}, () => v.request.initiator.stack.callFrames[0]);}],
        ['an unresolved parentId', v => {v.request.initiator.stack.parentId = {id: 'unresolved'};}],
        ['a new parent', v => {v.request.initiator.stack.parent = {callFrames: []};}],
        ['a new frame', v => {v.request.initiator.stack.callFrames.push(v.request.initiator.stack.callFrames[0]);}],
        ['a removed frame', v => {v.request.initiator.stack.callFrames.pop();}],
        ['a changed versioned asset', v => {v.request.initiator.stack.callFrames[0].url += '.changed';}],
        ['a changed function name', v => {v.request.initiator.stack.callFrames[0].functionName += 'changed';}],
        ['a changed line', v => {v.request.initiator.stack.callFrames[0].lineNumber += 1;}],
        ['a changed column', v => {v.request.initiator.stack.callFrames[0].columnNumber += 1;}],
        ['an extension frame', v => {v.request.initiator.stack.callFrames[0].url = 'chrome-extension://fixture-extension/content.js';}],
        ['a reordered stack', v => {v.request.initiator.stack.callFrames.reverse();}],
        ['new stack metadata', v => {v.request.initiator.stack.description = 'new';}],
        ['an exception', v => {v.entry.type = 'exception';}],
        ['an isolated world', v => {v.entry.contextName = 'FluentRead';}],
        ['an explicit extension stack', v => {v.entry.stack = [{url: 'chrome-extension://fixture-extension/content.js'}];}],
        ['a background error', v => {v.entry.targetType = 'service_worker';}],
        ['a known FluentRead error', v => {v.entry.ownership = 'fluentread';}],
        ['an unbound helper artifact', v => {v.artifactHash = '';}],
    ])('keeps %s blocking', (_name, mutate) => {
        const value = facts();mutate(value);
        expect(classifyRequest(value).matched).toBe(false);
    });

    it('requires one explicit external raw collector path', () => {
        expect(explicitArguments(['--raw-runtime-diagnostics-helper', '/explicit/raw.cjs']))
            .toEqual({rawHelperPath: '/explicit/raw.cjs'});
        expect(() => explicitArguments([])).toThrow('one explicit');
        expect(() => explicitArguments(['--raw-runtime-diagnostics-helper', '--other'])).toThrow('one explicit');
        expect(() => explicitArguments(['--raw-runtime-diagnostics-helper', '/a', '--raw-runtime-diagnostics-helper', '/b']))
            .toThrow('one explicit');
    });
});

async function collectorFixture(options: {captureFailure?: boolean; ambiguousEntries?: boolean;
    snapshotFailure?: boolean; rawVerdictMismatch?: boolean; stopFailure?: boolean} = {}) {
    const entries: any[] = [], calls: any[] = [];
    const coverage = {failures: [] as any[], limitations: ['original capture limitation']};
    let workerObserved = true, nextId = 0, reads = 0;
    const snapshot = () => {
        if (options.snapshotFailure && ++reads === 1) throw new Error('Original snapshot unavailable');
        return {entries: structuredClone(entries), coverage: structuredClone(coverage), completeCoverage: false,
            coverageScope: 'original scope', workerObserved,
            counts: {errors: entries.length, warnings: 0, expected: 0, site: 0},
            blockerIds: entries.map(e => e.id), passed: entries.length === 0 && workerObserved && coverage.failures.length === 0};
    };
    const session: any = new EventEmitter();
    session.send = vi.fn(async (method: string) => {
        if (method === 'Runtime.setMaxCallStackSizeToCapture' && options.captureFailure) throw new Error('Stack capture unavailable');
        if (method === 'Target.getTargetInfo') return {targetInfo: {targetId: 'target-1', type: 'page'}};
        if (method === 'Page.getFrameTree') return {frameTree: {frame: {id: 'frame-1', loaderId: 'loader-1', url: POLICY.pageUrl}}};
        return {};
    });
    session.detach = vi.fn(async () => session.removeAllListeners());
    const page = {url: () => POLICY.pageUrl}, context = {newCDPSession: vi.fn(async () => session)};
    const base = {
        async start(decorated: any) {
            const actual = await decorated.newCDPSession(page);
            actual.on('Log.entryAdded', function (this: unknown, params: any) {
                calls.push({receiver: this, params});
                if (params.entry.level !== 'error') return;
                entries.push({...facts().entry, id: ++nextId, sourceUrl: params.entry.url});
                if (options.ambiguousEntries) entries.push({...entries.at(-1), id: ++nextId});
            });
            await actual.send('Runtime.enable');await actual.send('Log.enable');
        },
        attachPage: vi.fn(), setExtensionId: vi.fn(), setPhase: vi.fn(), flush: vi.fn(), snapshot,
        assertClean() {
            if (options.rawVerdictMismatch) throw new Error('An additional unexplained original gate');
            const raw = snapshot();
            if (!raw.passed) throw new Error(`运行时诊断未通过：${raw.counts.errors} 个错误、${raw.counts.warnings} 个告警、${raw.coverage.failures.length} 个采集失败，后台采集${raw.workerObserved ? '已连接' : '未连接'}；见 runtime-diagnostics.json`);
        },
        stop: vi.fn(async () => {await session.detach();if (options.stopFailure) throw new Error('Original stop failed');}),
    };
    const diagnostics = createGithubRuntimeDiagnostics({rawHelper: {createRuntimeDiagnostics: () => base, redact: String},
        readArtifactHash: () => artifactHash});
    await diagnostics.start(context);diagnostics.setExtensionId(extensionId);diagnostics.setPhase('native/navigation');
    const emit = (index = 0, settings: {missingId?: boolean; unknownEndpoint?: boolean; noFinish?: boolean} = {}) => {
        const requestUrl = settings.unknownEndpoint ? 'https://github.com/fourth-endpoint' : nativeStacks.requests[index]!.requestUrl;
        const requestId = `request-${index + 1}`;
        session.emit('Network.requestWillBeSent', {requestId, frameId: 'frame-1', loaderId: 'loader-1',
            documentURL: POLICY.pageUrl, request: {url: requestUrl, method: 'GET'}, initiator: initiator(index)});
        session.emit('Network.responseReceived', {requestId, frameId: 'frame-1', loaderId: 'loader-1', type: 'Fetch',
            response: {url: requestUrl, status: 404, fromServiceWorker: false}});
        const params = {entry: {source: 'network', level: 'error', text: facts().entry.message,
            url: requestUrl, timestamp: 12345, ...(settings.missingId ? {} : {networkRequestId: requestId})}};
        session.emit('Log.entryAdded', params);
        if (!settings.noFinish) session.emit('Network.loadingFinished', {requestId});
        return params;
    };
    return {diagnostics, session, base, calls, context, emit, coverage, snapshot, loseWorker: () => {workerObserved = false;}};
}

describe('GitHub same-session raw collector decoration', () => {
    it('sets capture before requests, binds actual entry IDs and preserves raw failure separately', async () => {
        const f = await collectorFixture();
        const params = f.emit(0);f.emit(1);f.emit(2);
        expect(f.context.newCDPSession).toHaveBeenCalledOnce();
        expect(f.calls[0]).toEqual({receiver: f.session, params});
        expect(f.session.send.mock.calls.slice(0, 2)).toEqual([
            ['Runtime.enable'], ['Runtime.setMaxCallStackSizeToCapture', {size: 2048}],
        ]);
        expect(() => f.base.assertClean()).toThrow('运行时诊断未通过');
        expect(() => f.diagnostics.assertClean()).not.toThrow();
        const report = f.diagnostics.snapshot();
        expect(report.rawDiagnostics).toEqual(f.snapshot());
        expect(report.rawDiagnostics).toMatchObject({passed: false, blockerIds: [1, 2, 3], counts: {errors: 3, site: 0}});
        expect(report.rawVerdict).toMatchObject({observed: true, passed: false});
        expect(report).toMatchObject({passed: true, blockerIds: [], counts: {errors: 0, warnings: 0, site: 3},
            completeCoverage: false, coverage: {limitations: ['original capture limitation']}});
        expect(report.requestOwnership.adjustments).toHaveLength(3);
        expect(report.requestOwnership.captures[0]).toMatchObject({configured: true, size: 2048});
        await f.diagnostics.stop();expect(f.base.stop).toHaveBeenCalledOnce();
        expect(f.session.listenerCount('Network.requestWillBeSent')).toBe(0);
    });

    it.each(['capture-failure', 'missing-log-id', 'fourth-endpoint', 'unfinished', 'ambiguous-entries',
        'snapshot-failure', 'raw-verdict-mismatch', 'worker-lost', 'coverage-gap'])(
        'keeps %s blocking while preserving original facts', async variant => {
            const f = await collectorFixture({captureFailure: variant === 'capture-failure',
                ambiguousEntries: variant === 'ambiguous-entries', snapshotFailure: variant === 'snapshot-failure',
                rawVerdictMismatch: variant === 'raw-verdict-mismatch'});
            f.emit(0, {missingId: variant === 'missing-log-id', unknownEndpoint: variant === 'fourth-endpoint', noFinish: variant === 'unfinished'});
            if (variant === 'worker-lost') f.loseWorker();
            if (variant === 'coverage-gap') f.coverage.failures.push({surface: 'unattached frame'});
            expect(() => f.diagnostics.assertClean()).toThrow();
            const report = f.diagnostics.snapshot();
            expect(report.passed).toBe(false);
            expect(report.rawDiagnostics.entries.length).toBeGreaterThan(0);
            if (variant === 'fourth-endpoint') {
                expect(report.blockerIds).toEqual([1]);
                expect(report.requestOwnership.unclassifiedEntries[0].request.url).toBe('https://github.com/fourth-endpoint');
            }
            await f.diagnostics.stop();
        });

    it('does not conceal original cleanup errors', async () => {
        const f = await collectorFixture({stopFailure: true});
        await expect(f.diagnostics.stop()).rejects.toThrow('Original stop failed');
        expect(f.diagnostics.snapshot().requestOwnership.failures).toContainEqual({surface: 'raw-stop', message: 'Original stop failed'});
    });
});
