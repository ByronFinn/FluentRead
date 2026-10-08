/**
 * @file tests/modelExecutorHost.test.ts
 * 文件职责：验证 Offscreen 模型执行宿主的装配——直连工厂、事件推送与心跳定时器端口
 * 如何接到 modelExecutor，以及 start/cancel 面向 messageRouter 的受理语义。
 * 主要内容：fake createModel/emitEvent 注入下按 kind 分派 generate/stream、取消传导、
 * setInterval 心跳按协议常量起止、默认 emitEvent 经 chrome.runtime.sendMessage 推送
 * 'fluentReadModelCallEvent' 并吞掉管道异常。
 * 模块边界：只测宿主装配与端口传导，不重复覆盖执行器内部语义
 * （tests/modelExecutor.test.ts 已覆盖），不创建真实 provider、不访问网络；
 * start 的 void+catch 是防御执行器契约被破坏的双保险，真实执行器不会 reject，
 * 因此该防御分支只以注释说明，不做白盒注入。
 */
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {LanguageModel} from 'ai';
import type {Config} from '@/src/core/config/model';
import {createModelExecutorHost} from '@/src/app/offscreen/modelExecutorHost';
import {
    MODEL_CALL_EVENT_MESSAGE_TYPE,
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
        provider: 'fluentread-host-test',
        modelId: 'host-test-model',
        supportedUrls: {},
        doGenerate: stub.doGenerate,
        doStream: stub.doStream,
    } as unknown as LanguageModel;
}

function startRequest(overrides: Partial<ModelCallStartMessage> = {}): ModelCallStartMessage {
    return {
        type: MODEL_CALL_START_OFFSCREEN_MESSAGE_TYPE,
        requestId: 'host-req-1',
        service: 'openai',
        model: 'gpt-test',
        kind: 'generate',
        config: {} as Config,
        options: {prompt: [], temperature: 0.2},
        ...overrides,
    };
}

/** 记录事件与 requestId 的注入式 emitEvent，同时充当分派断言的观察点。 */
function recordingEmit(): {emitEvent: ReturnType<typeof vi.fn>; events: ModelCallEvent[]; requestIds: string[]} {
    const events: ModelCallEvent[] = [];
    const requestIds: string[] = [];
    const emitEvent = vi.fn((requestId: string, event: ModelCallEvent) => {
        requestIds.push(requestId);
        events.push(event);
    });
    return {emitEvent, events, requestIds};
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('model executor host 装配与分派', () => {
    it('start 按 kind=generate 分派，把注入的直连工厂与请求参数传导给执行器', async () => {
        const result = {content: [], warnings: []};
        const stub: ModelStub = {doGenerate: vi.fn(async () => result), doStream: vi.fn()};
        const createModel = vi.fn(() => asModel(stub));
        const recorder = recordingEmit();
        const host = createModelExecutorHost({createModel, emitEvent: recorder.emitEvent});
        const request = startRequest();

        host.start(request);
        await vi.waitFor(() => expect(recorder.events).toEqual([{kind: 'result', result}]));

        expect(createModel).toHaveBeenCalledOnce();
        expect(createModel).toHaveBeenCalledWith(request.config, 'openai', 'gpt-test');
        expect(stub.doGenerate).toHaveBeenCalledOnce();
        expect(stub.doStream).not.toHaveBeenCalled();
        expect(recorder.requestIds).toEqual([request.requestId]);
        const callOptions = stub.doGenerate.mock.calls[0][0] as FakeCallOptions;
        expect(callOptions.temperature).toBe(0.2);
        expect(callOptions.abortSignal).toBeInstanceOf(AbortSignal);
    });

    it('start 按 kind=stream 分派并按到达顺序转发分片', async () => {
        const stub: ModelStub = {
            doGenerate: vi.fn(),
            doStream: vi.fn(async () => ({
                stream: new ReadableStream({
                    start(controller) {
                        controller.enqueue({type: 'text-delta', id: 't1', delta: '你'});
                        controller.close();
                    },
                }),
            })),
        };
        const createModel = vi.fn(() => asModel(stub));
        const recorder = recordingEmit();
        const host = createModelExecutorHost({createModel, emitEvent: recorder.emitEvent});

        host.start(startRequest({kind: 'stream'}));
        await vi.waitFor(() => expect(recorder.events).toEqual([
            {kind: 'part', part: {type: 'text-delta', id: 't1', delta: '你'}},
            {kind: 'end'},
        ]));

        expect(stub.doStream).toHaveBeenCalledOnce();
        expect(stub.doGenerate).not.toHaveBeenCalled();
    });

    it('cancel 传导给执行器触发本地 abort，未知 requestId 安全忽略', async () => {
        let rejectGenerate!: (error: unknown) => void;
        const stub: ModelStub = {
            doGenerate: vi.fn(() => new Promise((_resolve, reject) => {
                rejectGenerate = reject;
            })),
            doStream: vi.fn(),
        };
        const recorder = recordingEmit();
        const host = createModelExecutorHost({createModel: vi.fn(() => asModel(stub)), emitEvent: recorder.emitEvent});
        const request = startRequest();

        host.start(request);
        const signal = (stub.doGenerate.mock.calls[0][0] as FakeCallOptions).abortSignal;
        expect(signal.aborted).toBe(false);

        expect(() => host.cancel('host-missing')).not.toThrow();
        expect(signal.aborted).toBe(false);

        host.cancel(request.requestId);
        expect(signal.aborted).toBe(true);
        rejectGenerate(Object.assign(new Error('用户已取消'), {name: 'AbortError'}));
        await vi.waitFor(() => expect(recorder.events).toEqual([
            {kind: 'error', name: 'AbortError', message: '用户已取消'},
        ]));
    });
});

describe('model executor host 心跳端口', () => {
    it('按协议常量间隔发送心跳，调用结束后停止定时器', async () => {
        vi.useFakeTimers();
        let resolveGenerate!: (value: unknown) => void;
        const stub: ModelStub = {
            doGenerate: vi.fn(() => new Promise((resolve) => {
                resolveGenerate = resolve;
            })),
            doStream: vi.fn(),
        };
        const recorder = recordingEmit();
        const host = createModelExecutorHost({createModel: vi.fn(() => asModel(stub)), emitEvent: recorder.emitEvent});
        const request = startRequest();

        host.start(request);
        expect(stub.doGenerate).toHaveBeenCalledOnce();

        const heartbeats = () => recorder.events.filter((event) => event.kind === 'heartbeat');
        vi.advanceTimersByTime(MODEL_CALL_HEARTBEAT_INTERVAL_MS - 1);
        expect(heartbeats()).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(heartbeats()).toEqual([{kind: 'heartbeat'}]);
        expect(recorder.requestIds.every((requestId) => requestId === request.requestId)).toBe(true);
        vi.advanceTimersByTime(MODEL_CALL_HEARTBEAT_INTERVAL_MS * 2);
        expect(heartbeats()).toEqual([{kind: 'heartbeat'}, {kind: 'heartbeat'}, {kind: 'heartbeat'}]);

        resolveGenerate({content: [], warnings: []});
        await Promise.resolve();
        await Promise.resolve();
        vi.advanceTimersByTime(MODEL_CALL_HEARTBEAT_INTERVAL_MS * 3);
        // 结束后停止函数已清除定时器，不再产生心跳或事件。
        expect(heartbeats()).toHaveLength(3);
        expect(recorder.events).toEqual([
            {kind: 'heartbeat'},
            {kind: 'heartbeat'},
            {kind: 'heartbeat'},
            {kind: 'result', result: {content: [], warnings: []}},
        ]);
    });
});

describe('model executor host 默认事件推送', () => {
    it('缺省 emitEvent 经 chrome.runtime.sendMessage 推送 fluentReadModelCallEvent 并读取 lastError', async () => {
        const sendMessage = vi.fn((_message: unknown, callback: () => void) => {
            callback();
        });
        vi.stubGlobal('chrome', {runtime: {sendMessage, lastError: undefined}});
        const stub: ModelStub = {doGenerate: vi.fn(async () => ({content: [], warnings: []})), doStream: vi.fn()};
        const host = createModelExecutorHost({createModel: vi.fn(() => asModel(stub))});
        const request = startRequest();

        host.start(request);
        await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
        expect(sendMessage).toHaveBeenCalledWith({
            type: MODEL_CALL_EVENT_MESSAGE_TYPE,
            requestId: request.requestId,
            event: {kind: 'result', result: {content: [], warnings: []}},
        }, expect.any(Function));
    });

    it('sendMessage 同步抛错时默认实现吞掉异常，执行照常收尾', async () => {
        const sendMessage = vi.fn(() => {
            throw new Error('Extension context invalidated');
        });
        vi.stubGlobal('chrome', {runtime: {sendMessage}});
        const stub: ModelStub = {doGenerate: vi.fn(async () => 'late-result'), doStream: vi.fn()};
        const host = createModelExecutorHost({createModel: vi.fn(() => asModel(stub))});

        expect(() => host.start(startRequest())).not.toThrow();
        await vi.waitFor(() => expect(stub.doGenerate).toHaveBeenCalledOnce());
        // 推送失败被默认实现与执行器各兜一层，调用本身完整收尾、不产生未处理拒绝。
        await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    });
});
