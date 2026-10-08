/**
 * @file src/features/comment-assistant/keepalive.ts
 * 文件职责：为评论后台请求提供引用计数式的保活节拍器，避免 MV3 service worker 在长模型调用期间被空闲回收。
 * 主要内容：引用计数从 0 变正时按 intervalMs 周期调用 ping，归零时停止计时；多余的释放不会把计数减为负数，也不会重复停表。
 * 模块边界：纯计时器模块，不 import 浏览器 API 或 webextension-polyfill；具体保活动作（扩展 API 探测）由应用组合根通过 ping 注入。
 */

/** 引用计数式保活句柄：请求接管时 acquire，结束或失败时释放；计数归零时停止周期探测。 */
export interface CommentKeepAlive {
    /** 获取一个引用，返回对应的释放函数；引用计数归零时停表。 */
    acquire(): () => void;
}

/** 创建保活节拍器：首个引用启动周期 ping，全部释放后停表；重复释放与未持有引用时的释放都安全。 */
export function createCommentKeepAlive(ping: () => void, intervalMs = 20_000): CommentKeepAlive {
    let references = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    return {
        acquire() {
            references += 1;
            // 只有 0→正数这一次 acquire 启动计时器，并发请求复用同一节拍，不叠加定时器。
            if (references === 1) timer = setInterval(ping, intervalMs);
            return () => {
                if (references === 0) return; // 重复或多余的 release：不递减为负数，也不重复停表。
                references -= 1;
                if (references === 0) {
                    clearInterval(timer);
                    timer = undefined;
                }
            };
        },
    };
}
