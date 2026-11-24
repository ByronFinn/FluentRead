/**
 * @file src/features/selection-translation/content/clickSelection.ts
 * 文件职责：以一次开启、两次点击的临时手势建立原生正文选区，避免持续按键或拖动鼠标。
 * 主要内容：校验真实字形命中和来源身份，仅放行文档根表面的全局禁译标记而保留局部保护，有界检查选区长度，兼容反向选择，与局部选择共享指针会话互斥，并仅在开启期间监听取消与自身点击事件。
 * 模块边界：不读写配置、不注册快捷键、不发起翻译或挂载界面；普通指针事件由已有划词组件转发，完成后由调用方接管选区。
 */
import {claimPointerSelectionSession} from '@/src/shared/dom/pointerSelectionSession';
import {findTextPointAtPoint, hasNoTranslateMarker, isDocumentSurfaceNoTranslateShell} from '@/src/core/translation/dom';
import {shouldIgnoreSelection} from '@/src/features/selection-translation/core';

export type ClickSelectionState = 'idle' | 'start' | 'end';
export interface ClickSelectionController {
    readonly active: boolean;
    toggle(): void;
    cancel(): void;
    handlePointerDown(event: PointerEvent): boolean;
    handlePointerUp(event: PointerEvent): boolean;
    dispose(): void;
}
interface ClickSelectionOptions {
    onStateChange(state: ClickSelectionState): void;
    onComplete(): void;
    onReject?(reason: 'range-too-large' | 'protected-content' | 'text-miss' | 'same-point'): void;
    acceptsRange?(range: Range): boolean;
}
interface Endpoint {node: Text; offset: number; text: string; root: Document | ShadowRoot}
interface PointerGesture {point: Endpoint | null; x: number; y: number; pointerId: number; target: EventTarget | null}
const MAX_TEXT = 4096;
const MAX_NODES = 8192;
const MAX_TRAVEL = 6;
const EXCLUDED = 'a[href],button,label,input,textarea,select,option,summary,script,style,noscript,template,iframe,object,embed,canvas,svg,math,video,audio,[inert],[hidden],[aria-hidden="true"],[contenteditable]:not([contenteditable="false"]),[role="link"],[role="button"],[role="textbox"],[role="checkbox"],[role="combobox"],[role="listbox"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="radio"],[role="scrollbar"],[role="slider"],[role="spinbutton"],[role="switch"],[role="tab"],[data-fluent-read-ui],.fluent-read-bilingual-content,.fluent-read-loading,.fluent-read-retry-wrapper,#fluent-read-selection-translator-container,#fluent-read-floating-ball-container,#fluent-read-share-card-container';

/** html/body 的全局禁译标记不阻止主动选取；同层的控件、编辑器与扩展 UI 标记仍逐层检查。 */
function isExcludedEndpoint(element: Element): boolean {
    for (let current: Element | null = element; current; current = current.parentElement) {
        if (current.matches(EXCLUDED) || hasNoTranslateMarker(current) && !isDocumentSurfaceNoTranslateShell(current)) return true;
    }
    return false;
}

/** 两端都必须属于同一仍然连接的原文；DOM 替换或同节点改字均不能沿用旧起点。 */
function isCurrent(point: Endpoint, owner: Document): boolean {
    return point.node.isConnected && point.node.ownerDocument === owner && point.node.getRootNode() === point.root
        && point.node.data === point.text && point.offset >= 0 && point.offset <= point.node.length;
}

/** 先逐节点计数，超出预算立即拒绝；不对长文调用 Range.toString 或 cloneContents。 */
function isBoundedRange(range: Range, owner: Document): boolean {
    const walker = owner.createTreeWalker(range.commonAncestorContainer, 0xFFFFFFFF);
    walker.currentNode = range.startContainer;
    let node: Node | null = range.startContainer;
    let count = 0;
    let visited = 0;
    while (node && ++visited <= MAX_NODES) {
        if (node.nodeType === 3) {
            const start = node === range.startContainer ? range.startOffset : 0;
            const end = node === range.endContainer ? range.endOffset : (node as Text).length;
            count += end - start;
            if (count > MAX_TEXT) return false;
        }
        if (node === range.endContainer) return count > 0;
        node = walker.nextNode();
    }
    return false;
}

/** 事件命中控件时不抢占其行为；字形命中不使用最近段落或整页扫描作为兜底。 */
function readPoint(event: PointerEvent, owner: Document, targetNode: Node): Endpoint | null {
    const root = targetNode.getRootNode();
    if (root !== owner && !(root.nodeType === 11 && 'host' in root)) return null;
    const point = findTextPointAtPoint(root as Document | ShadowRoot, event.clientX, event.clientY);
    if (!point || point.node.nodeType !== 3 || targetNode !== point.node && !targetNode.contains(point.node)) return null;
    const node = point.node as Text;
    const parent = node.parentElement;
    if (!parent || isExcludedEndpoint(parent) || (parent as HTMLElement).isContentEditable
        || node.ownerDocument !== owner || !node.isConnected || point.offset < 0 || point.offset > node.length) return null;
    const style = owner.defaultView?.getComputedStyle(parent);
    if (style?.visibility === 'hidden' || style?.display === 'none' || style?.userSelect === 'none') return null;
    // caret API 可将页边空白吸附到最近字符，必须再验证光标两侧的真实字符几何。
    const glyph = owner.createRange();
    for (const index of [point.offset, point.offset - 1]) {
        if (index < 0 || index >= node.length) continue;
        glyph.setStart(node, index);
        glyph.setEnd(node, index + 1);
        for (const rect of Array.from(glyph.getClientRects())) {
            if (rect.width > 0 && rect.height > 0 && event.clientX >= rect.left && event.clientX <= rect.right
                && event.clientY >= rect.top && event.clientY <= rect.bottom) {
                return {node, offset: point.offset, text: node.data, root: root as Document | ShadowRoot};
            }
        }
    }
    return null;
}

export function createClickSelectionController(options: ClickSelectionOptions): ClickSelectionController {
    const owner = document;
    const view = window;
    let state: ClickSelectionState = 'idle';
    let anchor: Endpoint | null = null;
    let gesture: PointerGesture | null = null;
    let disposed = false;
    let pendingClick: PointerGesture | null = null;
    let clickTimer: number | undefined;
    let releasePointerSession: (() => void) | undefined;

    const setState = (next: ClickSelectionState) => {
        if (next === state) return;
        state = next;
        options.onStateChange(next);
    };
    const clearClick = () => {
        pendingClick = null;
        if (clickTimer !== undefined) view.clearTimeout(clickTimer);
        clickTimer = undefined;
        if (state === 'idle') owner.removeEventListener('click', suppressClick, true);
    };
    const suppressClick = (event: MouseEvent) => {
        if (!event.isTrusted || !pendingClick) return;
        const ownClick = event.button === 0 && event.target === pendingClick.target
            && Math.hypot(event.clientX - pendingClick.x, event.clientY - pendingClick.y) <= MAX_TRAVEL;
        clearClick();
        if (ownClick) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    const armClick = (pointer: PointerGesture) => {
        clearClick();
        pendingClick = pointer;
        owner.addEventListener('click', suppressClick, true);
        clickTimer = view.setTimeout(clearClick, 500);
    };
    const detachCancellation = () => {
        view.removeEventListener('blur', cancel);
        view.removeEventListener('pagehide', cancel);
        owner.removeEventListener('visibilitychange', visibilityChanged);
        owner.removeEventListener('fluentread-route-change', cancel);
        owner.removeEventListener('pointercancel', pointerCancelled, true);
    };
    const deactivate = (preserveClick = false) => {
        releasePointerSession?.();
        releasePointerSession = undefined;
        anchor = null;
        gesture = null;
        detachCancellation();
        setState('idle');
        if (!preserveClick) clearClick();
    };
    function cancel() { deactivate(); }
    function visibilityChanged() { if (owner.visibilityState === 'hidden') cancel(); }
    function pointerCancelled(event: PointerEvent) { if (event.isTrusted) cancel(); }
    const claim = (event: PointerEvent) => { event.preventDefault(); event.stopPropagation(); };

    return {
        get active() { return state !== 'idle'; },
        toggle() {
            if (disposed) return;
            if (state !== 'idle') { cancel(); return; }
            clearClick();
            setState('start');
            releasePointerSession = claimPointerSelectionSession(cancel);
            view.addEventListener('blur', cancel);
            view.addEventListener('pagehide', cancel);
            owner.addEventListener('visibilitychange', visibilityChanged);
            owner.addEventListener('fluentread-route-change', cancel);
            owner.addEventListener('pointercancel', pointerCancelled, true);
        },
        cancel,
        handlePointerDown(event) {
            if (state === 'idle' || !event.isTrusted) return false;
            const target = event.composedPath?.()[0] ?? event.target;
            const element = (target as Node | null)?.nodeType === 1 ? target as Element : (target as Node | null)?.parentElement;
            if (event.button !== 0 || !['mouse', 'pen'].includes(event.pointerType)
                || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey
                || !element || isExcludedEndpoint(element) || (element as HTMLElement).isContentEditable
                || anchor && !isCurrent(anchor, owner)) {
                cancel();
                return false;
            }
            try {
                clearClick();
                gesture = {point: readPoint(event, owner, target as Node), x: event.clientX, y: event.clientY,
                    pointerId: event.pointerId, target: event.target};
                claim(event);
                return true;
            } catch {
                cancel();
                return false;
            }
        },
        handlePointerUp(event) {
            if (state === 'idle' || !event.isTrusted || !gesture || event.pointerId !== gesture.pointerId) return false;
            const completed = gesture;
            gesture = null;
            claim(event);
            if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) { cancel(); return true; }
            if (event.button !== 0 || Math.hypot(event.clientX - completed.x, event.clientY - completed.y) > MAX_TRAVEL) return true;
            armClick(completed);
            const point = completed.point;
            if (!point) { options.onReject?.('text-miss'); return true; }
            let didComplete = false;
            try {
                if (!isCurrent(point, owner) || anchor && !isCurrent(anchor, owner)) { cancel(); return true; }
                if (!anchor) {
                    const previousSelection = view.getSelection();
                    if (previousSelection) {
                        if (typeof previousSelection.collapse === 'function') previousSelection.collapse(point.node, point.offset);
                        else previousSelection.removeAllRanges();
                    }
                    anchor = point;
                    setState('end');
                    return true;
                }
                if (anchor.root !== point.root) { cancel(); return true; }
                const start = owner.createRange();
                start.setStart(anchor.node, anchor.offset);
                start.collapse(true);
                const end = owner.createRange();
                end.setStart(point.node, point.offset);
                end.collapse(true);
                const forward = start.compareBoundaryPoints(0, end) <= 0;
                const first = forward ? anchor : point;
                const last = forward ? point : anchor;
                const range = owner.createRange();
                range.setStart(first.node, first.offset);
                range.setEnd(last.node, last.offset);
                if (range.collapsed) { options.onReject?.('same-point'); return true; }
                if (!isBoundedRange(range, owner)) { options.onReject?.('range-too-large'); return true; }
                if (options.acceptsRange ? !options.acceptsRange(range) : shouldIgnoreSelection(range)) {
                    options.onReject?.('protected-content');
                    return true;
                }
                if (!range.toString().trim()) return true;
                const selection = view.getSelection();
                if (!selection) return true;
                if (typeof selection.setBaseAndExtent === 'function') selection.setBaseAndExtent(anchor.node, anchor.offset, point.node, point.offset);
                else { selection.removeAllRanges(); selection.addRange(range); }
                deactivate(true);
                didComplete = true;
            } catch {
                cancel();
            }
            if (didComplete) options.onComplete();
            return true;
        },
        dispose() { disposed = true; cancel(); },
    };
}
