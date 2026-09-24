<!--
 * @file src/features/comment-assistant/ui/CommentPanel.vue
 * 文件职责：在划词卡片内呈现「评论」页签面板，负责自动发起生成、结果流展示、逐条与整体复制、停止与重试。
 * 主要内容：原文预览与图片数量提示、重新生成动作行、评论条目（正文、译文、复制这条）、复制全部页脚、加载与错误状态；面板与读懂卡同构。
 * 模块边界：只经公共客户端触达后台，不组装提示词、不读取配置存储、不访问模型；选区与图片由划词卡片捕获后以纯数据传入。
-->
<template>
  <div class="fr-comment">
    <div class="fr-comment-source">
      <p class="fr-comment-source-text">{{ selection.text }}</p>
      <p v-if="selection.images.length" class="fr-comment-source-images">选区包含 {{ selection.images.length }} 张图片</p>
    </div>
    <div class="fr-comment-actions" role="group" aria-label="评论操作">
      <span class="fr-comment-action-pill">评论</span>
      <button type="button" class="fr-comment-regenerate" :disabled="!selection.text" @click="generate">{{ busy ? '取消并重新生成' : '重新生成' }}</button>
    </div>
    <div class="fr-comment-scroll" aria-live="polite">
      <p v-if="busy" class="fr-comment-status"><span class="fr-comment-pulse" aria-hidden="true" />正在生成评论…<button type="button" @click="stop">停止</button></p>
      <div v-else-if="error" class="fr-comment-error" role="alert">{{ error }}<button type="button" @click="generate">重试</button></div>
      <div v-else-if="comments.length" class="fr-comment-list">
        <div v-for="(comment, index) in comments" :key="index" class="fr-comment-turn">
          <p class="fr-comment-text">{{ comment.content }}</p>
          <p v-if="comment.translation" class="fr-comment-translation">{{ comment.translation }}</p>
          <div class="fr-comment-turn-tools">
            <button type="button" class="fr-comment-copy" :class="{'fr-copied': copied === itemKey(index)}" @click="copy(itemKey(index), comment.content)">
              {{ copied === itemKey(index) ? '已复制' : '复制这条' }}
            </button>
          </div>
        </div>
      </div>
      <p v-else class="fr-comment-hint">选中文字后自动开始；不满意时点“重新生成”。</p>
      <p v-if="notice" class="fr-comment-hint">{{ notice }}</p>
    </div>
    <p class="fr-comment-meta">提示词与条数在设置中修改 · 评论不保存到记录</p>
    <footer v-if="comments.length && !busy" class="fr-comment-footer">
      <button type="button" class="fr-comment-copy" :class="{'fr-copied': copied === 'all'}" @click="copy('all', comments.map(comment => comment.content).join('\n\n'))">
        {{ copied === 'all' ? '已复制' : `复制全部 ${comments.length} 条` }}
      </button>
    </footer>
  </div>
</template>

<script setup lang="ts">
import {onBeforeUnmount, ref, watch} from 'vue';
import {requestComments} from '../client';
import {createSelectionTtsClientRequestId} from '@/src/features/selection-translation/protocol';
import type {CommentItem} from '../types';

const props = defineProps<{
  selection: {text: string; images: string[]};
  active: boolean;
  modelRevision: number;
}>();
const emit = defineEmits<{(event: 'resize'): void}>();

const comments = ref<CommentItem[]>([]);
const busy = ref(false);
const error = ref('');
const copied = ref('');
const notice = ref('');
let handle: {cancel: () => void} | null = null;
let copyTimer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;
let lastKey = '';

const itemKey = (index: number) => `item-${index}`;
// 配置修订号只用于失效展示，不参与选区键：写配置不应自动再发起一次付费生成。
const selectionKey = () => `${props.selection.text}:${props.selection.images.length}`;

function stop(): void {
  // 作废当前请求，让后台迟到的结果不再落进面板。
  generation += 1;
  handle?.cancel();
  handle = null;
  if (busy.value) { busy.value = false; error.value = ''; }
}

function generate(): void {
  stop();
  const key = selectionKey();
  if (!props.selection.text.trim() || !props.active) return;
  const requestId = `comment-${createSelectionTtsClientRequestId()}`;
  const token = ++generation;
  lastKey = key;
  busy.value = true;
  error.value = '';
  notice.value = '';
  emit('resize');
  try {
    handle = requestComments({type: 'fluentReadComment', action: 'run', requestId, text: props.selection.text, images: props.selection.images}, {
    result: (response) => {
      if (token !== generation) return;
      handle = null;
      busy.value = false;
      if (response.success) comments.value = response.comments;
      else if (!response.cancelled) error.value = response.error;
      emit('resize');
    },
    error: (requestError) => {
      if (token !== generation) return;
      handle = null;
      busy.value = false;
      error.value = requestError.message;
      emit('resize');
    },
    });
  } catch {
    // 端口建立失败（例如扩展上下文失效）要立刻退出加载态，不能等用户手动停止。
    handle = null;
    busy.value = false;
    error.value = '评论请求未能发出，请重新选择文字后再试。';
    emit('resize');
  }
}

function copy(key: string, text: string): void {
  notice.value = '';
  // 非安全上下文不暴露 Clipboard API，成员访问本身就会同步抛错，因此先取再判。
  const clipboard = navigator.clipboard;
  const fail = () => { notice.value = '复制失败，请手动选择文本'; };
  if (!clipboard) { fail(); return; }
  try {
    void clipboard.writeText(text).then(() => {
      copied.value = key;
      if (copyTimer !== null) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => { copied.value = ''; copyTimer = null; }, 1500);
    }, fail);
  } catch {
    fail();
  }
}

watch(() => [props.active, props.selection] as const, ([active]) => {
  if (!active) { stop(); return; }
  if (selectionKey() !== lastKey) generate();
}, {flush: 'post', immediate: true});

// 与读懂卡一致：改配置只让现有结果失效，由用户显式再生成。
watch(() => props.modelRevision, () => {
  if (!props.active || (!comments.value.length && !busy.value && !error.value)) return;
  stop();
  comments.value = [];
  error.value = '';
  notice.value = '设置已更新，重新生成可使用新的设置。';
  emit('resize');
});

onBeforeUnmount(() => {
  stop();
  if (copyTimer !== null) clearTimeout(copyTimer);
});
</script>

<style scoped>
.fr-comment { --fr-comment-line: #eee8ec; --fr-comment-muted: #756a74; --fr-comment-soft: #faf7f9; display: flex; flex-direction: column; height: 100%; min-height: 0; box-sizing: border-box; padding: 10px 14px; overflow: hidden; color: #35333c; font: 13px/1.7 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
.fr-comment-source { flex-shrink: 0; margin-bottom: 8px; }
.fr-comment-source-text { margin: 0; color: #666570; font-size: 12px; line-height: 1.6; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; user-select: text; }
.fr-comment-source-images { margin: 4px 0 0; color: #9e5d71; font-size: 10.5px; font-weight: 700; }
.fr-comment-actions { flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.fr-comment-action-pill { padding: 3px 10px; border-radius: 7px; background: #f8e4ed; color: #923758; font-size: 12px; font-weight: 650; }
.fr-comment-regenerate { border: 1px solid rgba(126, 113, 121, .16); border-radius: 8px; background: #fff; color: #826573; font-size: 11.5px; font-weight: 650; padding: 4px 9px; cursor: pointer; }
.fr-comment-regenerate:hover:not(:disabled) { color: #d63f76; border-color: rgba(214, 63, 118, .35); }
.fr-comment-regenerate:disabled { opacity: .5; cursor: default; }
.fr-comment-scroll { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; padding: 2px 5px 4px 0; }
.fr-comment-turn { padding: 9px 1px; border-bottom: 1px solid var(--fr-comment-line); }
.fr-comment-turn:last-child { border-bottom: 0; }
.fr-comment-text { margin: 0; overflow-wrap: anywhere; user-select: text; }
.fr-comment-translation { margin: 3px 0 0; color: #9a7f89; font-size: 11.5px; line-height: 1.5; overflow-wrap: anywhere; user-select: text; }
.fr-comment-turn-tools { display: flex; justify-content: flex-end; margin-top: 5px; }
.fr-comment-copy { display: inline-flex; align-items: center; justify-content: center; min-height: 24px; padding: 0 8px; border: 1px solid rgba(126, 113, 121, .12); border-radius: 9px; background: rgba(255, 255, 255, .45); color: #8c8188; cursor: pointer; font: inherit; font-size: 11px; font-weight: 700; line-height: 1; white-space: nowrap; transition: background .14s ease, border-color .14s ease, color .14s ease, transform .14s ease; }
.fr-comment-copy:hover, .fr-comment-copy.fr-copied { border-color: rgba(214, 63, 118, .35); background: #fff; color: #d63f76; }
.fr-comment-status { display: flex; align-items: center; gap: 8px; margin: 9px 1px; color: var(--fr-comment-muted); font-size: 12px; }
.fr-comment-status button { border: 0; background: transparent; color: #a64b6e; cursor: pointer; font-size: 11.5px; }
.fr-comment-pulse { width: 8px; height: 8px; border-radius: 50%; background: #ef4b86; animation: fr-comment-pulse 1s ease-in-out infinite; }
@keyframes fr-comment-pulse { 50% { opacity: .25; transform: scale(.8); } }
.fr-comment-error { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 9px 1px; color: #c43b63; font-size: 12px; }
.fr-comment-error button { border: 1px solid currentColor; border-radius: 6px; padding: 2px 7px; background: transparent; color: inherit; cursor: pointer; font-size: 11px; }
.fr-comment-hint { margin: 9px 1px; color: var(--fr-comment-muted); font-size: 11.5px; }
.fr-comment-meta { flex-shrink: 0; margin: 4px 1px 6px; color: #aaa1a6; font-size: 10px; }
.fr-comment-footer { flex-shrink: 0; display: flex; justify-content: flex-end; padding-top: 8px; border-top: 1px solid var(--fr-comment-line); }
:global(.fr-dark-theme) .fr-comment { color: #e8e3e8; --fr-comment-line: #4a4149; --fr-comment-muted: #b7aeb5; --fr-comment-soft: #322c34; }
:global(.fr-dark-theme) .fr-comment-source-text { color: #b9b2ba; }
:global(.fr-dark-theme) .fr-comment-regenerate, :global(.fr-dark-theme) .fr-comment-copy { background: transparent; border-color: #544351; color: #d9c7d1; }
:global(.fr-dark-theme) .fr-comment-action-pill { background: #583344; color: #ffd6e6; }
</style>
