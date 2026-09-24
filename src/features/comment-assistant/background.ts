/**
 * @file src/features/comment-assistant/background.ts
 * 文件职责：为评论请求建立按标签页、frame 和 document 隔离的后台取消与并发边界。
 * 主要内容：校验选区文本与 data URL 图片白名单、处理先取消后启动、替换同页旧请求、限制并发，并在配置停用或超时后丢弃迟到结果。
 * 模块边界：不读取浏览器或密钥，不选择模型也不执行提示词组装；配置就绪、站点资格与真实模型调用由应用组合根注入。
 */
import {COMMENT_MAX_IMAGE_CHARS, COMMENT_MAX_IMAGES, COMMENT_MAX_TEXT} from '@/src/core/config/comment';
import type {CommentRequest, CommentResponse} from './types';

export interface CommentSender {
    id?: string;
    url?: string;
    tab?: {id?: number; url?: string; incognito?: boolean};
    frameId?: number;
    documentId?: string;
}
export interface CommentHandlerDependencies {
    extensionId: string;
    ready: Promise<unknown>;
    eligibility(sender: CommentSender): string | undefined;
    run(request: CommentRequest, signal: AbortSignal): Promise<CommentResponse>;
}
interface ActiveComment {requestId: string; sender: CommentSender; controller: AbortController}
const CANCELLED: CommentResponse = {success: false, error: '已取消', cancelled: true};
const INVALID: CommentResponse = {success: false, error: '无效的评论请求'};
const LIMIT = 2;
const HISTORY_LIMIT = 64;
const REQUEST_TIMEOUT = 60_000;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** 页面只能提交文本与 data URL 图片；数量、长度和字符集在此一次性收紧，越界即拒绝而非截断。 */
export function isCommentRequestPayload(message: Record<string, unknown>): message is Record<string, unknown> & CommentRequest {
    if (message.action !== 'run' || typeof message.text !== 'string') return false;
    const text = message.text.trim();
    if (!text || text.length > COMMENT_MAX_TEXT) return false;
    if (!Array.isArray(message.images) || message.images.length > COMMENT_MAX_IMAGES) return false;
    return message.images.every(image => typeof image === 'string' && image.length > 0 && image.length <= COMMENT_MAX_IMAGE_CHARS && /^data:image\/(?:png|jpeg|webp);base64,/u.test(image));
}

function ownerOf(sender: CommentSender): string {
    return JSON.stringify([sender.tab!.id, sender.frameId ?? 0, sender.documentId ?? sender.url ?? '']);
}

/** 即使被注入的请求不响应 AbortSignal，也按时释放 UI 和后台所有权。 */
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    let onAbort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error('cancelled'));
        signal.addEventListener('abort', onAbort, {once: true});
    });
    try { return await Promise.race([work, cancelled]); }
    finally { signal.removeEventListener('abort', onAbort); }
}

/** 只允许扩展自身的内容脚本调用；同一个 requestId 在不同 document 中互不影响。 */
export function createCommentHandler(deps: CommentHandlerDependencies) {
    const active = new Map<string, ActiveComment>();
    const seen = new Set<string>();
    let disposed = false;
    const remember = (key: string) => {
        seen.add(key);
        if (seen.size > HISTORY_LIMIT) seen.delete(seen.values().next().value!);
    };
    const cancelWhere = (predicate: (sender: CommentSender) => boolean) => {
        for (const entry of active.values()) if (predicate(entry.sender)) entry.controller.abort();
    };
    return {
        cancelAll() { cancelWhere(() => true); },
        cancelTab(tabId: number) { cancelWhere(sender => sender.tab!.id === tabId); },
        cancelDisallowed() { cancelWhere(sender => Boolean(deps.eligibility(sender))); },
        dispose() { disposed = true; cancelWhere(() => true); active.clear(); seen.clear(); },
        async handle(message: unknown, sender: CommentSender): Promise<CommentResponse> {
            if (disposed || sender.id !== deps.extensionId || !Number.isSafeInteger(sender.tab?.id)
                || sender.tab!.id! < 0 || !isRecord(message) || message.type !== 'fluentReadComment'
                || typeof message.requestId !== 'string' || !/^[\w.:-]{1,128}$/u.test(message.requestId)) return INVALID;
            const owner = ownerOf(sender);
            const key = `${owner}:${message.requestId}`;
            if (message.action === 'cancel') {
                remember(key);
                const entry = active.get(owner);
                if (entry?.requestId === message.requestId) entry.controller.abort();
                return CANCELLED;
            }
            if (!isCommentRequestPayload(message)) return INVALID;
            if (seen.has(key)) return CANCELLED;
            const previous = active.get(owner);
            if (previous?.requestId === message.requestId) return {success: false, error: '这个请求正在处理中'};
            previous?.controller.abort();
            if (!previous && active.size >= LIMIT) return {success: false, error: '正在处理其他评论请求，请稍后再试'};
            const controller = new AbortController();
            active.set(owner, {requestId: message.requestId, sender, controller});
            const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
            const cleanup = () => {
                clearTimeout(timer);
                if (active.get(owner)?.controller === controller) active.delete(owner);
                remember(key);
            };
            try {
                await abortable(deps.ready, controller.signal);
                if (controller.signal.aborted) { cleanup(); return CANCELLED; }
                const blocked = deps.eligibility(sender);
                if (blocked) { cleanup(); return {success: false, error: blocked}; }
                const response = await abortable(deps.run(message as unknown as CommentRequest, controller.signal), controller.signal);
                if (controller.signal.aborted) { cleanup(); return CANCELLED; }
                const nowBlocked = deps.eligibility(sender);
                const result: CommentResponse = nowBlocked ? {success: false, error: nowBlocked} : response;
                cleanup();
                return result;
            } catch {
                const result: CommentResponse = controller.signal.aborted ? CANCELLED : {success: false, error: '评论请求未完成，请重试'};
                cleanup();
                return result;
            }
        },
    };
}
