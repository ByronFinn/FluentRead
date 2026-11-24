/**
 * @file src/core/site-adaptation/bbcCreditCaption.ts
 * 文件职责：识别 BBC 已核实图片结构中的纯署名图注，保留带叙述文字或其他阅读语义的图注。
 * 主要内容：限定同一最近 figure 的唯一原生图注与图片署名，严格比较规范空白后的完整文字；
 * 为内置 BBC adapter 补充裁剪、原文保护、快照省略及 mutation 边界，自定义替换不继承此能力。
 * 模块边界：只读取传入 DOM 与 adapter，不写入或克隆宿主 DOM，不新增 JSON 能力或跨兄弟重扫机制。
 */
import type {AdapterContext, TranslationSiteAdapter} from '../translation/types';

const ownedSelector = '[data-fr-translation-owned="true"]';
const creditSelector = '[data-testid="image"] > span, [data-testid="hero-image"] > span';
const semanticAttributes = ['role', 'tabindex', 'contenteditable', 'href', 'aria-label', 'aria-labelledby'];

function isOwned(element: Element): boolean {
    return element.closest(ownedSelector) !== null;
}

function nativeText(node: Node): string {
    if (node.nodeType === 3) return node.textContent!;
    if (node.nodeType !== 1 || isOwned(node as Element)) return '';
    return [...node.childNodes].map(nativeText).join('');
}

function normalize(text: string): string {
    return text.replace(/\s+/gu, ' ').trim();
}

/** 原站只有直接子级和一层 DIV 网格包装；不跨任意祖先关联图片与图注。 */
function isDirectFigurePart(element: Element, figure: Element): boolean {
    return element.parentElement === figure
        || (element.parentElement!.localName === 'div' && element.parentElement!.parentElement === figure);
}

function nativeElements(figure: Element, selector: string): Element[] {
    return [...figure.querySelectorAll(selector)].filter(element =>
        !isOwned(element) && element.closest('figure') === figure);
}

function nativeChildren(element: Element): Element[] {
    return [...element.children].filter(child => !isOwned(child));
}

function hasReadingSemantics(element: Element): boolean {
    return nativeChildren(element).length > 0 || semanticAttributes.some(attribute => element.hasAttribute(attribute));
}

function relatedCredit(caption: Element): Element | null {
    const figure = caption.closest('figure');
    if (!figure || !figure.closest('article') || isOwned(caption) || !isDirectFigurePart(caption, figure)) return null;
    const captions = nativeElements(figure, 'figcaption');
    const credits = nativeElements(figure, creditSelector);
    if (captions.length !== 1 || credits.length !== 1) return null;
    const credit = credits[0]!;
    const image = credit.parentElement!;
    if (!isDirectFigurePart(image, figure)
        || nativeChildren(image).filter(child => child.localName === 'img').length !== 1) return null;
    // 文字相等不能省略链接、强调、控件或其他原生阅读结构；自有副本不参与判断。
    if (hasReadingSemantics(caption) || hasReadingSemantics(credit)) return null;
    return credit;
}

export function isBbcCreditOnlyCaption(element: Element): boolean {
    const caption = element.closest('figcaption');
    if (!caption || isOwned(element)) return false;
    const credit = relatedCredit(caption);
    if (!credit) return false;
    const creditText = normalize(nativeText(credit));
    return creditText.length > 0 && normalize(nativeText(caption)) === `(Credit: ${creditText})`;
}

/** 署名变化不直接吞掉；调度器仍只保证处理当前脏根，不承诺旁边 caption 自动重扫。 */
function isCreditDependency(element: Element): boolean {
    const credit = element.closest(creditSelector);
    if (!credit || isOwned(element)) return false;
    const figure = credit.closest('figure');
    if (!figure) return false;
    return nativeElements(figure, 'figcaption').some(caption => relatedCredit(caption) === credit);
}

export function withBbcCreditCaptionProtection(adapter: TranslationSiteAdapter): TranslationSiteAdapter {
    const matchesCaption = (element: Element, context: AdapterContext) =>
        adapter.matches(context.url) && isBbcCreditOnlyCaption(element);
    // 保留原 adapter 属性描述符与惰性 getter；只覆盖本能力负责的四个边界。
    const wrapped = Object.create(Object.getPrototypeOf(adapter), Object.getOwnPropertyDescriptors(adapter)) as TranslationSiteAdapter;
    Object.defineProperty(wrapped, 'observedAttributes', {enumerable: true, get() {
        const attributes = adapter.observedAttributes;
        return attributes === null ? null : [...new Set([
            ...(attributes ?? []), 'data-testid', 'data-fr-translation-owned', ...semanticAttributes,
        ])];
    }});
    wrapped.decide = (element, context) => matchesCaption(element, context)
        ? {kind: 'prune-subtree', reason: 'bbc-news:credit-only-caption'} : adapter.decide(element, context);
    wrapped.shouldStayOriginal = (element, context) => matchesCaption(element, context)
        || adapter.shouldStayOriginal?.(element, context) === true;
    wrapped.shouldOmitFromTranslation = (element, context) => matchesCaption(element, context)
        || adapter.shouldOmitFromTranslation?.(element, context) === true;
    wrapped.shouldIgnoreMutation = (element, context) => {
        if (adapter.matches(context.url) && isCreditDependency(element)) return false;
        return matchesCaption(element, context) || adapter.shouldIgnoreMutation?.(element, context) === true;
    };
    return wrapped;
}
