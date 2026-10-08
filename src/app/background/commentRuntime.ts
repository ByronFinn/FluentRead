/**
 * @file src/app/background/commentRuntime.ts
 * 文件职责：把评论后台处理器组装到扩展配置、评论服务、浏览器标签页生命周期和 service worker 保活。
 * 主要内容：绑定评论流端口、站点与开关资格、偏好或停用变化时取消在途请求、标签页关闭与导航时按页取消，把每次模型调用写入模型用量统计，并注入基于扩展 API 探测的保活节拍器。
 * 模块边界：这是应用组合根，不实现消息校验、提示词或模型协议；校验与所有权在 feature handler，编排在 services/comment，保活节拍器在 features/comment-assistant/keepalive。
 */
import browser from 'webextension-polyfill';
import {config, configReady, subscribeConfig} from '@/src/services/config/store';
import {normalizeCommentPreferences} from '@/src/core/config/comment';
import {modelUsageRepository} from '@/src/platform/storage/modelUsageRepository';
import {createCommentHandler} from '@/src/features/comment-assistant/background';
import {createCommentKeepAlive} from '@/src/features/comment-assistant/keepalive';
import {attachCommentStreamPort} from '@/src/features/comment-assistant/streamPort';
import {createCommentRuntime} from '@/src/services/comment/runtime';
import {createHarnessLanguageModel} from '@/src/services/harness/modelGateway';
import {isExtensionDisabledOnSite} from '@/src/core/site-rules/domain';
import type {BackgroundMessageHandler} from './messageRouter';
import type {CommentUsageSink} from '@/src/services/comment/runtime';
import type {CommentSender} from '@/src/features/comment-assistant/background';

export function installCommentBackgroundRuntime(): BackgroundMessageHandler<{sender?: CommentSender}> {
    // 评论与其他 AI 调用共用模型用量仓库，按同一代次写入，避免统计口径分裂。
    const createUsageSink = (): CommentUsageSink => {
        const generation = modelUsageRepository.captureGeneration();
        return event => { void modelUsageRepository.recordMany([event], generation).catch(() => undefined); };
    };
    const runtime = createCommentRuntime(() => config, createHarnessLanguageModel, createUsageSink);
    const eligibility = (sender: CommentSender) => {
        if (!config.on || !normalizeCommentPreferences(config.comment, config.customOpenAIProviders).enabled) return '评论功能已停用';
        if (isExtensionDisabledOnSite(sender.url || '', config.disabledExtensionDomains)
            || isExtensionDisabledOnSite(sender.tab?.url || '', config.disabledExtensionDomains)) return '当前网站已禁用扩展';
        return undefined;
    };
    // MV3 service worker 空闲约 30 秒被终止且进行中的 fetch 不保活；评论生成期间按 20 秒节奏探测平台信息（任意扩展 API 调用都会重置空闲计时器），请求结束由 handler 释放。
    const keepAlive = createCommentKeepAlive(() => {
        try { void browser.runtime.getPlatformInfo?.().catch(() => undefined); } catch { /* 保活探测失败不影响请求。 */ }
    });
    const handler = createCommentHandler({
        extensionId: browser.runtime.id,
        ready: configReady,
        eligibility,
        run: (request, signal) => runtime.run(request, signal),
        keepAlive,
    });
    browser.runtime.onConnect.addListener(port => attachCommentStreamPort(port, handler));
    let preferencesKey = JSON.stringify(config.comment);
    subscribeConfig(next => {
        const nextKey = JSON.stringify(next.comment);
        if (nextKey !== preferencesKey) handler.cancelAll();
        preferencesKey = nextKey;
        handler.cancelDisallowed();
    });
    browser.tabs.onRemoved.addListener(tabId => handler.cancelTab(tabId));
    browser.tabs.onUpdated.addListener((tabId, change) => {
        if (change.status === 'loading' || change.url) handler.cancelTab(tabId);
    });
    return {type: 'fluentReadComment', handle: (message, context) => handler.handle(message, context.sender ?? {})};
}
