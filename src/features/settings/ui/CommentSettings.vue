<!--
 * @file src/features/settings/ui/CommentSettings.vue
 * 文件职责：让用户启用划词评论助手，并配置服务、模型、评论条数与风格提示词。
 * 主要内容：启用卡片、沿用 Harness 服务白名单的服务与模型选择、条数上限、可折叠提示词编辑器（占位符插入与恢复默认）。
 * 模块边界：只编辑传入 Config 的 comment 字段；不调用模型、不组装最终系统提示词，安全壳由 core/comment 固定。
-->
<template>
  <SettingsGroup title="启用与服务" description="选中网页文字后点“评论”，生成可直接粘贴的社交评论。使用已配置的大模型服务和密钥。">
    <FeatureEnableCard v-model="config.comment.enabled" title="启用评论助手" description="在划词卡片的页签条中显示“评论”；评论结果不写入学习记录。" />
  </SettingsGroup>

  <SettingsGroup title="评论设置">
    <div class="comment-provider-row">
      <div class="comment-provider-field">
        <label>评论服务</label>
        <el-select v-model="config.comment.service" class="comment-select" clearable filterable aria-label="评论服务" placeholder="跟随当前默认服务" @change="config.comment.model = ''">
          <el-option v-for="item in serviceOptions" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
        <small class="comment-provider-help">仅支持大模型；{{ effectiveServiceUsable ? '' : '当前默认服务不可用，请在这里选择一个 AI 服务。' }}</small>
      </div>
      <div class="comment-provider-field">
        <label>模型</label>
        <el-select v-model="config.comment.model" class="comment-select" clearable filterable allow-create default-first-option aria-label="评论模型" placeholder="跟随服务模型">
          <el-option v-for="model in modelOptions" :key="model" :label="model" :value="model" />
        </el-select>
        <small class="comment-provider-help">默认沿用服务的模型，也可以选择或输入模型名称。</small>
      </div>
    </div>
    <SettingsItem label="评论条数" description="每次生成的候选数量；模型必须按该数量提交，超出会被裁剪。">
      <el-input-number v-model="config.comment.count" :min="1" :max="5" controls-position="right" aria-label="评论条数" />
    </SettingsItem>
  </SettingsGroup>

  <SettingsGroup title="提示词" description="自定义风格指令；安全规则、选区包装与输出契约固定内置，用户内容不会覆盖它们。">
    <details class="comment-prompts">
      <summary>编辑风格指令</summary>
      <div class="comment-prompt-body">
        <div class="comment-prompt-toolbar">
          <small>选中文本与图片会自动提供，无需写入提示词。留空使用默认风格。</small>
          <button type="button" @click="restore">恢复默认</button>
        </div>
        <textarea ref="editor" v-model="config.comment.prompt" data-i18n-ignore :maxlength="COMMENT_PROMPT_MAX_LENGTH"
          :placeholder="DEFAULT_COMMENT_PROMPT" aria-label="评论风格提示词" spellcheck="false" />
        <div class="comment-prompt-variables">
          <span>点击插入占位符</span>
          <button v-for="variable in COMMENT_PROMPT_VARIABLES" :key="variable.token" type="button" @mousedown.prevent @click="insertVariable(variable.token)">
            <code data-i18n-ignore>{{ variable.token }}</code><span>{{ variable.label }}</span>
          </button>
        </div>
        <small class="comment-prompt-count" data-i18n-ignore>{{ config.comment.prompt.length }} / {{ COMMENT_PROMPT_MAX_LENGTH }}</small>
      </div>
    </details>
  </SettingsGroup>
</template>

<script setup lang="ts">
import {computed, nextTick, ref, toRef} from 'vue';
import {options, models} from '@/src/core/config/catalog';
import {getCustomOpenAIProviderLabel, getCustomOpenAIProviderModels, isCustomOpenAIProviderId} from '@/src/core/config/customOpenAI';
import {isCommentServiceUsable} from '@/src/core/config/comment';
import {isHarnessService} from '@/src/core/config/harness';
import {COMMENT_PROMPT_MAX_LENGTH, COMMENT_PROMPT_VARIABLES, DEFAULT_COMMENT_PROMPT} from '@/src/core/comment/prompts';
import type {Config} from '@/src/core/config/model';
import SettingsGroup from './components/SettingsGroup.vue';
import SettingsItem from './components/SettingsItem.vue';
import FeatureEnableCard from '@/src/ui/components/FeatureEnableCard.vue';

const props = defineProps<{config: Config}>();
const config = toRef(props, 'config');
const editor = ref<HTMLTextAreaElement | null>(null);
const serviceOptions = computed(() => [
  ...options.services.filter((item) => !item.disabled && isHarnessService(item.value)),
  ...config.value.customOpenAIProviders.filter((provider) => !options.services.some((item) => item.value === provider.id)).map((provider) => ({value: provider.id, label: getCustomOpenAIProviderLabel(config.value.customOpenAIProviders, provider.id)})),
]);
const modelOptions = computed(() => {
  const service = config.value.comment.service || config.value.service;
  return (isCustomOpenAIProviderId(service) ? getCustomOpenAIProviderModels(config.value.customOpenAIProviders, service) : models.get(service) || []).filter((model) => model !== '自定义模型');
});
const effectiveServiceUsable = computed(() => isCommentServiceUsable(config.value.comment.service || config.value.service, config.value.customOpenAIProviders));

function restore(): void { config.value.comment.prompt = DEFAULT_COMMENT_PROMPT; }
async function insertVariable(token: string) {
  const field = editor.value;
  const current = config.value.comment.prompt;
  if (!field || current.length + token.length > COMMENT_PROMPT_MAX_LENGTH) return;
  const start = field.selectionStart;
  const end = field.selectionEnd;
  config.value.comment.prompt = current.slice(0, start) + token + current.slice(end);
  await nextTick();
  field.focus();
  field.setSelectionRange(start + token.length, start + token.length);
}
</script>

<style scoped>
.comment-provider-row { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:24px; padding:16px; border-bottom:1px solid var(--line); }
.comment-provider-field { display:flex; flex-direction:column; gap:8px; min-width:0; }
.comment-provider-field > label { color:var(--ink); font-size:12.5px; font-weight:700; line-height:1.45; }
.comment-provider-help { color:var(--muted); font-size:10.5px; line-height:1.55; }
.comment-provider-row .comment-select { width:100%; max-width:none; }
@media (max-width:600px) { .comment-provider-row { grid-template-columns:1fr; gap:16px; padding-inline:12px; } }
.comment-prompts { padding:16px; color:var(--ink); }
.comment-prompts summary { cursor:pointer; font-size:13px; font-weight:700; }
.comment-prompts summary:focus-visible { outline:2px solid var(--brand); outline-offset:4px; }
.comment-prompt-body { display:grid; gap:12px; margin-top:16px; }
.comment-prompt-toolbar { display:flex; justify-content:space-between; align-items:center; gap:12px; }
.comment-prompt-toolbar small { color:var(--muted); font-size:11px; line-height:1.6; }
.comment-prompts button { border:1px solid var(--line); border-radius:8px; padding:6px 10px; color:var(--ink); background:var(--surface); cursor:pointer; font:inherit; font-size:11px; }
.comment-prompt-toolbar button { flex-shrink:0; color:var(--brand); }
.comment-prompts textarea { display:block; width:100%; min-height:150px; max-height:440px; resize:vertical; border:1px solid var(--line); border-radius:10px; padding:14px; background:var(--surface-soft); color:var(--ink); font:12px/1.8 ui-monospace,monospace; }
.comment-prompts textarea:focus { outline:2px solid color-mix(in srgb,var(--brand) 45%,transparent); outline-offset:1px; }
.comment-prompt-variables { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.comment-prompt-variables > span { color:var(--muted); font-size:11px; }
.comment-prompt-variables button { display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
.comment-prompt-variables code { color:var(--brand); }
.comment-prompt-count { justify-self:end; color:var(--muted); font-size:10px; }
:global(:root.dark .comment-select .el-select__wrapper) { border-color:var(--line); background:var(--surface-soft); transition-property:border-color,box-shadow; }
:global(:root.dark .comment-select .el-select__wrapper:hover),
:global(:root.dark .comment-select .el-select__wrapper.is-focused) { background:var(--surface); }
:global(:root.dark .comment-select .el-select__selected-item),
:global(:root.dark .comment-select .el-select__input) { color:var(--ink); }
:global(:root.dark .comment-select .el-select__placeholder.is-transparent),
:global(:root.dark .comment-select .el-select__caret) { color:var(--muted); }
</style>
