import {beforeEach, describe, expect, it, vi} from 'vitest';
import {createCommentHandler, isCommentRequestPayload} from '@/src/features/comment-assistant/background';
import {COMMENT_MAX_IMAGE_CHARS} from '@/src/core/config/comment';
import type {CommentKeepAlive} from '@/src/features/comment-assistant/keepalive';
import type {CommentSender} from '@/src/features/comment-assistant/background';
import type {CommentRequest, CommentResponse} from '@/src/features/comment-assistant/types';

const sender = (overrides: Partial<CommentSender> = {}): CommentSender =>
    ({id: 'ext', tab: {id: 1}, frameId: 0, url: 'https://site.example/', ...overrides});
const runRequest = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
    ({type: 'fluentReadComment', action: 'run', requestId: 'r1', text: '原文', images: [], ...overrides});

const failure = (response: CommentResponse) => {
    // 判别联合需要显式收窄：成功响应出现时直接让测试失败，而不是绕过类型检查。
    if (response.success) throw new Error(`期望失败响应，实际成功: ${JSON.stringify(response.comments)}`);
    return response;
};
/** 构造可观测的保活 spy：记录 acquire 次数与累计 release 次数，供各退出路径断言引用严格配对。 */
const keepAliveSpy = () => {
    let released = 0;
    const acquire = vi.fn(() => () => { released += 1; });
    const keepAlive: CommentKeepAlive = {acquire};
    return {keepAlive, acquire, releasedCount: () => released};
};
describe('comment background handler', () => {
    let run: ReturnType<typeof vi.fn>;
    let eligible: string | undefined;
    let ready: Promise<unknown>;
    const deps = () => ({
        extensionId: 'ext',
        get ready() { return ready; },
        eligibility: () => eligible,
        run: (request: CommentRequest, signal: AbortSignal) => run(request, signal),
    });
    beforeEach(() => { run = vi.fn().mockResolvedValue({success: true, comments: []}); eligible = undefined; ready = Promise.resolve(); });

    it('rejects foreign senders and malformed envelopes', async () => {
        const handler = createCommentHandler(deps());
        expect(failure(await handler.handle(runRequest(), {...sender(), id: 'other'})).error).toContain('无效');
        expect(failure(await handler.handle(runRequest(), {id: 'ext'})).error).toContain('无效');
        expect(failure(await handler.handle(runRequest(), sender({tab: {id: -1}}))).error).toContain('无效');
        expect(failure(await handler.handle(runRequest({requestId: 'bad id!'}) as never, sender())).error).toContain('无效');
        expect(failure(await handler.handle({type: 'other'}, sender())).error).toContain('无效');
    });

    it('validates payload bounds through the shared guard', async () => {
        expect(isCommentRequestPayload(runRequest() as Record<string, unknown>)).toBe(true);
        expect(isCommentRequestPayload(runRequest({text: ' '}) as Record<string, unknown>)).toBe(false);
        expect(isCommentRequestPayload(runRequest({text: 'x'.repeat(8193)}) as Record<string, unknown>)).toBe(false);
        expect(isCommentRequestPayload(runRequest({images: ['https://x']}) as Record<string, unknown>)).toBe(false);
        expect(isCommentRequestPayload(runRequest({images: Array.from({length: 5}, () => 'data:image/png;base64,Y')}) as Record<string, unknown>)).toBe(false);
        expect(isCommentRequestPayload(runRequest({images: 'nope'}) as Record<string, unknown>)).toBe(false);
    });

    it('runs, blocks by eligibility and re-checks after completion', async () => {
        const handler = createCommentHandler(deps());
        expect(await handler.handle(runRequest() as never, sender())).toEqual({success: true, comments: []});
        expect(run).toHaveBeenCalledOnce();
        eligible = '评论功能已停用';
        expect(failure(await handler.handle(runRequest({requestId: 'r2'}) as never, sender())).error).toContain('停用');
        eligible = undefined;
        run.mockImplementation(async () => { eligible = '当前网站已禁用扩展'; return {success: true, comments: []}; });
        expect(failure(await handler.handle(runRequest({requestId: 'r3'}) as never, sender())).error).toContain('禁用');
    });

    it('cancels: explicit, superseded, tab-scoped, disallowed and dispose', async () => {
        const handler = createCommentHandler(deps());
        let release!: (value: CommentResponse) => void;
        run.mockImplementation((_request: CommentRequest, signal: AbortSignal) =>
            new Promise<CommentResponse>((resolve) => {
                release = resolve;
                signal.addEventListener('abort', () => resolve({success: false, error: '已取消', cancelled: true}), {once: true});
            }));
        const pending = handler.handle(runRequest() as never, sender());
        await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
        expect(failure(await handler.handle(runRequest() as never, sender())).error).toContain('正在处理');
        expect(failure(await handler.handle({type: 'fluentReadComment', action: 'cancel', requestId: 'r1'} as never, sender())).cancelled).toBe(true);
        expect(failure(await pending).cancelled).toBe(true);
        expect(failure(await handler.handle({type: 'fluentReadComment', action: 'cancel', requestId: 'never-seen'} as never, sender())).cancelled).toBe(true);

        const first = handler.handle(runRequest({requestId: 'r4'}) as never, sender());
        await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
        const second = handler.handle(runRequest({requestId: 'r5', text: '新选区'}) as never, sender());
        await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
        expect(failure(await first).cancelled).toBe(true);
        release({success: true, comments: [], sourceTranslation: null});
        expect((await second).success).toBe(true);

        const tab2 = handler.handle(runRequest({requestId: 'r9', text: '另一页'}) as never, sender({tab: {id: 2}}));
        await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(4));
        handler.cancelTab(2);
        expect(failure(await tab2).cancelled).toBe(true);

        const blocked = handler.handle(runRequest({requestId: 'r10', text: '停用页'}) as never, sender({tab: {id: 3}}));
        await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(5));
        eligible = '评论功能已停用';
        handler.cancelDisallowed();
        expect(failure(await blocked).cancelled).toBe(true);
        handler.dispose();
        expect(failure(await handler.handle(runRequest({requestId: 'r11'}) as never, sender())).error).toContain('无效');
    });

    it('waits for config readiness and drops late results after timeout', async () => {
        vi.useFakeTimers();
        try {
            let gate!: () => void;
            ready = new Promise<void>((resolve) => { gate = resolve; });
            const handler = createCommentHandler(deps());
            const pending = handler.handle(runRequest() as never, sender());
            run.mockResolvedValue({success: true, comments: []});
            gate();
            expect((await pending).success).toBe(true);

            const alive = keepAliveSpy();
            const timed = createCommentHandler({...deps(), keepAlive: alive.keepAlive});
            run.mockImplementation((_r: CommentRequest, signal: AbortSignal) =>
                new Promise<CommentResponse>((resolve) => signal.addEventListener('abort', () => resolve({success: false, error: '已取消', cancelled: true}), {once: true})));
            const slow = timed.handle(runRequest({requestId: 'slow'}) as never, sender());
            await vi.advanceTimersByTimeAsync(60_001);
            expect(alive.releasedCount()).toBe(0); // 保活后超时放宽到 120 秒：旧的 60 秒边界不再触发。
            await vi.advanceTimersByTimeAsync(59_999);
            expect(failure(await slow).cancelled).toBe(true);
            expect(alive.acquire).toHaveBeenCalledOnce();
            expect(alive.releasedCount()).toBe(1); // 超时路径同样释放保活引用。
        } finally {
            vi.useRealTimers();
        }
    });

    it('acquires the keepalive once per taken-over request and releases it on every exit path', async () => {
        const alive = keepAliveSpy();
        const handler = createCommentHandler({...deps(), keepAlive: alive.keepAlive});
        expect((await handler.handle(runRequest() as never, sender())).success).toBe(true);
        expect(alive.acquire).toHaveBeenCalledOnce();
        expect(alive.releasedCount()).toBe(1);
        eligible = '评论功能已停用';
        expect(failure(await handler.handle(runRequest({requestId: 'r2'}) as never, sender())).error).toContain('停用');
        expect(alive.acquire).toHaveBeenCalledTimes(2);
        expect(alive.releasedCount()).toBe(2);
        eligible = undefined;
        run.mockRejectedValue(new Error('boom'));
        expect(failure(await handler.handle(runRequest({requestId: 'r3'}) as never, sender())).error).toContain('未完成');
        expect(alive.acquire).toHaveBeenCalledTimes(3);
        expect(alive.releasedCount()).toBe(3);
    });

    it('never acquires the keepalive before takeover and releases it on cancel and supersede', async () => {
        const alive = keepAliveSpy();
        const handler = createCommentHandler({...deps(), keepAlive: alive.keepAlive});
        // 无效信封、无效载荷与纯取消消息都在接管前返回，不占用保活引用。
        expect(failure(await handler.handle(runRequest() as never, {...sender(), id: 'other'})).error).toContain('无效');
        expect(failure(await handler.handle(runRequest({text: ' '}) as never, sender())).error).toContain('无效');
        expect(failure(await handler.handle({type: 'fluentReadComment', action: 'cancel', requestId: 'r1'} as never, sender())).cancelled).toBe(true);
        expect(alive.acquire).not.toHaveBeenCalled();

        run.mockImplementation((_request: CommentRequest, signal: AbortSignal) =>
            new Promise<CommentResponse>((resolve) => signal.addEventListener('abort', () => resolve({success: false, error: '已取消', cancelled: true}), {once: true})));
        const inFlight = handler.handle(runRequest({requestId: 'dup'}) as never, sender());
        expect(alive.acquire).toHaveBeenCalledOnce();
        // 先等 run 真正启动再取消，避免取消落在 ready 等待窗口里让 run 根本不启动。
        await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
        expect(failure(await handler.handle(runRequest({requestId: 'dup'}) as never, sender())).error).toContain('正在处理'); // 同一请求重复提交不追加引用。
        expect(alive.acquire).toHaveBeenCalledOnce();
        expect(failure(await handler.handle({type: 'fluentReadComment', action: 'cancel', requestId: 'dup'} as never, sender())).cancelled).toBe(true);
        expect(failure(await inFlight).cancelled).toBe(true);
        expect(alive.releasedCount()).toBe(1); // 显式取消路径释放。

        const stale = handler.handle(runRequest({requestId: 'old'}) as never, sender());
        await vi.waitFor(() => expect(alive.acquire).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
        const current = handler.handle(runRequest({requestId: 'new', text: '新选区'}) as never, sender());
        await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
        expect(failure(await stale).cancelled).toBe(true);
        expect(alive.releasedCount()).toBe(2); // 被替换的旧请求释放。
        expect(failure(await handler.handle({type: 'fluentReadComment', action: 'cancel', requestId: 'new'} as never, sender())).cancelled).toBe(true);
        expect(failure(await current).cancelled).toBe(true);
        expect(alive.releasedCount()).toBe(3);
    });

    it('does not acquire the keepalive when the concurrency limit rejects a new owner', async () => {
        const alive = keepAliveSpy();
        const handler = createCommentHandler({...deps(), keepAlive: alive.keepAlive});
        run.mockImplementation((_request: CommentRequest, signal: AbortSignal) =>
            new Promise<CommentResponse>((resolve) => signal.addEventListener('abort', () => resolve({success: false, error: '已取消', cancelled: true}), {once: true})));
        const a = handler.handle(runRequest({requestId: 'a', text: 'T'}) as never, sender({tab: {id: 10}}));
        const b = handler.handle(runRequest({requestId: 'b', text: 'T'}) as never, sender({tab: {id: 11}}));
        const overflow = handler.handle(runRequest({requestId: 'c', text: 'T'}) as never, sender({tab: {id: 12}}));
        expect(failure(await overflow).error).toContain('稍后再试');
        expect(alive.acquire).toHaveBeenCalledTimes(2); // 只有被接管的两个请求各持有一个引用。
        handler.cancelAll();
        expect(failure(await a).cancelled).toBe(true);
        expect(failure(await b).cancelled).toBe(true);
        expect(alive.releasedCount()).toBe(2);
    });

    it('enforces per-owner concurrency and remembers finished keys', async () => {
        const handler = createCommentHandler(deps());
        run.mockImplementation((_r: CommentRequest, signal: AbortSignal) =>
            new Promise<CommentResponse>((resolve) => signal.addEventListener('abort', () => resolve({success: false, error: '已取消', cancelled: true}), {once: true})));
        const a = handler.handle(runRequest({requestId: 'a', text: 'T'}) as never, sender({tab: {id: 10}}));
        const b = handler.handle(runRequest({requestId: 'b', text: 'T'}) as never, sender({tab: {id: 11}}));
        const c = handler.handle(runRequest({requestId: 'c', text: 'T'}) as never, sender({tab: {id: 12}}));
        expect(failure(await c).error).toContain('稍后再试');
        const cancelA = handler.handle({type: 'fluentReadComment', action: 'cancel', requestId: 'a'} as never, sender({tab: {id: 10}}));
        expect(failure(await a).cancelled).toBe(true);
        expect(failure(await cancelA).cancelled).toBe(true);
        expect(failure(await handler.handle(runRequest({requestId: 'a', text: 'T'}) as never, sender({tab: {id: 10}}))).cancelled).toBe(true);
        const cancelB = handler.handle({type: 'fluentReadComment', action: 'cancel', requestId: 'b'} as never, sender({tab: {id: 11}}));
        expect(failure(await b).cancelled).toBe(true);
        expect(failure(await cancelB).cancelled).toBe(true);
    });

    it('surfaces run failures and generic crashes', async () => {
        const handler = createCommentHandler(deps());
        run.mockResolvedValue({success: false, error: '服务不可用'} as CommentResponse);
        expect(failure(await handler.handle(runRequest() as never, sender())).error).toBe('服务不可用');
        run.mockRejectedValue(new Error('boom'));
        expect(failure(await handler.handle(runRequest({requestId: 'z'}) as never, sender())).error).toContain('未完成');
    });

    it('defaults owner coordinates when the sender omits frame, document and url', async () => {
        const handler = createCommentHandler(deps());
        expect(await handler.handle(runRequest() as never, {id: 'ext', tab: {id: 5}}))
            .toEqual({success: true, comments: []});
        expect(run).toHaveBeenCalledOnce();
        expect(failure(await handler.handle(runRequest({requestId: 'r1'}) as never, {id: 'ext', tab: {id: 5}})).cancelled)
            .toBe(true);
    });

    it('rejects well-formed envelopes whose payload is out of bounds', async () => {
        const handler = createCommentHandler(deps());
        expect(failure(await handler.handle(runRequest({text: '   '}) as never, sender())).error).toContain('无效');
        expect(failure(await handler.handle(runRequest({text: 12}) as never, sender())).error).toContain('无效');
    });

    it('cancels every request and drops a run that rejects after abort', async () => {
        const handler = createCommentHandler(deps());
        run.mockImplementation((_request: CommentRequest, signal: AbortSignal) => new Promise<CommentResponse>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')), {once: true});
        }));
        const first = handler.handle(runRequest() as never, sender());
        const second = handler.handle(runRequest({requestId: 'r2'}) as never, sender({tab: {id: 2}}));
        await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
        handler.cancelAll();
        expect(failure(await first).cancelled).toBe(true);
        expect(failure(await second).cancelled).toBe(true);
    });

    it('evicts the oldest finished keys once history exceeds its cap', async () => {
        const handler = createCommentHandler(deps());
        for (let index = 0; index < 70; index += 1) {
            expect(await handler.handle(runRequest({requestId: `k${index}`}) as never, sender())).toEqual({success: true, comments: []});
        }
        expect(await handler.handle(runRequest({requestId: 'k0'}) as never, sender())).toEqual({success: true, comments: []});
        expect(failure(await handler.handle(runRequest({requestId: 'k69'}) as never, sender())).cancelled).toBe(true);
    });

    it('refuses an oversized data URL instead of truncating it', async () => {
        const huge = `data:image/png;base64,${'A'.repeat(COMMENT_MAX_IMAGE_CHARS + 1)}`;
        expect(isCommentRequestPayload(runRequest({images: [huge]}) as Record<string, unknown>)).toBe(false);
        const handler = createCommentHandler(deps());
        expect(failure(await handler.handle(runRequest({images: [huge]}) as never, sender())).error).toContain('无效');
        expect(run).not.toHaveBeenCalled();
    });

    it('keeps owners apart by frame and document inside one tab', async () => {
        const handler = createCommentHandler(deps());
        const frame1 = sender({tab: {id: 9}, frameId: 1, documentId: 'doc-a'});
        const frame2 = sender({tab: {id: 9}, frameId: 2, documentId: 'doc-b'});
        let releaseFirst!: (value: CommentResponse) => void;
        run.mockImplementationOnce(() => new Promise<CommentResponse>((resolve) => { releaseFirst = resolve; }));
        const first = handler.handle(runRequest() as never, frame1);
        await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
        const second = handler.handle(runRequest() as never, frame2);
        await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
        expect(failure(await handler.handle({type: 'fluentReadComment', action: 'cancel', requestId: 'r1'} as never, frame1)).cancelled).toBe(true);
        expect(await second).toEqual({success: true, comments: []});
        releaseFirst({success: true, comments: [{content: '迟到的答案', translation: null}], sourceTranslation: null});
        expect(failure(await first).cancelled).toBe(true);
    });

    it('accepts an image exactly at the documented bound', () => {
        const edge = `data:image/png;base64,${'A'.repeat(COMMENT_MAX_IMAGE_CHARS - 'data:image/png;base64,'.length)}`;
        expect(isCommentRequestPayload(runRequest({images: [edge]}) as Record<string, unknown>)).toBe(true);
    });

    it('treats frames as separate owners even when the document matches', async () => {
        const handler = createCommentHandler(deps());
        const senderA = sender({tab: {id: 12}, frameId: 0, documentId: 'doc'});
        const senderB = sender({tab: {id: 12}, frameId: 8, documentId: 'doc'});
        let releaseA!: (value: CommentResponse) => void;
        let releaseB!: (value: CommentResponse) => void;
        run.mockImplementationOnce(() => new Promise<CommentResponse>((resolve) => { releaseA = resolve; }))
            .mockImplementationOnce(() => new Promise<CommentResponse>((resolve) => { releaseB = resolve; }));
        const frameA = handler.handle(runRequest() as never, senderA);
        await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
        const frameB = handler.handle(runRequest() as never, senderB);
        await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
        releaseA({success: true, comments: [{content: 'A', translation: null}], sourceTranslation: null});
        expect(await frameA).toEqual({success: true, comments: [{content: 'A', translation: null}], sourceTranslation: null});
        expect(failure(await handler.handle({type: 'fluentReadComment', action: 'cancel', requestId: 'r1'} as never, senderB)).cancelled).toBe(true);
        releaseB({success: true, comments: [{content: 'B', translation: null}], sourceTranslation: null});
        expect(failure(await frameB).cancelled).toBe(true);
    });

    it('keeps the superseding request owned after the aborted one settles late', async () => {
        const handler = createCommentHandler(deps());
        let releaseStale!: (value: CommentResponse) => void;
        let releaseCurrent!: (value: CommentResponse) => void;
        run.mockImplementationOnce(() => new Promise<CommentResponse>((resolve) => { releaseStale = resolve; }))
            .mockImplementationOnce((_request, signal) => new Promise<CommentResponse>((resolve) => {
                releaseCurrent = resolve;
                signal.addEventListener('abort', () => resolve({success: false, error: '已取消', cancelled: true}), {once: true});
            }));
        const stale = handler.handle(runRequest({requestId: 'rA'}) as never, sender());
        await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
        const current = handler.handle(runRequest({requestId: 'rB'}) as never, sender());
        await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
        releaseStale({success: true, comments: [{content: '迟到的旧答案', translation: null}], sourceTranslation: null});
        expect(failure(await stale).cancelled).toBe(true);
        expect(failure(await handler.handle({type: 'fluentReadComment', action: 'cancel', requestId: 'rB'} as never, sender())).cancelled).toBe(true);
        releaseCurrent({success: true, comments: [{content: '不该出现', translation: null}], sourceTranslation: null});
        expect(failure(await current).cancelled).toBe(true);
    });
});
