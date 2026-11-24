/**
 * @file tests/clickSelectionSettingsLifecycle.test.ts
 * 文件职责：执行两点选取设置的真实客户端模板，验证启停与录制操作的配置归属。
 * 主要内容：覆盖快捷键占用及开启后被其他入口占用的紧凑错误提示与直接修复、录制确认/取消、清除回默认值、隐藏及缓存停用、配置替换和旧弹窗回调失效。
 * 模块边界：只替换 Element Plus 展示控件及共享录制器端口，不替代两点选取设置组件、配置规则或 Vue 生命周期。
 */
import {parseHTML} from 'linkedom';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import * as vue from 'vue';
import {Config} from '@/src/core/config/model';
import {DEFAULT_CLICK_SELECTION_HOTKEY} from '@/src/core/config/clickSelection';
import Settings from '@/src/features/settings/ui/ClickSelectionSettings.vue';

const warnings = vi.hoisted(() => vi.fn());
vi.mock('element-plus', () => ({ElMessage: {warning: warnings}}));
vi.mock('@/src/features/settings/ui/components/SettingsItem.vue', () => ({default: {setup(_: unknown, {attrs, slots}: any) {
    return () => vue.h('section', attrs, [attrs.label, slots.default?.()]);
}}}));
vi.mock('@/src/ui/components/CustomHotkeyInput.vue', () => ({__esModule: true, default: {setup(_: unknown, {attrs}: any) {
    return () => vue.h('div', {...attrs, class: 'recorder-port'});
}}}));

let app: vue.App, document: Document, root: HTMLElement, props: {config: Config; active?: boolean}, shown: vue.Ref<boolean>;
let events: Map<Element, Record<string, any>>;
async function settle() { await vue.nextTick(); await Promise.resolve(); await vue.nextTick(); }
function config(): Config { return Object.assign(new Config(), {selectionTranslatorMode: 'bilingual', disableSelectionTranslator: false}); }
beforeEach(() => { warnings.mockClear(); document = parseHTML('<html><body><div id="app"></div></body></html>').document as unknown as Document; events = new Map(); });
afterEach(async () => {app?.unmount(); await settle();});
async function mount(source = config(), active?: boolean): Promise<void> {
    props = vue.reactive({config: source, ...(active === undefined ? {} : {active})}); shown = vue.ref(true);
    const renderer = vue.createRenderer({
        patchProp(el: any, key: string, _before: unknown, value: any) {
            const handlers = events.get(el) ?? {}; events.set(el, handlers);
            if (/^on[A-Z]/u.test(key)) {handlers[key] = value; return;}
            if (value === false || value === undefined || value === null) el.removeAttribute(key); else el.setAttribute(key, String(value));
        },
        insert: (child: any, parent: any, anchor: any = null) => parent.insertBefore(child, anchor), remove: (node: any) => node.parentNode?.removeChild(node),
        createElement: tag => document.createElement(tag), createText: value => document.createTextNode(value), createComment: value => document.createComment(value),
        setText: (node: any, value) => {node.nodeValue = value;}, setElementText: (el: any, value) => {el.textContent = value;},
        parentNode: (node: any) => node.parentNode, nextSibling: (node: any) => node.nextSibling, querySelector: selector => document.querySelector(selector),
        setScopeId: () => {}, cloneNode: (node: any) => node.cloneNode(true),
        insertStaticContent: (html: string, parent: any, anchor: any) => {const t = document.createElement('template'); t.innerHTML = html;
            const first = t.content.firstChild!, last = t.content.lastChild!; parent.insertBefore(t.content, anchor); return [first, last];},
    });
    app = renderer.createApp({setup: () => () => vue.h(vue.KeepAlive, null, {default: () => shown.value
        ? vue.h(Settings, props) : vue.h({render: () => null}, {key: 'other'})})});
    app.component('el-button', {setup(_: unknown, {attrs, slots}: any) {return () => vue.h('button', attrs, slots.default?.());}});
    app.component('el-switch', {setup(_: unknown, {attrs}: any) {return () => vue.h('input', attrs);}});
    root = document.getElementById('app')!; app.mount(root); await settle();
}
function handler(selector: string, event: string): (...args: any[]) => any {
    const el = root.querySelector(selector)!; expect(el, selector).not.toBeNull();
    const fn = events.get(el)?.[event]; expect(fn, event).toBeTypeOf('function'); return fn;
}
function toggle(value: any): void { handler('[aria-label="两点选取"]', 'onChange')(value); }
async function edit(): Promise<void> {
    handler('[aria-label="编辑两点选取快捷键"]', 'onClick')();
    for (let i = 0; i < 30 && !root.querySelector('.recorder-port'); i++) await settle();
    expect(root.querySelector('.recorder-port')).not.toBeNull();
}

 describe('两点选取设置实际模板与短生命周期', () => {
    it('划词停用时仍可关闭点选偏好或调整组合键，以解除再次启用冲突', async () => {
        await mount(Object.assign(config(), {selectionTranslatorMode:'disabled',disableSelectionTranslator:true,selectionClickSelectEnabled:true}));
        expect(root.querySelector('[aria-label="两点选取"]')?.hasAttribute('disabled')).toBe(false);
        toggle(false);await settle();expect(props.config.selectionClickSelectEnabled).toBe(false);
        await edit();handler('.recorder-port','onConfirm')('Alt+J');await settle();expect(props.config.selectionClickSelectHotkey).toBe('Alt+J');
        expect(props.config.selectionTranslatorMode).toBe('disabled');expect(props.config.disableSelectionTranslator).toBe(true);
    });
    it.each(['hover','full-page','section'] as const)('%s 方案已占用时不能反向开启或改键抢占，停用方案后可启用', async action => {
        const source = Object.assign(config(), {on: false, quickTranslationProfiles: [{id:'reserved',action,enabled:true,hotkey:DEFAULT_CLICK_SELECTION_HOTKEY,
            service:'',model:'',targetLanguage:'',displayMode:'inherit' as const,fullPageMode:'inherit' as const}]});
        await mount(source);toggle(true);expect(props.config.selectionClickSelectEnabled).toBe(false);
        expect(warnings).toHaveBeenCalledWith(expect.stringContaining('额外翻译方案'));
        await edit();handler('.recorder-port','onConfirm')(DEFAULT_CLICK_SELECTION_HOTKEY);await settle();
        expect(root.querySelector('.recorder-port')).not.toBeNull();expect(props.config.quickTranslationProfiles[0].enabled).toBe(true);
        props.config.quickTranslationProfiles[0].enabled=false;handler('.recorder-port','onCancel')();await settle();toggle(true);
        expect(props.config.selectionClickSelectEnabled).toBe(true);
    });
    it('智能高亮快捷键启用时不能反向开启或录制抢占，停用草稿不占用', async () => {
        const source = config(); source.on = false; source.informationHighlight = {...source.informationHighlight, enabled: false, hotkeyEnabled: true, hotkey: DEFAULT_CLICK_SELECTION_HOTKEY};
        await mount(source); toggle(true); expect(props.config.selectionClickSelectEnabled).toBe(false);
        expect(warnings).toHaveBeenCalledWith(expect.stringContaining('智能高亮'));
        await edit(); handler('.recorder-port', 'onConfirm')(DEFAULT_CLICK_SELECTION_HOTKEY); await settle();
        expect(root.querySelector('.recorder-port')).not.toBeNull(); expect(props.config.informationHighlight.hotkeyEnabled).toBe(true);
        props.config.informationHighlight.hotkeyEnabled = false; handler('.recorder-port', 'onCancel')(); await settle(); toggle(true); await settle();
        expect(props.config.selectionClickSelectEnabled).toBe(true);
    });

    it('默认关闭且紧凑，冲突时仍可编辑按键后开启；拒绝非布尔事件，关闭保留按键', async () => {
        await mount(); expect(root.textContent).toContain('两点选取'); expect(root.querySelector('kbd')?.textContent).toMatch(/(?:Alt|Option)\+Shift\+S/u);
        toggle('true'); expect(props.config.selectionClickSelectEnabled).toBe(false);
        props.config.floatingBallHotkey = 'custom'; props.config.customFloatingBallHotkey = DEFAULT_CLICK_SELECTION_HOTKEY;
        toggle(true); expect(props.config.selectionClickSelectEnabled).toBe(false); expect(warnings).toHaveBeenCalledWith(expect.stringContaining('全文翻译'));
        await edit(); handler('.recorder-port', 'onConfirm')('Alt+J'); await settle();
        expect(props.config.selectionClickSelectEnabled).toBe(false); toggle(true); await settle();
        expect(root.querySelector('kbd')?.textContent).toMatch(/(?:Alt|Option)\+J/u);
        toggle(false); await settle(); expect(root.querySelector('kbd')).not.toBeNull(); expect(props.config.selectionClickSelectHotkey).toBe('Alt+J');
    });

    it('录制确认只保存当前有效组合，取消和清除分别保留设置与恢复默认', async () => {
        await mount(Object.assign(config(), {selectionClickSelectEnabled: true})); await edit();
        const confirm = handler('.recorder-port', 'onConfirm');
        confirm('Control'); expect(warnings).toHaveBeenCalledWith(expect.stringContaining('组合键')); expect(root.querySelector('.recorder-port')).not.toBeNull();
        confirm('s'); confirm('Meta+S'); expect(props.config.selectionClickSelectHotkey).toBe(DEFAULT_CLICK_SELECTION_HOTKEY);
        confirm('Alt+J'); await settle(); expect(props.config.selectionClickSelectHotkey).toBe('Alt+J'); expect(root.querySelector('.recorder-port')).toBeNull();
        await edit(); const cancelledConfirm = handler('.recorder-port', 'onConfirm'), cancelledCancel = handler('.recorder-port', 'onCancel');
        cancelledCancel(); await settle(); cancelledConfirm('Alt+M'); cancelledCancel();
        expect(root.querySelector('.recorder-port')).toBeNull(); expect(props.config.selectionClickSelectHotkey).toBe('Alt+J');
        await edit(); cancelledCancel(); cancelledConfirm('Alt+K'); await settle();
        expect(root.querySelector('.recorder-port')).not.toBeNull(); expect(props.config.selectionClickSelectHotkey).toBe('Alt+J');
        handler('.recorder-port', 'onConfirm')(''); await settle(); expect(props.config.selectionClickSelectHotkey).toBe(DEFAULT_CLICK_SELECTION_HOTKEY);
        await edit(); handler('.recorder-port', 'onUpdate:modelValue')(false); await settle();
        expect(root.querySelector('.recorder-port')).toBeNull(); expect(props.config.selectionClickSelectHotkey).toBe(DEFAULT_CLICK_SELECTION_HOTKEY);
    });

    it('录制期间出现新冲突不能确认，去掉冲突后可继续', async () => {
        await mount(Object.assign(config(), {selectionClickSelectEnabled: true})); await edit();
        props.config.paragraphCopyEnabled = true; props.config.paragraphCopyHotkey = 'custom'; props.config.customParagraphCopyHotkey = 'Alt+J';
        handler('.recorder-port', 'onConfirm')('Alt+J'); await settle();
        expect(warnings).toHaveBeenCalledWith(expect.stringContaining('段落复制')); expect(props.config.selectionClickSelectHotkey).toBe(DEFAULT_CLICK_SELECTION_HOTKEY);
        expect(root.querySelector('.recorder-port')).not.toBeNull(); props.config.paragraphCopyEnabled = false;
        handler('.recorder-port', 'onConfirm')('Alt+J'); await settle(); expect(props.config.selectionClickSelectHotkey).toBe('Alt+J');
    });

    it('其他入口后续占用时在原行说明冲突，直接改键后恢复且不切换开关', async () => {
        await mount(Object.assign(config(), {selectionClickSelectEnabled: true}));
        const button = () => root.querySelector('[aria-label="编辑两点选取快捷键"]')!;
        const row = () => root.querySelector('section')!;
        expect(row().getAttribute('description')).toContain('依次点击文字起点和终点');
        expect(button().getAttribute('type')).toBe('default');
        props.config.sectionTranslationHotkeyEnabled = true;
        props.config.sectionTranslationHotkey = 'custom';
        props.config.customSectionTranslationHotkey = DEFAULT_CLICK_SELECTION_HOTKEY;
        await settle();
        expect(button().getAttribute('type')).toBe('danger');
        expect(button().getAttribute('title')).toContain('局部翻译');
        expect(row().getAttribute('description')).toBe(button().getAttribute('title'));
        expect(root.querySelectorAll('section')).toHaveLength(1);
        expect(props.config.selectionClickSelectEnabled).toBe(true);
        await edit(); handler('.recorder-port', 'onConfirm')('Alt+J'); await settle();
        expect(button().getAttribute('type')).toBe('default');
        expect(button().getAttribute('title')).toBe('编辑两点选取快捷键');
        expect(row().getAttribute('description')).toContain('依次点击文字起点和终点');
        expect(props.config.selectionClickSelectEnabled).toBe(true);
        expect(props.config.customSectionTranslationHotkey).toBe(DEFAULT_CLICK_SELECTION_HOTKEY);
    });

    it.each(['hidden', 'cached', 'config', 'enabled', 'mode', 'hotkey', 'unmount'])('%s 使旧开关/按键按钮/弹窗回调作废，恢复后不能复活', async reason => {
        await mount(Object.assign(config(), {selectionClickSelectEnabled: true})); const previous = props.config;
        const oldToggle = handler('[aria-label="两点选取"]', 'onChange'), oldOpen = handler('[aria-label="编辑两点选取快捷键"]', 'onClick');
        await edit(); const confirm = handler('.recorder-port', 'onConfirm'), cancel = handler('.recorder-port', 'onCancel');
        if (reason === 'hidden') props.active = false;
        if (reason === 'cached') shown.value = false;
        if (reason === 'config') props.config = Object.assign(config(), {selectionClickSelectEnabled: true});
        if (reason === 'enabled') props.config.selectionClickSelectEnabled = false;
        if (reason === 'mode') props.config.selectionTranslatorMode = 'disabled';
        if (reason === 'hotkey') props.config.selectionClickSelectHotkey = 'Alt+L';
        if (reason === 'unmount') {app.unmount(); app = undefined as any;}
        await settle(); expect(root.querySelector('.recorder-port')).toBeNull();
        oldToggle(false); oldOpen(); confirm('Alt+J'); cancel(); await settle();
        expect(previous.selectionClickSelectHotkey).toBe(reason === 'hotkey' ? 'Alt+L' : DEFAULT_CLICK_SELECTION_HOTKEY);
        expect(props.config.selectionClickSelectHotkey).not.toBe('Alt+J');
        if (reason === 'unmount') return;
        props.active = true; shown.value = true; props.config.selectionClickSelectEnabled = true; props.config.selectionTranslatorMode = 'bilingual'; await settle();
        oldToggle(false); oldOpen(); confirm('Alt+J'); await settle();
        expect(props.config.selectionClickSelectEnabled).toBe(true); expect(root.querySelector('.recorder-port')).toBeNull();
        await edit(); cancel(); confirm('Alt+K'); await settle(); expect(root.querySelector('.recorder-port')).not.toBeNull();
    });

    it('隐藏的设置不开启、不录制；旧控件也不能重新开启已关闭功能', async () => {
        await mount(Object.assign(config(), {selectionClickSelectEnabled: true}), false);
        const open = handler('[aria-label="编辑两点选取快捷键"]', 'onClick'); open(); toggle(false); await settle();
        expect(root.querySelector('.recorder-port')).toBeNull(); expect(props.config.selectionClickSelectEnabled).toBe(true);
        props.active = true; await settle(); const oldOpen = handler('[aria-label="编辑两点选取快捷键"]', 'onClick'); toggle(false); await settle();
        oldOpen(); await settle(); expect(root.querySelector('.recorder-port')).toBeNull();
    });
});
