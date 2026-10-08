/**
 * @file src/services/harness/modelExecutor.ts
 *
 * 文件职责：在 Offscreen 常驻 DOM 运行时里执行 Harness 模型调用的执行器核心——
 * 受理后台代理的开始/取消请求，驱动真 provider 的 doGenerate/doStream，并把结果、
 * 流分片与错误按 modelCallProtocol 的事件形状推回后台，全程可注入端口、可在 node 单测。
 * 主要内容：ModelExecutorPorts 端口接口（直连模型工厂、事件推送、心跳定时器）、
 * createModelExecutor 工厂返回 runGenerate/runStream/cancel 三个入口，内部以
 * Map<requestId, AbortController> 登记在执行调用，保证重复 requestId 幂等、取消可传导、
 * 推送失败不中断执行。
 * 模块边界：本文件不 import 浏览器 API 与 'ai' 运行时（仅 type import），不解析配置、
 * 不构建 provider、不发送 runtime 消息；所有外部能力经端口注入，宿主负责把端口接到
 * createHarnessLanguageModel 直连版、chrome.runtime.sendMessage 与 SW 保活定时器上。
 */
import type {LanguageModel} from 'ai';
import type {Config} from '@/src/core/config/model';
import {
    MODEL_CALL_HEARTBEAT_INTERVAL_MS,
    serializeModelCallError,
    type ModelCallEvent,
    type ModelCallStartMessage,
} from './modelCallProtocol';

/**
 * v3 具体模型收敛：端口按任务契约返回 LanguageModel 联合（宿主直接传入
 * createHarnessLanguageModel 的返回值），而该工厂实际恒返回 v3 provider，
 * 这里沿用 modelGateway 的 Extract 收敛方式做一次性静态断言，不做运行时校验。
 */
type ExecutorLanguageModel = Extract<LanguageModel, {specificationVersion: 'v3'}>;

export interface ModelExecutorPorts {
    /** 宿主注入直连工厂（offscreen 内运行的 createHarnessLanguageModel 直连版，禁止再进代理，防递归）。 */
    createModel(config: Config, service: string, model: string): LanguageModel;
    /** 宿主注入：把事件推回后台（fire-and-forget，失败由宿主吞掉；executor 仍会再兜一层 try/catch）。 */
    emitEvent(requestId: string, event: ModelCallEvent): void;
    /** 宿主注入：定时心跳，返回停止函数。 */
    startHeartbeat(requestId: string, intervalMs: number): () => void;
}

export interface ModelExecutor {
    runGenerate(request: ModelCallStartMessage): Promise<void>;
    runStream(request: ModelCallStartMessage): Promise<void>;
    cancel(requestId: string): void;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * 执行器核心。所有方法都不会 reject：后台宿主可以安全地 fire-and-forget 调用，
 * 结果与失败一律经事件通道表达。
 */
export function createModelExecutor(ports: ModelExecutorPorts): ModelExecutor {
    const activeRequests = new Map<string, AbortController>();

    const emit = (requestId: string, event: ModelCallEvent): void => {
        try {
            ports.emitEvent(requestId, event);
        } catch {
            // 取舍：消息管道已断（Offscreen 页面将死）时推送会抛错，执行不能因此中断——
            // 模型侧请求已经计费，中途放弃会让结果彻底丢失。result 事件推送失败同样只允许
            // 吞掉：后台代理拿不到结果，会由其本地超时/取消兜底，这里继续走 finally 正常收尾。
        }
    };

    const startHeartbeatSafely = (requestId: string): (() => void) | undefined => {
        try {
            return ports.startHeartbeat(requestId, MODEL_CALL_HEARTBEAT_INTERVAL_MS);
        } catch {
            // 心跳只用于重置后台 SW 空闲计时器（协议假设 ②），定时器端口故障不能中断调用本身。
            return undefined;
        }
    };

    /**
     * 登记新调用。同 requestId 已在执行时直接忽略：runtime 消息可能重放，而重复执行意味着
     * 对同一请求重复计费；宿主侧受理重放仍返回 accepted，executor 静默幂等返回。
     */
    const beginRequest = (requestId: string): AbortController | undefined => {
        if (activeRequests.has(requestId)) return undefined;
        const controller = new AbortController();
        activeRequests.set(requestId, controller);
        return controller;
    };

    const emitCaughtError = (requestId: string, error: unknown, abortedLocally: boolean): void => {
        if (abortedLocally) {
            // 本地 controller 已取消：无论 provider 抛出什么形态，一律归一为 name:'AbortError'，
            // 后台本地已用 signal 立即 reject 调用方，这个事件只作迟到确认、会被静默丢弃。
            emit(requestId, {kind: 'error', name: 'AbortError', message: errorMessage(error)});
            return;
        }
        // 未本地取消则原样保真序列化：SDK 内部超时同样表现为 name:'AbortError'，
        // normalizeAiSdkError 需要靠原始 name/message 区分内部超时与用户取消，不能在这里改写。
        emit(requestId, serializeModelCallError(error));
    };

    const finishRequest = (requestId: string, stopHeartbeat: (() => void) | undefined): void => {
        stopHeartbeat?.();
        activeRequests.delete(requestId);
    };

    const runGenerate = async (request: ModelCallStartMessage): Promise<void> => {
        const controller = beginRequest(request.requestId);
        if (!controller) return;
        let stopHeartbeat: (() => void) | undefined;
        try {
            stopHeartbeat = startHeartbeatSafely(request.requestId);
            const model = ports.createModel(request.config, request.service, request.model) as ExecutorLanguageModel;
            const result = await model.doGenerate({...request.options, abortSignal: controller.signal});
            emit(request.requestId, {kind: 'result', result});
        } catch (error) {
            emitCaughtError(request.requestId, error, controller.signal.aborted);
        } finally {
            finishRequest(request.requestId, stopHeartbeat);
        }
    };

    const runStream = async (request: ModelCallStartMessage): Promise<void> => {
        const controller = beginRequest(request.requestId);
        if (!controller) return;
        let stopHeartbeat: (() => void) | undefined;
        try {
            stopHeartbeat = startHeartbeatSafely(request.requestId);
            const model = ports.createModel(request.config, request.service, request.model) as ExecutorLanguageModel;
            // LanguageModelV3StreamResult 除 stream 外只有 request.body / response.headers 遥测字段：
            // 它们描述已发出的 HTTP 请求，后台代理重建流时不消费，且 Response 头语义在结构化克隆
            // 后无法保真，因此忽略——首个 part 之前不注入任何合成事件，分片保持 opaque 透传。
            const {stream} = await model.doStream({...request.options, abortSignal: controller.signal});
            // 用 getReader 手动循环而非 for-await：ReadableStream 的异步迭代器在较旧 Chrome
            // 不保证可用，reader.read() 是全版本基线，读取顺序仍由流自身保证（协议假设 ①）。
            const reader = stream.getReader();
            while (true) {
                const {done, value} = await reader.read();
                if (done) break;
                emit(request.requestId, {kind: 'part', part: value});
            }
            emit(request.requestId, {kind: 'end'});
        } catch (error) {
            emitCaughtError(request.requestId, error, controller.signal.aborted);
        } finally {
            finishRequest(request.requestId, stopHeartbeat);
        }
    };

    const cancel = (requestId: string): void => {
        // 只触发本地 abort，不等待、不 emit：后台代理在发 CANCEL 消息前已用本地 signal
        // 立即 reject 调用方，这里再推事件只会制造迟到噪音。
        activeRequests.get(requestId)?.abort();
    };

    return {runGenerate, runStream, cancel};
}
