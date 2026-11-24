/**
 * @file tests/clickSelection.test.ts
 * 文件职责：验证两点选取只消费明确开启后的正文点击，并保持原生选择方向与宿主控件行为。
 * 主要内容：覆盖正反向选区、文档根禁译外壳与局部保护、空白重试、拖动拒绝、来源失效、文本与节点预算、点击抑制和临时监听清理。
 * 模块边界：使用独立 DOM 与可控字符几何验证手势控制器，不调用翻译、配置或扩展消息。
 */
import {parseHTML} from 'linkedom';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createClickSelectionController, type ClickSelectionController} from '@/src/features/selection-translation/content/clickSelection';
import {shouldIgnoreSelection} from '@/src/features/selection-translation/core';
import {claimPointerSelectionSession} from '@/src/shared/dom/pointerSelectionSession';

vi.mock('@/src/features/selection-translation/core', () => ({shouldIgnoreSelection: vi.fn(() => false)}));

const controllers: ClickSelectionController[] = [];
beforeEach(() => vi.mocked(shouldIgnoreSelection).mockReset().mockReturnValue(false));
afterEach(() => { controllers.forEach(controller => controller.dispose()); controllers.length = 0; vi.unstubAllGlobals(); });

function fixture(markup = '<p id="first">First readable sentence.</p><p id="second">Second readable sentence.</p>') {
    const view = parseHTML(`<html><body><main>${markup}</main></body></html>`);
    const owner = view.document;
    // linkedom 的 currentNode 赋值不会更新遍历起点；补齐浏览器 TreeWalker 的标准定位语义。
    const createWalker = owner.createTreeWalker.bind(owner);
    owner.createTreeWalker = ((root: Node, mask: number) => {
        const native = createWalker(root, mask);
        const nodes: Node[] = [root];
        for (let node = native.nextNode(); node; node = native.nextNode()) nodes.push(node);
        let index = 0;
        return {
            get currentNode() { return nodes[index]; },
            set currentNode(node: Node) { index = nodes.indexOf(node); },
            nextNode() { return nodes[++index] ?? null; },
        } as unknown as TreeWalker;
    }) as Document['createTreeWalker'];
    const locations = new Map<Node, {x: number; y: number}>();
    const serialized = vi.fn();
    const allText = () => {
        const walker = owner.createTreeWalker(owner, 4);
        const result: Text[] = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) result.push(node as Text);
        return result;
    };
    allText().forEach((node, index) => locations.set(node, {x: 10, y: 10 + index * 30}));
    class TestRange {
        startContainer: Node = owner;
        startOffset = 0;
        endContainer: Node = owner;
        endOffset = 0;
        get collapsed() { return this.startContainer === this.endContainer && this.startOffset === this.endOffset; }
        get commonAncestorContainer(): Node {
            for (let node: Node | null = this.startContainer; node; node = node.parentNode) if (node === this.endContainer || node.contains(this.endContainer)) return node;
            return owner;
        }
        setStart(node: Node, offset: number) { this.startContainer = node; this.startOffset = offset; }
        setEnd(node: Node, offset: number) { this.endContainer = node; this.endOffset = offset; }
        collapse(toStart: boolean) {
            if (toStart) { this.endContainer = this.startContainer; this.endOffset = this.startOffset; }
            else { this.startContainer = this.endContainer; this.startOffset = this.endOffset; }
        }
        compareBoundaryPoints(_how: number, other: TestRange) {
            return this.startContainer === other.startContainer ? this.startOffset - other.startOffset
                : allText().indexOf(this.startContainer as Text) - allText().indexOf(other.startContainer as Text);
        }
        getClientRects() {
            const location = locations.get(this.startContainer);
            if (!location) return [];
            const left = location.x + this.startOffset * 8;
            const right = location.x + this.endOffset * 8;
            return [{left, right, top: location.y, bottom: location.y + 16, width: right - left, height: 16}];
        }
        toString() {
            serialized();
            const nodes = allText();
            const start = nodes.indexOf(this.startContainer as Text);
            const end = nodes.indexOf(this.endContainer as Text);
            return nodes.slice(start, end + 1).map((node, index) => node.data.slice(
                index === 0 ? this.startOffset : 0, node === this.endContainer ? this.endOffset : node.length)).join('');
        }
    }
    owner.createRange = (() => new TestRange()) as unknown as Document['createRange'];
    let hit: {offsetNode: Node; offset: number} | null = null;
    owner.caretPositionFromPoint = (() => hit) as unknown as Document['caretPositionFromPoint'];
    const selection = {
        anchorNode: null as Node | null, anchorOffset: 0, focusNode: null as Node | null, focusOffset: 0,
        setBaseAndExtent: vi.fn(function (this: typeof selection, anchorNode: Node, anchorOffset: number, focusNode: Node, focusOffset: number) {
            Object.assign(this, {anchorNode, anchorOffset, focusNode, focusOffset});
        }),
        collapse: vi.fn(function (this: typeof selection, node: Node, offset: number) {
            Object.assign(this, {anchorNode: node, anchorOffset: offset, focusNode: node, focusOffset: offset});
        }),
        removeAllRanges: vi.fn(), addRange: vi.fn((_range: Range) => {}),
    };
    view.getSelection = (() => selection) as unknown as Window['getSelection'];
    view.getComputedStyle = (() => ({display: 'block', visibility: 'visible', userSelect: 'text'})) as unknown as Window['getComputedStyle'];
    vi.stubGlobal('document', owner);
    vi.stubGlobal('window', view);
    const states = vi.fn();
    const complete = vi.fn();
    const rejected = vi.fn();
    const create = (acceptsRange?: (range: Range) => boolean, reportRejections = true) => {
        const controller = createClickSelectionController({onStateChange: states, onComplete: complete, onReject: reportRejections ? rejected : undefined, acceptsRange});
        controllers.push(controller);
        return controller;
    };
    const text = (selector = '#first') => owner.querySelector(selector)!.firstChild as Text;
    const pointer = (node: Node, offset: number, changes: Partial<PointerEvent> = {}) => {
        hit = {offsetNode: node, offset};
        const location = locations.get(node) ?? {x: 10, y: 10};
        return {isTrusted: true, button: 0, pointerType: 'mouse', pointerId: 1, ctrlKey: false, shiftKey: false,
            altKey: false, metaKey: false, clientX: location.x + offset * 8 + (offset === node.textContent?.length ? -1 : 1), clientY: location.y + 8,
            target: node.parentNode, composedPath: () => [node.parentNode], preventDefault: vi.fn(), stopPropagation: vi.fn(),
            ...changes} as unknown as PointerEvent;
    };
    const click = (controller: ClickSelectionController, node: Node, offset: number, changes: Partial<PointerEvent> = {}) => {
        const event = pointer(node, offset, changes);
        return {event, down: controller.handlePointerDown(event), up: controller.handlePointerUp(event)};
    };
    return {owner, view, create, states, complete, rejected, selection, pointer, click, text, locations, serialized};
}

describe('两点选取', () => {
    it('开启前没有监听器或指针副作用，开启后完成一次正向选择并自动退出', () => {
        const f = fixture();
        const listen = vi.spyOn(f.owner, 'addEventListener');
        const controller = f.create();
        expect(listen).not.toHaveBeenCalled();
        expect(f.click(controller, f.text(), 0).down).toBe(false);
        controller.toggle();
        expect(f.states.mock.calls).toEqual([['start']]);
        expect(f.click(controller, f.text(), 0).down).toBe(true);
        expect(f.selection.setBaseAndExtent).not.toHaveBeenCalled();
        expect(f.states.mock.calls.at(-1)).toEqual(['end']);
        f.click(controller, f.text(), 5);
        expect(controller.active).toBe(false);
        expect(f.states.mock.calls.at(-1)).toEqual(['idle']);
        expect(f.selection.setBaseAndExtent).toHaveBeenCalledWith(f.text(), 0, f.text(), 5);
        expect(f.complete).toHaveBeenCalledOnce();
        expect(shouldIgnoreSelection).toHaveBeenCalledOnce();
    });

    it('跨行反向选择保留点击方向，向已有划词流程提供排序后的 Range', () => {
        const f = fixture();
        const accepted = vi.fn((_range: Range) => true);
        const controller = f.create(accepted);
        controller.toggle();
        f.click(controller, f.text('#second'), 6);
        f.click(controller, f.text(), 3);
        expect(f.selection.setBaseAndExtent).toHaveBeenCalledWith(f.text('#second'), 6, f.text(), 3);
        expect(accepted).toHaveBeenCalledOnce();
        const range = accepted.mock.calls[0][0] as Range;
        expect(range.startContainer).toBe(f.text());
        expect(range.startOffset).toBe(3);
        expect(range.endContainer).toBe(f.text('#second'));
        expect(range.endOffset).toBe(6);
        expect(shouldIgnoreSelection).not.toHaveBeenCalled();
    });

    it('空白命中与同点点击均保留本轮，随后有效终点只完成一次', () => {
        const f = fixture();
        const controller = f.create();
        controller.toggle();
        f.click(controller, f.text(), 0, {clientX: 900});
        expect(f.states.mock.calls).toEqual([['start']]);
        expect(f.rejected).toHaveBeenLastCalledWith('text-miss');
        f.click(controller, f.text(), 1);
        f.click(controller, f.text(), 1);
        expect(f.rejected).toHaveBeenLastCalledWith('same-point');
        expect(f.complete).not.toHaveBeenCalled();
        expect(controller.active).toBe(true);
        f.click(controller, f.text(), 8);
        expect(f.complete).toHaveBeenCalledOnce();
    });

    it('两次点击之间的拖动不会被当成终点，也不会改动已有原生选区', () => {
        const f = fixture();
        const controller = f.create();
        controller.toggle();
        f.click(controller, f.text(), 0);
        const down = f.pointer(f.text(), 3);
        expect(controller.handlePointerDown(down)).toBe(true);
        expect(controller.handlePointerUp({...down, clientX: down.clientX + 50})).toBe(true);
        expect(f.complete).not.toHaveBeenCalled();
        expect(f.selection.setBaseAndExtent).not.toHaveBeenCalled();
        f.click(controller, f.text(), 5);
        expect(f.selection.anchorOffset).toBe(0);
        expect(f.selection.focusOffset).toBe(5);
    });

    it.each(['a href="/next"', 'button', 'label', 'div contenteditable="true"', 'div role="button"'])('点击控件 %s 取消模式并放行宿主操作', (tag) => {
        const name = tag.split(' ')[0];
        const f = fixture(`<p id="first">Readable text</p><${tag} id="control">Action</${name}>`);
        const controller = f.create();
        controller.toggle();
        f.click(controller, f.text(), 0);
        const {event, down, up} = f.click(controller, f.text('#control'), 1);
        expect(down).toBe(false);
        expect(up).toBe(false);
        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(controller.active).toBe(false);
        expect(f.complete).not.toHaveBeenCalled();
    });

    it.each(['html', 'body'].flatMap(tag => ['class', 'translate', 'data-notranslate'].map(attribute => ({tag, attribute}))))('文档根禁译标记 $tag/$attribute 不阻止两点选取正文', ({tag, attribute}) => {
        const f = fixture();
        f.owner.querySelector(tag)!.setAttribute(attribute, attribute === 'class' ? 'notranslate' : attribute === 'translate' ? 'no' : 'true');
        const controller = f.create();
        controller.toggle();
        expect(f.click(controller, f.text(), 0).down).toBe(true);
        expect(f.click(controller, f.text(), 5).down).toBe(true);
        expect(f.selection.setBaseAndExtent).toHaveBeenCalledWith(f.text(), 0, f.text(), 5);
        expect(f.complete).toHaveBeenCalledOnce();
        expect(controller.active).toBe(false);
    });

    it('DeepSeek 组合根标记下跨段落选取仍只完成一次', () => {
        const f = fixture();
        f.owner.documentElement.classList.add('notranslate');
        f.owner.documentElement.setAttribute('translate', 'no');
        f.owner.body.setAttribute('data-notranslate', 'true');
        const controller = f.create();
        controller.toggle();
        f.click(controller, f.text(), 0);
        f.click(controller, f.text('#second'), 6);
        expect(f.selection.setBaseAndExtent).toHaveBeenCalledWith(f.text(), 0, f.text('#second'), 6);
        expect(f.complete).toHaveBeenCalledOnce();
    });

    it.each(['class="notranslate"', 'translate="no"', 'data-notranslate="true"'])('根禁译外壳内的局部 %s 仍放行宿主点击', marker => {
        const f = fixture(`<p id="first">Readable text</p><span ${marker} id="protected">Protected text</span>`);
        f.owner.documentElement.setAttribute('translate', 'no');
        const controller = f.create();
        controller.toggle();
        f.click(controller, f.text(), 0);
        const {event, down, up} = f.click(controller, f.text('#protected'), 3);
        expect(down).toBe(false);
        expect(up).toBe(false);
        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(f.selection.setBaseAndExtent).not.toHaveBeenCalled();
        expect(f.complete).not.toHaveBeenCalled();
        expect(controller.active).toBe(false);
    });

    it.each([
        ['html', 'role', 'button'], ['body', 'role', 'textbox'],
        ['html', 'contenteditable', 'true'], ['body', 'hidden', ''],
        ['html', 'aria-hidden', 'true'], ['body', 'inert', ''],
        ['html', 'data-fluent-read-ui', ''], ['body', 'class', 'fluent-read-bilingual-content'],
    ])('根禁译标记不能绕过同层保护 %s/%s', (tag, attribute, value) => {
        const f = fixture();
        const surface = f.owner.querySelector(tag)!;
        surface.setAttribute('translate', 'no');
        surface.setAttribute(attribute, value);
        const controller = f.create();
        controller.toggle();
        const {event, down} = f.click(controller, f.text(), 0);
        expect(down).toBe(false);
        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(f.complete).not.toHaveBeenCalled();
        expect(controller.active).toBe(false);
    });

    it('caret 在普通事件容器内命中局部禁译文本时仍拒绝端点', () => {
        const f = fixture('<p id="first">Before <span translate="no">Protected text</span> after</p>');
        f.owner.documentElement.classList.add('notranslate');
        f.owner.documentElement.setAttribute('translate', 'no');
        const protectedText = f.owner.querySelector('span')!.firstChild!;
        const controller = f.create();
        controller.toggle();
        const event = f.pointer(f.text(), 0);
        f.owner.caretPositionFromPoint = (() => ({offsetNode: protectedText, offset: 0})) as unknown as Document['caretPositionFromPoint'];
        expect(controller.handlePointerDown(event)).toBe(true);
        expect(controller.handlePointerUp(event)).toBe(true);
        expect(f.rejected).toHaveBeenCalledWith('text-miss');
        expect(f.states.mock.calls).toEqual([['start']]);
        expect(f.complete).not.toHaveBeenCalled();
    });

    it.each([{ctrlKey: true}, {shiftKey: true}, {altKey: true}, {metaKey: true}, {button: 2}, {pointerType: 'touch'}])('修饰键、右键及触摸手势取消并放行：%j', (change) => {
        const f = fixture();
        const controller = f.create();
        controller.toggle();
        expect(f.click(controller, f.text(), 0, change).down).toBe(false);
        expect(controller.active).toBe(false);
    });

    it('合成指针事件不能改变模式或调用原生选区', () => {
        const f = fixture();
        const controller = f.create();
        controller.toggle();
        expect(f.click(controller, f.text(), 0, {isTrusted: false}).down).toBe(false);
        expect(f.states.mock.calls).toEqual([['start']]);
        expect(f.selection.setBaseAndExtent).not.toHaveBeenCalled();
    });

    it.each(['replace', 'mutate'])('起点正文 %s 后取消，不能将新文本接到旧端点', (change) => {
        const f = fixture();
        const controller = f.create();
        controller.toggle();
        f.click(controller, f.text(), 0);
        if (change === 'replace') f.owner.querySelector('#first')!.textContent = 'Changed source';
        else f.text().data = 'Changed source';
        expect(f.click(controller, f.text('#second'), 3).down).toBe(false);
        expect(controller.active).toBe(false);
        expect(f.complete).not.toHaveBeenCalled();
    });

    it('终点确认前再次验证来源，拒绝 down 与 up 之间的同节点改字', () => {
        const f = fixture();
        const controller = f.create();
        controller.toggle();
        f.click(controller, f.text(), 0);
        const event = f.pointer(f.text(), 5);
        controller.handlePointerDown(event);
        f.text().data = 'Source changed';
        controller.handlePointerUp(event);
        expect(controller.active).toBe(false);
        expect(f.complete).not.toHaveBeenCalled();
    });

    it('超过 4096 字符先拒绝，不序列化长文或调用受保护选区扫描', () => {
        const f = fixture(`<p id="first">${'x'.repeat(5000)}</p>`);
        const controller = f.create();
        controller.toggle();
        f.click(controller, f.text(), 0);
        f.click(controller, f.text(), 4500);
        expect(f.serialized).not.toHaveBeenCalled();
        expect(shouldIgnoreSelection).not.toHaveBeenCalled();
        expect(f.complete).not.toHaveBeenCalled();
        expect(f.rejected).toHaveBeenCalledWith('range-too-large');
        f.click(controller, f.text(), 4096);
        expect(f.complete).toHaveBeenCalledOnce();
    });

    it('文本很少但中间有大量空节点时按节点预算拒绝，避免扫描异常页面结构', () => {
        const f = fixture(`<p id="first">start</p>${'<span></span>'.repeat(8200)}<p id="second">end</p>`);
        const controller = f.create();
        controller.toggle();
        f.click(controller, f.text(), 0);
        f.click(controller, f.text('#second'), 3);
        expect(f.rejected).toHaveBeenCalledWith('range-too-large');
        expect(f.serialized).not.toHaveBeenCalled();
        expect(shouldIgnoreSelection).not.toHaveBeenCalled();
        expect(f.complete).not.toHaveBeenCalled();
    });

    it('受保护内容或适配器拒绝的选区保持起点，允许换一个终点重试', () => {
        const f = fixture();
        const accepted = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
        const controller = f.create(accepted);
        controller.toggle();
        f.click(controller, f.text(), 0);
        f.click(controller, f.text(), 5);
        expect(controller.active).toBe(true);
        expect(f.complete).not.toHaveBeenCalled();
        expect(f.rejected).toHaveBeenCalledWith('protected-content');
        f.click(controller, f.text(), 10);
        expect(f.complete).toHaveBeenCalledOnce();
        expect(accepted).toHaveBeenCalledTimes(2);
        expect(shouldIgnoreSelection).not.toHaveBeenCalled();
    });

    it('完成后的自有 click 被抑制一次，其他页面点击不受影响', () => {
        const f = fixture();
        const controller = f.create();
        controller.toggle();
        f.click(controller, f.text(), 0);
        const {event} = f.click(controller, f.text(), 5);
        const nativeClick = new f.view.Event('click', {bubbles: true, cancelable: true});
        Object.defineProperties(nativeClick, {isTrusted: {value: true}, button: {value: 0},
            clientX: {value: event.clientX}, clientY: {value: event.clientY}});
        f.text().parentElement!.dispatchEvent(nativeClick);
        expect(nativeClick.defaultPrevented).toBe(true);
        const nextClick = new f.view.Event('click', {bubbles: true, cancelable: true});
        f.text().parentElement!.dispatchEvent(nextClick);
        expect(nextClick.defaultPrevented).toBe(false);
    });

    it.each(['blur', 'pagehide', 'fluentread-route-change', 'visibilitychange', 'pointercancel'])('%s 清理本轮，下一次开启从起点重新开始', (type) => {
        const f = fixture();
        const controller = f.create();
        controller.toggle();
        f.click(controller, f.text(), 0);
        if (type === 'visibilitychange') Object.defineProperty(f.owner, 'visibilityState', {value: 'hidden'});
        const event = new f.view.Event(type);
        Object.defineProperty(event, 'isTrusted', {value: true});
        (type === 'blur' || type === 'pagehide' ? f.view : f.owner).dispatchEvent(event);
        expect(controller.active).toBe(false);
        controller.toggle();
        f.click(controller, f.text(), 5);
        expect(f.complete).not.toHaveBeenCalled();
        expect(f.states.mock.calls.at(-1)).toEqual(['end']);
    });

    it('再次快捷键、显式取消与卸载都清理监听；卸载后不能重新开启', () => {
        const f = fixture();
        const remove = vi.spyOn(f.owner, 'removeEventListener');
        const controller = f.create();
        controller.toggle();
        controller.toggle();
        expect(controller.active).toBe(false);
        expect(remove).toHaveBeenCalledWith('pointercancel', expect.any(Function), true);
        controller.toggle();
        f.click(controller, f.text(), 0);
        controller.cancel();
        controller.toggle();
        controller.dispose();
        controller.toggle();
        expect(controller.active).toBe(false);
    });

    it('支持浏览器不提供 setBaseAndExtent 的原生 Range 兼容路径', () => {
        const f = fixture();
        Object.defineProperty(f.selection, 'setBaseAndExtent', {value: undefined});
        const controller = f.create();
        controller.toggle();
        f.click(controller, f.text(), 2);
        f.click(controller, f.text(), 7);
        expect(f.selection.removeAllRanges).toHaveBeenCalledOnce();
        expect(f.selection.addRange).toHaveBeenCalledOnce();
        const range = f.selection.addRange.mock.calls[0][0] as Range;
        expect(range.toString()).toBe('rst r');
        expect(f.complete).toHaveBeenCalledOnce();
    });

    it('浏览器尚无原生 Selection 或选区只有空白时保持起点，允许重试', () => {
        const f = fixture('<p id="first">   readable sentence.</p>');
        const controller = f.create();
        controller.toggle();
        f.click(controller, f.text(), 0);
        f.click(controller, f.text(), 2);
        expect(f.complete).not.toHaveBeenCalled();
        const getSelection = f.view.getSelection;
        f.view.getSelection = () => null;
        f.click(controller, f.text(), 6);
        expect(f.complete).not.toHaveBeenCalled();
        f.view.getSelection = getSelection;
        f.click(controller, f.text(), 8);
        expect(f.complete).toHaveBeenCalledOnce();
    });

    it('选区包含受保护内容时明确反馈，且不会访问原生 Selection', () => {
        const f = fixture();
        vi.mocked(shouldIgnoreSelection).mockReturnValue(true);
        const controller = f.create();
        controller.toggle();
        f.click(controller, f.text(), 0);
        f.click(controller, f.text(), 5);
        expect(f.rejected).toHaveBeenCalledWith('protected-content');
        expect(f.selection.setBaseAndExtent).not.toHaveBeenCalled();
        expect(controller.active).toBe(true);
    });

    it('开启期间只有自有 click 被消费，合成点击与无待抑制点击直接放行', () => {
        const f = fixture();
        const controller = f.create();
        controller.toggle();
        const {event} = f.click(controller, f.text(), 0);
        f.text().parentElement!.dispatchEvent(new f.view.Event('click', {bubbles: true, cancelable: true}));
        const elsewhere = new f.view.Event('click', {bubbles: true, cancelable: true});
        Object.defineProperties(elsewhere, {isTrusted: {value: true}, button: {value: 0},
            clientX: {value: event.clientX + 100}, clientY: {value: event.clientY}});
        f.text().parentElement!.dispatchEvent(elsewhere);
        expect(elsewhere.defaultPrevented).toBe(false);
        const noPending = new f.view.Event('click', {bubbles: true, cancelable: true});
        Object.defineProperty(noPending, 'isTrusted', {value: true});
        f.text().parentElement!.dispatchEvent(noPending);
        expect(noPending.defaultPrevented).toBe(false);
    });

    it('完成后的 click 抑制有固定期限，到期移除最后一个监听器', () => {
        vi.useFakeTimers();
        try {
            const f = fixture();
            const remove = vi.spyOn(f.owner, 'removeEventListener');
            const controller = f.create();
            controller.toggle();
            f.click(controller, f.text(), 0);
            f.click(controller, f.text(), 5);
            vi.advanceTimersByTime(500);
            expect(remove).toHaveBeenCalledWith('click', expect.any(Function), true);
            expect(controller.active).toBe(false);
        } finally { vi.useRealTimers(); }
    });

    it('页面仍可见或收到合成 pointercancel 时保留模式，真实取消才清理', () => {
        const f = fixture();
        const controller = f.create();
        controller.toggle();
        Object.defineProperty(f.owner, 'visibilityState', {value: 'visible'});
        f.owner.dispatchEvent(new f.view.Event('visibilitychange'));
        f.owner.dispatchEvent(new f.view.Event('pointercancel'));
        expect(controller.active).toBe(true);
    });

    it('没有按下、抬起指针不匹配、合成抬起与新增修饰键都不能完成选择', () => {
        const f = fixture();
        const controller = f.create();
        controller.toggle();
        const event = f.pointer(f.text(), 0);
        expect(controller.handlePointerUp(event)).toBe(false);
        controller.handlePointerDown(event);
        expect(controller.handlePointerUp({...event, pointerId: 2})).toBe(false);
        expect(controller.handlePointerUp({...event, isTrusted: false})).toBe(false);
        expect(controller.handlePointerUp({...event, button: 2})).toBe(true);
        expect(f.states.mock.calls).toEqual([['start']]);
        controller.handlePointerDown(event);
        expect(controller.handlePointerUp({...event, ctrlKey: true})).toBe(true);
        expect(controller.active).toBe(false);
    });

    it('事件直接命中文本节点或缺少 composedPath 时仍能确定正确正文', () => {
        const f = fixture();
        const controller = f.create();
        controller.toggle();
        f.click(controller, f.text(), 0, {target: f.text(), composedPath: () => [f.text()]} as unknown as Partial<PointerEvent>);
        f.click(controller, f.text(), 5, {composedPath: undefined});
        expect(f.complete).toHaveBeenCalledOnce();
        controller.toggle();
        expect(f.click(controller, f.text(), 0, {target: null, composedPath: () => []}).down).toBe(false);
    });

    it('命中已脱离文档或普通 DocumentFragment 的元素时不将其作为正文起点', () => {
        const f = fixture();
        const controller = f.create();
        controller.toggle();
        const detached = f.owner.createElement('p');
        detached.textContent = 'Detached text';
        f.click(controller, detached.firstChild!, 0);
        const fragment = f.owner.createDocumentFragment();
        fragment.append(detached);
        f.click(controller, detached.firstChild!, 0);
        expect(f.states.mock.calls).toEqual([['start']]);
        expect(f.complete).not.toHaveBeenCalled();
    });

    it('不能跨 ShadowRoot 选取，避免正文与组件内部文字被拼接', () => {
        const f = fixture();
        const host = f.owner.createElement('div');
        f.owner.body.append(host);
        const root = host.attachShadow({mode: 'open'});
        root.innerHTML = '<p>Shadow source</p>';
        const shadowText = root.firstChild!.firstChild as Text;
        f.locations.set(shadowText, {x: 10, y: 100});
        const controller = f.create();
        controller.toggle();
        f.click(controller, f.text(), 0);
        f.click(controller, shadowText, 5);
        expect(controller.active).toBe(false);
        expect(f.complete).not.toHaveBeenCalled();
    });

    it('浏览器缺少 caret 能力或命中了元素节点时保留模式等待有效文本', () => {
        const f = fixture();
        const controller = f.create();
        controller.toggle();
        f.owner.caretPositionFromPoint = () => null;
        f.click(controller, f.text(), 0);
        f.owner.caretPositionFromPoint = (() => ({offsetNode: f.text().parentElement, offset: 0})) as unknown as Document['caretPositionFromPoint'];
        f.click(controller, f.text(), 0);
        expect(f.states.mock.calls).toEqual([['start']]);
    });

    it('caret 命中容器内受保护子树或越界偏移时不会接受端点', () => {
        const f = fixture('<p id="first">Before <a href="/next">Link</a> after</p>');
        const controller = f.create();
        controller.toggle();
        const link = f.owner.querySelector('a')!.firstChild!;
        const pointer = f.pointer(f.text(), 0);
        f.owner.caretPositionFromPoint = (() => ({offsetNode: link, offset: 0})) as unknown as Document['caretPositionFromPoint'];
        controller.handlePointerDown(pointer);
        controller.handlePointerUp(pointer);
        f.click(controller, f.text(), -1);
        f.click(controller, f.text(), 100);
        expect(f.states.mock.calls).toEqual([['start']]);
    });

    it.each([{visibility: 'hidden'}, {display: 'none'}, {userSelect: 'none'}])('尊重正文的不可见或禁止选择样式：%j', style => {
        const f = fixture();
        f.view.getComputedStyle = (() => style) as unknown as Window['getComputedStyle'];
        const controller = f.create();
        controller.toggle();
        f.click(controller, f.text(), 0);
        expect(f.states.mock.calls).toEqual([['start']]);
    });

    it('DOM 几何读取或 Range 建立失败时安全取消本轮，不残留旧起点', () => {
        const f = fixture();
        const controller = f.create();
        controller.toggle();
        const createRange = f.owner.createRange;
        f.owner.createRange = () => { throw new Error('Document no longer accepts ranges'); };
        expect(f.click(controller, f.text(), 0).down).toBe(false);
        expect(controller.active).toBe(false);
        f.owner.createRange = createRange;
        controller.toggle();
        f.click(controller, f.text(), 0);
        const end = f.pointer(f.text(), 5);
        controller.handlePointerDown(end);
        f.owner.createRange = () => { throw new Error('Range source invalidated'); };
        controller.handlePointerUp(end);
        expect(controller.active).toBe(false);
        expect(f.complete).not.toHaveBeenCalled();
    });

    it('第一点折叠上次原生高亮，下一次选择不沿用旧选区', () => {
        const f = fixture();
        Object.assign(f.selection, {anchorNode: f.text(), anchorOffset: 0, focusNode: f.text(), focusOffset: 20});
        const controller = f.create();
        controller.toggle();
        f.click(controller, f.text(), 3);
        expect(f.selection.collapse).toHaveBeenCalledWith(f.text(), 3);
        expect(f.selection.anchorOffset).toBe(3);
        expect(f.selection.focusOffset).toBe(3);
        expect(f.complete).not.toHaveBeenCalled();
    });

    it('浏览器没有 collapse 时第一点清除旧选区，没有 Selection 时仍可等待终点', () => {
        const f = fixture();
        Object.defineProperty(f.selection, 'collapse', {value: undefined});
        const controller = f.create();
        controller.toggle();
        f.click(controller, f.text(), 3);
        expect(f.selection.removeAllRanges).toHaveBeenCalledOnce();
        controller.cancel();
        controller.toggle();
        f.view.getSelection = () => null;
        f.click(controller, f.text(), 3);
        expect(f.states.mock.calls.at(-1)).toEqual(['end']);
    });

    it('拒绝反馈端口可省略，过长或受保护选区不会抛异常', () => {
        const f = fixture(`<p id="first">${'x'.repeat(5000)}</p>`);
        const controller = f.create(undefined, false);
        controller.toggle();
        f.click(controller, f.text(), 0, {clientX: 900});
        f.click(controller, f.text(), 0);
        f.click(controller, f.text(), 0);
        f.click(controller, f.text(), 4500);
        expect(controller.active).toBe(true);
        vi.mocked(shouldIgnoreSelection).mockReturnValue(true);
        f.click(controller, f.text(), 10);
        expect(controller.active).toBe(true);
        expect(f.complete).not.toHaveBeenCalled();
    });

    it('其他正文选取会话认领指针时取消两点模式并清理其临时监听', () => {
        const f = fixture();
        const remove = vi.spyOn(f.owner, 'removeEventListener');
        const controller = f.create();
        controller.toggle();
        f.click(controller, f.text(), 0);
        const releaseOther = claimPointerSelectionSession(vi.fn());
        try {
            expect(controller.active).toBe(false);
            expect(f.states.mock.calls.at(-1)).toEqual(['idle']);
            expect(remove).toHaveBeenCalledWith('pointercancel', expect.any(Function), true);
            expect(f.click(controller, f.text(), 5).down).toBe(false);
            expect(f.complete).not.toHaveBeenCalled();
        } finally { releaseOther(); }
    });

    it('两点模式启动时取消之前的选取会话，旧会话释放不会影响新的所有者', () => {
        const f = fixture();
        const cancelPrevious = vi.fn();
        const releasePrevious = claimPointerSelectionSession(cancelPrevious);
        const controller = f.create();
        controller.toggle();
        expect(cancelPrevious).toHaveBeenCalledOnce();
        releasePrevious();
        expect(controller.active).toBe(true);
        f.click(controller, f.text(), 0);
        const releaseNext = claimPointerSelectionSession(vi.fn());
        try {
            expect(controller.active).toBe(false);
            expect(f.complete).not.toHaveBeenCalled();
        } finally { releaseNext(); }
    });
});
