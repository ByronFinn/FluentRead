import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {LanguageModel} from 'ai';
import type {Config} from '@/src/core/config/model';
import type {OffscreenClient} from '@/src/platform/offscreen/client';
import {
    createOffscreenHarnessLanguageModel,
    MODEL_CALL_SILENCE_TIMEOUT_MS,
    type OffscreenModelClientPorts,
} from '@/src/services/harness/offscreenModelClient';
import {
    MODEL_CALL_CANCEL_OFFSCREEN_MESSAGE_TYPE,
    MODEL_CALL_EVENT_MESSAGE_TYPE,
    MODEL_CALL_START_OFFSCREEN_MESSAGE_TYPE,
    type ModelCallEvent,
    type ModelCallOptions,
} from '@/src/services/harness/modelCallProtocol';

/** 与代理同形的 v3 具体模型视图，测试直接调用 doGenerate/doStream。 */
type V3Model = Extract<LanguageModel, {specificationVersion: 'v3'}>;

interface RecordedSend {
    message: {
        readonly type: string;
        readonly requestId: string;
        readonly [field: string]: unknown;
    };
    options: {
        signal?: AbortSignal;
        cancelMessage?: {readonly type: string; readonly requestId: string};
    };
    resolve: () => void;
    reject: (error: unknown) => void;
}

interface Harness {
    ports: OffscreenModelClientPorts;
    sends: RecordedSend[];
    subscribe: ReturnType<typeof vi.fn>;
    now: ReturnType<typeof vi.fn>;
    createModel(config?: Config, service?: string, model?: string): V3Model;
    /** 按协议事件消息形状派发到当前订阅 listener。 */
    dispatch(requestId: string, event: ModelCallEvent): void;
    /** 原样派发任意消息（验证非协议消息被忽略）。 */
    dispatchRaw(message: unknown): void;
    /** 时钟与定时器同步推进。 */
    advance(ms: number): void;
    advanceClock(ms: number): void;
    advanceTimers(ms: number): void;
}

/** 组装端口桩：send 记录参数并返回可编程 resolve/reject；subscribe 捕获 listener；时钟可控。 */
function createHarness(): Harness {
    const sends: RecordedSend[] = [];
    const send = vi.fn((message: RecordedSend['message'], options: RecordedSend['options']) =>
        new Promise<void>((resolve, reject) => {
            sends.push({message, options, resolve, reject});
        }));
    let listener: ((message: unknown) => void) | undefined;
    const subscribe = vi.fn((registered: (message: unknown) => void) => {
        listener = registered;
        return () => {
            listener = undefined;
        };
    });
    let clock = 0;
    const now = vi.fn(() => clock);
    const ports: OffscreenModelClientPorts = {
        getClient: () => ({send}) as unknown as Pick<OffscreenClient, 'send'>,
        subscribe,
        now,
    };
    return {
        ports,
        sends,
        subscribe,
        now,
        createModel(config = {} as Config, service = 'openai', model = 'gpt-test') {
            return createOffscreenHarnessLanguageModel(ports)(config, service, model) as V3Model;
        },
        dispatch(requestId, event) {
            this.dispatchRaw({type: MODEL_CALL_EVENT_MESSAGE_TYPE, requestId, event});
        },
        dispatchRaw(message) {
            listener?.(message);
        },
        advance(ms) {
            this.advanceClock(ms);
            this.advanceTimers(ms);
        },
        advanceClock(ms) {
            clock += ms;
        },
        advanceTimers(ms) {
            vi.advanceTimersByTime(ms);
        },
    };
}

function callOptions(signal?: AbortSignal): ModelCallOptions {
    return signal === undefined
        ? {prompt: [], temperature: 0.5}
        : {prompt: [], temperature: 0.5, abortSignal: signal};
}

/** 读尽流并捕获中途错误，用于断言分片顺序与终止形态。 */
async function readStream(stream: ReadableStream<unknown>): Promise<{parts: unknown[]; error?: unknown}> {
    const reader = stream.getReader();
    const parts: unknown[] = [];
    for (;;) {
        try {
            const {done, value} = await reader.read();
            if (done) return {parts};
            parts.push(value);
        } catch (error) {
            return {parts, error};
        }
    }
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('offscreen model proxy doGenerate', () => {
    it('exposes v3 metadata with an offscreen proxy identity without opening a channel', () => {
        const harness = createHarness();
        const model = harness.createModel({} as Config, 'deepseek', 'deepseek-chat');

        expect(model.specificationVersion).toBe('v3');
        expect(model.provider).toBe('fluentread-harness-offscreen-deepseek');
        expect(model.modelId).toBe('deepseek-chat');
        expect(model.supportedUrls).toEqual({});
        expect(harness.subscribe).not.toHaveBeenCalled();
        expect(harness.sends).toHaveLength(0);
    });

    it('sends a fully populated start message and resolves with the executor result', async () => {
        const harness = createHarness();
        const config = {} as Config;
        const model = harness.createModel(config);
        const controller = new AbortController();
        const result = {content: [], warnings: [], finishReason: 'stop', usage: {inputTokens: 1, outputTokens: 2}};

        const pending = model.doGenerate(callOptions(controller.signal));
        expect(harness.sends).toHaveLength(1);
        const recorded = harness.sends[0];
        expect(recorded.message.type).toBe(MODEL_CALL_START_OFFSCREEN_MESSAGE_TYPE);
        expect(recorded.message.target).toBe('offscreen');
        expect(recorded.message.requestId).toMatch(/^model-call-/u);
        expect(recorded.message.service).toBe('openai');
        expect(recorded.message.model).toBe('gpt-test');
        expect(recorded.message.kind).toBe('generate');
        expect(recorded.message.config).toBe(config);
        const recordedOptions = recorded.message.options as Record<string, unknown>;
        expect(recordedOptions).toEqual({prompt: [], temperature: 0.5});
        expect('abortSignal' in recordedOptions).toBe(false);
        expect(recorded.options.signal).toBe(controller.signal);
        expect(recorded.options.cancelMessage).toEqual({
            type: MODEL_CALL_CANCEL_OFFSCREEN_MESSAGE_TYPE,
            target: 'offscreen',
            requestId: recorded.message.requestId,
        });

        recorded.resolve();
        harness.dispatch(recorded.message.requestId, {kind: 'result', result});
        await expect(pending).resolves.toBe(result);
    });

    it('rebuilds a JSON-serialized response timestamp when landing the result event', async () => {
        const harness = createHarness();
        const model = harness.createModel();
        const pending = model.doGenerate(callOptions());
        harness.sends[0].resolve();
        // 模拟通道 JSON 化：结果契约里的 response.timestamp 已退化为 ISO 字符串。
        harness.dispatch(harness.sends[0].message.requestId, {
            kind: 'result',
            result: {
                content: [],
                finishReason: {unified: 'stop'},
                usage: {inputTokens: {total: 1}, outputTokens: {total: 2}},
                response: {id: 'resp-1', timestamp: '2026-10-08T12:00:00.000Z', modelId: 'gpt-test'},
            },
        });
        const resolved = await pending;
        const response = resolved.response as {id?: string; timestamp: Date; modelId?: string};
        expect(response.timestamp).toBeInstanceOf(Date);
        expect(response.timestamp.toISOString()).toBe('2026-10-08T12:00:00.000Z');
    });

    it('rejects with a restored plain error event', async () => {
        const harness = createHarness();
        const model = harness.createModel();
        const pending = model.doGenerate(callOptions());
        harness.sends[0].resolve();
        harness.dispatch(harness.sends[0].message.requestId, {kind: 'error', name: 'Error', message: '连接上游失败'});
        await expect(pending).rejects.toMatchObject({name: 'Error', message: '连接上游失败'});
    });

    it('keeps APICallError discriminant fields when restoring error events', async () => {
        const harness = createHarness();
        const model = harness.createModel();
        const pending = model.doGenerate(callOptions());
        harness.sends[0].resolve();
        harness.dispatch(harness.sends[0].message.requestId, {
            kind: 'error',
            name: 'AI_APICallError',
            message: 'rate limited',
            url: 'https://api.example.com/v1/chat/completions',
            statusCode: 429,
            responseBodyText: '{"error":{"message":"Too Many Requests"}}',
        });
        await expect(pending).rejects.toMatchObject({
            name: 'AI_APICallError',
            message: 'rate limited',
            url: 'https://api.example.com/v1/chat/completions',
            statusCode: 429,
            responseBody: '{"error":{"message":"Too Many Requests"}}',
        });
    });

    it('rejects immediately without sending when the signal is already aborted', async () => {
        const harness = createHarness();
        const model = harness.createModel();
        const controller = new AbortController();
        controller.abort();

        await expect(model.doGenerate(callOptions(controller.signal))).rejects.toMatchObject({
            name: 'AbortError',
            message: '模型调用已取消',
        });
        expect(harness.sends).toHaveLength(0);
        expect(harness.subscribe).not.toHaveBeenCalled();
    });

    it('rejects with a local AbortError on abort after acceptance and ignores late settlement', async () => {
        const harness = createHarness();
        const model = harness.createModel();
        const controller = new AbortController();
        const pending = model.doGenerate(callOptions(controller.signal));
        harness.sends[0].resolve();
        const settled = pending.then(() => 'fulfilled', (error: Error) => error);

        controller.abort();
        await expect(settled).resolves.toMatchObject({name: 'AbortError', message: '模型调用已取消'});
        // client 在 abort 时的拒绝与 executor 迟到的 result 都不再改变结局。
        harness.sends[0].reject(Object.assign(new Error('Offscreen 请求已取消'), {name: 'AbortError'}));
        harness.dispatch(harness.sends[0].message.requestId, {kind: 'result', result: 'late-result'});
        await Promise.resolve();
        await expect(settled).resolves.toMatchObject({name: 'AbortError', message: '模型调用已取消'});
    });

    it('rejects with a local AbortError on abort before acceptance and keeps cancelMessage in send options', async () => {
        const harness = createHarness();
        const model = harness.createModel();
        const controller = new AbortController();
        const pending = model.doGenerate(callOptions(controller.signal));

        expect(harness.sends[0].options.cancelMessage).toMatchObject({
            type: MODEL_CALL_CANCEL_OFFSCREEN_MESSAGE_TYPE,
            requestId: harness.sends[0].message.requestId,
        });
        const settled = pending.then(() => 'fulfilled', (error: Error) => error);
        controller.abort();
        await expect(settled).resolves.toMatchObject({name: 'AbortError', message: '模型调用已取消'});
        harness.sends[0].reject(Object.assign(new Error('Offscreen 请求已取消'), {name: 'AbortError'}));
        harness.dispatch(harness.sends[0].message.requestId, {kind: 'result', result: 'late-result'});
        await Promise.resolve();
        await expect(settled).resolves.toMatchObject({name: 'AbortError'});
    });

    it('rethrows a send rejection as-is', async () => {
        const harness = createHarness();
        const model = harness.createModel();
        const pending = model.doGenerate(callOptions());
        const failure = new Error('无法创建 Offscreen 文档：boom');

        harness.sends[0].reject(failure);
        await expect(pending).rejects.toBe(failure);
    });

    it('wraps non-Error send rejections', async () => {
        const harness = createHarness();
        const model = harness.createModel();
        const pending = model.doGenerate(callOptions());

        harness.sends[0].reject('raw failure');
        await expect(pending).rejects.toMatchObject({message: 'raw failure'});
    });

    it('times out after the silence window even though acceptance succeeded', async () => {
        const harness = createHarness();
        const model = harness.createModel();
        const pending = model.doGenerate(callOptions());
        harness.sends[0].resolve();

        harness.advance(MODEL_CALL_SILENCE_TIMEOUT_MS);
        await expect(pending).rejects.toMatchObject({name: 'TimeoutError', message: expect.stringContaining('90')});
        // 迟到的 result 事件在清理后被忽略。
        harness.dispatch(harness.sends[0].message.requestId, {kind: 'result', result: 'late'});
        await Promise.resolve();
    });

    it('times out when acceptance never settles', async () => {
        const harness = createHarness();
        const model = harness.createModel();
        const pending = model.doGenerate(callOptions());

        harness.advance(MODEL_CALL_SILENCE_TIMEOUT_MS);
        await expect(pending).rejects.toMatchObject({name: 'TimeoutError'});
        // 迟到的受理被忽略，不再产生副作用。
        harness.sends[0].resolve();
        await Promise.resolve();
    });

    it('keeps the call alive across heartbeat windows and still resolves', async () => {
        const harness = createHarness();
        const model = harness.createModel();
        const pending = model.doGenerate(callOptions());
        harness.sends[0].resolve();
        const requestId = harness.sends[0].message.requestId;

        harness.advance(80_000);
        harness.dispatch(requestId, {kind: 'heartbeat'});
        harness.advance(80_000);
        harness.dispatch(requestId, {kind: 'heartbeat'});
        harness.advance(89_999);
        harness.dispatch(requestId, {kind: 'result', result: 'still-alive'});

        await expect(pending).resolves.toBe('still-alive');
    });

    it('times out after heartbeats stop arriving', async () => {
        const harness = createHarness();
        const model = harness.createModel();
        const pending = model.doGenerate(callOptions());
        harness.sends[0].resolve();
        const requestId = harness.sends[0].message.requestId;
        const settled = pending.then(() => 'fulfilled', (error: Error) => error);

        harness.advance(80_000);
        harness.dispatch(requestId, {kind: 'heartbeat'});
        harness.advance(90_000);

        await expect(settled).resolves.toMatchObject({name: 'TimeoutError'});
        harness.dispatch(requestId, {kind: 'result', result: 'late'});
        await Promise.resolve();
        await expect(settled).resolves.toMatchObject({name: 'TimeoutError'});
    });

    it('re-arms the silence timer on clock drift instead of failing early', async () => {
        const harness = createHarness();
        const model = harness.createModel();
        const pending = model.doGenerate(callOptions());
        harness.sends[0].resolve();
        let settled: unknown = 'unset';
        pending.then(() => {
            settled = 'fulfilled';
        }, (error: unknown) => {
            settled = error;
        });

        // 定时器到点但注入时钟只走了 50s：按剩余时长补挂，不能立刻判死。
        harness.advanceClock(50_000);
        harness.advanceTimers(MODEL_CALL_SILENCE_TIMEOUT_MS);
        await Promise.resolve();
        await Promise.resolve();
        expect(settled).toBe('unset');

        harness.advanceClock(40_000);
        harness.advanceTimers(40_000);
        await expect(pending).rejects.toMatchObject({name: 'TimeoutError'});
    });

    it('ignores malformed, unrelated, unknown-requestId and mismatched-kind events', async () => {
        const harness = createHarness();
        const model = harness.createModel();
        const pending = model.doGenerate(callOptions());
        harness.sends[0].resolve();
        const requestId = harness.sends[0].message.requestId;

        harness.dispatchRaw(undefined);
        harness.dispatchRaw('fluentReadModelCallEvent');
        harness.dispatchRaw(42);
        harness.dispatchRaw({type: 'selectionTtsPlaybackState', requestId, event: {kind: 'result', result: 1}});
        harness.dispatchRaw({type: MODEL_CALL_EVENT_MESSAGE_TYPE, requestId: 123, event: {kind: 'result', result: 1}});
        harness.dispatchRaw({type: MODEL_CALL_EVENT_MESSAGE_TYPE, requestId, event: null});
        harness.dispatchRaw({type: MODEL_CALL_EVENT_MESSAGE_TYPE, requestId, event: {kind: 7}});
        harness.dispatchRaw({type: MODEL_CALL_EVENT_MESSAGE_TYPE, requestId: 'model-call-unknown', event: {kind: 'result', result: 1}});
        // part/end 与 generate 请求错配：忽略。
        harness.dispatch(requestId, {kind: 'part', part: {type: 'text-delta', id: 't1', delta: '你'}});
        harness.dispatch(requestId, {kind: 'end'});

        harness.dispatch(requestId, {kind: 'result', result: 'survives-noise'});
        await expect(pending).resolves.toBe('survives-noise');
    });
});

describe('offscreen model proxy doStream', () => {
    it('enqueues parts in order, closes on end and ignores heartbeat plus mismatched result', async () => {
        const harness = createHarness();
        const model = harness.createModel();
        const pending = model.doStream(callOptions());
        expect(harness.sends[0].message.kind).toBe('stream');
        harness.sends[0].resolve();
        const {stream} = await pending;
        const requestId = harness.sends[0].message.requestId;

        harness.dispatch(requestId, {kind: 'part', part: {type: 'stream-start', warnings: []}});
        harness.dispatch(requestId, {kind: 'heartbeat'});
        harness.dispatch(requestId, {kind: 'part', part: {type: 'text-delta', id: 't1', delta: '你'}});
        // result 与 stream 请求错配：忽略。
        harness.dispatch(requestId, {kind: 'result', result: {content: []}});
        harness.dispatch(requestId, {kind: 'part', part: {type: 'text-delta', id: 't1', delta: '好'}});
        harness.dispatch(requestId, {kind: 'end'});

        const received = await readStream(stream);
        expect(received.error).toBeUndefined();
        expect(received.parts).toEqual([
            {type: 'stream-start', warnings: []},
            {type: 'text-delta', id: 't1', delta: '你'},
            {type: 'text-delta', id: 't1', delta: '好'},
        ]);
    });

    it('rebuilds JSON-serialized response-metadata timestamps when landing stream parts', async () => {
        const harness = createHarness();
        const model = harness.createModel();
        const pending = model.doStream(callOptions());
        harness.sends[0].resolve();
        const {stream} = await pending;
        const requestId = harness.sends[0].message.requestId;

        harness.dispatch(requestId, {kind: 'part', part: {type: 'text-delta', id: 't1', delta: '你'}});
        // 模拟通道 JSON 化：response-metadata 的 Date 已退化为 ISO 字符串。
        harness.dispatch(requestId, {
            kind: 'part',
            part: {type: 'response-metadata', timestamp: '2026-10-08T08:30:00.000Z', modelId: 'gpt-test'},
        });
        harness.dispatch(requestId, {kind: 'end'});

        const received = await readStream(stream);
        expect(received.parts[1]).toMatchObject({type: 'response-metadata', modelId: 'gpt-test'});
        expect((received.parts[1] as {timestamp: Date}).timestamp).toBeInstanceOf(Date);
        expect((received.parts[1] as {timestamp: Date}).timestamp.toISOString()).toBe('2026-10-08T08:30:00.000Z');
    });

    it('errors the stream after delivered parts when an error event arrives', async () => {
        const harness = createHarness();
        const model = harness.createModel();
        const pending = model.doStream(callOptions());
        harness.sends[0].resolve();
        const {stream} = await pending;
        const requestId = harness.sends[0].message.requestId;

        const reader = stream.getReader();
        harness.dispatch(requestId, {kind: 'part', part: 'p1'});
        await expect(reader.read()).resolves.toMatchObject({done: false, value: 'p1'});
        harness.dispatch(requestId, {
            kind: 'error',
            name: 'AI_APICallError',
            message: 'upstream broke',
            url: 'https://api.example.com/v1',
            statusCode: 500,
            responseBodyText: '{"e":1}',
        });
        // controller.error 会丢弃未读分片（streams 规范），已读出的分片不受影响。
        await expect(reader.read()).rejects.toMatchObject({
            name: 'AI_APICallError',
            message: 'upstream broke',
            url: 'https://api.example.com/v1',
            statusCode: 500,
            responseBody: '{"e":1}',
        });
    });

    it('rejects the outer promise when an error event races ahead of acceptance', async () => {
        const harness = createHarness();
        const model = harness.createModel();
        const pending = model.doStream(callOptions());
        const requestId = harness.sends[0].message.requestId;

        harness.dispatch(requestId, {kind: 'error', name: 'Error', message: 'early failure'});
        await expect(pending).rejects.toMatchObject({name: 'Error', message: 'early failure'});
        // 迟到的受理被忽略。
        harness.sends[0].resolve();
        await Promise.resolve();
    });

    it('resolves with a closed stream when end races ahead of acceptance', async () => {
        const harness = createHarness();
        const model = harness.createModel();
        const pending = model.doStream(callOptions());
        const requestId = harness.sends[0].message.requestId;

        harness.dispatch(requestId, {kind: 'part', part: 'buffered-part'});
        harness.dispatch(requestId, {kind: 'end'});
        const {stream} = await pending;
        harness.sends[0].resolve();
        await Promise.resolve();

        const received = await readStream(stream);
        expect(received.error).toBeUndefined();
        expect(received.parts).toEqual(['buffered-part']);
    });

    it('aborts mid-stream with AbortError on the stream while keeping delivered parts', async () => {
        const harness = createHarness();
        const model = harness.createModel();
        const controller = new AbortController();
        const pending = model.doStream(callOptions(controller.signal));
        expect(harness.sends[0].options.cancelMessage).toMatchObject({
            type: MODEL_CALL_CANCEL_OFFSCREEN_MESSAGE_TYPE,
            requestId: harness.sends[0].message.requestId,
        });
        harness.sends[0].resolve();
        const {stream} = await pending;
        const requestId = harness.sends[0].message.requestId;

        const reader = stream.getReader();
        harness.dispatch(requestId, {kind: 'part', part: 'p1'});
        await expect(reader.read()).resolves.toMatchObject({done: false, value: 'p1'});
        controller.abort();
        await expect(reader.read()).rejects.toMatchObject({name: 'AbortError', message: '模型调用已取消'});
        harness.sends[0].reject(Object.assign(new Error('Offscreen 请求已取消'), {name: 'AbortError'}));
        await Promise.resolve();
    });

    it('rejects the outer promise when aborted before acceptance', async () => {
        const harness = createHarness();
        const model = harness.createModel();
        const controller = new AbortController();
        const pending = model.doStream(callOptions(controller.signal));
        const settled = pending.then(() => 'fulfilled', (error: Error) => error);

        controller.abort();
        await expect(settled).resolves.toMatchObject({name: 'AbortError', message: '模型调用已取消'});
        harness.sends[0].reject(Object.assign(new Error('Offscreen 请求已取消'), {name: 'AbortError'}));
        harness.dispatch(harness.sends[0].message.requestId, {kind: 'end'});
        await Promise.resolve();
        await expect(settled).resolves.toMatchObject({name: 'AbortError'});
    });

    it('times out mid-stream with TimeoutError on the stream', async () => {
        const harness = createHarness();
        const model = harness.createModel();
        const pending = model.doStream(callOptions());
        harness.sends[0].resolve();
        const {stream} = await pending;
        const reader = stream.getReader();
        harness.dispatch(harness.sends[0].message.requestId, {kind: 'part', part: 'p1'});
        await expect(reader.read()).resolves.toMatchObject({done: false, value: 'p1'});

        harness.advance(MODEL_CALL_SILENCE_TIMEOUT_MS);
        await expect(reader.read()).rejects.toMatchObject({name: 'TimeoutError'});
    });

    it('rethrows a send rejection on the outer promise', async () => {
        const harness = createHarness();
        const model = harness.createModel();
        const pending = model.doStream(callOptions());
        const failure = new Error('无法创建 Offscreen 文档：准备失败');

        harness.sends[0].reject(failure);
        await expect(pending).rejects.toBe(failure);
    });

    it('rejects immediately without sending when the signal is already aborted', async () => {
        const harness = createHarness();
        const model = harness.createModel();
        const controller = new AbortController();
        controller.abort();

        await expect(model.doStream(callOptions(controller.signal))).rejects.toMatchObject({name: 'AbortError'});
        expect(harness.sends).toHaveLength(0);
        expect(harness.subscribe).not.toHaveBeenCalled();
    });
});

describe('offscreen model proxy subscription and concurrency', () => {
    it('subscribes once per ports, isolates concurrent calls and leaves no stale handlers', async () => {
        const harness = createHarness();
        const modelGenerate = harness.createModel({} as Config, 'openai', 'gpt-a');
        const modelStream = harness.createModel({} as Config, 'deepseek', 'gpt-b');

        const pendingGenerate = modelGenerate.doGenerate(callOptions());
        const pendingStream = modelStream.doStream(callOptions());

        expect(harness.subscribe).toHaveBeenCalledTimes(1);
        expect(harness.sends).toHaveLength(2);
        const requestIdGenerate = harness.sends[0].message.requestId;
        const requestIdStream = harness.sends[1].message.requestId;
        expect(requestIdGenerate).not.toBe(requestIdStream);
        expect(requestIdGenerate).toMatch(/^model-call-/u);
        expect(requestIdStream).toMatch(/^model-call-/u);

        harness.sends[1].resolve();
        const {stream} = await pendingStream;
        // 对 generate 调用派发 part（错配忽略）与心跳，不影响 stream。
        harness.dispatch(requestIdGenerate, {kind: 'part', part: 'noise-for-generate'});
        harness.dispatch(requestIdStream, {kind: 'part', part: 'b1'});
        harness.dispatch(requestIdGenerate, {kind: 'result', result: 'A-result'});
        await expect(pendingGenerate).resolves.toBe('A-result');
        harness.dispatch(requestIdStream, {kind: 'end'});
        const received = await readStream(stream);
        expect(received.parts).toEqual(['b1']);

        // 清理后旧 requestId 与未知 requestId 的事件不再有副作用，也不抛错。
        expect(() => {
            harness.dispatch(requestIdGenerate, {kind: 'result', result: 'stale'});
            harness.dispatch(requestIdStream, {kind: 'error', name: 'Error', message: 'stale'});
            harness.dispatch('model-call-unknown', {kind: 'result', result: 'noise'});
        }).not.toThrow();
        expect(harness.subscribe).toHaveBeenCalledTimes(1);
    });
});
