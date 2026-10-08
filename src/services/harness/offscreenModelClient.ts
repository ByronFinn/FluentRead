/**
 * @file src/services/harness/offscreenModelClient.ts
 *
 * 文件职责：实现 MV3 service worker 侧的「代理 LanguageModel」——后台不再直接构建真
 * provider（SW 空闲 30 秒被终止且 fetch 不保活），而是把 doGenerate/doStream 经
 * modelCallProtocol 的消息协议转发到常驻 Offscreen 文档执行（真 provider 在那里构建），
 * 结果、流分片与错误经 runtime 事件回推后在本文件落地为 Promise / ReadableStream，
 * 供 AI SDK 在后台进程照常消费。
 * 主要内容：OffscreenModelClientPorts 端口接口（惰性 OffscreenClient、runtime 事件订阅、
 * 可注入时钟）、MODEL_CALL_SILENCE_TIMEOUT_MS 静默安全网常量、按 ports 共享的事件
 * dispatcher（Map<requestId, handler> 分发、迟到与未知 requestId 直接忽略）、
 * openModelCallChannel 调用通道引擎（受理、本地取消、静默计时、清理），以及
 * createOffscreenHarnessLanguageModel 代理模型工厂（与 modelGateway 的直连版同形）。
 * 模块边界：本文件不 import 浏览器对象——全部浏览器能力经端口注入且只在调用时经惰性
 * getter 求值（node 测试环境无 chrome，模块顶层求值会炸）；不构建 provider、不解析配置、
 * 不管理 Offscreen 文档生命周期；消息形状与错误保真完全复用 modelCallProtocol 第一层协议，
 * 受理确认、连接重建与取消消息尽力发送复用 platform/offscreen client 的既有语义。
 *
 * 通道事实（与协议层共同依赖，改动前必须同步核对）：
 * ① 后台主消息监听器是 async 函数，对未知类型返回 {success:false} 不占死通道：
 *    'fluentReadModelCallEvent' 事件消息无需后台路由注册 case，本模块的订阅 listener
 *    与主 listener 经 onMessage 多 listener 广播并行收到；
 * ② runtime 消息按发送顺序到达（协议假设 ①），流分片顺序由此保证；
 * ③ 心跳事件只用于重置静默计时（协议假设 ②），其内容被忽略。
 */
import type {LanguageModel} from 'ai';
import type {Config} from '@/src/core/config/model';
import type {OffscreenClient, OffscreenMessageEnvelope} from '@/src/platform/offscreen/client';
import {
    MODEL_CALL_CANCEL_OFFSCREEN_MESSAGE_TYPE,
    MODEL_CALL_EVENT_MESSAGE_TYPE,
    MODEL_CALL_START_OFFSCREEN_MESSAGE_TYPE,
    createModelCallRequestId,
    restoreModelCallError,
    stripAbortSignal,
    type ModelCallCancelMessage,
    type ModelCallEvent,
    type ModelCallKind,
    type ModelCallOptions,
    type ModelCallStartMessage,
} from './modelCallProtocol';

/** 与 modelGateway/modelExecutor 相同的 v3 具体模型抽取：代理与直连版保持同形。 */
type ProxyLanguageModel = Extract<LanguageModel, {specificationVersion: 'v3'}>;

/** doGenerate 的完整结果类型（事件通道里的 result 为 opaque，落地时一次性收敛）。 */
type ModelGenerateResult = Awaited<ReturnType<ProxyLanguageModel['doGenerate']>>;

/** doStream 的返回类型；除 stream 外的 request/response 遥测字段按协议层决策忽略。 */
type ModelStreamResult = Awaited<ReturnType<ProxyLanguageModel['doStream']>>;

/** 流分片类型（事件通道里的 part 为 opaque，enqueue 时一次性收敛）。 */
type ModelStreamPart = ModelStreamResult['stream'] extends ReadableStream<infer TPart> ? TPart : never;

export interface OffscreenModelClientPorts {
    /** 惰性解析 OffscreenClient；每次调用时求值。 */
    getClient(): Pick<OffscreenClient, 'send'>;
    /** 订阅 runtime 消息（包装 chrome.runtime.onMessage.addListener），返回退订；listener 返回值恒为 undefined 不占通道。 */
    subscribe(listener: (message: unknown) => void): () => void;
    /** 可注入时钟与随机源（测试）。 */
    now(): number;
}

/**
 * 静默安全网：约 4.5 个心跳周期（MODEL_CALL_HEARTBEAT_INTERVAL_MS = 20s）的容错余量。
 * 执行器的每次事件（含心跳）都会刷新该计时，正常调用不会触网；只有 Offscreen 挂死、
 * 事件管道断裂，或 client.send 在未配置 messageTimeoutMs 时受理响应永久 pending，
 * 才会走到这里——防止 executor 挂死导致调用方永久 pending。
 */
export const MODEL_CALL_SILENCE_TIMEOUT_MS = 90_000;

/** 单个 ports 实例共享的事件分发状态；生产环境只有一个 ports，即进程内唯一订阅。 */
interface ModelCallDispatcherState {
    /** requestId → 该调用的事件处理器；调用终局后删除，迟到事件按未知 requestId 忽略。 */
    readonly handlers: Map<string, (event: ModelCallEvent) => void>;
    /** 退订句柄：通道与 service worker 同生命周期，正常不退订，仅保留以备宿主显式关闭。 */
    readonly unsubscribe: () => void;
}

/**
 * ports → dispatcher 缓存。dispatcher 在模块内共享：同一 ports 首次发起调用时 subscribe
 * 一次，之后该 ports 创建的所有模型、所有并发调用复用同一订阅与同一 Map；按 ports 实例
 * 隔离则保证不同宿主（生产 chrome 端口与各测试桩）互不串扰。WeakMap 键不延长 ports 生命周期。
 */
const modelCallDispatchers = new WeakMap<OffscreenModelClientPorts, ModelCallDispatcherState>();

/**
 * 判别 ModelCallEventMessage：非本协议的消息（后台路由的其他消息、宿主页面噪音等）
 * 直接忽略，与主监听器「对未知类型返回 {success:false}」的宽容语义对齐。
 */
function isModelCallEventMessage(
    message: unknown,
): message is {readonly requestId: string; readonly event: ModelCallEvent} {
    if (typeof message !== 'object' || message === null) return false;
    const candidate = message as {readonly type?: unknown; readonly requestId?: unknown; readonly event?: unknown};
    if (candidate.type !== MODEL_CALL_EVENT_MESSAGE_TYPE) return false;
    if (typeof candidate.requestId !== 'string') return false;
    if (typeof candidate.event !== 'object' || candidate.event === null) return false;
    return typeof (candidate.event as {readonly kind?: unknown}).kind === 'string';
}

/** 首次使用该 ports 时建立共享 dispatcher；此后的所有调用只复用，不再重复订阅。 */
function ensureModelCallDispatcher(ports: OffscreenModelClientPorts): ModelCallDispatcherState {
    const existing = modelCallDispatchers.get(ports);
    if (existing) return existing;
    const handlers = new Map<string, (event: ModelCallEvent) => void>();
    const listener = (message: unknown): void => {
        // 函数体为语句块，返回值恒为 undefined：不占用 chrome.runtime.onMessage 的同步
        // 响应通道（通道事实 ①）；未知 requestId 的 handlers.get 为 undefined，天然忽略。
        if (!isModelCallEventMessage(message)) return;
        handlers.get(message.requestId)?.(message.event);
    };
    const unsubscribe = ports.subscribe(listener);
    const state: ModelCallDispatcherState = {handlers, unsubscribe};
    modelCallDispatchers.set(ports, state);
    return state;
}

/** 本地取消：不等 executor 回音立即失败；client 已随 signal 尽力发送 cancelMessage。 */
function createLocalAbortError(): Error {
    const error = new Error('模型调用已取消');
    error.name = 'AbortError';
    return error;
}

/** 静默超时：name 取 'TimeoutError'，与 normalizeAiSdkError 对超时类错误的 name 判别对齐。 */
function createSilenceTimeoutError(): Error {
    const error = new Error(`Offscreen 模型调用超过 ${MODEL_CALL_SILENCE_TIMEOUT_MS / 1000} 秒未收到任何事件`);
    error.name = 'TimeoutError';
    return error;
}

/** 单次调用的静态参数；config 为工厂调用时捕获的快照引用，克隆由消息通道完成。 */
interface ModelCallRequest {
    readonly service: string;
    readonly model: string;
    readonly kind: ModelCallKind;
    readonly config: Config;
    readonly options: ModelCallOptions;
}

/** 事件通道在调用方的落地方式：generate 落到 resolve/reject，stream 落到 enqueue/close/error。 */
interface ModelCallChannelSink {
    /** 非 heartbeat 事件（活性刷新已由引擎统一完成）；complete 用于终局并注销登记。 */
    onEvent(event: ModelCallEvent, complete: () => void): void;
    /** client.send 受理成功（send 的响应即受理，不携带结果数据）。 */
    onAccepted(): void;
    /** 失败出口：错误事件（restore 后）、本地取消、静默超时或受理失败；调用时登记已清理。 */
    onFailure(error: Error): void;
}

/**
 * 单次调用的事件通道引擎：登记 requestId、发出 START 消息、管理本地取消与静默计时，
 * 并在终局（result/error/end、本地取消、静默超时、受理失败）后清理登记与定时器。
 * 各失败出口在调用 sink 前已完成清理，因此迟到的同名事件不会再送达该 sink。
 */
function openModelCallChannel(
    ports: OffscreenModelClientPorts,
    request: ModelCallRequest,
    sink: ModelCallChannelSink,
): void {
    const requestId = createModelCallRequestId();
    const dispatcher = ensureModelCallDispatcher(ports);
    const signal = request.options.abortSignal;
    let finished = false;
    let silenceTimer: ReturnType<typeof setTimeout> | undefined;
    let lastActivityAt = ports.now();

    const finish = (): void => {
        finished = true;
        clearTimeout(silenceTimer);
        silenceTimer = undefined;
        signal?.removeEventListener('abort', handleAbort);
        dispatcher.handlers.delete(requestId);
    };

    const checkSilence = (): void => {
        silenceTimer = undefined;
        const idleForMs = ports.now() - lastActivityAt;
        if (idleForMs < MODEL_CALL_SILENCE_TIMEOUT_MS) {
            // 注入时钟与真实定时器存在漂移时按剩余时长补挂，绝不过早判死。
            silenceTimer = setTimeout(checkSilence, MODEL_CALL_SILENCE_TIMEOUT_MS - idleForMs);
            return;
        }
        finish();
        sink.onFailure(createSilenceTimeoutError());
    };

    const refreshActivity = (): void => {
        lastActivityAt = ports.now();
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(checkSilence, MODEL_CALL_SILENCE_TIMEOUT_MS);
    };

    const handleAbort = (): void => {
        finish();
        sink.onFailure(createLocalAbortError());
    };

    const handleEvent = (event: ModelCallEvent): void => {
        // 每次收到任意事件（含心跳）刷新静默计时；心跳内容按协议假设 ② 忽略。
        refreshActivity();
        if (event.kind === 'heartbeat') return;
        sink.onEvent(event, finish);
    };

    // 先登记再发送：受理响应与事件分片走不同管道，事件可能先于受理到达（通道事实 ②）。
    dispatcher.handlers.set(requestId, handleEvent);
    refreshActivity();
    signal?.addEventListener('abort', handleAbort, {once: true});

    const startMessage: OffscreenMessageEnvelope<ModelCallStartMessage> = {
        type: MODEL_CALL_START_OFFSCREEN_MESSAGE_TYPE,
        target: 'offscreen',
        requestId,
        service: request.service,
        model: request.model,
        kind: request.kind,
        config: request.config,
        options: stripAbortSignal(request.options),
    };
    const cancelMessage: ModelCallCancelMessage & {readonly target: 'offscreen'} = {
        type: MODEL_CALL_CANCEL_OFFSCREEN_MESSAGE_TYPE,
        target: 'offscreen',
        requestId,
    };
    // send 的响应即受理；send reject（取消/超时/连接失败）时 client 已尽力发出
    // cancelMessage，这里清理登记并把错误原样抛给调用方（受理前失败没有结果可言）。
    void ports.getClient().send<unknown, OffscreenMessageEnvelope<ModelCallStartMessage>>(startMessage, {
        signal,
        cancelMessage,
    }).then(
        () => {
            if (!finished) sink.onAccepted();
        },
        (error: unknown) => {
            if (finished) return;
            finish();
            sink.onFailure(error instanceof Error ? error : new Error(String(error)));
        },
    );
}

/**
 * 创建后台侧代理模型工厂，签名与 createHarnessLanguageModel 同形：宿主在后台用本工厂
 * 替换直连工厂即可把模型执行迁入 Offscreen。config/service/model 在工厂调用时捕获进
 * 闭包，不读取全局状态；同一 ports 的所有模型共享一个事件订阅。
 */
export function createOffscreenHarnessLanguageModel(
    ports: OffscreenModelClientPorts,
): (config: Config, service: string, model: string) => LanguageModel {
    return (config: Config, service: string, model: string): LanguageModel => {
        const proxyModel: ProxyLanguageModel = {
            specificationVersion: 'v3',
            provider: `fluentread-harness-offscreen-${service}`,
            modelId: model,
            // 代理无法得知 Offscreen 内真 provider 的原生 URL 能力（RegExp 也不是可跨
            // 进程共享的元数据），按空表上报：AI SDK 核心会在调用前自行下载文件内容随
            // prompt 传输，语义保守且无需一次额外的往返询问。
            supportedUrls: {},
            doGenerate: (options: ModelCallOptions) => new Promise<ModelGenerateResult>((resolve, reject) => {
                if (options.abortSignal?.aborted) {
                    // 尚未发出任何消息，直接失败即可，无需 cancel 补偿。
                    reject(createLocalAbortError());
                    return;
                }
                openModelCallChannel(ports, {service, model, kind: 'generate', config, options}, {
                    onAccepted: () => {
                        // 受理不携带结果：doGenerate 只等待 result/error 事件落地。
                    },
                    onEvent: (event, complete) => {
                        if (event.kind === 'result') {
                            complete();
                            resolve(event.result as ModelGenerateResult);
                            return;
                        }
                        if (event.kind === 'error') {
                            complete();
                            reject(restoreModelCallError(event));
                            return;
                        }
                        // part/end 与 generate 请求错配（协议防御）：忽略，等待 result 或失败兜底。
                    },
                    onFailure: reject,
                });
            }),
            doStream: (options: ModelCallOptions) => new Promise<ModelStreamResult>((resolve, reject) => {
                if (options.abortSignal?.aborted) {
                    reject(createLocalAbortError());
                    return;
                }
                // push 模式无背压：start 里不发数据，part 事件到达即 enqueue，分片顺序由
                // 通道事实 ②（runtime 消息按发送顺序到达）保证；读取端始终用 reader 拉取。
                let streamController!: ReadableStreamDefaultController<ModelStreamPart>;
                const stream = new ReadableStream<ModelStreamPart>({
                    start(controller) {
                        streamController = controller;
                    },
                });
                openModelCallChannel(ports, {service, model, kind: 'stream', config, options}, {
                    onAccepted: () => {
                        resolve({stream});
                    },
                    onEvent: (event, complete) => {
                        if (event.kind === 'part') {
                            streamController.enqueue(event.part as ModelStreamPart);
                            return;
                        }
                        if (event.kind === 'end') {
                            complete();
                            streamController.close();
                            resolve({stream});
                            return;
                        }
                        if (event.kind === 'error') {
                            complete();
                            const restored = restoreModelCallError(event);
                            streamController.error(restored);
                            reject(restored);
                            return;
                        }
                        // result 与 stream 请求错配（协议防御）：忽略。
                    },
                    onFailure: (error) => {
                        // 本地取消/静默超时/受理失败：已受理时错误落在流上（外层 resolve
                        // 第二次是 no-op），未受理时同时拒绝外层，两种时序调用方都能感知。
                        streamController.error(error);
                        reject(error);
                    },
                });
            }),
        };
        return proxyModel;
    };
}
