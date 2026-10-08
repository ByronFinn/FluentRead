/**
 * @file tests/harnessSettingsCommentPrompt.test.ts
 * 文件职责：在纯 node 环境挂载设置页翻译卡片分区，验证评论风格提示词的契约文案与系统提示词预览行为。
 * 主要内容：用 Vite ssrLoadModule 加载 HarnessSettings.vue（桩掉子组件、UI i18n、阅读卡公开出口与 webextension-polyfill），以元素捕获型渲染器执行真实模板；断言工具行契约文案、预览按钮的显隐切换与 aria-expanded、预览文本等于 buildCommentSystemPrompt 的未识别选区语言场景拼装（含安全壳段、用户风格段、计数渲染与目标语言），以及预览随编辑实时更新、留空回落默认风格。
 * 模块边界：只验证设置组件自身的展示与状态机，不触达配置存储、后台消息或浏览器扩展 runtime。
 */
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import vue from '@vitejs/plugin-vue';
import {afterEach, describe, expect, it} from 'vitest';
import {createServer, type Plugin, type ViteDevServer} from 'vite';
import {compileScript, compileTemplate, parse} from 'vue/compiler-sfc';
import ts from 'typescript';
import {buildCommentSystemPrompt, COMMENT_SECURITY_RULES, DEFAULT_COMMENT_PROMPT} from '@/src/core/comment/prompts';
import {Config} from '@/src/core/config/model';

const runtime = createRequire(import.meta.url)('vue') as typeof import('vue');
const CONTRACT_COPY = '选中文本与图片会自动提供，无需写入提示词。提示词只影响语气、视角与风格；评论语言由目标语言设置与选区语言判定决定，条数由上方计数器决定，均不受提示词影响。留空使用默认风格。';
const PREVIEW_NOTE = '以未识别选区语言的场景预览；实际语言段会按选区语言自动判定注入。';
const CUSTOM_STYLE = '以武侠笔锋点评，多用反问。';

type RenderElement = Record<string, any> & {tag: string; props: Record<string, any>; text?: string};
let server: ViteDevServer | undefined;
let unmount: (() => void) | undefined;

afterEach(async () => {
    unmount?.(); unmount = undefined;
    await server?.close(); server = undefined;
});

// 与 glossarySettingsComponent 同款桩：子 .vue 渲染插槽以保留分区内容，UI i18n 与阅读卡公开出口替换为纯实现。
function mocks(): Plugin {
    return {name: 'harness-comment-prompt-mocks', enforce: 'pre', resolveId(id) {
        if (id === 'webextension-polyfill') return '\0harness-comment-browser';
        if (id.endsWith('.vue') && !id.endsWith('/HarnessSettings.vue')) return '\0harness-comment-child';
        if (/\/src\/ui\/i18n(?:\.ts)?$/u.test(id)) return '\0harness-comment-i18n';
        if (/\/reading-assistant\/public(?:\.ts)?$/u.test(id)) return '\0harness-comment-reading';
        return null;
    }, load(id) {
        if (id === '\0harness-comment-child') return `import {h} from 'vue'; export default {inheritAttrs: false, setup: (_props, {slots}) => () => h('div', slots.default?.() ?? [])};`;
        if (id === '\0harness-comment-browser') return 'export default {runtime: {sendMessage: async () => undefined}}';
        if (id === '\0harness-comment-i18n') return `import {ref} from 'vue'; export const useUiI18n = () => ({language: ref('zh-CN'), t: (key) => key, translateLegacy: (text) => text});`;
        if (id === '\0harness-comment-reading') return `import {h} from 'vue'; export const ReadingAnswer = {props: ['text'], setup: () => () => h('div')};`;
        return null;
    }};
}

async function settle(): Promise<void> {for (let index = 0; index < 8; index += 1) {await Promise.resolve(); await runtime.nextTick();}}

async function mountHarness() {
    const config = runtime.reactive(new Config());
    config.comment.count = 2;
    config.comment.prompt = CUSTOM_STYLE;
    server = await createServer({configFile: false, appType: 'custom', logLevel: 'silent', root: process.cwd(),
        plugins: [mocks(), vue()], resolve: {alias: {'@': resolve(process.cwd(), '.')}},
        server: {hmr: false, middlewareMode: true}, ssr: {noExternal: ['webextension-polyfill']}});
    const {default: component} = await server.ssrLoadModule('/src/features/settings/ui/HarnessSettings.vue');
    // 编译真实模板并在捕获元素的宿主渲染器中执行，断言直接落在渲染结果上。
    const filename = resolve(process.cwd(), 'src/features/settings/ui/HarnessSettings.vue');
    const {descriptor} = parse(readFileSync(filename, 'utf8'), {filename});
    const bindings = compileScript(descriptor, {id: 'harness-comment-prompt-test'}).bindings;
    const template = compileTemplate({source: descriptor.template!.content, filename, id: 'harness-comment-prompt-test',
        compilerOptions: {mode: 'function', bindingMetadata: bindings, expressionPlugins: ['typescript']}});
    expect(template.errors).toEqual([]);
    const renderCode = ts.transpileModule(template.code, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
    component.ssrRender = undefined;
    component.render = new Function('Vue', renderCode)({...runtime, vModelText: {}, vModelSelect: {}, vModelCheckbox: {}});
    const elements: RenderElement[] = [];
    const renderer = runtime.createRenderer<RenderElement, RenderElement>({
        patchProp: (node, key, _previous, value) => {node.props[key] = value;},
        insert: () => undefined, remove: () => undefined,
        createElement: tag => {const node = {tag, props: {}}; elements.push(node); return node;},
        createText: () => ({tag: '#text', props: {}}), createComment: () => ({tag: '#comment', props: {}}),
        setText: () => undefined, setElementText: (node, value) => {node.text = String(value);},
        parentNode: () => null, nextSibling: () => null, querySelector: () => null, setScopeId: () => undefined,
        cloneNode: node => ({...node}), insertStaticContent: () => [{tag: '#static', props: {}}, {tag: '#static', props: {}}],
    });
    const app = renderer.createApp(component, {config});
    app.provide(runtime.ssrContextKey, {modules: new Set<string>()});
    app.config.warnHandler = () => undefined;
    const vm = app.mount({tag: '#root', props: {}});
    const state = (vm.$ as unknown as {setupState: Record<string, any>}).setupState;
    await settle();
    return {config, state, elements};
}

function previewButtons(elements: RenderElement[]): RenderElement[] {
    return elements.filter(node => node.tag === 'button' && node.props['aria-controls'] === 'harness-comment-prompt-preview');
}

function previewTexts(elements: RenderElement[]): string[] {
    return elements.filter(node => node.tag === 'pre' && String(node.props.class ?? '').includes('harness-comment-prompt-preview-text'))
        .map(node => node.text ?? '');
}

describe('HarnessSettings comment prompt contract and preview', () => {
    it('renders the explicit contract copy in the style instruction toolbar', async () => {
        const {elements} = await mountHarness();
        expect(elements.some(node => node.tag === 'small' && node.text === CONTRACT_COPY)).toBe(true);
    });

    it('toggles the preview and renders the shell, style, count and target language segments', async () => {
        const {config, elements} = await mountHarness();
        expect(previewTexts(elements)).toEqual([]);
        const [button] = previewButtons(elements);
        expect(button?.text).toBe('预览系统提示词');
        expect(button?.props['aria-expanded']).toBe(false);
        button?.props.onClick?.();
        await settle();
        const [expanded] = previewButtons(elements).slice(-1);
        expect(expanded?.text).toBe('收起预览');
        expect(expanded?.props['aria-expanded']).toBe(true);
        // 预览以未识别选区语言的场景拼装：安全壳、用户风格段、按计数器渲染的任务规则与目标语言同时可见。
        const [preview] = previewTexts(elements).slice(-1);
        expect(preview).toBe(buildCommentSystemPrompt(config.comment.prompt, config.comment.count, config.to,
            {sameLanguage: false, selectionLanguage: undefined}));
        expect(preview).toContain(COMMENT_SECURITY_RULES);
        expect(preview).toContain(CUSTOM_STYLE);
        expect(preview).toContain('一次提交恰好 2 条');
        expect(preview).toContain('zh-Hans');
        expect(elements.some(node => node.tag === 'small' && String(node.props.class ?? '').includes('harness-comment-prompt-preview-note') && node.text === PREVIEW_NOTE)).toBe(true);
    });

    it('updates the preview live and hides it again on the second toggle', async () => {
        const {config, elements} = await mountHarness();
        previewButtons(elements)[0]?.props.onClick?.();
        await settle();
        config.comment.prompt = '改用温柔语气，先共情再吐槽。';
        await settle();
        expect(previewTexts(elements).at(-1)).toContain('改用温柔语气，先共情再吐槽。');
        config.comment.prompt = '';
        await settle();
        // 留空回落默认风格段，其余四段保持内置，证明预览展示的是最终系统提示词而非用户原文。
        expect(previewTexts(elements).at(-1)).toContain(DEFAULT_COMMENT_PROMPT);
        expect(previewTexts(elements).at(-1)).toContain(COMMENT_SECURITY_RULES);
        const before = previewTexts(elements).length;
        previewButtons(elements).at(-1)?.props.onClick?.();
        await settle();
        // 捕获型渲染器不回收已卸载节点，纯长度断言恒真；改断言开关回到初始态：按钮文案复原且 aria-expanded 收起。
        const [collapsed] = previewButtons(elements).slice(-1);
        expect(collapsed?.text).toBe('预览系统提示词');
        expect(collapsed?.props['aria-expanded']).toBe(false);
        config.comment.prompt = '隐藏后不应出现新预览。';
        await settle();
        expect(previewTexts(elements)).toHaveLength(before);
    });
});
