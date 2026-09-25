/**
 * @file src/features/selection-translation/core.ts
 * 文件职责：集中划词翻译的纯交互与内容算法，包括请求代次、词典回退、触发展示状态、选区过滤、上下文摘要、弹窗锚点和语音语言规范化。
 * 主要内容：定义 SelectionRequestTokenGate、Presentation 状态机、选区/视口类型，处理同语种判断、文本清理、公式单份文本提取、敏感区域排除（img 不再排除，跨内联图片的文字选区仍出卡）、多矩形选择、弹窗定位、选区入口抑制判定及仅用于朗读的普通话语言别名。
 * 模块边界：本模块不监听 document selection、不发消息、不渲染 Vue 或播放音频；组件负责连接 DOM，词典和 TTS 由 services/background 提供，函数保持确定性以供单元测试。
 */
import {getElementTagName, isTopLevelApplicationShell} from '@/src/core/translation/public';
import {getChineseScript, normalizeChineseLanguageCode} from '@/src/core/language/chinese';
import {isLanguageCodeMatch} from '@/src/core/language/codes';

export interface SelectionRect {
    top: number;
    right: number;
    bottom: number;
    left: number;
    width: number;
    height: number;
}

export interface PopupSize {
    width: number;
    height: number;
}

export interface ViewportSize {
    width: number;
    height: number;
}

export interface PopupPosition {
    left: number;
    top: number;
    placement: 'top' | 'bottom';
}

export interface SelectionContentRequest {
    text: string;
    targetLanguage: string;
    generation: number;
}

export interface SelectionAnswerCandidate extends SelectionContentRequest {
    answer: string;
}

/** 为每条异步通道维护独立代次，避免一种请求的完成结果误废弃另一种请求。 */
export class SelectionRequestTokenGate {
    private generation = 0;

    begin(): number {
        this.generation += 1;
        return this.generation;
    }

    invalidate(): void {
        this.generation += 1;
    }

    isCurrent(token: number): boolean {
        return token === this.generation;
    }
}

function normalizeSelectionRequestLanguage(value: string): string {
    return normalizeChineseLanguageCode(String(value || '')).replace(/_/g, '-').toLowerCase();
}

/** ECDICT 随包附带的辅助释义是简体中文，仅在目标语言兼容时参与回退。 */
export function canUseBundledDictionaryFallback(targetLanguage: string): boolean {
    return normalizeSelectionRequestLanguage(targetLanguage) === 'zh-hans';
}

export function resolveSelectionDictionaryFallback(targetLanguage: string, translatedDefinitions: readonly unknown[]): string {
    if (!canUseBundledDictionaryFallback(targetLanguage)) return '';
    return translatedDefinitions
        .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
        .map(value => value.trim())
        .slice(0, 4)
        .join('；');
}

export function resolveSelectionVocabularyAnswer(
    current: SelectionContentRequest | null,
    translation: SelectionAnswerCandidate | null,
    dictionary: SelectionAnswerCandidate | null,
): string {
    if (!current) return '';
    const matches = (candidate: SelectionAnswerCandidate | null): candidate is SelectionAnswerCandidate => Boolean(
        candidate
        && candidate.generation === current.generation
        && candidate.text === current.text
        && normalizeSelectionRequestLanguage(candidate.targetLanguage) === normalizeSelectionRequestLanguage(current.targetLanguage)
        && candidate.answer.trim(),
    );
    if (matches(translation)) return translation.answer.trim();
    return matches(dictionary) ? dictionary.answer.trim() : '';
}

export interface SelectionPresentationState {
    showIndicator: boolean;
    showTooltip: boolean;
}

export type SelectionPresentationTrigger = 'direct' | 'icon' | 'dot' | 'shortcut';

/** 延迟配置变化仍以当前选区稳定时刻为起点，避免刷新配置后重新等待完整时长。 */
export function getSelectionPresentationDelayRemaining(
    delay: number,
    selectionSettledAt: number,
    now: number,
): number {
    const elapsed = Math.max(0, now - selectionSettledAt);
    return Math.max(0, delay - elapsed);
}

/** 与展示无关的配置刷新不能关闭用户已经明确打开的翻译浮层。 */
export function reconcileSelectionPresentation(
    current: SelectionPresentationState,
    trigger: SelectionPresentationTrigger,
    triggerChanged: boolean,
): SelectionPresentationState {
    if (!triggerChanged) return current;
    if (trigger === 'direct') return { showIndicator: false, showTooltip: true };
    if (trigger === 'shortcut') return { showIndicator: false, showTooltip: false };
    return { showIndicator: true, showTooltip: false };
}

export interface SelectionEntryGuards {
    /** 纯中文选区且目标语言为中文：翻译与读懂都不适用。 */
    chineseOnly: boolean;
    /** 选区已是目标语言：翻译无意义。 */
    inTargetLanguage: boolean;
    readingEnabled: boolean;
    commentEnabled: boolean;
}

/** 选区入口统一抑制：评论入口可用时不再吞掉中文/目标语言选区；读懂仍沿用原有关预检。 */
export function shouldSkipSelectionEntry(guards: SelectionEntryGuards): boolean {
    if (guards.chineseOnly) return !guards.commentEnabled;
    if (guards.inTargetLanguage) return !guards.readingEnabled && !guards.commentEnabled;
    return false;
}

/** 选区检测结果与目标语言使用统一标签规则比较；中文必须具有一致的明确书写体系。 */
export function isSameLanguage(detectedLanguage: string | undefined, targetLanguage: string | undefined): boolean {
    return isLanguageCodeMatch(detectedLanguage, targetLanguage);
}

const DEFAULT_PADDING = 12;
const DEFAULT_GAP = 10;

/** 规范化浏览器选区文本，同时保留对阅读有意义的换行。 */
export function normalizeSelectionText(value: string): string {
    return value
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n[ \t]+/g, '\n')
        .trim();
}

export function summarizeSelectionContext(
    containerText: string,
    selectedText: string,
    maxLength = 500,
    selectedIndex?: number,
): string {
    const normalized = String(containerText || '').replace(/\s+/gu, ' ').trim();
    const selected = String(selectedText || '').trim();
    if (!normalized || !selected || maxLength < 16) return '';
    if (normalized.length <= maxLength) return normalized;
    const normalizedLower = normalized.toLocaleLowerCase();
    const selectedLower = selected.toLocaleLowerCase();
    const firstIndex = normalizedLower.indexOf(selectedLower);
    if (firstIndex < 0) return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
    let matchedIndex = firstIndex;
    if (typeof selectedIndex === 'number' && Number.isFinite(selectedIndex)) {
        const preferredIndex = Math.max(0, Math.min(normalized.length, selectedIndex));
        const leftIndex = normalizedLower.lastIndexOf(selectedLower, preferredIndex);
        const rightIndex = normalizedLower.indexOf(selectedLower, preferredIndex);
        if (leftIndex < 0) matchedIndex = rightIndex;
        else if (rightIndex < 0) matchedIndex = leftIndex;
        else matchedIndex = preferredIndex - leftIndex <= rightIndex - preferredIndex ? leftIndex : rightIndex;
    }
    const contentLength = Math.max(1, maxLength - 2);
    const selectedCenter = matchedIndex + selected.length / 2;
    const start = Math.max(0, Math.min(normalized.length - contentLength, Math.round(selectedCenter - contentLength / 2)));
    const end = Math.min(normalized.length, start + contentLength);
    const prefix = start > 0 ? '…' : '';
    const suffix = end < normalized.length ? '…' : '';
    return `${prefix}${normalized.slice(start, end).trim()}${suffix}`.slice(0, maxLength);
}

// 只把有明确渲染器身份的数学子树视为原子，不能放开普通 aria-hidden/SVG 控件。
const selectionFormulaSelector = 'math, mjx-container, .MathJax, .MathJax_Display, .MathJax_SVG, .MathJax_CHTML, .katex';

/** 选区中的公式只取一份可读表示，避免浏览器把可视字形、辅助 MathML 与 TeX 串在一起。 */
export function readSelectionText(range: Range, browserText: string): string {
    const ancestor = elementFromSelectionNode(range.commonAncestorContainer);
    if (ancestor?.closest(selectionFormulaSelector)) return '';
    if (!ancestor?.querySelector(selectionFormulaSelector)) return normalizeSelectionText(browserText);
    const fragment = ancestor.ownerDocument.createElement('div');
    fragment.append(range.cloneContents());
    const formulas = Array.from(fragment.querySelectorAll(selectionFormulaSelector))
        .filter(element => !element.parentElement?.closest(selectionFormulaSelector));
    if (formulas.length === 0) return normalizeSelectionText(browserText);
    const prose = fragment.cloneNode(true) as HTMLElement;
    prose.querySelectorAll(`${selectionFormulaSelector}, script, style, .MathJax_Preview`).forEach(element => element.remove());
    if (!/\p{L}/u.test(prose.textContent!)) return '';
    for (const formula of formulas) {
        const tex = formula.nextElementSibling?.matches('script[type^="math/tex"]')
            ? formula.nextElementSibling.textContent
            : formula.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
        formula.querySelectorAll('.MJX_Assistive_MathML, mjx-assistive-mml, .katex-mathml, annotation, annotation-xml').forEach(element => element.remove());
        const text = normalizeSelectionText(tex || formula.textContent!);
        formula.replaceWith(fragment.ownerDocument!.createTextNode(text ? `$${text}$` : ''));
    }
    fragment.querySelectorAll('script, style, .MathJax_Preview').forEach(element => element.remove());
    return normalizeSelectionText(fragment.textContent!);
}

/** 相交的公式可留在正文选区内，交互控件与外层显式排除区域仍受原规则保护。 */
function isInlineSelectionFormulaPart(element: Element): boolean {
    const root = element.closest(selectionFormulaSelector);
    if (!root) return false;
    if (isEditableSelectionElement(element)) return false;
    const tag = getElementTagName(element);
    if ((selectionExcludedTagNames.has(tag) && tag !== 'math' && tag !== 'svg') ||
        selectionExcludedRoles.has(element.getAttribute('role')?.trim().toLowerCase() ?? '')) return false;
    const outer = root.parentElement?.closest(selectionFormulaSelector) ?? root;
    return !isSelectionExcludedElement(outer.parentElement);
}

// img 不再排除：文字选区跨越内联图片或 emoji 图片（如 X 的 twemoji）时仍需出卡，
// 纯图片选区因快照读不到文本会自然跳过，无需在此拦截。
const selectionExcludedTagNames = new Set([
    'audio', 'button', 'canvas', 'code', 'embed', 'iframe', 'input',
    'kbd', 'math', 'object', 'option', 'picture', 'pre', 'samp', 'select',
    'svg', 'template', 'textarea', 'var', 'video',
]);

const selectionExcludedRoles = new Set([
    'button', 'checkbox', 'combobox', 'listbox', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'radio', 'scrollbar', 'slider', 'spinbutton',
    'switch', 'tab', 'textbox',
]);

const selectionExcludedSelector = [
    '.fluent-read-bilingual-content',
    '.fluent-read-loading',
    '.fluent-read-retry-wrapper',
    '.notranslate',
    '[aria-hidden="true"]',
    '[data-fluent-read-ui]',
    '[data-notranslate="true"]',
    '[role="button"]',
    '[role="checkbox"]',
    '[role="combobox"]',
    '[role="listbox"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="option"]',
    '[role="radio"]',
    '[role="scrollbar"]',
    '[role="slider"]',
    '[role="spinbutton"]',
    '[role="switch"]',
    '[role="tab"]',
    '[role="textbox"]',
    '[translate="no"]',
    '[contenteditable="true"]',
    '[contenteditable="plaintext-only"]',
    ...Array.from(selectionExcludedTagNames, (tagName) => tagName),
].join(',');

export function isSelectionExcludedTagName(tagName: string): boolean {
    return selectionExcludedTagNames.has(tagName.trim().toLowerCase());
}

function isEditableSelectionElement(element: Element): boolean {
    if ((element as HTMLElement).isContentEditable) return true;

    let current: Element | null = element;
    while (current) {
        if (current.hasAttribute('contenteditable')) {
            return current.getAttribute('contenteditable')?.trim().toLowerCase() !== 'false';
        }
        current = current.parentElement;
    }
    return false;
}

function isIntrinsicallyExcludedSelectionElement(element: Element): boolean {
    if (isSelectionExcludedTagName(getElementTagName(element))) return true;

    const role = element.getAttribute('role')?.trim().toLowerCase();
    if (role && selectionExcludedRoles.has(role)) return true;
    return isEditableSelectionElement(element);
}

function isSelectionExcludedElement(element: Element | null): boolean {
    if (!element) return false;
    if (isIntrinsicallyExcludedSelectionElement(element)) return true;

    const excluded = element.closest(selectionExcludedSelector);
    if (!excluded) return false;
    // A broad marker on a body-level SPA shell should not suppress a direct user
    // selection, while the boundary element itself and nested protected regions remain excluded.
    return excluded === element || !isTopLevelApplicationShell(excluded);
}

function elementFromSelectionNode(node: Node | null): Element | null {
    if (!node) return null;
    return node.nodeType === 1 ? node as Element : node.parentElement;
}

function selectionExcludedDescendants(range: Range): Element[] {
    const commonAncestor = range.commonAncestorContainer;
    const queryRoot = commonAncestor.nodeType === 3 ? commonAncestor.parentElement : commonAncestor;
    if (!queryRoot || !('querySelectorAll' in queryRoot)) return [];
    return Array.from((queryRoot as ParentNode).querySelectorAll(selectionExcludedSelector));
}

function containsNonZeroClientRect(rects: DOMRectList): boolean {
    return Array.from(rects).some(rect => rect.width > 0 || rect.height > 0);
}

function hasNonZeroClientRect(element: Element): boolean {
    if (containsNonZeroClientRect(element.getClientRects())) return true;

    const contentRange = element.ownerDocument?.createRange();
    if (!contentRange) return false;
    contentRange.selectNodeContents(element);
    return containsNonZeroClientRect(contentRange.getClientRects());
}

/**
 * 划词翻译只处理页面正文，不处理原子内容或交互控件；内联图片与 emoji 图片不算原子内容，
 * 跨越它们的文字选区仍会出卡。这里同时检查选区两端与实时 DOM 中相交且具有可见几何的
 * 排除元素，避免隐藏控件误伤浏览器生成的段落选区。
 */
export function shouldIgnoreSelection(range: Range): boolean {
    const boundaries = [
        elementFromSelectionNode(range.startContainer),
        elementFromSelectionNode(range.endContainer),
    ];
    if (boundaries.some(element => isSelectionExcludedElement(element) &&
        !(element && isInlineSelectionFormulaPart(element)))) return true;

    try {
        return selectionExcludedDescendants(range).some((element) => {
            try {
                if (!isIntrinsicallyExcludedSelectionElement(element) &&
                    isTopLevelApplicationShell(element)) return false;
                if (isInlineSelectionFormulaPart(element)) return false;
                return range.intersectsNode(element) && hasNonZeroClientRect(element);
            } catch {
                return false;
            }
        });
    } catch {
        return false;
    }
}

/**
 * 选择最靠近选区焦点的视觉边缘；使用客户端矩形可以避免把入口放在多行选区中间。
 */
export function chooseSelectionRect(rects: SelectionRect[], isForward = true): SelectionRect | null {
    if (rects.length === 0) return null;
    return isForward ? rects[rects.length - 1] : rects[0];
}

/**
 * 以当前选中行作为弹层锚点并限制在视口内。计算保持为纯函数，使滚动和缩放行为
 * 无需挂载 Vue、也不依赖宿主页面 CSS 即可测试。
 */
export function calculateSelectionPopupPosition(
    anchor: SelectionRect,
    popup: PopupSize,
    viewport: ViewportSize,
    padding = DEFAULT_PADDING,
    gap = DEFAULT_GAP,
): PopupPosition {
    const maxLeft = Math.max(padding, viewport.width - popup.width - padding);
    const left = clamp(anchor.left, padding, maxLeft);
    const fitsAbove = anchor.top - popup.height - gap >= padding;
    const placement = fitsAbove ? 'top' : 'bottom';
    const rawTop = fitsAbove ? anchor.top - popup.height - gap : anchor.bottom + gap;
    const maxTop = Math.max(padding, viewport.height - popup.height - padding);

    return {
        left,
        top: clamp(rawTop, padding, maxTop),
        placement,
    };
}

/** 阅读卡先预留固定视窗，再选择位置；正文增长不能改变定位尺寸或上下方位。 */
export function calculateReadingPopupLayout(anchor: SelectionRect, viewport: ViewportSize): PopupPosition & PopupSize {
    const width = Math.max(0, Math.min(388, viewport.width - 2 * DEFAULT_PADDING));
    const height = Math.max(0, Math.min(520, viewport.height - 2 * DEFAULT_PADDING));
    return {...calculateSelectionPopupPosition(anchor, {width, height}, viewport), width, height};
}

export function normalizeSpeechLanguage(language: string | undefined, fallback = 'en-US'): string {
    const normalized = String(language ?? '').trim().replace(/_/g, '-');
    const lower = normalized.toLowerCase();
    if (!normalized || ['auto', 'detect', 'unknown', 'und'].includes(lower)) return fallback;

    const script = getChineseScript(normalized);
    if (script) return script === 'Hans' ? 'zh-CN' : 'zh-TW';

    const aliases: Record<string, string> = {
        // 只选择普通话朗读音色，不据此推断原文的简繁或跳过翻译。
        'cmn': 'zh-CN',
        'zho': 'zh-CN',
        'chi': 'zh-CN',
        'en': 'en-US',
        'ja': 'ja-JP',
        'ko': 'ko-KR',
        'fr': 'fr-FR',
        'de': 'de-DE',
        'es': 'es-ES',
        'it': 'it-IT',
        'pt': 'pt-BR',
        'ru': 'ru-RU',
    };

    if (aliases[lower]) return aliases[lower];
    return /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(normalized) ? normalized : fallback;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}
