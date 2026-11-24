/**
 * @file src/features/paragraph-copy/core.ts
 * 文件职责：把鼠标命中的段落节点转换成可写入剪贴板的文本，负责区分原文与 FluentRead 译文、保留代码块换行，并按配置口径组合最终内容。
 * 主要内容：导出 PARAGRAPH_COPY_BLOCK_SELECTOR、ParagraphTexts、ParagraphCopyPayload、findCopyableBlock、readParagraphTexts 与 composeParagraphCopyText，内部维护块级标签、跳过标签与插件 UI 选择器；普通正文折叠空白，代码块保留首行缩进和内部连续空行。
 * 模块边界：本模块只读取传入的 DOM 并返回纯字符串结果，不监听事件、不读取配置存储、不访问剪贴板，也不发起翻译；快捷键口径归 core/config/paragraphCopy，手势与提示归 content 运行时。
 */
import type {ParagraphCopyContentMode} from '@/src/core/config/paragraphCopy';

/** 鼠标命中非翻译候选（代码块、表格单元格等）时向上寻找的最小可复制块。 */
export const PARAGRAPH_COPY_BLOCK_SELECTOR = [
    'p', 'li', 'dd', 'dt', 'td', 'th', 'blockquote', 'pre', 'figcaption', 'summary',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'article', 'section', 'aside', 'main', 'div',
].join(',');

/**
 * FluentRead 自己的界面宿主不是网页正文，命中时不复制。
 * 这里按 id 前缀匹配而不是逐个列出悬浮球、划词、圈选等容器：新增界面无需回来补充，
 * 同时避免把只在扩展中存在的容器 id 带进 userscript 产物。
 */
const EXTENSION_UI_SELECTOR = [
    '[id^="fluent-read-"]',
    '.fluent-read-video-ui',
    '[data-fluent-read-ui]',
].join(',');

/** 双语模式下追加在原文后的译文包裹层。 */
const BILINGUAL_CONTENT_SELECTOR = '.fluent-read-bilingual-content[data-fr-translation-owned="true"]';

/** 仅译文模式把原文留在轻 DOM，译文写在闭合 ShadowRoot 与 aria-label 中。 */
const SINGLE_SLOT_SELECTOR = '.fluent-read-single-slot[data-fr-translation-owned="true"]';

/** 取原文时要整体跳过的插件产物：译文包裹层、加载指示器和重试按钮。 */
const TRANSLATION_ARTIFACT_SELECTOR = [
    BILINGUAL_CONTENT_SELECTOR,
    '.fluent-read-loading',
    '.fluent-read-retry-wrapper',
    EXTENSION_UI_SELECTOR,
].join(',');

const SKIPPED_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'audio', 'video']);

const BLOCK_TAGS = new Set([
    'address', 'article', 'aside', 'blockquote', 'dd', 'div', 'dl', 'dt', 'fieldset', 'figcaption',
    'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main',
    'nav', 'ol', 'p', 'pre', 'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

interface TextSegment {
    value: string;
    /** 原样保留：换行占位与代码块内容不参与空白折叠。 */
    raw: boolean;
}

export interface ParagraphTexts {
    original: string;
    translation: string;
    /** 段落当前呈现给用户的形态，决定"跟随显示"口径复制什么。 */
    display: 'original' | 'bilingual' | 'translation';
}

export interface ParagraphCopyPayload {
    text: string;
    kind: 'original' | 'translation' | 'bilingual';
    /** 用户要求译文但该段落尚未翻译，已回退为原文。 */
    missingTranslation: boolean;
}

function tagNameOf(element: Element): string {
    const name = element.tagName;
    return typeof name === 'string' ? name.toLowerCase() : '';
}

function matchesSelector(element: Element, selector: string): boolean {
    return typeof element.matches === 'function' && element.matches(selector);
}

/** 折叠空白后再拼接，避免行内标签之间丢失词间空格或带出缩进。 */
function renderSegments(segments: readonly TextSegment[]): string {
    const parts: string[] = [];
    let buffer = '';
    const flush = (): void => {
        const value = buffer.replace(/\s+/gu, ' ').trim();
        if (value) parts.push(value);
        buffer = '';
    };
    for (const segment of segments) {
        if (!segment.raw) {
            buffer += segment.value;
            continue;
        }
        flush();
        parts.push(segment.value);
    }
    flush();
    // 普通文本已在 flush 中规范化，只移除块边界的换行；整体 trim 或压缩换行会破坏 pre 的代码。
    return parts.join('').replace(/^\n+|\n+$/gu, '');
}

function pushBreak(segments: TextSegment[]): void {
    const last = segments[segments.length - 1];
    // 段落之间只留一个换行；开头不留空行。
    if (!last || (last.raw && last.value === '\n')) return;
    segments.push({value: '\n', raw: true});
}

/** 收集节点的可见文字；skipTranslationArtifacts 决定是否排除 FluentRead 写入的译文。 */
function collectSegments(node: Node, segments: TextSegment[], skipTranslationArtifacts: boolean): void {
    type Frame = {node: Node; segments: TextSegment[]} | {segments: TextSegment[]; inner?: TextSegment[]};
    const pending: Frame[] = [{node, segments}];
    // 使用显式栈保留进入/退出顺序，页面 DOM 的深度不再消耗 JavaScript 调用栈。
    while (pending.length) {
        const frame = pending.pop()!;
        const output = frame.segments;
        if (!('node' in frame)) {
            if (frame.inner) {
                // 代码块整体按原样保留缩进和换行。
                const raw = frame.inner.map((segment) => segment.value).join('').replace(/^\n+|\s+$/gu, '');
                if (raw) output.push({value: raw, raw: true});
            }
            pushBreak(output);
            continue;
        }
        const current = frame.node;
        if (current.nodeType === 3) {
            output.push({value: current.nodeValue ?? '', raw: false});
            continue;
        }
        if (current.nodeType !== 1) continue;
        const element = current as Element;
        const tag = tagNameOf(element);
        if (SKIPPED_TAGS.has(tag)) continue;
        if (matchesSelector(element, skipTranslationArtifacts ? TRANSLATION_ARTIFACT_SELECTOR : EXTENSION_UI_SELECTOR)) continue;
        if (tag === 'br') {
            pushBreak(output);
            continue;
        }
        const block = BLOCK_TAGS.has(tag);
        const inner = tag === 'pre' ? [] : undefined;
        const childOutput = inner ?? output;
        if (block) {
            pushBreak(output);
            pending.push({segments: output, inner});
        }
        // 不为每个元素复制 childNodes；逆序入栈仍按文档顺序采集。
        const children = element.childNodes;
        for (let index = children.length - 1; index >= 0; index--) {
            pending.push({node: children[index], segments: childOutput});
        }
    }
}

function readText(element: Element, skipTranslationArtifacts: boolean): string {
    const segments: TextSegment[] = [];
    collectSegments(element, segments, skipTranslationArtifacts);
    return renderSegments(segments);
}

/** 译文按文档顺序收集：双语包裹层取可见文字，仅译文槽取 aria-label 上的译文。 */
function readTranslationText(element: Element): {text: string; display: 'original' | 'bilingual' | 'translation'} {
    if (typeof element.querySelectorAll !== 'function') return {text: '', display: 'original'};
    const parts: string[] = [];
    let bilingual = false;
    let single = false;
    let accepted: Element | null = null;
    for (const artifact of element.querySelectorAll(`${BILINGUAL_CONTENT_SELECTOR},${SINGLE_SLOT_SELECTOR}`)) {
        // querySelectorAll 按先序返回。退出上一个顶层产物后，不会再次进入它的子树，
        // 因此只需检查最近采集的产物，避免逐个比较所有既有兄弟节点。
        if (accepted?.contains(artifact)) continue;
        accepted = artifact;
        if (matchesSelector(artifact, SINGLE_SLOT_SELECTOR)) {
            const value = (artifact.getAttribute('aria-label') ?? '').trim();
            if (value) {
                single = true;
                parts.push(value);
            }
            continue;
        }
        const value = readText(artifact, false);
        if (value) {
            bilingual = true;
            parts.push(value);
        }
    }
    return {
        text: parts.join('\n'),
        display: bilingual ? 'bilingual' : single ? 'translation' : 'original',
    };
}

/** 读取段落的原文与译文；两者都来自当前 DOM，不依赖翻译会话状态。 */
export function readParagraphTexts(element: Element): ParagraphTexts {
    const {text: translation, display} = readTranslationText(element);
    return {original: readText(element, true), translation, display};
}

/**
 * 命中的节点不是翻译候选时，向上取最近的块级元素。
 * 命中 FluentRead 自己的界面时返回 null，插件不复制自己的按钮和面板文字。
 */
export function findCopyableBlock(element: Element | null | undefined): Element | null {
    if (!element) return null;
    if (matchesSelector(element, EXTENSION_UI_SELECTOR)
        || (typeof element.closest === 'function' && element.closest(EXTENSION_UI_SELECTOR))) return null;
    const block = typeof element.closest === 'function' ? element.closest(PARAGRAPH_COPY_BLOCK_SELECTOR) : null;
    if (block) return block;
    return (element.textContent ?? '').trim() ? element : null;
}

/**
 * 按配置口径组合最终文本。auto 跟随段落当前显示形态；显式选择译文或双语而该段落
 * 尚未翻译时回退原文并标记 missingTranslation，让提示能说明实际复制了什么。
 */
export function composeParagraphCopyText(
    texts: ParagraphTexts,
    mode: ParagraphCopyContentMode,
    translationBeforeOriginal = false,
): ParagraphCopyPayload | null {
    const requested = mode === 'auto' ? texts.display : mode;
    const missingTranslation = requested !== 'original' && !texts.translation;
    const kind = missingTranslation ? 'original' : requested;

    if (kind === 'translation') return {text: texts.translation, kind, missingTranslation};
    if (kind === 'bilingual' && texts.original) {
        const ordered = translationBeforeOriginal
            ? [texts.translation, texts.original]
            : [texts.original, texts.translation];
        return {text: ordered.join('\n'), kind, missingTranslation};
    }
    if (kind === 'bilingual') return {text: texts.translation, kind: 'translation', missingTranslation};
    if (!texts.original) return null;
    return {text: texts.original, kind: 'original', missingTranslation};
}
