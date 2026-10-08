/**
 * @file src/app/offscreen/modelExecutorHost.ts
 * 文件职责：在 Offscreen 常驻 DOM 运行时内装配 Harness 模型执行器宿主——把协议层的
 * modelExecutor 接到真实端口上：直连模型工厂、chrome.runtime 事件推送和 setInterval
 * 心跳定时器，并向 messageRouter 暴露 start/cancel 两个受理入口。
 * 主要内容：createModelExecutorHost 工厂接收 createModel（必须注入
 * createHarnessLanguageModelDirect 直连工厂，防止在 Offscreen 内再次代理回后台形成递归）
 * 与可选 emitEvent（默认经 chrome.runtime.sendMessage 推送 'fluentReadModelCallEvent'，
 * 异常吞掉）；start 按 request.kind 分派 runGenerate/runStream 并 fire-and-forget，
 * cancel 传导给执行器触发本地 abort。
 * 模块边界：本文件只做端口装配，不解析消息字段（messageRouter 负责）、不实现执行语义
 * （modelExecutor 负责）、不构建 provider（modelGateway 直连工厂负责）；chrome 全局只在
 * 默认 emitEvent 函数体内访问，模块顶层不触碰任何浏览器 API，保证可在 node 单测装配。
 * 生命周期取舍：执行器不持有定时器以外的持久资源，在途调用随 Offscreen 页面终止，
 * 后台代理以本地超时/取消兜底，因此 runtime 的 pagehide 清理无需覆盖模型调用。
 */
import {createModelExecutor} from '@/src/services/harness/modelExecutor';
import {
    MODEL_CALL_EVENT_MESSAGE_TYPE,
    type ModelCallEvent,
    type ModelCallStartMessage,
} from '@/src/services/harness/modelCallProtocol';
import type {createHarnessLanguageModelDirect} from '@/src/services/harness/modelGateway';

/** 宿主依赖：直连模型工厂必填，事件推送端口可选（缺省接 chrome.runtime.sendMessage）。 */
export interface ModelExecutorHostDependencies {
    readonly createModel: typeof createHarnessLanguageModelDirect;
    readonly emitEvent?: (requestId: string, event: ModelCallEvent) => void;
}

/** 面向 messageRouter 的受理入口：start 受理即返回（fire-and-forget），cancel 触发本地 abort。 */
export interface ModelExecutorHost {
    start(request: ModelCallStartMessage): void;
    cancel(requestId: string): void;
}

/**
 * 默认事件推送：fire-and-forget 发往后台主监听器。后台对未知消息返回 {success:false}
 * 且不占死通道，'fluentReadModelCallEvent' 无需后台注册 case；callback 读取 lastError
 * 避免 Chrome 为"接收端已消失"输出未处理告警，同步抛错也一并吞掉——推送是尽力而为，
 * 结果丢失由后台代理的本地超时/取消兜底（执行器内部还会再兜一层 try/catch）。
 */
function emitModelCallEventViaRuntime(requestId: string, event: ModelCallEvent): void {
    try {
        chrome.runtime.sendMessage({
            type: MODEL_CALL_EVENT_MESSAGE_TYPE,
            requestId,
            event,
        }, () => {
            void chrome.runtime.lastError;
        });
    } catch {
        // Offscreen 页面销毁中或扩展上下文失效时 sendMessage 会同步抛错；执行不能因此中断。
    }
}

/** 装配执行器宿主：单宿主单执行器，所有在途调用共享同一张 requestId 登记表。 */
export function createModelExecutorHost(dependencies: ModelExecutorHostDependencies): ModelExecutorHost {
    const emitEvent = dependencies.emitEvent ?? emitModelCallEventViaRuntime;
    const executor = createModelExecutor({
        createModel: dependencies.createModel,
        emitEvent,
        // 心跳端口：setInterval 立即开始计时（intervalMs 由执行器按协议常量传入），
        // 返回的停止函数清除定时器；首个心跳在间隔到点后才发出，与 MV3 的 30 秒空闲
        // 计时器语义匹配（协议假设 ②：心跳迟到无副作用）。
        startHeartbeat: (requestId: string, intervalMs: number): (() => void) => {
            const timer = setInterval(() => emitEvent(requestId, {kind: 'heartbeat'}), intervalMs);
            return () => clearInterval(timer);
        },
    });
    return {
        start(request: ModelCallStartMessage): void {
            // 受理即返回：结果、分片与错误只经事件通道表达。executor 契约保证不 reject，
            // catch 是双保险，防止未来执行器改动把未处理拒绝泄漏进 Offscreen 页面。
            const pending = request.kind === 'stream'
                ? executor.runStream(request)
                : executor.runGenerate(request);
            void pending.catch(() => {
                // 双保险：见上方注释。此处吞错即全部职责，不做任何补偿动作。
            });
        },
        cancel(requestId: string): void {
            executor.cancel(requestId);
        },
    };
}
