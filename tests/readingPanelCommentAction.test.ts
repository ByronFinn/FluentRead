/**
 * @file tests/readingPanelCommentAction.test.ts
 * 文件职责：在纯 node 环境下用 SSR 渲染阅读面板的真实模板，验证「评论」动作与 读懂/句法/用法/练习 并列出现在动作行。
 * 主要内容：ssrLoadModule 加载 ReadingPanel.vue 后用 renderToString 一次性渲染（不触发挂载后的会话恢复与监听副作用），解析 role=group「学习方式」内的按钮序列，断言 commentEnabled 时动作行渲染「评论」按钮、位于学习动作之后且不带选中态；关闭时不渲染。事件契约由模板源码断言（@click 触发 open-comment）覆盖，SSR 输出不包含运行时事件处理器。「重新生成」已收进更多操作菜单，不在动作行断言范围。
 * 模块边界：只验证动作行的呈现与事件契约，不触达后台 handler、模型服务或真实浏览器扩展 runtime。
 */
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import vue from '@vitejs/plugin-vue';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createServer, type Plugin, type ViteDevServer} from 'vite';
import {renderToString} from 'vue/server-renderer';
import {DEFAULT_HARNESS_PREFERENCES} from '@/src/core/config/harness';

const TEST_KEY = '__frReadingPanelCommentAction';
const require = createRequire(import.meta.url);
const runtime = require('vue') as typeof import('vue');
let server: ViteDevServer | undefined;

afterEach(async () => {
  server = undefined;
  await Promise.resolve();
  delete (globalThis as Record<string, unknown>)[TEST_KEY];
});

// 桩掉阅读客户端、runtime 消息、界面文案与重组件回答子树，模板本身保持真实编译。
function mocks(): Plugin {
  return {name: 'reading-comment-action-mocks', enforce: 'pre', resolveId(id, importer) {
    if (id === 'webextension-polyfill') return '\0reading-action-browser';
    if (id === '../client' && importer?.includes('/reading-assistant/ui/')) return '\0reading-action-client';
    if (id === '@/src/ui/i18n' || id.replaceAll('\\', '/').endsWith('/src/ui/i18n')) return '\0reading-action-i18n';
    if (id.endsWith('ReadingAnswer.vue')) return '\0reading-action-answer';
    return null;
  }, load(id) {
    if (id === '\0reading-action-browser') return 'export default {runtime: {sendMessage: async () => ({success: true})}};';
    if (id === '\0reading-action-client') return `export const {streamReading,getHarnessSession,listHarnessSessions,saveLearningMemory} = globalThis.${TEST_KEY};`;
    if (id === '\0reading-action-i18n') return `import {ref} from 'vue'; export const useUiI18n = () => ({language: ref('zh-CN'), t: key => key, translateLegacy: text => text});`;
    if (id === '\0reading-action-answer') return 'export default {setup: () => () => null};';
    return null;
  }};
}

async function renderReadingPanel(commentEnabled: boolean) {
  (globalThis as Record<string, unknown>)[TEST_KEY] = {
    streamReading: () => ({cancel: () => undefined}),
    getHarnessSession: vi.fn(async () => null),
    listHarnessSessions: vi.fn(async () => ({sessions: [], hasMore: false})),
    saveLearningMemory: vi.fn(async () => ({})),
  };
  server = await createServer({configFile: false, appType: 'custom', logLevel: 'silent', root: process.cwd(),
    plugins: [mocks(), vue()], resolve: {alias: {'@': resolve(process.cwd())}},
    server: {hmr: false, middlewareMode: true}, ssr: {noExternal: ['webextension-polyfill']}});
  const loaded = await server.ssrLoadModule('/src/features/reading-assistant/ui/ReadingPanel.vue');
  const component = loaded.default;
  const props = {
    selection: {text: 'Practice helps.', sentence: 'Practice helps.', context: 'Practice helps every day.'},
    preferences: {...DEFAULT_HARNESS_PREFERENCES, enabled: true}, active: true, targetLanguage: 'zh-CN', sourceLanguage: 'en',
    vocabularyEnabled: false, privateContext: false, animations: false, commentEnabled,
    onOpenComment: () => undefined};
  // SSR 只执行 setup 与渲染，不触发 onMounted 的会话恢复、滚动监听等浏览器副作用。
  return renderToString(runtime.h(component, props));
}

/** 取动作行（role=group「学习方式」）内的按钮文本序列与评论按钮开标签。 */
function parseActionRow(html: string): {labels: string[]; commentButtonTag: string | null} {
  // SSR 输出会追加 scoped data-v 属性，属性边界用 [^>]* 容纳。
  const row = html.match(/<div class="fr-reading-actions"[^>]*role="group"[^>]*aria-label="学习方式"[^>]*>([\s\S]*?)<\/div>/);
  expect(row, '动作行应当渲染').toBeTruthy();
  const labels = [...row![1].matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map(match => match[1].trim());
  const commentMatch = row![1].match(/<button\b[^>]*>评论<\/button>/);
  return {labels, commentButtonTag: commentMatch?.[0] ?? null};
}

describe('reading panel comment action row', () => {
  it('renders the comment action after study actions without a pressed state', async () => {
    const html = await renderReadingPanel(true);
    const {labels, commentButtonTag} = parseActionRow(html);
    // 上游把 grammar 动作在按钮上显示为「句法」；「重新生成」在更多操作菜单，不出现在动作行。
    expect(labels).toEqual(['读懂', '句法', '用法', '练习', '评论']);
    // 评论切换到另一页签，不属于学习方式选中态；事件契约由模板源码断言覆盖。
    expect(commentButtonTag).toContain('type="button"');
    expect(commentButtonTag).not.toContain('aria-pressed');
    expect(readFileSync(resolve(process.cwd(), 'src/features/reading-assistant/ui/ReadingPanel.vue'), 'utf8'))
      .toContain(`<button v-if="commentEnabled" type="button" @click="emit('open-comment')">评论</button>`);
  });

  it('hides the comment action when the comment assistant is disabled', async () => {
    const html = await renderReadingPanel(false);
    expect(parseActionRow(html).labels).toEqual(['读懂', '句法', '用法', '练习']);
    expect(parseActionRow(html).commentButtonTag).toBeNull();
  });
});
