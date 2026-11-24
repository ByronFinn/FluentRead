/**
 * @file src/features/vocabulary/content/reencounter.ts
 * 文件职责：把收藏匹配、后台读取和隔离 Vue 浮层接入统一内容生命周期。
 * 主要内容：按开关与无痕边界挂载，消息订阅失败或挂载途中失效时回滚扫描器与监听；接收跨页收藏变更，按需读取选中收藏，用代次与取消信号阻止关闭后的迟到读取及浮层复活，支持本次暂停与永久关闭。
 * 模块边界：不访问 Dexie 或模型端点，不更改宿主正文、收藏次数或复习状态；匹配归 scanner，讲解归既有 reading-assistant 流式客户端。
 */
import browser from 'webextension-polyfill';
import {shallowReactive} from 'vue';
import type {ContentScriptContext} from 'wxt/utils/content-script-context';
import {createVueShadowUi} from '@/src/platform/shadow-ui';
import {config, requestConfigPatch} from '@/src/services/config/store';
import {VOCABULARY_BOOK_CHANGED_MESSAGE, VOCABULARY_BOOK_MESSAGE, type VocabularyBookResponse} from '../protocol';
import type {ReencounterEntry} from '../domain/reencounter';
import {installReencounterScanner, type ReencounterScanner} from './scanner';
import type {ReencounterOccurrence} from './readingText';
import type {ReencounterState} from './reencounterState';
import ReencounterPanel from '../ui/ReencounterPanel.vue';

let owner: {dispose: () => void} | undefined;

export function unmountVocabularyReencounter(): void { owner?.dispose(); owner = undefined; }

export function mountVocabularyReencounter(ctx: ContentScriptContext, signal: AbortSignal): void {
  if (owner || signal.aborted || ctx.isInvalid || browser.extension.inIncognitoContext || !config.vocabularyReencounterEnabled) return;
  const state = shallowReactive<ReencounterState>({occurrences: [], current: null, saved: null, loading: false, error: '', paused: false});
  const messages = browser.runtime.onMessage;
  let active = true;
  let listGeneration = 0;
  let readGeneration = 0;
  let ui: Awaited<ReturnType<typeof createVueShadowUi>> | undefined;
  let uiPending: Promise<void> | undefined;
  let uiFailures = 0;
  let scanner: ReencounterScanner;
  const current = () => active && !signal.aborted && !ctx.isInvalid;
  function close(): void { readGeneration += 1; state.current = null; state.saved = null; state.loading = false; state.error = ''; }
  function ensureUi(): void {
    if (ui && !ui.shadowHost.isConnected) {ui.remove(); ui = undefined; uiFailures += 1;}
    if (ui || uiPending || !current() || uiFailures >= 2) return;
    uiPending = createVueShadowUi(ctx, {
      name: 'fluent-read-vocabulary-reencounter', hostId: 'fluent-read-vocabulary-reencounter', component: ReencounterPanel,
      props: {state, close, open, pause, disable, retry: () => state.current && open(state.current)},
    }).then(mounted => {
      if (!current()) mounted.remove(); else ui = mounted;
    }).catch(() => {uiFailures += 1; /* 可选浮层失效时保留页面，不无限重新挂载。 */ }).finally(() => { uiPending = undefined; });
  }
  async function request<T>(action: 'reencounterList' | 'reencounterGet', entryId?: string): Promise<T> {
    const response = await browser.runtime.sendMessage({type: VOCABULARY_BOOK_MESSAGE, action, entryId}) as VocabularyBookResponse<T>;
    if (!response?.success) throw new Error(response?.error?.message || '收藏暂时无法读取');
    return response.data;
  }
  async function open(occurrence: ReencounterOccurrence): Promise<void> {
    if (!current() || state.paused) return;
    close();
    const generation = readGeneration;
    state.current = occurrence; state.loading = true; ensureUi();
    try {
      const saved = await request<ReencounterEntry>('reencounterGet', occurrence.entry.id);
      if (current() && generation === readGeneration) state.saved = saved;
    } catch (error) {
      if (current() && generation === readGeneration) state.error = error instanceof Error ? error.message : '收藏暂时无法读取';
    } finally { if (current() && generation === readGeneration) state.loading = false; }
  }
  async function load(): Promise<void> {
    const generation = ++listGeneration;
    try {
      const entries = await request<ReencounterEntry[]>('reencounterList');
      if (current() && generation === listGeneration && !state.paused) scanner.setEntries(entries);
    } catch {
      if (current() && generation === listGeneration) scanner.setEntries([]);
    }
  }
  function pause(): void { state.paused = true; listGeneration += 1; close(); scanner.dispose(); }
  async function disable(): Promise<void> {
    try { await requestConfigPatch({vocabularyReencounterEnabled: false}, browser.runtime.sendMessage.bind(browser.runtime)); }
    catch (error) { if (current()) state.error = error instanceof Error ? error.message : '设置保存失败'; }
  }
  const changed = (message: unknown): undefined => {
    if (current() && (message as {type?: string})?.type === VOCABULARY_BOOK_CHANGED_MESSAGE && !state.paused) { close(); void load(); }
    return undefined;
  };
  scanner = installReencounterScanner(document, {
    changed(occurrences) {
      if (!current()) return;
      state.occurrences = occurrences;
      const selected = state.current;
      if (selected && !occurrences.some(item => item.entry.id === selected.entry.id && item.sentence === selected.sentence
        && item.ranges[0].startContainer === selected.ranges[0].startContainer && item.ranges[0].startOffset === selected.ranges[0].startOffset)) close();
      if (occurrences.length) ensureUi();
    },
    open: occurrence => { void open(occurrence); },
  });
  const instance = {dispose() {
    if (!active) return;
    active = false; listGeneration += 1; close(); scanner.dispose(); ui?.remove(); ui = undefined;
    try { messages.removeListener(changed); } catch { /* 扩展重载后仍须释放页面资源。 */ }
    signal.removeEventListener('abort', instance.dispose);
    if (owner === instance) owner = undefined;
  }};
  owner = instance;
  try {
    messages.addListener(changed);
    signal.addEventListener('abort', instance.dispose, {once: true});
  } catch (error) {
    instance.dispose();
    throw error;
  }
  if (!current()) {instance.dispose(); return;}
  void load();
}
