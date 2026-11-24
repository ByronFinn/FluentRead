/**
 * @file src/app/content/pageTranslationFontMessage.ts
 * 文件职责：提供当前文档实际译文字体的只读诊断查询，并拒绝其他扩展或已失效的上下文。
 * 主要内容：验证扩展 sender、页面启用与上下文状态，返回带文档实例标识和完整 URL 的样式状态；全局字体写入统一走配置持久化，不再接受单页覆盖命令。
 * 模块边界：不注册监听器、不写配置或文档样式；字体控制器由 content composition root 按全局配置同步，未装配的上下文返回 unavailable。
 */
import type {ContentScriptContext} from 'wxt/utils/content-script-context';
import {config} from '@/src/services/config/store';
import {getFullPageTranslationDocumentToken} from './features';
import type {PageTranslationFontRuntime} from './pageTranslationFont';

export interface PageTranslationFontMessageState {
    isSiteDisabled(): boolean;
    isPageSuspended?(): boolean;
    pageTranslationFont?: PageTranslationFontRuntime;
}

export function handlePageTranslationFontMessage(
    payload: Record<string, unknown>, sender: unknown, ctx: ContentScriptContext,
    state: PageTranslationFontMessageState, sendResponse: (response?: unknown) => void,
): boolean | undefined {
    if (payload.type !== 'getPageTranslationFontState') return undefined;
    const senderId = sender && typeof sender === 'object' ? (sender as {id?: unknown}).id : undefined;
    let extensionId: string | undefined;
    try { extensionId = browser.runtime.id; } catch { /* 扩展重载后 runtime 访问本身可能失效。 */ }
    if (typeof extensionId !== 'string' || !extensionId || senderId !== extensionId || ctx.isInvalid || config.on === false ||
        state.isPageSuspended?.() || !state.pageTranslationFont) {
        sendResponse({status: 'unavailable'});
        return true;
    }
    if (state.isSiteDisabled()) {
        sendResponse({status: 'disabled'});
        return true;
    }
    const documentToken = getFullPageTranslationDocumentToken();
    const pageUrl = window.location.href;
    sendResponse({status: 'success', browserDefault: state.pageTranslationFont.read(), documentToken, pageUrl});
    return true;
}
