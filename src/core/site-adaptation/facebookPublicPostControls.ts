/**
 * @file src/core/site-adaptation/facebookPublicPostControls.ts
 * 文件职责：保护实站已证实会被翻译的 Facebook 分享计数、全部回复入口和评论排序菜单。
 * 主要内容：先以原生 button/span 和完整中文字面格式排除阅读正文，再动态核对已验证的
 * post dialog/article/message；全部回复复用评论卡片兄弟关系，排序核对菜单语义与评论 pane。
 * 模块边界：纯只读内置 adapter 装饰，不写 DOM、不点击、不依赖样式类、具体计数或作者名；
 * 仅支持当前实测 UI 格式，额外正文、交互阅读结构和未知 locale 均不授予 metadata 保护。
 */
import {
    getFacebookPublicPostContext, withFacebookPublicPostProtection,
    isFacebookOwned as isOwned, facebookNativeElements as nativeElements,
    facebookNativeChildren as children, facebookNativeTextValue as text,
    facebookOnlyNativeChild as onlyChild, facebookControlSemanticAttributes as blockedAttributes,
} from './facebookPublicPostDialogLabel';
import {hasFacebookPublicPostReplyCard} from './facebookPublicPostReplySummary';
import type {TranslationSiteAdapter} from '../translation/types';

const bodySelector = '[data-ad-preview="message"], span[dir="auto"][lang]';

function directText(element: Element): string {
    return [...element.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent!).join('').trim();
}

function plain(element: Element, tag: string): boolean {
    return element.localName === tag && !blockedAttributes.some(attribute => element.hasAttribute(attribute));
}

function isCommentSort(button: Element, span: Element, article: Element): boolean {
    if (button.getAttribute('aria-haspopup') !== 'menu' || button.getAttribute('aria-expanded') !== 'false'
        || span.getAttribute('dir') !== 'auto' || directText(span) !== '最相关' || text(span) !== '最相关') return false;
    const decoration = onlyChild(span, 'div');
    if (!decoration || !plain(decoration, 'div') || directText(decoration) !== '') return false;
    const parts = children(decoration);
    if (parts.length !== 2 || !plain(parts[0]!, 'span') || children(parts[0]!).length !== 0 || text(parts[0]!) !== ''
        || !plain(parts[1]!, 'div') || directText(parts[1]!) !== '') return false;
    const svg = onlyChild(parts[1]!, 'svg');
    if (!svg || svg.getAttribute('aria-hidden') !== 'true' || text(svg) !== ''
        || children(svg).length !== 1 || children(svg)[0]!.localName !== 'path') return false;
    const parent = button.parentElement!, header = parent.parentElement!, pane = header.parentElement;
    if (!pane || ![parent, header, pane].every(node => plain(node, 'div') && directText(node) === '')
        || onlyChild(parent, 'div') !== button || onlyChild(header, 'div') !== parent
        || pane.closest('[role="article"]') !== article) return false;
    const paneParts = children(pane);
    if (paneParts.length !== 2 || paneParts[0] !== header || !plain(paneParts[1]!, 'div')) return false;
    const comments = nativeElements(paneParts[1]!, '[role="article"][aria-label][tabindex="-1"]');
    return comments.length > 0 && comments.every(comment =>
        nativeElements(comment, 'span[dir="auto"][lang]').length === 1);
}

export function isFacebookPublicPostControl(element: Element): boolean {
    const button = element.closest('div[role="button"][tabindex="0"]');
    if (!button || isOwned(element) || button.closest(bodySelector) || nativeElements(button, bodySelector).length > 0
        || ['contenteditable', 'href', 'aria-label', 'aria-labelledby'].some(attribute => button.hasAttribute(attribute))
        || directText(button) !== '') return false;
    const span = onlyChild(button, 'span');
    if (!span || !plain(span, 'span')) return false;
    const source = text(span);
    const share = /^\d+次分享$/u.test(source), expand = /^全部\d+条回复$/u.test(source);
    const sort = directText(span) === '最相关';
    // 普通段落与控件文案先排除，不为它们扫描全页 ID 或 main article。
    if (!share && !expand && !sort) return false;
    const dialog = button.closest('[role="dialog"][aria-modal="true"]');
    if (!dialog) return false;
    const heading = nativeElements(dialog, 'h2[dir="auto"]').find(node => !node.closest('[role="article"]'));
    const context = heading && getFacebookPublicPostContext(heading);
    if (!context || button.closest('[role="article"]') !== context.article) return false;
    if (sort) return isCommentSort(button, span, context.article);
    if (button.hasAttribute('aria-haspopup') || button.hasAttribute('aria-expanded')
        || ![span, ...nativeElements(span, '*')].every(node => plain(node, 'span') && !node.hasAttribute('aria-hidden'))) return false;
    const inner = onlyChild(span, 'span');
    return Boolean(inner && (share ? span.getAttribute('dir') === 'auto'
        : inner.getAttribute('dir') === 'auto' && hasFacebookPublicPostReplyCard(button)));
}

export function withFacebookPublicPostControlsProtection(adapter: TranslationSiteAdapter): TranslationSiteAdapter {
    return withFacebookPublicPostProtection(adapter, isFacebookPublicPostControl,
        'facebook-public-post:ui-control', ['lang', 'aria-hidden', 'aria-haspopup', 'aria-expanded']);
}
