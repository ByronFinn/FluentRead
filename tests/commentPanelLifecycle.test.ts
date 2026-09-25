/**
 * @file tests/commentPanelLifecycle.test.ts
 * 文件职责：在纯 node 环境下挂载评论面板，验证自动发起、停止与迟到的结果、配置修订失效、顶部译文展示与回落、复制降级、底部设置跳转与卸载清理。
 * 主要内容：用 Vite ssrLoadModule 加载 CommentPanel.vue，桩掉评论客户端与 webextension-polyfill 的 runtime 消息及 Clipboard API，断言请求次数、取消调用、面板状态迁移（含顶部选区译文的赋值、重置与缺失回落），以及「设置」按钮经 openOptionsPage 跳转翻译卡片分区、失败时降级为面板提示。
 * 模块边界：只验证面板自身的所有权与状态机，不触达后台 handler、模型服务或真实浏览器扩展 runtime。
 */
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import vue from '@vitejs/plugin-vue';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createServer, type Plugin, type ViteDevServer} from 'vite';
import type {CommentRequest, CommentResponse} from '@/src/features/comment-assistant/types';

const TEST_KEY = '__frCommentPanelLifecycle';
interface StreamCall {
    request: CommentRequest;
    callbacks: {result: (response: CommentResponse) => void; error: (error: Error) => void};
    cancel: ReturnType<typeof vi.fn>;
}
let server: ViteDevServer | undefined;
let unmount: (() => void) | undefined;
const runtime = createRequire(import.meta.url)('vue') as typeof import('vue');

afterEach(async () => {
    unmount?.(); unmount = undefined;
    await server?.close(); server = undefined;
    delete (globalThis as Record<string, unknown>)[TEST_KEY];
    delete (navigator as unknown as {clipboard?: unknown}).clipboard;
});

async function mountPanel(overrides: Record<string, unknown> = {}) {
    const calls: StreamCall[] = [];
    const state = {
        requestComments: (request: CommentRequest, callbacks: StreamCall['callbacks']) => {
            const call = {request, callbacks, cancel: vi.fn()};
            calls.push(call);
            return {cancel: call.cancel};
        },
        // 面板的「设置」按钮只经 runtime 消息请求打开设置页分区；单测替换实现模拟成功与失败。
        sendMessage: async (_message: unknown) => ({success: true}) as unknown,
    };
    (globalThis as Record<string, unknown>)[TEST_KEY] = state;
    const mocks: Plugin = {
        name: 'comment-panel-mocks', enforce: 'pre',
        resolveId(id, importer) {
            if (id === '../client' && importer?.includes('/comment-assistant/ui/')) return '\0comment-client';
            // 面板经 polyfill 触达后台消息；polyfill 只在浏览器扩展环境可用，这里桩掉。
            if (id === 'webextension-polyfill') return '\0comment-panel-browser';
            return null;
        },
        load(id) {
            if (id === '\0comment-client') return `export const requestComments = (...args) => globalThis.${TEST_KEY}.requestComments(...args);`;
            if (id === '\0comment-panel-browser') return `const browser = {runtime: {sendMessage: (...args) => globalThis.${TEST_KEY}.sendMessage(...args)}};\nexport default browser;`;
            return null;
        },
    };
    server = await createServer({configFile: false, appType: 'custom', logLevel: 'silent', root: process.cwd(),
        plugins: [mocks, vue()], resolve: {alias: {'@': resolve(process.cwd())}},
        server: {hmr: false, middlewareMode: true}, ssr: {noExternal: ['webextension-polyfill']}});
    const loaded = await server.ssrLoadModule('/src/features/comment-assistant/ui/CommentPanel.vue');
    const component = loaded.default;
    component.ssrRender = undefined; component.render = () => null;
    const renderer = runtime.createRenderer<Record<string, never>, Record<string, unknown>>({
        patchProp: () => undefined, insert: () => undefined, remove: () => undefined,
        createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
        setText: () => undefined, setElementText: () => undefined, parentNode: () => null,
        nextSibling: () => null, querySelector: () => null, setScopeId: () => undefined,
        cloneNode: () => ({}), insertStaticContent: () => [{}, {}],
    });
    const props = runtime.reactive({selection: {text: 'Ship it Friday.', images: ['data:image/png;base64,AA']},
        active: true, modelRevision: 0, ...overrides});
    let panel: any;
    const app = renderer.createApp({setup: () => () => runtime.h(component, {...props, ref: (instance: any) => { if (instance) panel = instance.$.setupState; }})});
    app.provide(runtime.ssrContextKey, {modules: new Set<string>()});
    app.config.warnHandler = () => undefined;
    app.mount({}); unmount = () => app.unmount();
    await runtime.nextTick();
    const finish = (response: CommentResponse, call = calls.at(-1)!) => call.callbacks.result(response);
    return {panel, props, calls, state, finish, tick: runtime.nextTick};
}

// 成功响应统一带上选区译文：默认 null（顶部回落原文），需要的用例按断言传入译文字符串。
const okComments = (content: string, sourceTranslation: string | null = null): CommentResponse =>
    ({success: true, comments: [{content, translation: null}], sourceTranslation});

describe('comment panel ownership and lifecycle', () => {
    it('generates once per selection and ignores a result that arrives after stop', async () => {
        const {panel, calls, finish, tick} = await mountPanel();
        expect(calls).toHaveLength(1);
        expect(calls[0].request).toMatchObject({type: 'fluentReadComment', action: 'run', text: 'Ship it Friday.'});
        expect(calls[0].request.requestId).toMatch(/^comment-/u);
        panel.stop();
        const stale = calls[0];
        finish(okComments('Late'), stale);
        await tick();
        expect(panel.comments).toEqual([]);
        expect(panel.busy).toBe(false);
        panel.generate();
        expect(calls).toHaveLength(2);
        finish(okComments('Fresh'), calls[1]);
        expect(panel.comments.map((item: {content: string}) => item.content)).toEqual(['Fresh']);
    });

    it('starts a new request whenever the selection changes again', async () => {
        const {panel, props, calls, finish, tick} = await mountPanel();
        finish(okComments('First'));
        props.selection = {...props.selection, text: 'Another paragraph.'};
        await tick();
        expect(calls).toHaveLength(2);
        finish(okComments('Second'));
        props.selection = {...props.selection, text: 'Ship it Friday.'};
        await tick();
        expect(calls).toHaveLength(3);
        panel.generate();
        expect(calls).toHaveLength(4);
    });

    // 挂载设施不渲染真实 DOM，顶部展示契约是模板表达式 sourceTranslation ?? selection.text，这里断言驱动它的状态。
    it('shows the source translation at the top when the response carries one', async () => {
        const {panel, props, finish} = await mountPanel();
        finish(okComments('Ship it!', '这是选区的中文译文'));
        expect(panel.sourceTranslation).toBe('这是选区的中文译文');
        // 译文优先：顶部不再显示选区原文文本。
        expect(panel.sourceTranslation ?? props.selection.text).not.toBe(props.selection.text);
    });

    it('falls back to the raw selection at the top when no translation is provided', async () => {
        const {panel, props, finish} = await mountPanel();
        // 选区即目标语言等情况后台会回 null，顶部回落显示原文。
        finish(okComments('中文选区'));
        expect(panel.sourceTranslation).toBe(null);
        expect(panel.sourceTranslation ?? props.selection.text).toBe('Ship it Friday.');
    });

    it('resets the top translation while regenerating and shows the new one on arrival', async () => {
        const {panel, props, calls, finish} = await mountPanel();
        finish(okComments('First', '第一版译文'));
        expect(panel.sourceTranslation).toBe('第一版译文');
        panel.generate();
        expect(panel.busy).toBe(true);
        // 忙碌期间新请求已重置译文，顶部回落为选区原文。
        expect(panel.sourceTranslation).toBe(null);
        expect(panel.sourceTranslation ?? props.selection.text).toBe('Ship it Friday.');
        finish(okComments('Second', '第二版译文'), calls[1]);
        expect(panel.sourceTranslation).toBe('第二版译文');
    });

    it('keeps a settings revision from silently spending another request', async () => {
        const {panel, props, calls, finish, tick} = await mountPanel();
        finish(okComments('Answer'));
        Object.assign(props, {modelRevision: 1});
        await tick();
        expect(calls).toHaveLength(1);
        expect(panel.comments).toEqual([]);
        expect(panel.notice).toContain('设置已更新');
        panel.generate();
        expect(calls).toHaveLength(2);
    });

    it('surfaces provider failures and clears them on the next attempt', async () => {
        const {panel, calls, finish, tick} = await mountPanel();
        calls[0].callbacks.error(new Error('连接断开'));
        await tick();
        expect(panel.error).toContain('连接断开');
        finish(okComments('Ignored'));
        expect(panel.error).toContain('连接断开');
        panel.generate();
        expect(panel.error).toBe('');
    });

    it('reports a cancelled result without an error and keeps the previous list', async () => {
        const {panel, calls, finish} = await mountPanel();
        finish(okComments('Kept'));
        panel.generate();
        calls[1].callbacks.result({success: false, error: '已取消', cancelled: true});
        expect(panel.error).toBe('');
        expect(panel.comments.map((item: {content: string}) => item.content)).toEqual(['Kept']);
    });

    it('degrades copy without the clipboard API and clears its timer on unmount', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', {value: {writeText}, configurable: true});
        const {panel, calls, finish, tick} = await mountPanel();
        finish(okComments('Paste me'));
        panel.copy('item-0', 'Paste me');
        await tick();
        expect(writeText).toHaveBeenCalledWith('Paste me');
        expect(panel.copied).toBe('item-0');
        delete (navigator as unknown as {clipboard?: unknown}).clipboard;
        panel.copy('item-0', 'Paste me');
        expect(panel.notice).toContain('复制失败');
        unmount?.(); unmount = undefined;
        await tick();
        expect(calls).toHaveLength(1);
    });

    it('cancels the in-flight request when the panel unmounts', async () => {
        const {panel, calls} = await mountPanel();
        expect(calls).toHaveLength(1);
        unmount?.(); unmount = undefined;
        await runtime.nextTick();
        expect(calls[0].cancel).toHaveBeenCalledOnce();
        expect(panel.busy).toBe(false);
    });

    it('stops generating while inactive', async () => {
        const {panel, props, calls, tick} = await mountPanel({active: false});
        expect(calls).toHaveLength(0);
        props.active = true;
        await tick();
        expect(calls).toHaveLength(1);
        props.active = false;
        await tick();
        expect(calls[0].cancel).toHaveBeenCalledOnce();
        expect(panel.busy).toBe(false);
    });

    it('ignores an error that arrives after the request was stopped', async () => {
        const {panel, calls, tick} = await mountPanel();
        panel.stop();
        calls[0].callbacks.error(new Error('迟到的失败'));
        await tick();
        expect(panel.error).toBe('');
        expect(panel.busy).toBe(false);
    });

    it('clears the copy feedback timer when the panel unmounts', async () => {
        vi.useFakeTimers();
        try {
            Object.defineProperty(navigator, 'clipboard', {value: {writeText: vi.fn().mockResolvedValue(undefined)}, configurable: true});
            const {panel, calls, finish} = await mountPanel();
            finish(okComments('Paste me'), calls[0]);
            panel.copy('item-0', 'Paste me');
            await vi.advanceTimersByTimeAsync(0);
            expect(panel.copied).toBe('item-0');
            unmount?.(); unmount = undefined;
            await vi.advanceTimersByTimeAsync(5_000);
            expect(panel.copied).toBe('item-0');
        } finally {
            vi.useRealTimers();
            delete (navigator as unknown as {clipboard?: unknown}).clipboard;
        }
    });

    it('leaves the loading state when the port cannot be opened', async () => {
        const {panel, calls, tick} = await mountPanel();
        expect(calls).toHaveLength(1);
        (globalThis as Record<string, any>)[TEST_KEY].requestComments = () => { throw new Error('context invalidated'); };
        panel.generate();
        await tick();
        expect(panel.busy).toBe(false);
        expect(panel.error).toContain('未能发出');
    });

    it('opens the translation card settings section from the bottom bar and degrades on background failure', async () => {
        const {panel, state, tick} = await mountPanel();
        // 卡内折叠编辑器已删除：设置统一在设置页翻译卡片分区，卡内只剩跳转按钮，失败走面板提示行。
        expect(panel.draft).toBeUndefined();
        expect(panel.settingsSummary).toBeUndefined();
        const sent: unknown[] = [];
        state.sendMessage = async (message: unknown) => { sent.push(message); return {success: true}; };
        await panel.openSettings();
        await tick();
        expect(sent).toEqual([{type: 'openOptionsPage', section: 'settings-harness'}]);
        expect(panel.notice).toBe('');
        state.sendMessage = async () => undefined;
        await panel.openSettings();
        await tick();
        expect(panel.notice).toBe('打开设置失败，请从专项翻译进入“翻译卡片”。');
        state.sendMessage = async () => { throw new Error('background stopped'); };
        await panel.openSettings();
        expect(panel.notice).toBe('打开设置失败，请从专项翻译进入“翻译卡片”。');
    });
});
