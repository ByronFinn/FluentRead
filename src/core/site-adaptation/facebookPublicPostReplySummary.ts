/**
 * @file src/core/site-adaptation/facebookPublicPostReplySummary.ts
 * 文件职责：保护已核实 Facebook 中文公开帖中的原生“作者回复了 / 计数”摘要控件。
 * 主要内容：复验 post dialog 的 IDREF 与唯一 article/message，限定评论 article 的兄弟卡片、
 * 原生四槽 avatar/作者/隐藏分隔符/计数结构，并与当前主作者链接的完整动态文本严格比较。
 * 模块边界：仅纯只读 DOM 与内置 adapter 装饰，不点击、不读取图像 URL、不匹配固定姓名；
 * 未知 locale、额外阅读文字或关系变化均保留通用路径，用户覆盖/停用撤销本能力。
 */
import {
    getFacebookPublicPostContext, withFacebookPublicPostProtection,
    isFacebookOwned as isOwned, facebookNativeElements as nativeElements,
    facebookNativeChildren as children, facebookNativeTextValue as text,
    facebookOnlyNativeChild as onlyChild, facebookControlSemanticAttributes as blockedAttributes,
} from './facebookPublicPostDialogLabel';
import type {TranslationSiteAdapter} from '../translation/types';

const bodySelector = '[data-ad-preview="message"], span[dir="auto"][lang]';

function wrapper(element: Element, tag = 'div'): boolean {
    return element.localName === tag && !blockedAttributes.some(attribute => element.hasAttribute(attribute))
        && ![...element.childNodes].some(node => node.nodeType === 3 && node.textContent!.trim().length > 0);
}

function textSlot(element: Element, separator = false): boolean {
    return [element, ...nativeElements(element, '*')].every(node =>
        (node === element || node.localName === 'span')
        && !blockedAttributes.some(attribute => node.hasAttribute(attribute))
        && (separator || !node.hasAttribute('aria-hidden')));
}

function avatarSlot(element: Element): boolean {
    const container = onlyChild(element, 'div');
    if (!container || !wrapper(element) || !wrapper(container)) return false;
    const svg = onlyChild(container, 'svg');
    if (!svg || svg.getAttribute('aria-hidden') !== 'true' || svg.getAttribute('role') !== 'none') return false;
    return text(svg) === '' && nativeElements(svg, '*').every(node => ['mask', 'circle', 'g', 'image'].includes(node.localName))
        && nativeElements(svg, 'mask').length === 1 && nativeElements(svg, 'image').length === 1;
}

/** 调用方先核对主帖上下文；原生回复控件是评论 article 外的同卡片第二子树。 */
export function hasFacebookPublicPostReplyCard(button: Element): boolean {
    const leaf = button.parentElement!;
    const branch = leaf.parentElement!;
    const replies = branch.parentElement;
    const card = replies?.parentElement;
    if (!replies || !card) return false;
    if (![leaf, branch, replies, card].every(node => wrapper(node))) return false;
    const cardParts = children(card), leafParts = children(leaf);
    if (cardParts.length !== 2 || cardParts[1] !== replies
        || !cardParts[0]!.matches('[role="article"][aria-label][tabindex="-1"]')
        || nativeElements(cardParts[0]!, 'span[dir="auto"][lang]').length !== 1
        || onlyChild(replies, 'div') !== branch || onlyChild(branch, 'div') !== leaf
        || leafParts.length !== 2 || leafParts[1] !== button || !wrapper(leafParts[0]!)
        || children(leafParts[0]!).length !== 0) return false;
    return true;
}

export function isFacebookPublicPostReplySummary(element: Element): boolean {
    const button = element.closest('div[role="button"][tabindex="0"]');
    if (!button || isOwned(element) || button.closest(bodySelector) || nativeElements(button, bodySelector).length > 0
        || ['contenteditable', 'href', 'aria-label', 'aria-labelledby'].some(attribute => button.hasAttribute(attribute))) return false;
    const dialog = button.closest('[role="dialog"][aria-modal="true"]');
    if (!dialog) return false;
    const heading = nativeElements(dialog, 'h2[dir="auto"]').find(node => !node.closest('[role="article"]'));
    const context = heading && getFacebookPublicPostContext(heading);
    if (!context || button.closest('[role="article"]') !== context.article || !hasFacebookPublicPostReplyCard(button)) return false;

    if ([...button.childNodes].some(node => node.nodeType === 3 && node.textContent!.trim().length > 0)) return false;
    const outer = onlyChild(button, 'span');
    const inner = outer && onlyChild(outer, 'span');
    const row = inner && onlyChild(inner, 'div');
    if (!outer || !inner || !row || !wrapper(outer, 'span') || !wrapper(inner, 'span')
        || inner.getAttribute('dir') !== 'auto' || !wrapper(row)) return false;
    const slots = children(row);
    if (slots.length !== 4 || slots.some(slot => slot.localName !== 'div')) return false;
    const [avatar, author, separator, count] = slots as [Element, Element, Element, Element];
    if (!avatarSlot(avatar) || !textSlot(author) || !textSlot(separator, true) || !textSlot(count)) return false;
    const hidden = nativeElements(separator, '[aria-hidden]');
    if (hidden.length !== 1 || hidden[0]!.localName !== 'span' || hidden[0]!.getAttribute('aria-hidden') !== 'true'
        || text(hidden[0]!) !== '·' || text(separator) !== '·' || !/^\d+条回复$/u.test(text(count))) return false;

    const profiles = nativeElements(context.article, '[data-ad-rendering-role="profile_name"]').filter(profile =>
        profile.closest('[role="article"]') === context.article && !profile.closest(bodySelector));
    if (profiles.length !== 1) return false;
    const links = nativeElements(profiles[0]!, 'h3 a[role="link"]');
    if (links.length !== 1 || !nativeElements(links[0]!, '*').every(node =>
        ['b', 'span'].includes(node.localName) && !blockedAttributes.some(attribute => node.hasAttribute(attribute)))) return false;
    const name = text(links[0]!);
    return name.length > 0 && text(author) === `${name}回复了`;
}

export function withFacebookPublicPostReplySummaryProtection(adapter: TranslationSiteAdapter): TranslationSiteAdapter {
    return withFacebookPublicPostProtection(adapter, isFacebookPublicPostReplySummary,
        'facebook-public-post:reply-summary', ['lang', 'aria-hidden', 'data-ad-rendering-role']);
}
