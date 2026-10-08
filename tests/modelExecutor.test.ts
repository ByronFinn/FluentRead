import {describe, expect, it, vi} from 'vitest';
import type {LanguageModel} from 'ai';
import type {Config} from '@/src/core/config/model';
import {createModelExecutor, type ModelExecutorPorts} from '@/src/services/harness/modelExecutor';
import {
    MODEL_CALL_HEARTBEAT_INTERVAL_MS,
    MODEL_CALL_START_OFFSCREEN_MESSAGE_TYPE,
    type ModelCallEvent,
    type ModelCallOptions,
    type ModelCallStartMessage,
} from '@/src/services/harness/modelCallProtocol';

type FakeCallOptions = ModelCallOptions & {abortSignal: AbortSignal};

interface ModelStub {
    doGenerate: ReturnType<typeof vi.fn>;
    doStream: ReturnType<typeof vi.fn>;
}

function asModel(stub: ModelStub): LanguageModel {
    return {
        specificationVersion: 'v3',
        provider: 'fluentread-test',
        modelId: 'test-model',
        supportedUrls: {},
        doGenerate: stub.doGenerate,
        doStream: stub.doStream,
    } as unknown as LanguageModel;
}

function startRequest(overrides: Partial<ModelCallStartMessage> = {}): ModelCallStartMessage {
    return {
        type: MODEL_CALL_START_OFFSCREEN_MESSAGE_TYPE,
        requestId: 'model-call-req-1',
        service: 'openai',
        model: 'gpt-test',
        kind: 'generate',
        config: {} as Config,
        options: {prompt: [], temperature: 0.5},
        ...overrides,
    };
}

interface Harness {
    ports: ModelExecutorPorts;
    events: ModelCallEvent[];
    eventRequestIds: string[];
    createModel: ReturnType<typeof vi.fn>;
    startHeartbeat: ReturnType<typeof vi.fn>;
    stopHeartbeat: ReturnType<typeof vi.fn>;
    emitEvent: ReturnType<typeof vi.fn>;
}

/** 组装端口桩：默认注入成功的 doGenerate 模型，事件按到达顺序记录。 */
function createHarness(model: LanguageModel | Error, options: Partial<Pick<Harness, 'emitEvent' | 'startHeartbeat'>> = {}): Harness {
    const events: ModelCallEvent[] = [];
    const eventRequestIds: string[] = [];
    const stopHeartbeat = vi.fn();
    const createModel = vi.fn(() => {
        if (model instanceof Error) throw model;
        return model;
    });
    const emitEvent = options.emitEvent ?? vi.fn((requestId: string, event: ModelCallEvent) => {
        eventRequestIds.push(requestId);
        events.push(event);
    });
    const startHeartbeat = options.startHeartbeat ?? vi.fn(() => stopHeartbeat);
    return {
        ports: {createModel, emitEvent, startHeartbeat},
        events,
        eventRequestIds,
        createModel,
        startHeartbeat,
        stopHeartbeat,
        emitEvent,
    };
}

describe('model executor generate', () => {
    it('emits result, passes options with abortSignal and cleans up registration and heartbeat', async () => {
        const result = {content: [], warnings: []};
        const stub: ModelStub = {doGenerate: vi.fn(async () => result), doStream: vi.fn()};
        const harness = createHarness(asModel(stub));
        const executor = createModelExecutor(harness.ports);
        const request = startRequest();

        await executor.runGenerate(request);

        expect(harness.events).toEqual([{kind: 'result', result}]);
        expect(harness.eventRequestIds).toEqual([request.requestId]);
        expect(stub.doGenerate).toHaveBeenCalledTimes(1);
        const callOptions = stub.doGenerate.mock.calls[0][0] as FakeCallOptions;
        expect(callOptions.temperature).toBe(0.5);
        expect(callOptions.abortSignal).toBeInstanceOf(AbortSignal);
        expect(harness.createModel).toHaveBeenCalledWith(request.config, 'openai', 'gpt-test');
        expect(harness.startHeartbeat).toHaveBeenCalledWith(request.requestId, MODEL_CALL_HEARTBEAT_INTERVAL_MS);
        expect(harness.stopHeartbeat).toHaveBeenCalledTimes(1);

        // 登记已清理：同 requestId 再次受理会真正执行第二次调用。
        await executor.runGenerate(request);
        expect(stub.doGenerate).toHaveBeenCalledTimes(2);
        expect(harness.stopHeartbeat).toHaveBeenCalledTimes(2);
    });

    it('reports model construction failure as an error event and still stops the heartbeat', async () => {
        const harness = createHarness(new Error('请先为阅读助手选择一个模型'));
        const executor = createModelExecutor(harness.ports);

        await expect(executor.runGenerate(startRequest())).resolves.toBeUndefined();

        expect(harness.events).toEqual([{kind: 'error', name: 'Error', message: '请先为阅读助手选择一个模型'}]);
        expect(harness.startHeartbeat).toHaveBeenCalledTimes(1);
        expect(harness.stopHeartbeat).toHaveBeenCalledTimes(1);
    });

    it('keeps APICallError discriminant fields when doGenerate fails', async () => {
        const stub: ModelStub = {
            doGenerate: vi.fn(async () => {
                throw Object.assign(new Error('rate limited'), {
                    name: 'AI_APICallError',
                    url: 'https://api.example.com/v1/chat/completions',
                    statusCode: 429,
                    responseBody: '{"error":{"message":"Too Many Requests"}}',
                });
            }),
            doStream: vi.fn(),
        };
        const harness = createHarness(asModel(stub));
        const executor = createModelExecutor(harness.ports);

        await executor.runGenerate(startRequest());

        expect(harness.events).toEqual([{
            kind: 'error',
            name: 'AI_APICallError',
            message: 'rate limited',
            url: 'https://api.example.com/v1/chat/completions',
            statusCode: 429,
            responseBodyText: '{"error":{"message":"Too Many Requests"}}',
        }]);
        expect(harness.stopHeartbeat).toHaveBeenCalledTimes(1);
    });

    it('reports a locally cancelled call as a normalized AbortError', async () => {
        let rejectGenerate!: (error: unknown) => void;
        const stub: ModelStub = {
            doGenerate: vi.fn(() => new Promise((_resolve, reject) => {
                rejectGenerate = reject;
            })),
            doStream: vi.fn(),
        };
        const harness = createHarness(asModel(stub));
        const executor = createModelExecutor(harness.ports);
        const request = startRequest();

        const pending = executor.runGenerate(request);
        expect((stub.doGenerate.mock.calls[0][0] as FakeCallOptions).abortSignal.aborted).toBe(false);
        executor.cancel(request.requestId);
        expect((stub.doGenerate.mock.calls[0][0] as FakeCallOptions).abortSignal.aborted).toBe(true);
        rejectGenerate(Object.assign(new Error('用户已取消'), {name: 'AbortError'}));
        await pending;

        expect(harness.events).toEqual([{kind: 'error', name: 'AbortError', message: '用户已取消'}]);
        expect(harness.stopHeartbeat).toHaveBeenCalledTimes(1);
    });

    it('preserves provider AbortErrors untouched when the call was not cancelled locally', async () => {
        const stub: ModelStub = {
            doGenerate: vi.fn(async () => {
                // AI SDK 内部总超时同样表现为 AbortError，normalizeAiSdkError 需要原始信息。
                throw Object.assign(new Error('internal timeout'), {name: 'AbortError'});
            }),
            doStream: vi.fn(),
        };
        const harness = createHarness(asModel(stub));
        const executor = createModelExecutor(harness.ports);

        await executor.runGenerate(startRequest());

        expect(harness.events).toEqual([{kind: 'error', name: 'AbortError', message: 'internal timeout'}]);
    });

    it('stringifies non-Error rejections when reporting a cancelled call', async () => {
        let rejectGenerate!: (error: unknown) => void;
        const stub: ModelStub = {
            doGenerate: vi.fn(() => new Promise((_resolve, reject) => {
                rejectGenerate = reject;
            })),
            doStream: vi.fn(),
        };
        const harness = createHarness(asModel(stub));
        const executor = createModelExecutor(harness.ports);
        const request = startRequest();

        const pending = executor.runGenerate(request);
        executor.cancel(request.requestId);
        rejectGenerate('raw failure');
        await pending;

        expect(harness.events).toEqual([{kind: 'error', name: 'AbortError', message: 'raw failure'}]);
    });
});

describe('model executor stream', () => {
    it('forwards parts in order, ignores telemetry fields and ends the stream', async () => {
        const stub: ModelStub = {
            doGenerate: vi.fn(),
            doStream: vi.fn(async () => ({
                stream: new ReadableStream({
                    start(controller) {
                        controller.enqueue({type: 'stream-start', warnings: []});
                        controller.enqueue({type: 'text-delta', id: 't1', delta: '你'});
                        controller.enqueue({type: 'text-delta', id: 't1', delta: '好'});
                        controller.close();
                    },
                }),
                // v3 StreamResult 的其余字段是 request/response 遥测，协议选择忽略。
                request: {body: '{"model":"gpt-test"}'},
                response: {headers: {'x-request-id': 'abc'}},
            })),
        };
        const harness = createHarness(asModel(stub));
        const executor = createModelExecutor(harness.ports);
        const request = startRequest({kind: 'stream'});

        await executor.runStream(request);

        expect(harness.events).toEqual([
            {kind: 'part', part: {type: 'stream-start', warnings: []}},
            {kind: 'part', part: {type: 'text-delta', id: 't1', delta: '你'}},
            {kind: 'part', part: {type: 'text-delta', id: 't1', delta: '好'}},
            {kind: 'end'},
        ]);
        const callOptions = stub.doStream.mock.calls[0][0] as FakeCallOptions;
        expect(callOptions.temperature).toBe(0.5);
        expect(callOptions.abortSignal).toBeInstanceOf(AbortSignal);
        expect(harness.stopHeartbeat).toHaveBeenCalledTimes(1);
    });

    it('emits only an error event when doStream itself rejects', async () => {
        const stub: ModelStub = {
            doGenerate: vi.fn(),
            doStream: vi.fn(async () => {
                throw new Error('连接上游失败');
            }),
        };
        const harness = createHarness(asModel(stub));
        const executor = createModelExecutor(harness.ports);

        await expect(executor.runStream(startRequest({kind: 'stream'}))).resolves.toBeUndefined();

        expect(harness.events).toEqual([{kind: 'error', name: 'Error', message: '连接上游失败'}]);
        expect(harness.stopHeartbeat).toHaveBeenCalledTimes(1);
    });

    it('reports a mid-stream failure without emitting end', async () => {
        const stub: ModelStub = {
            doGenerate: vi.fn(),
            doStream: vi.fn(async () => ({
                stream: new ReadableStream({
                    // 先交付首片再异步中断：controller.error 会丢弃仍排队中的分片，
                    // 同步 enqueue+error 无法模拟"中途"失败。
                    async start(controller) {
                        controller.enqueue({type: 'text-delta', id: 't1', delta: '你'});
                        await new Promise((resolve) => setTimeout(resolve, 0));
                        controller.error(new Error('upstream broke'));
                    },
                }),
            })),
        };
        const harness = createHarness(asModel(stub));
        const executor = createModelExecutor(harness.ports);

        await executor.runStream(startRequest({kind: 'stream'}));

        expect(harness.events).toEqual([
            {kind: 'part', part: {type: 'text-delta', id: 't1', delta: '你'}},
            {kind: 'error', name: 'Error', message: 'upstream broke'},
        ]);
        expect(harness.stopHeartbeat).toHaveBeenCalledTimes(1);
    });

    it('propagates cancel into the stream abort signal and reports AbortError', async () => {
        const stub: ModelStub = {
            doGenerate: vi.fn(),
            doStream: vi.fn((options: FakeCallOptions) => ({
                stream: new ReadableStream({
                    start(controller) {
                        options.abortSignal.addEventListener('abort', () => {
                            controller.error(Object.assign(new Error('流已取消'), {name: 'AbortError'}));
                        });
                    },
                }),
            })),
        };
        const harness = createHarness(asModel(stub));
        const executor = createModelExecutor(harness.ports);
        const request = startRequest({kind: 'stream'});

        const pending = executor.runStream(request);
        expect((stub.doStream.mock.calls[0][0] as FakeCallOptions).abortSignal.aborted).toBe(false);
        executor.cancel(request.requestId);
        await pending;

        expect(harness.events).toEqual([{kind: 'error', name: 'AbortError', message: '流已取消'}]);
        expect(harness.stopHeartbeat).toHaveBeenCalledTimes(1);
    });
});

describe('model executor idempotency and port failures', () => {
    it('ignores replayed start messages for an active requestId without double billing', async () => {
        let resolveGenerate!: (value: unknown) => void;
        const stub: ModelStub = {
            doGenerate: vi.fn(() => new Promise((resolve) => {
                resolveGenerate = resolve;
            })),
            doStream: vi.fn(),
        };
        const harness = createHarness(asModel(stub));
        const executor = createModelExecutor(harness.ports);
        const request = startRequest();

        const pending = executor.runGenerate(request);
        await expect(executor.runGenerate(request)).resolves.toBeUndefined();
        await expect(executor.runStream({...request, kind: 'stream'})).resolves.toBeUndefined();

        resolveGenerate({content: [], warnings: []});
        await pending;

        expect(harness.createModel).toHaveBeenCalledTimes(1);
        expect(stub.doGenerate).toHaveBeenCalledTimes(1);
        expect(stub.doStream).not.toHaveBeenCalled();
        expect(harness.events).toEqual([{kind: 'result', result: {content: [], warnings: []}}]);
    });

    it('swallows emit failures so execution still finishes and the heartbeat stops', async () => {
        const stub: ModelStub = {
            doGenerate: vi.fn(async () => ({content: [], warnings: []})),
            doStream: vi.fn(async () => ({
                stream: new ReadableStream({
                    start(controller) {
                        controller.enqueue({type: 'text-delta', id: 't1', delta: '你'});
                        controller.close();
                    },
                }),
            })),
        };
        const emitEvent = vi.fn(() => {
            throw new Error('Receiving end does not exist');
        });
        const harness = createHarness(asModel(stub), {emitEvent});
        const executor = createModelExecutor(harness.ports);

        await expect(executor.runGenerate(startRequest())).resolves.toBeUndefined();
        await expect(executor.runStream(startRequest({kind: 'stream', requestId: 'model-call-req-2'}))).resolves.toBeUndefined();

        expect(emitEvent).toHaveBeenCalledTimes(3);
        expect(harness.stopHeartbeat).toHaveBeenCalledTimes(2);
    });

    it('tolerates a broken heartbeat port without interrupting the call', async () => {
        const stub: ModelStub = {doGenerate: vi.fn(async () => 'result-payload'), doStream: vi.fn()};
        const startHeartbeat = vi.fn(() => {
            throw new Error('no timer available');
        });
        const harness = createHarness(asModel(stub), {startHeartbeat});
        const executor = createModelExecutor(harness.ports);

        await executor.runGenerate(startRequest());

        expect(harness.events).toEqual([{kind: 'result', result: 'result-payload'}]);
        expect(harness.stopHeartbeat).not.toHaveBeenCalled();
    });

    it('ignores cancellation of an unknown requestId', () => {
        const stub: ModelStub = {doGenerate: vi.fn(), doStream: vi.fn()};
        const harness = createHarness(asModel(stub));
        const executor = createModelExecutor(harness.ports);

        expect(() => executor.cancel('model-call-missing')).not.toThrow();
        expect(harness.createModel).not.toHaveBeenCalled();
    });
});
