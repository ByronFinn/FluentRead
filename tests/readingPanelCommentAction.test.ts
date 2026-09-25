/**
 * @file tests/readingPanelCommentAction.test.ts
 * 文件职责：在纯 node 环境下渲染阅读面板的真实模板，验证「评论」动作与 读懂/拆句/用法/练习 并列出现在动作行并把点击透传给父级。
 * 主要内容：重编 ReadingPanel.vue 的客户端渲染函数，用记录元素与事件的自定义渲染器收集按钮树，断言 commentEnabled 时动作行渲染「评论」按钮、位于学习动作之后与「重新生成」之前、不带选中态且点击触发 open-comment；关闭时不渲染。
 * 模块边界：只验证动作行的呈现与事件契约，不触达后台 handler、模型服务或真实浏览器扩展 runtime。
 */
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import vue from '@vitejs/plugin-vue';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createServer, type Plugin, type ViteDevServer} from 'vite';
import {compileScript, compileTemplate, parse} from 'vue/compiler-sfc';
import ts from 'typescript';
import {DEFAULT_HARNESS_PREFERENCES} from '@/src/core/config/harness';

const TEST_KEY = '__frReadingPanelCommentAction';
const require = createRequire(import.meta.url);
const runtime = require('vue') as typeof import('vue');
let server: ViteDevServer | undefined;
let unmount: (() => void) | undefined;

afterEach(async () => {
  unmount?.(); unmount = undefined;
  await server?.close(); server = undefined;
  delete (globalThis as Record<string, unknown>)[TEST_KEY];
});

// 桩掉阅读客户端、runtime 消息与界面文案，模板本身保持真实编译。
function mocks(): Plugin {
  return {name: 'reading-comment-action-mocks', enforce: 'pre', resolveId(id, importer) {
    if (id === 'webextension-polyfill') return '\0reading-action-browser';
    if (id === '../client' && importer?.includes('/reading-assistant/ui/')) return '\0reading-action-client';
    if (id === '@/src/ui/i18n' || id.replaceAll('\\', '/').endsWith('/src/ui/i18n')) return '\0reading-action-i18n';
    return null;
  }, load(id) {
    if (id === '\0reading-action-browser') return 'export default {runtime: {sendMessage: async () => ({success: true})}};';
    if (id === '\0reading-action-client') return `export const {streamReading,getHarnessSession,listHarnessSessions,saveLearningMemory} = globalThis.${TEST_KEY};`;
    if (id === '\0reading-action-i18n') return `import {ref} from 'vue'; export const useUiI18n = () => ({language: ref('zh-CN'), t: key => key, translateLegacy: text => text});`;
    return null;
  }};
}

type RenderNode = Record<string, any> & {tag: string; props: Record<string, any>; children?: RenderNode[]; text?: string};

async function mountReadingPanel(commentEnabled: boolean) {
  (globalThis as Record<string, unknown>)[TEST_KEY] = {
    streamReading: () => ({cancel: () => undefined}),
    getHarnessSession: vi.fn(async () => null),
    listHarnessSessions: vi.fn(async () => ({sessions: [], hasMore: false})),
    saveLearningMemory: vi.fn(async () => ({})),
  };
  server = await createServer({configFile: false, appType: 'custom', logLevel: 'silent', root: process.cwd(),
    plugins: [mocks(), vue()], resolve: {alias: {'@': resolve(process.cwd())}},
    server: {hmr: false, middlewareMode: true}, ssr: {noExternal: ['webextension-polyfill']}});
  // SSR 变体不产出客户端渲染函数；按仓库既有做法用真实模板重编，保留值绑定与事件监听。
  const filename = resolve(process.cwd(), 'src/features/reading-assistant/ui/ReadingPanel.vue');
  const {descriptor} = parse(readFileSync(filename, 'utf8'), {filename});
  const bindings = compileScript(descriptor, {id: 'reading-comment-action-test'}).bindings;
  const template = compileTemplate({source: descriptor.template!.content, filename, id: 'reading-comment-action-test',
    compilerOptions: {mode: 'function', bindingMetadata: bindings, expressionPlugins: ['typescript']}});
  expect(template.errors).toEqual([]);
  const renderCode = ts.transpileModule(template.code, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
  const loaded = await server.ssrLoadModule('/src/features/reading-assistant/ui/ReadingPanel.vue');
  const component = loaded.default;
  component.render = new Function('Vue', renderCode)({...runtime, vModelText: {}});
  // 渲染器记录元素属性与父子关系，静态文本落在元素 text，动态插值落在子文本节点上。
  const elements: RenderNode[] = [];
  const renderer = runtime.createRenderer<RenderNode, RenderNode>({
    patchProp: (node, key, _previous, value) => {node.props[key] = value;},
    insert: (child, parent) => { if (Array.isArray(parent?.children) && !parent.children.includes(child)) parent.children.push(child); },
    remove: () => undefined,
    createElement: tag => {const node = {tag, props: {}, children: []}; elements.push(node); return node;},
    createText: text => ({tag: '#text', props: {}, text}), createComment: () => ({tag: '#comment', props: {}}),
    setText: (node, value) => {node.text = value;}, setElementText: (node, value) => {node.text = value;},
    parentNode: () => null, nextSibling: () => null, querySelector: () => null, setScopeId: () => undefined,
    cloneNode: node => ({...node}), insertStaticContent: () => [{tag: '#static', props: {}, children: []}, {tag: '#static', props: {}, children: []}],
  });
  const openComment = vi.fn();
  const props = runtime.reactive({selection: {text: 'Practice helps.', sentence: 'Practice helps.', context: 'Practice helps every day.'},
    preferences: {...DEFAULT_HARNESS_PREFERENCES, enabled: true}, active: true, targetLanguage: 'zh-CN', sourceLanguage: 'en',
    vocabularyEnabled: false, privateContext: false, animations: false, commentEnabled, onOpenComment: openComment});
  const app = renderer.createApp({setup: () => () => runtime.h(component, props)});
  app.provide(runtime.ssrContextKey, {modules: new Set<string>()});
  app.config.warnHandler = () => undefined;
  app.mount({tag: '#root', props: {}, children: []}); unmount = () => app.unmount();
  for (let index = 0; index < 8; index += 1) { await Promise.resolve(); await runtime.nextTick(); }
  const textOf = (node: RenderNode): string => {
    let value = node.text ?? '';
    for (const child of node.children ?? []) if (child.tag !== '#comment' && child.tag !== '#static') value += textOf(child);
    return value;
  };
  // 动作行容器带 role=group 与「学习方式」标签；按钮顺序即创建顺序。
  const actionRow = () => elements.find(node => node.props.role === 'group' && node.props['aria-label'] === '学习方式');
  const rowButtons = () => {
    const row = actionRow();
    const buttons: Array<RenderNode & {label: string}> = [];
    const visit = (node: RenderNode) => { for (const child of node.children ?? []) { if (child.tag === 'button') buttons.push({...child, label: textOf(child)}); visit(child); } };
    if (row) visit(row);
    return buttons;
  };
  return {rowButtons, openComment};
}

describe('reading panel comment action row', () => {
  it('renders the comment action after study actions and before regenerate, emitting open-comment on click', async () => {
    const {rowButtons, openComment} = await mountReadingPanel(true);
    const labels = rowButtons().map(button => button.label);
    expect(labels).toEqual(['读懂', '拆句', '用法', '练习', '评论', '重新生成']);
    const commentButton = rowButtons().find(button => button.label === '评论')!;
    // 评论会切换到另一页签，不属于学习方式选中态。
    expect(commentButton.props['aria-pressed']).toBeUndefined();
    commentButton.props.onClick?.({});
    expect(openComment).toHaveBeenCalledOnce();
  });

  it('hides the comment action when the comment assistant is disabled', async () => {
    const {rowButtons, openComment} = await mountReadingPanel(false);
    expect(rowButtons().map(button => button.label)).toEqual(['读懂', '拆句', '用法', '练习', '重新生成']);
    expect(openComment).not.toHaveBeenCalled();
  });
});
