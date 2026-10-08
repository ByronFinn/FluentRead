/**
 * @file src/services/harness/modelCallProtocol.ts
 *
 * 文件职责：定义 Harness 模型调用从 MV3 service worker 迁入 Offscreen 常驻 DOM 运行时的第一层纯协议——
 * 后台代理与 Offscreen 执行器之间的消息形状、事件判别联合、错误保真字段集以及可独立单测的纯函数。
 * 主要内容：MODEL_CALL_START_OFFSCREEN / MODEL_CALL_CANCEL_OFFSCREEN 消息常量与 ModelCallStartMessage、
 * ModelCallCancelMessage 请求类型；'fluentReadModelCallEvent' 事件推送类型与 ModelCallEvent 判别联合；
 * stripAbortSignal、createModelCallRequestId、serializeModelCallError、restoreModelCallError 纯函数和
 * MODEL_CALL_HEARTBEAT_INTERVAL_MS 心跳间隔。
 * 模块边界：本文件只包含类型、常量与纯函数，零浏览器 API、零 'ai' 运行时依赖（仅 type import）；
 * 不构建 provider、不发送消息、不管理生命周期——执行由 modelExecutor 完成，通断与 SW 保活由宿主端口承担。
 *
 * 协议假设（后台代理与 Offscreen 执行器共同依赖，改动任一侧前必须同步核对）：
 * ① 扩展 runtime 消息管道按发送顺序到达同一接收端（Offscreen 到后台只有单一 listener），
 *    流分片的顺序由此保证，因此事件不携带序号，也不做乱序重排；
 * ② 心跳事件在后台仅用于重置 MV3 service worker 的 30 秒空闲计时器，代理忽略其内容；
 *    心跳丢失、重复或迟到都没有副作用，执行器也不依赖心跳确认存活。
 */
import type {LanguageModel} from 'ai';
import type {Config} from '@/src/core/config/model';
import type {OffscreenMessage} from '@/src/platform/offscreen/client';

/**
 * 与 modelGateway 相同的 v3 具体模型抽取。'ai' 未再导出 LanguageModelV3CallOptions，
 * 且 pnpm 严格布局下仓库无法直接 import '@ai-sdk/provider'，因此沿用 Parameters 推导。
 */
type HarnessConcreteLanguageModel = Extract<LanguageModel, {specificationVersion: 'v3'}>;

/** LanguageModelV3CallOptions 的等价定义：doGenerate/doStream 共用的完整调用参数。 */
export type ModelCallOptions = Parameters<HarnessConcreteLanguageModel['doGenerate']>[0];

/**
 * 剔除 abortSignal 后的可克隆调用参数。AbortSignal 绝不能进入结构化克隆边界
 * （见 OffscreenSendOptions 注释），后台用本地 signal 控制，Offscreen 用重建的
 * AbortController；prompt/tools/schema 等其余字段是纯数据，原样透传不解析。
 */
export type ModelCallOptionsPayload = Omit<ModelCallOptions, 'abortSignal'>;

/** 后台 → Offscreen：开始一次 doGenerate 或 doStream 调用（经 target:'offscreen' 信封派发）。 */
export const MODEL_CALL_START_OFFSCREEN_MESSAGE_TYPE = 'MODEL_CALL_START_OFFSCREEN' as const;

/** 后台 → Offscreen：取消仍在执行的调用；命名对齐 CANCEL_*_OFFSCREEN 先例。 */
export const MODEL_CALL_CANCEL_OFFSCREEN_MESSAGE_TYPE = 'MODEL_CALL_CANCEL_OFFSCREEN' as const;

/** Offscreen → 后台：fire-and-forget 事件推送，风格对齐 'selectionTtsPlaybackState' 先例。 */
export const MODEL_CALL_EVENT_MESSAGE_TYPE = 'fluentReadModelCallEvent' as const;

export type ModelCallKind = 'generate' | 'stream';

export interface ModelCallStartMessage extends OffscreenMessage {
    readonly type: typeof MODEL_CALL_START_OFFSCREEN_MESSAGE_TYPE;
    readonly requestId: string;
    readonly service: string;
    readonly model: string;
    readonly kind: ModelCallKind;
    /** 发起时冻结的纯 JSON 配置快照；凭据只在 Offscreen 内解冻使用，不随事件回传后台。 */
    readonly config: Config;
    readonly options: ModelCallOptionsPayload;
}

export interface ModelCallCancelMessage extends OffscreenMessage {
    readonly type: typeof MODEL_CALL_CANCEL_OFFSCREEN_MESSAGE_TYPE;
    readonly requestId: string;
}

/**
 * 错误事件字段集（保真结论，源自对 providers/translation/ai-sdk/errors.ts 的核对）：
 * normalizeAiSdkError 的第一判别是 APICallError.isInstance / RetryError.isInstance——
 * instanceof 语义无法跨越结构化克隆存活，错误重建后必然落入通用分支；该分支只消费
 * error.name（AbortError / TimeoutError / InvalidPrompt 类名判别）与 error.message
 * （timeout / network / invalid-request 文案判别）。因此：
 * - name + message 是必选字段，保住通用分支的全部判别能力；
 * - url / statusCode / responseBodyText 对应 APICallError 的可序列化判别字段，供后台
 *   代理一步重建 APICallError 实例，恢复 401/429 等 statusKind 分支；
 * - 取舍：responseHeaders / isRetryable / data 不进入协议（最小化消息载荷与敏感面），
 *   重建 APICallError 后 Retry-After、x-request-id 提取与 HTML 错误页判别会退化为通用分支。
 */
export interface ModelCallErrorFields {
    readonly kind: 'error';
    readonly name: string;
    readonly message: string;
    readonly url?: string;
    readonly statusCode?: number;
    readonly responseBodyText?: string;
}

/**
 * Offscreen → 后台的执行事件判别联合：
 * - heartbeat：仅重置后台 SW 空闲计时器（假设 ②）；
 * - part：doStream 分片，opaque 透传，后台按到达顺序重建流（假设 ①）；
 * - result：doGenerate 完整结果，opaque 透传；
 * - error：见 ModelCallErrorFields 的保真字段集；
 * - end：流正常耗尽的终止标记，后台以此 resolve 代理流。
 */
export type ModelCallEvent =
    | {readonly kind: 'heartbeat'}
    | {readonly kind: 'part'; readonly part: unknown}
    | {readonly kind: 'result'; readonly result: unknown}
    | ModelCallErrorFields
    | {readonly kind: 'end'};

export interface ModelCallEventMessage {
    readonly type: typeof MODEL_CALL_EVENT_MESSAGE_TYPE;
    readonly requestId: string;
    readonly event: ModelCallEvent;
}

/** 心跳间隔：小于 MV3 service worker 的 30 秒空闲阈值并留出余量，单次丢失不影响保活。 */
export const MODEL_CALL_HEARTBEAT_INTERVAL_MS = 20_000;

/** 浏览器 CSPRNG 端口；randomUUID 仅在 secure context 保证暴露，需保留 getRandomValues 退路。 */
type ModelCallRandomSource = Pick<Crypto, 'getRandomValues'> & {
    readonly randomUUID?: () => string;
};

/**
 * 浅拷贝剔除 abortSignal，其余字段（含 prompt/tools/schema 的对象引用）原样保留；
 * 深拷贝或解析交给 runtime 消息的结构化克隆，本函数不做任何语义转换。
 */
export function stripAbortSignal(options: ModelCallOptions): ModelCallOptionsPayload {
    const {abortSignal: _removed, ...payload} = options;
    return payload;
}

/** 使用浏览器 CSPRNG 生成模型调用 requestId；风格对齐 reading-assistant 的 `reading-${uuid}` 与划词 TTS 的可注入随机源。 */
export function createModelCallRequestId(
    randomSource: ModelCallRandomSource = globalThis.crypto,
): string {
    const uuid = typeof randomSource.randomUUID === 'function'
        ? randomSource.randomUUID()
        : fallbackModelCallUuid(randomSource);
    return `model-call-${uuid}`;
}

/** randomUUID 缺失时用 getRandomValues 生成等价的 RFC 4122 v4 身份（对齐 selection TTS 协议退路）。 */
function fallbackModelCallUuid(randomSource: Pick<Crypto, 'getRandomValues'>): string {
    const bytes = randomSource.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * 把执行侧捕获的错误压平为可克隆的错误事件字段。对 APICallError 做鸭子类型读取
 * （url/statusCode/responseBody 属性，不 import 'ai'）：真 provider 的 APICallError
 * 实例天然携带这些字段，普通 Error 则只保留 name/message。
 */
export function serializeModelCallError(error: unknown): ModelCallErrorFields {
    const name = error instanceof Error && error.name ? error.name : 'Error';
    const message = error instanceof Error ? error.message : String(error);
    const candidate = error as {url?: unknown; statusCode?: unknown; responseBody?: unknown};
    const url = typeof candidate.url === 'string' ? candidate.url : undefined;
    const statusCode = typeof candidate.statusCode === 'number' && Number.isFinite(candidate.statusCode)
        ? candidate.statusCode
        : undefined;
    const responseBody = typeof candidate.responseBody === 'string' ? candidate.responseBody : undefined;
    return {
        kind: 'error',
        name,
        message,
        ...(url === undefined ? {} : {url}),
        ...(statusCode === undefined ? {} : {statusCode}),
        ...(responseBody === undefined ? {} : {responseBodyText: responseBody}),
    };
}

/**
 * 按事件字段重建 Error。name 原样写回（AbortError 特判即依赖 name 判别：
 * normalizeAiSdkError 用 error.name === 'AbortError' 区分用户取消与内部超时，
 * 后台代理同样按 name 静默丢弃本地已取消的迟到错误）；url/statusCode/responseBodyText
 * 以 APICallError 的字段名（url/statusCode/responseBody）挂回，供后台需要时直接
 * 构造 APICallError 恢复完整归一分支。
 */
/** 还原错误的可选判别字段（按 APICallError 字段名直挂），供后台归一层类型安全地消费。 */
export type RestoredModelCallError = Error & {url?: string; statusCode?: number; responseBody?: string};

export function restoreModelCallError(fields: ModelCallErrorFields): RestoredModelCallError {
    const error = new Error(fields.message);
    error.name = fields.name || 'Error';
    const enriched = error as RestoredModelCallError;
    if (fields.url !== undefined) enriched.url = fields.url;
    if (fields.statusCode !== undefined) enriched.statusCode = fields.statusCode;
    if (fields.responseBodyText !== undefined) enriched.responseBody = fields.responseBodyText;
    return enriched;
}
