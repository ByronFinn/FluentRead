/**
 * @file src/features/comment-assistant/streamPort.ts
 * 文件职责：把一个评论请求绑定到独立长连接，回传一次性结果并在断开时取消后台工作。
 * 主要内容：限制每端口一个请求、按请求标识回发结果、清理监听器并阻止断开后的重复消息。
 * 模块边界：仅适配注入的端口与评论 handler，不访问浏览器、模型、配置或存储；评论无中间进度，只有最终结果。
 */
import type {CommentSender, createCommentHandler} from './background';
import type {CommentStreamMessage} from './types';

interface Listener<T extends (...args: any[]) => void> {addListener(listener: T): void; removeListener(listener: T): void}
export interface CommentStreamPort {
    name: string;
    sender?: CommentSender;
    postMessage(message: CommentStreamMessage): void;
    disconnect(): void;
    onMessage: Listener<(message: unknown) => void>;
    onDisconnect: Listener<() => void>;
}

export function attachCommentStreamPort(port: CommentStreamPort, handler: Pick<ReturnType<typeof createCommentHandler>, 'handle'>): void {
    if (port.name !== 'fluentReadCommentStream') return;
    let connected = true;
    let started = false;
    let requestId = '';
    const sender = port.sender ?? {};
    const cleanup = () => {
        port.onMessage.removeListener(receive);
        port.onDisconnect.removeListener(disconnect);
    };
    const disconnect = () => {
        connected = false;
        cleanup();
        if (requestId) void handler.handle({type: 'fluentReadComment', action: 'cancel', requestId}, sender).catch(() => undefined);
    };
    const send = (message: CommentStreamMessage) => {
        if (!connected) return;
        try { port.postMessage(message); } catch { disconnect(); }
    };
    const receive = (message: unknown) => {
        if (started || !connected) return;
        started = true;
        if (message && typeof message === 'object' && 'requestId' in message && typeof message.requestId === 'string') requestId = message.requestId;
        void (async () => {
            try {
                const response = await handler.handle(message, sender);
                send({type: 'result', requestId, response});
            } catch {
                send({type: 'result', requestId, response: {success: false, error: '评论连接已中断，请重试'}});
            } finally {
                connected = false;
                cleanup();
                try { port.disconnect(); } catch { /* 已断开的端口无需再次关闭。 */ }
            }
        })();
    };
    port.onMessage.addListener(receive);
    port.onDisconnect.addListener(disconnect);
}
