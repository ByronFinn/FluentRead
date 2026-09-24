/**
 * @file src/features/comment-assistant/client.ts
 * 文件职责：封装评论请求的 runtime port 与取消边界，向面板提供稳定的异步接口。
 * 主要内容：连接 fluentReadCommentStream 端口、按请求标识接收一次性结果、断开时报错，并通过 sendMessage 补发取消。
 * 模块边界：不组装提示词、不访问 DOM 或密钥；模型调用与校验全部在后台完成。
 */
import browser from 'webextension-polyfill';
import type {CommentRequest, CommentResponse, CommentStreamMessage} from './types';

export function requestComments(request: CommentRequest, handlers: {
    result?: (response: CommentResponse) => void;
    error?: (error: Error) => void;
}): {cancel: () => void} {
    const port = browser.runtime.connect({name: 'fluentReadCommentStream'});
    let closed = false;
    const cancel = () => {
        if (closed) return;
        closed = true;
        try { port.disconnect(); } catch { /* port 已断开。 */ }
        void browser.runtime.sendMessage({type: 'fluentReadComment', action: 'cancel', requestId: request.requestId}).catch(() => undefined);
    };
    const handleMessage = (rawMessage: unknown) => {
        if (closed) return;
        const message = rawMessage as CommentStreamMessage;
        if (message.requestId !== request.requestId) return;
        closed = true;
        handlers.result?.(message.response);
        try { port.disconnect(); } catch { /* 已断开。 */ }
    };
    const handleDisconnect = () => {
        if (closed) return;
        closed = true;
        handlers.error?.(new Error('评论连接已断开，请重试。'));
    };
    port.onMessage.addListener(handleMessage);
    port.onDisconnect.addListener(handleDisconnect);
    try { port.postMessage(request); } catch { handleDisconnect(); }
    return {cancel};
}
