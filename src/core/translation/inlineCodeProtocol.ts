/**
 * @file src/core/translation/inlineCodeProtocol.ts
 * 文件职责：为受限的简单行内代码段构建可复验的整句占位协议。
 * 主要内容：冻结原生与快照的文字、节点和保护状态，把代码替换为不含代码信息的标记，按原顺序校验译文并映射回既有文本槽；中文普通空白可在有限条件下沿用原槽边界。
 * 模块边界：只处理调用方提供的 DOM 与纯文本，不访问配置、请求服务或修改 DOM；调用方必须绑定翻译会话、缓存、术语、渲染及恢复生命周期，不满足条件时回退原有逐槽路径。
 */
import {getComposedParent, isForeignTranslationBoundary, isHiddenTranslationElement, isIconFontElement,
    maxComposedAncestorDepth} from '@/src/core/translation/dom';
import {createTranslationTextProtectionCache, isTranslationTextNodeProtected} from '@/src/core/translation/text';
import type {TranslationSourceSnapshot} from '@/src/core/translation/serialization';
import type {TranslationTextProtectionOptions} from '@/src/core/translation/dom';
import {sha256Hex} from '@/src/shared/function/sha256';
import {decodeInlineCodeTranslation, inlineCodeNonSimpleWhitespace, parseInlineCodeSource} from './inlineCodeMarkers';

const reservedMarker = /__FRCODE/iu;
// 零宽和双向控制字符虽非标准空白，也不可在槽边界按普通空格处理。
const nonSimpleWhitespace = inlineCodeNonSimpleWhitespace;
const safeDocumentRoles = new Set(['main', 'article', 'document', 'region', 'presentation', 'none', 'generic', 'list', 'listitem']);
const forbiddenAncestorTags = new Set(['a', 'button', 'input', 'select', 'textarea', 'option', 'pre', 'code', 'script', 'style']);
const maximumChildren = 129;
const maximumCharacters = 65536;

export interface InlineCodePacketOptions {
    /** 仅这两种中文目标允许补回普通空格；不等同于逐字保留服务的空白。 */
    targetLanguage?: string;
    /** 与当前翻译范围一致的保护参数；不能启用代码语言预检的豁免。 */
    protectionOptions?: TranslationTextProtectionOptions;
    /** 由运行时返回其确切持有的 loading 节点，不能按页面类名推测归属。 */
    getIgnoredArtifact?: () => Element | undefined;
}

export interface InlineCodePacket {
    readonly source: string;
    /** 只含可译正文，不含标记及代码，供语言预检。 */
    readonly detectionText: string;
    /** 原始文字节点含边界空格，供本地来源重放检查，不包含代码。 */
    readonly sourceTexts: readonly string[];
    /** 完整标记供调用方校验术语碰撞，不含代码内容。 */
    readonly markers: readonly string[];
    /** 仅本地用于重放校验；不得发送到服务或进入网络缓存键。 */
    readonly codeTexts: readonly string[];
    /** 代码的受限 class 状态；仅在本地校验，不能发送或用于网络缓存键。 */
    readonly codeClasses: readonly (string | null)[];
    /** 异步请求及提交前复验原节点与保护状态。 */
    isCurrent(): boolean;
    /** 按原顺序返回既有文本槽译文；来源或协议不确定时返回 null。 */
    decode(result: unknown): string[] | null;
}

/** 只接受无属性或唯一的标准 class="notranslate"；undefined 表示不安全的骨架。 */
export function getInlineCodeClass(element: Element): string | null | undefined {
    if (element.localName !== 'code') return undefined;
    if (element.attributes.length === 0) return null;
    if (element.attributes.length !== 1) return undefined;
    const attribute = element.attributes[0]!;
    return attribute.name === 'class' && attribute.namespaceURI == null && attribute.value === 'notranslate'
        ? 'notranslate' : undefined;
}

/** 实时节点的站点策略、可见性和交互祖先必须与调用方范围一致。 */
export function inlineCodeNodesAreAllowed(owner: HTMLElement, textNodes: readonly Text[], codes: readonly Element[],
    shouldStayOriginal: (element: Element) => boolean, options: InlineCodePacketOptions): boolean {
    const view = owner.ownerDocument.defaultView;
    if (!owner.isConnected || !view || typeof view.getComputedStyle !== 'function') return false;
    try {
        // 每次同步检查使用新的保护缓存，不能跨 DOM 变更复用。
        const protectionCache = createTranslationTextProtectionCache();
        if (view.getComputedStyle(owner).whiteSpace !== 'normal') return false;
        if (textNodes.some(node => isTranslationTextNodeProtected(node, shouldStayOriginal,
            undefined, options.protectionOptions, protectionCache))) return false;
        for (const code of codes) {
            // 代码按设计始终保留在本地，只复验可见性与外部译文边界。
            // 站点 protect 命中代码本身是预期行为，不阻止其周围正文翻译。
            if (isHiddenTranslationElement(code) || isIconFontElement(code) || isForeignTranslationBoundary(code)) return false;
            const style = view.getComputedStyle(code);
            if (!style || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' ||
                style.contentVisibility === 'hidden' || style.opacity === '0') return false;
        }
        let element: Element | null = owner;
        let depth = 0;
        while (element) {
            const role = element.getAttribute('role');
            if (++depth > maxComposedAncestorDepth || shouldStayOriginal(element) !== false ||
                forbiddenAncestorTags.has(element.localName) || element.hasAttribute('hidden') ||
                element.hasAttribute('inert') || element.getAttribute('aria-hidden') === 'true' ||
                element.hasAttribute('contenteditable') || element.getAttribute('translate')?.toLowerCase() === 'no' ||
                element.classList.contains('notranslate') || element.getAttribute('data-notranslate') === 'true' ||
                element.hasAttribute('tabindex') ||
                (role !== null && !safeDocumentRoles.has(role.toLowerCase()))) return false;
            const style = view.getComputedStyle(element);
            if (!style || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' ||
                style.contentVisibility === 'hidden' || style.opacity === '0') return false;
            element = getComposedParent(element);
        }
        return true;
    } catch {
        return false;
    }
}

/**
 * 快照必须与原生节点逐项对应；代码只允许无属性或唯一 notranslate class、单 Text 的简单结构。
 * 标记固定顺序使返回结果能复用原有 DOM 骨架和仅译文槽。
 */
export function createInlineCodePacket(
    owner: HTMLElement,
    snapshot: TranslationSourceSnapshot,
    shouldStayOriginal: (element: Element) => boolean,
    options: InlineCodePacketOptions = {},
): InlineCodePacket | null {
    if (!owner || !snapshot?.clone || typeof shouldStayOriginal !== 'function' ||
        options.protectionOptions?.includeInlineCodeForLanguage) return null;
    const live = Array.from(owner.childNodes);
    const copy = Array.from(snapshot.clone.childNodes);
    if (owner.localName !== 'p' || live.length < 3 || live.length > maximumChildren || live.length % 2 !== 1 ||
        copy.length !== live.length || snapshot.slots.length !== (live.length + 1) / 2) return null;
    const codes: Element[] = [];
    const textNodes: Text[] = [];
    const sources: string[] = [];
    const originals: string[] = [];
    const codeTexts: Node[] = [];
    const clonedCodeTexts: Node[] = [];
    const codeClasses: Array<string | null> = [];
    for (let index = 0; index < live.length; index += 1) {
        const node = live[index]!, cloned = copy[index]!;
        if (index % 2 === 0) {
            const slot = snapshot.slots[index / 2];
            const value = node.nodeValue;
            if (node.nodeType !== 3 || cloned.nodeType !== 3 || value === null || !value.trim() ||
                cloned.nodeValue !== value || !slot || slot.node !== cloned ||
                `${slot.prefix}${slot.source}${slot.suffix}` !== value) return null;
            sources.push(value);
            textNodes.push(node as Text);
            originals.push(value);
        } else {
            if (node.nodeType !== 1 || cloned.nodeType !== 1) return null;
            const code = node as Element, cloneCode = cloned as Element;
            const codeClass = getInlineCodeClass(code);
            if (codeClass === undefined || getInlineCodeClass(cloneCode) !== codeClass ||
                code.childNodes.length !== 1 || cloneCode.childNodes.length !== 1 ||
                code.firstChild?.nodeType !== 3 || cloneCode.firstChild?.nodeType !== 3 ||
                !code.textContent || code.textContent !== cloneCode.textContent) return null;
            codes.push(code);
            codeClasses.push(codeClass);
            codeTexts.push(code.firstChild);
            clonedCodeTexts.push(cloneCode.firstChild);
            originals.push(code.textContent);
        }
    }
    if (sources.some(source => nonSimpleWhitespace.test(source)) ||
        originals.reduce((sum, value) => sum + value.length, 0) > maximumCharacters ||
        originals.some(value => reservedMarker.test(value)) || !inlineCodeNodesAreAllowed(owner, textNodes, codes, shouldStayOriginal, options)) return null;
    // nonce 只由可发送的正文生成，不含代码内容或其摘要。
    const nonce = sha256Hex(sources.join('\0')).slice(0, 16);
    const markers = codes.map((_, index) => `__FRCODE_${nonce}_${index}__`);
    const source = sources.map((text, index) => text + (markers[index] ?? '')).join('');
    const markerPlan = parseInlineCodeSource(source);
    if (!markerPlan) return null;
    const frozenSlotParts = snapshot.slots.map(({prefix, source, suffix}) => ({prefix, source, suffix}));
    const detectionText = sources.join(' ');
    const protectedCodeTexts = Object.freeze(codes.map(code => code.textContent!));
    const isCurrent = (): boolean => {
        let ignored: Element | undefined;
        try { ignored = options.getIgnoredArtifact?.(); } catch { return false; }
        // 精确匹配调用方持有的节点；不能通过类名排除宿主内容。
        if (ignored && (live.includes(ignored) || (ignored.parentNode && ignored.parentNode !== owner))) return false;
        const current = Array.from(owner.childNodes).filter(node => node !== ignored);
        if (current.length !== live.length || snapshot.clone.childNodes.length !== copy.length ||
            snapshot.slots.length !== sources.length || !inlineCodeNodesAreAllowed(owner, textNodes, codes, shouldStayOriginal, options)) return false;
        return live.every((node, index) => {
            if (current[index] !== node || snapshot.clone.childNodes[index] !== copy[index]) return false;
            if (index % 2 === 0) {
                const slot = snapshot.slots[index / 2];
                return node.nodeValue === originals[index] && copy[index]!.nodeValue === originals[index] &&
                    slot?.node === copy[index] && slot.prefix === frozenSlotParts[index / 2]!.prefix &&
                    slot.source === frozenSlotParts[index / 2]!.source && slot.suffix === frozenSlotParts[index / 2]!.suffix;
            }
            const code = node as Element, cloned = copy[index] as Element;
            return getInlineCodeClass(code) === codeClasses[(index - 1) / 2] &&
                getInlineCodeClass(cloned) === codeClasses[(index - 1) / 2] && code.childNodes.length === 1 &&
                cloned.childNodes.length === 1 && code.firstChild === codeTexts[(index - 1) / 2] &&
                cloned.firstChild === clonedCodeTexts[(index - 1) / 2] &&
                code.firstChild?.nodeType === 3 && cloned.firstChild?.nodeType === 3 &&
                code.textContent === originals[index] && cloned.textContent === originals[index];
        });
    };
    return Object.freeze({source, detectionText, sourceTexts: Object.freeze([...sources]), markers: Object.freeze(markers), codeTexts: protectedCodeTexts,
        codeClasses: Object.freeze([...codeClasses]), isCurrent, decode(result: unknown): string[] | null {
        if (!isCurrent()) return null;
        return decodeInlineCodeTranslation(markerPlan, result, options.targetLanguage);
    }});
}
