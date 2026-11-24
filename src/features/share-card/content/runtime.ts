/**
 * @file src/features/share-card/content/runtime.ts
 * 文件职责：为划词翻译结果提供制作卡片动作，按需创建独立封闭 Shadow UI。
 * 主要内容：启动仅记录可用状态，用户从划词结果主动打开时复用工作台；保存挂载代次与清理句柄，停用和卸载释放全部资源。
 * 模块边界：只接收调用方传入的原文与译文，不监听网页悬停或焦点、不读取正文；卡片渲染和样式存储归 UI，页面总开关由 content registry 编排。
 */
import type {ContentScriptContext} from 'wxt/utils/content-script-context';
import type {ShadowRootContentScriptUi} from 'wxt/utils/content-script-ui/shadow-root';
import {createVueShadowUi, type VueShadowMount} from '@/src/platform/shadow-ui';
import {showPageNotice} from '@/src/features/page-notice/public';
import {config} from '@/src/services/config/store';
import {normalizeUiLanguage, translate} from '@/src/core/i18n';
import {cardSourceDomain, type ShareCardExcerpt} from '../core';
import ShareCardStudio from '../ui/ShareCardStudio.vue';

interface Studio {open(excerpt: ShareCardExcerpt): Promise<void>}
let context: ContentScriptContext | null = null;
let controller: AbortController | null = null;
let ui: ShadowRootContentScriptUi<VueShadowMount> | null = null;
let pending: Promise<Studio | null> | null = null;
let generation = 0;
const HOST_ID = 'fluent-read-share-card-container';

function instance(): Studio | null { return ui?.mounted?.instance as Studio | null ?? null; }
export function isShareCardMounted(): boolean { return Boolean(controller && !controller.signal.aborted); }
function reportOpenFailure(): void {
    showPageNotice(translate('shareCard.openFailed', normalizeUiLanguage(config.uiLanguage)), 'error');
}
async function ensureStudio(): Promise<Studio | null> {
    if (ui && !ui.shadowHost.isConnected) {
        // 先释放旧引用，再卸载旧 Vue，避免清理回调误用后来创建的工作台。
        const detached = ui; ui = null; detached.remove();
    }
    if (!controller || !context || context.isInvalid || config.on === false) return null;
    if (ui) return instance();
    if (!pending) {
        const current = generation;
        const task = createVueShadowUi(context, {
            name: 'fluent-read-share-card-ui', hostId: HOST_ID, component: ShareCardStudio, mode: 'closed',
        }).then(created => {
            if (current !== generation || !controller || context?.isInvalid || config.on === false) { created.remove(); return null; }
            ui = created; return instance();
        }).finally(() => { if (pending === task) pending = null; });
        pending = task;
    }
    return pending;
}
export async function openShareCard(excerpt: {original: string; translation: string}): Promise<void> {
    if (!controller || config.on === false || !excerpt.original.trim() || !excerpt.translation.trim()) return;
    const current = generation;
    const snapshot = {original: excerpt.original, translation: excerpt.translation, source: cardSourceDomain(location.href)};
    try {
        const studio = await ensureStudio();
        if (!studio || current !== generation || !config.on || context?.isInvalid) return;
        await studio.open(snapshot);
    } catch { if (current === generation) reportOpenFailure(); }
}
export function mountShareCard(ctx: ContentScriptContext): void {
    if (controller || ctx.isInvalid) return;
    context = ctx; controller = new AbortController();
}
export function unmountShareCard(): void {
    generation++; controller?.abort(); controller = null; context = null;
    pending = null; const previous = ui; ui = null; previous?.remove();
}
