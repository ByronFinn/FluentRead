/**
 * @file tests/aiMultiSegmentSettingsLifecycle.test.ts
 * 文件职责：执行 AI 多段设置的真实客户端模板，验证紧凑预算编辑、原子重置与操作归属。
 * 主要内容：覆盖开关保留预算、数值范围和非法输入回显、同值无更新、关闭与重新开启、同步配置替换、隐藏、KeepAlive 停用和卸载后的旧回调失效。
 * 模块边界：Vue、设置组件及数值外壳保持真实，只用可观察端口替代 Element Plus 控件；真实输入格式化、布局及存储由生产浏览器专项验证。
 */
import {parseHTML} from 'linkedom';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import * as vue from 'vue';
import {Config} from '@/src/core/config/model';
import type {AiMultiSegmentLimits} from '@/src/core/config/aiMultiSegment';
import Settings from '@/src/features/settings/ui/AiMultiSegmentSettings.vue';

vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({t: (key: string) => key})}));
vi.mock('@/src/features/settings/ui/components/FieldHelp.vue', () => ({default: {render: () => null}}));

const title = 'settings.fullPage.multiSegmentTitle';
const segments = 'settings.fullPage.multiSegmentFragmentsAria';
const characters = 'settings.fullPage.multiSegmentCharactersAria';
const reset = 'settings.fullPage.multiSegmentResetAria';
let app: vue.App | undefined, document: Document, root: HTMLElement;
let props: {config: Config; active?: boolean}, shown: vue.Ref<boolean>;
let events: Map<Element, Record<string, any>>;
const updates = vi.fn();
async function settle() {await vue.nextTick();await Promise.resolve();await vue.nextTick();}
beforeEach(() => {
    document = parseHTML('<html><body><div id="app"></div></body></html>').document as unknown as Document;
    events = new Map();updates.mockClear();
});
afterEach(async () => {app?.unmount();app = undefined;await settle();});

async function mount(source: Partial<Config> = {}, active?: boolean): Promise<void> {
    expect(Settings).toHaveProperty('render', expect.any(Function));
    props = vue.reactive({config: Object.assign(new Config(), source), ...(active === undefined ? {} : {active})});
    shown = vue.ref(true);
    const renderer = vue.createRenderer({
        patchProp(el: any, key: string, _before: unknown, value: any) {
            const handlers = events.get(el) ?? {};events.set(el, handlers);
            if (/^on[A-Z]/u.test(key)) {handlers[key] = value;return;}
            if (value === false || value === undefined || value === null) el.removeAttribute(key);
            else el.setAttribute(key, String(value));
        },
        insert: (child: any, parent: any, anchor: any = null) => parent.insertBefore(child, anchor),
        remove: (node: any) => node.parentNode?.removeChild(node),
        createElement: tag => document.createElement(tag), createText: value => document.createTextNode(value), createComment: value => document.createComment(value),
        setText: (node: any, value) => {node.nodeValue = value;}, setElementText: (el: any, value) => {el.textContent = value;},
        parentNode: (node: any) => node.parentNode, nextSibling: (node: any) => node.nextSibling, querySelector: selector => document.querySelector(selector),
        setScopeId: () => {}, cloneNode: (node: any) => node.cloneNode(true),
        insertStaticContent: (html: string, parent: any, anchor: any) => {
            const template = document.createElement('template');template.innerHTML = html;
            const first = template.content.firstChild!, last = template.content.lastChild!;
            parent.insertBefore(template.content, anchor);return [first, last];
        },
    });
    app = renderer.createApp({setup: () => () => vue.h(vue.KeepAlive, null, {default: () => shown.value
        ? vue.h(Settings, {...props, 'onUpdate:limits': (limits: AiMultiSegmentLimits) => {
            updates(limits);props.config = {...props.config, ...limits};
        }}) : vue.h({render: () => null}, {key: 'other'})})});
    app.component('el-switch', {setup(_: unknown, {attrs}: any) {return () => vue.h('input', attrs);}});
    app.component('el-input-number', {props: ['modelValue', 'disabled', 'min', 'max', 'precision'],
        setup(input: any, {attrs}: any) {return () => vue.h('input', {...attrs, value: input.modelValue,
            disabled: input.disabled, min: input.min, max: input.max, precision: input.precision});}});
    root = document.getElementById('app')!;app.mount(root);await settle();
}

function control(label: string): HTMLElement {
    const element = root.querySelector<HTMLElement>(`[aria-label="${label}"]`);expect(element, label).not.toBeNull();return element!;
}
function handler(label: string, event: string): (...args: any[]) => void {
    const callback = events.get(control(label))?.[event];expect(callback, `${label}: ${event}`).toBeTypeOf('function');return callback;
}
async function toggle(value: unknown) {handler(title, 'onUpdate:modelValue')(value);await settle();}
async function change(label: string, value: unknown) {handler(label, 'onChange')(value);await settle();}

describe('AI 多段设置实际模板与生命周期', () => {
    it('默认只显示开关，开启后同一组显示两个带名称的整数预算；合法编辑只交接一次完整预算', async () => {
        await mount();expect(root.querySelector('[data-testid="ai-multi-segment-limits"]')).toBeNull();
        await toggle('true');expect(props.config.enableAIMultiSegment).toBe(false);
        await toggle(true);
        expect(root.querySelectorAll('[data-testid="ai-multi-segment-limits"]')).toHaveLength(1);
        expect(control(segments).getAttribute('value')).toBe('8');
        expect(control(characters).getAttribute('value')).toBe('2000');
        expect(control(segments).getAttribute('precision')).toBe('0');
        expect(control(characters).getAttribute('min')).toBe('500');
        expect(control(characters).getAttribute('max')).toBe('12000');
        expect(control(reset).hasAttribute('disabled')).toBe(true);
        await change(segments, 32);expect(updates).toHaveBeenCalledOnce();
        expect(updates).toHaveBeenLastCalledWith({aiMultiSegmentMaxSegments: 32, aiMultiSegmentMaxCharacters: 2000});
        await change(characters, 12000);expect(updates).toHaveBeenCalledTimes(2);
        expect(props.config).toMatchObject({enableAIMultiSegment: true, aiMultiSegmentMaxSegments: 32, aiMultiSegmentMaxCharacters: 12000});
        await change(segments, 2);await change(characters, 500);
        expect(props.config).toMatchObject({aiMultiSegmentMaxSegments: 2, aiMultiSegmentMaxCharacters: 500});
    });

    it('空值、小数及非法端口值不保存，重新挂载输入以恢复已保存数值；同值不交接更新', async () => {
        await mount({enableAIMultiSegment: true, aiMultiSegmentMaxSegments: 16, aiMultiSegmentMaxCharacters: 4000});
        for (const [label, invalidValues, expected] of [
            [segments, [undefined, null, Number.NaN, Infinity, '12', 1, 33, 8.5], '16'],
            [characters, [undefined, null, Number.NaN, Infinity, '4000', 499, 12001, 1500.5], '4000'],
        ] as const) {
            for (const value of invalidValues) {
                const previous = control(label), neighbor = control(label === segments ? characters : segments);await change(label, value);
                expect(control(label)).not.toBe(previous);
                expect(control(label === segments ? characters : segments)).toBe(neighbor);
                expect(control(label).getAttribute('value')).toBe(expected);
                expect(updates).not.toHaveBeenCalled();
            }
        }
        const previous = control(segments);await change(segments, 16);await change(characters, 4000);
        expect(control(segments)).toBe(previous);expect(updates).not.toHaveBeenCalled();
    });

    it('关闭隐藏预算并保留自定义值，重新开启后恢复；默认按钮一次重置两项且保留开关', async () => {
        await mount({enableAIMultiSegment: true, aiMultiSegmentMaxSegments: 24, aiMultiSegmentMaxCharacters: 9000});
        await toggle(false);expect(root.querySelector('[data-testid="ai-multi-segment-limits"]')).toBeNull();
        expect(props.config).toMatchObject({aiMultiSegmentMaxSegments: 24, aiMultiSegmentMaxCharacters: 9000});
        await toggle(true);expect(control(reset).hasAttribute('disabled')).toBe(false);
        handler(reset, 'onClick')();await settle();
        expect(updates).toHaveBeenCalledOnce();expect(updates).toHaveBeenLastCalledWith({aiMultiSegmentMaxSegments: 8, aiMultiSegmentMaxCharacters: 2000});
        expect(props.config.enableAIMultiSegment).toBe(true);expect(control(reset).hasAttribute('disabled')).toBe(true);
        handler(reset, 'onClick')();expect(updates).toHaveBeenCalledOnce();
    });

    it.each(['section', 'cached', 'config', 'enabled', 'values', 'unmount'] as const)('%s 后旧输入、重置与开关回调不能保存，返回后只接受当前控件', async reason => {
        await mount({enableAIMultiSegment: true, aiMultiSegmentMaxSegments: 16, aiMultiSegmentMaxCharacters: 4000});
        const oldSegments = handler(segments, 'onChange'), oldCharacters = handler(characters, 'onChange');
        const oldReset = handler(reset, 'onClick'), oldToggle = handler(title, 'onUpdate:modelValue');
        if (reason === 'section') props.active = false;
        if (reason === 'cached') shown.value = false;
        if (reason === 'config') props.config = {...props.config};
        if (reason === 'enabled') props.config.enableAIMultiSegment = false;
        if (reason === 'values') props.config.aiMultiSegmentMaxCharacters = 4500;
        if (reason === 'unmount') {app!.unmount();app = undefined;}
        await settle();const expected = {...props.config};
        oldSegments(32);oldCharacters(12000);oldReset();oldToggle(false);
        expect(props.config).toEqual(expected);expect(updates).not.toHaveBeenCalled();
        if (reason === 'unmount') return;
        props.active = true;shown.value = true;props.config.enableAIMultiSegment = true;await settle();
        oldSegments(32);oldCharacters(12000);oldReset();oldToggle(false);
        expect(props.config.enableAIMultiSegment).toBe(true);expect(updates).not.toHaveBeenCalled();
        await change(segments, 12);expect(updates).toHaveBeenCalledOnce();expect(props.config.aiMultiSegmentMaxSegments).toBe(12);
    });

    it('初始失活仍显示已保存预算但禁止更改，恢复后当前输入可用', async () => {
        await mount({enableAIMultiSegment: true, aiMultiSegmentMaxSegments: 12}, false);
        expect(control(segments).hasAttribute('disabled')).toBe(true);
        await toggle(false);await change(segments, 32);handler(reset, 'onClick')();
        expect(props.config).toMatchObject({enableAIMultiSegment: true, aiMultiSegmentMaxSegments: 12});expect(updates).not.toHaveBeenCalled();
        props.active = true;await settle();expect(control(segments).hasAttribute('disabled')).toBe(false);
        await change(characters, 5000);expect(props.config.aiMultiSegmentMaxCharacters).toBe(5000);
    });

    it('外部同对象预算更新同步失效旧回调，不等待 Vue 渲染后再防护', async () => {
        await mount({enableAIMultiSegment: true});const oldChange = handler(segments, 'onChange'), previous = control(segments);
        props.config.aiMultiSegmentMaxCharacters = 7000;
        oldChange(24);expect(updates).not.toHaveBeenCalled();
        await settle();expect(control(segments)).not.toBe(previous);await change(segments, 24);
        expect(updates).toHaveBeenLastCalledWith({aiMultiSegmentMaxSegments: 24, aiMultiSegmentMaxCharacters: 7000});
    });

    it('本地连续提交保留两输入实例，合法提交后旧回调仍失效，另一输入草稿不被重建清空', async () => {
        await mount({enableAIMultiSegment: true});
        const segmentInput = control(segments), characterInput = control(characters), oldChange = handler(segments, 'onChange');
        await change(segments, 9);
        expect(control(segments)).toBe(segmentInput);expect(control(characters)).toBe(characterInput);
        oldChange(24);expect(updates).toHaveBeenCalledOnce();
        await change(segments, 10);await change(characters, 2100);
        expect(props.config).toMatchObject({aiMultiSegmentMaxSegments: 10, aiMultiSegmentMaxCharacters: 2100});
        expect(control(segments)).toBe(segmentInput);expect(control(characters)).toBe(characterInput);
    });

    it.each(['segments', 'characters'] as const)('本地提交回写前又收到不同的外部 %s 值时，外部结果胜出并重建输入', async field => {
        await mount({enableAIMultiSegment: true});
        const previous = control(segments), oldChange = handler(segments, 'onChange');
        oldChange(12);
        if (field === 'segments') props.config.aiMultiSegmentMaxSegments = 16;
        else props.config.aiMultiSegmentMaxCharacters = 3500;
        await settle();expect(control(segments)).not.toBe(previous);
        oldChange(24);expect(updates).toHaveBeenCalledOnce();
        expect(props.config).toMatchObject({aiMultiSegmentMaxSegments: field === 'segments' ? 16 : 12,
            aiMultiSegmentMaxCharacters: field === 'segments' ? 2000 : 3500});
    });
});
