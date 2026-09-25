<!--
 * @file src/features/settings/ui/HarnessSettings.vue
 * 文件职责：让用户通过翻译卡片示例理解功能，并配置网页动作、模型、阅读偏好和评论动作。
 * 主要内容：先呈现启用开关和可展开的交互示例，再将翻译服务、打开方式与动作、回答偏好和原文范围合并为一个设置栏，随后提供学习记忆、提示词与评论设置（启用开关、评论服务、模型、条数和风格提示词编辑器），保留内核来源说明。
 * 模块边界：只编辑传入 Config 的 harness 与 comment 字段；评论仅在卡内展示、不写入学习记录；阅读记录由学习中心统一呈现，不发起模型请求，不拥有网页选区或提示词。
 -->
<template>
  <div class="harness-attribution">
    <span>翻译卡片基于 DeepSeek Harness 内核开发。</span>
    <a href="https://github.com/deepseek-ai/deepseek-harness" target="_blank" rel="noopener noreferrer">DeepSeek Harness 开源项目 ↗</a>
  </div>
  <SettingsGroup title="启用与服务" description="选中网页文字，直接点“读懂”或“拆句”。回答留在原文旁边，读完就继续浏览。">
    <FeatureEnableCard v-model="config.harness.enabled" title="启用翻译卡片" :description="t('reading.enableHelp')" />
  </SettingsGroup>

  <SettingsGroup>
    <details class="harness-demo">
      <summary>试试翻译卡片</summary>
      <div class="harness-demo-body">
        <p class="harness-demo-help">选中文字 → 点一个动作 → 读懂后继续浏览。</p>
        <div class="harness-preview-wrap"><div class="harness-preview">
          <div class="harness-preview-caption"><span>网页中的效果</span><small>演示内容，不调用模型</small></div>
          <p class="harness-sentence"><mark>Although the task was difficult, she finished it on time.</mark></p>
          <div class="harness-preview-actions" aria-label="示例学习动作">
            <button v-for="action in visibleActions" :key="action.id" type="button"
              :class="{active: previewAction === action.id, 'is-default': config.harness.defaultAction === action.id}"
              :aria-pressed="previewAction === action.id" :title="action.description" @click="previewAction = action.id">
              {{ action.label }}
            </button>
          </div>
          <div class="harness-preview-answer" aria-live="polite"><ReadingAnswer :text="previewResults[previewAction]" /></div>
          <p class="harness-preview-footer">还想问一句？在翻译卡片下方输入问题，继续围绕这段原文学习。</p>
        </div></div>
      </div>
    </details>
  </SettingsGroup>

  <SettingsGroup title="翻译设置">
    <div class="harness-provider-row">
      <div class="harness-provider-field">
        <label>翻译服务</label>
        <div class="harness-service-control">
          <el-select v-model="config.harness.service" class="harness-select" @change="config.harness.model = ''" clearable aria-label="翻译卡片服务" :aria-describedby="!effectiveServiceSupportsHarness ? 'harness-service-hint' : undefined" placeholder="跟随当前默认服务" filterable>
            <el-option v-for="item in serviceOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <small class="harness-provider-help">仅支持大模型，使用已配置的服务和密钥。</small>
          <small v-if="!effectiveServiceSupportsHarness" id="harness-service-hint" class="service-hint" role="status">当前默认服务不能回答学习问题，请在这里选择一个 AI 服务。</small>
        </div>
      </div>
      <div class="harness-provider-field">
        <label>模型</label>
        <el-select v-model="config.harness.model" class="harness-select" clearable filterable allow-create default-first-option aria-label="翻译卡片模型" placeholder="跟随服务模型">
          <el-option v-for="model in modelOptions" :key="model" :label="model" :value="model" />
        </el-select>
        <small class="harness-provider-help">默认沿用服务的模型，也可以选择或输入模型名称。</small>
      </div>
    </div>
    <SettingsItem label="打开方式" :description="t('reading.triggerHelp')">
      <SegmentedControl v-model="config.harness.trigger" :options="triggerOptions" :label="t('reading.triggerTitle')" />
    </SettingsItem>
    <SettingsItem v-if="config.harness.trigger === 'hover'" :label="t('reading.hoverDelay')" :description="t('reading.hoverHelp')">
      <el-input-number v-model="config.harness.hoverDelay" :min="200" :max="3000" :step="100" controls-position="right" :aria-label="t('reading.hoverDelay')" />
    </SettingsItem>
    <SettingsItem v-if="config.harness.trigger === 'shortcut'" :label="t('reading.shortcut')" :description="t('reading.shortcutHelp')">
      <button type="button" class="harness-hotkey-button" @click="showHotkeyDialog = true">{{ config.harness.customHotkey }}</button>
    </SettingsItem>
    <CustomHotkeyInput v-model="showHotkeyDialog" :current-value="config.harness.customHotkey" @confirm="config.harness.customHotkey = $event; showHotkeyDialog = false" />

    <SettingsItem label="选中后显示的动作" description="保留“读懂”，其他动作可按需隐藏；网页浮条和上方示例同步变化。" stacked>
      <div class="harness-actions">
        <label v-for="action in HARNESS_ACTIONS" :key="action.id" class="harness-action">
          <input type="checkbox" :checked="config.harness.actions.includes(action.id)" :disabled="action.id === 'meaning'" @change="toggleAction(action.id)" />
          <span><strong>{{ action.label }}</strong><small>{{ action.description }}</small></span>
        </label>
      </div>
    </SettingsItem>
    <SettingsItem label="优先动作" description="作为网页浮条的主要动作；隐藏它时会自动恢复为“读懂”。">
      <el-select v-model="config.harness.defaultAction" class="harness-select" aria-label="默认动作">
        <el-option v-for="action in visibleActions" :key="action.id" :label="action.label" :value="action.id" />
      </el-select>
    </SettingsItem>

    <SettingsItem label="回答长度" description="先给出重点，需要更多解释时可以继续追问。">
      <SegmentedControl v-model="config.harness.explanationDepth" :options="explanationDepthOptions" label="解释深度" />
    </SettingsItem>
    <SettingsItem label="学习程度" description="让解释和练习贴近你的水平。">
      <el-select v-model="config.harness.learningLevel" class="harness-select" aria-label="学习程度">
        <el-option label="初级" value="beginner" /><el-option label="中级" value="intermediate" /><el-option label="高级" value="advanced" />
      </el-select>
    </SettingsItem>

    <SettingsItem label="结合哪些原文" :description="config.harness.contextMode === 'paragraph' ? '需要理解代词或言外之意时，允许参考所选文字所在的段落；不会读取整页。' : '只发送你选中的文字，适合单句学习；不会补读周围段落。'">
      <SegmentedControl v-model="config.harness.contextMode" :options="contextModeOptions" label="上下文范围" />
    </SettingsItem>
    <SettingsItem v-if="config.harness.contextMode === 'paragraph'" label="段落最多发送" description="控制可参考的原文长度，通常保留默认值即可。">
      <div class="harness-context-limit"><el-input-number v-model="config.harness.maxContextChars" :min="500" :max="4000" :step="100" controls-position="right" aria-label="上下文上限" /><span>字符</span></div>
    </SettingsItem>
  </SettingsGroup>

  <SettingsGroup class="harness-memory-settings" :title="t('learning.memory')" :description="t('settings.memoryHelp')">
    <SettingsItem :label="t('settings.memoryEnabled')" :description="t('settings.memoryDescription')">
      <el-switch v-model="config.harness.memoryEnabled" :aria-label="t('settings.memoryEnabled')" />
    </SettingsItem>
  </SettingsGroup>

  <HarnessPromptSettings :preferences="config.harness" />

  <SettingsGroup title="评论" description="选中网页文字后点“评论”，生成可直接粘贴的社交评论。使用已配置的大模型服务和密钥。">
    <FeatureEnableCard v-model="config.comment.enabled" title="启用评论助手" description="在翻译卡片「读懂」动作行与卡片头部显示「评论」动作，选区指示条同步提供入口；评论结果不写入学习记录。" />
  </SettingsGroup>

  <SettingsGroup title="评论设置">
    <div class="harness-provider-row">
      <div class="harness-provider-field">
        <label>评论服务</label>
        <div class="harness-service-control">
          <el-select v-model="config.comment.service" class="harness-select" clearable filterable aria-label="评论服务" placeholder="跟随当前默认服务" @change="config.comment.model = ''">
            <el-option v-for="item in commentServiceOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <small class="harness-provider-help">仅支持大模型；{{ effectiveCommentServiceUsable ? '' : '当前默认服务不可用，请在这里选择一个 AI 服务。' }}</small>
        </div>
      </div>
      <div class="harness-provider-field">
        <label>模型</label>
        <el-select v-model="config.comment.model" class="harness-select" clearable filterable allow-create default-first-option aria-label="评论模型" placeholder="跟随服务模型">
          <el-option v-for="model in commentModelOptions" :key="model" :label="model" :value="model" />
        </el-select>
        <small class="harness-provider-help">默认沿用服务的模型，也可以选择或输入模型名称。</small>
      </div>
    </div>
    <SettingsItem label="评论条数" description="每次生成的候选数量；模型必须按该数量提交，超出会被裁剪。">
      <el-input-number v-model="config.comment.count" :min="1" :max="5" controls-position="right" aria-label="评论条数" />
    </SettingsItem>
  </SettingsGroup>

  <SettingsGroup title="评论风格提示词" description="自定义风格指令；安全规则、选区包装与输出契约固定内置，用户内容不会覆盖它们。">
    <details class="harness-comment-prompts">
      <summary>编辑风格指令</summary>
      <div class="harness-comment-prompt-body">
        <div class="harness-comment-prompt-toolbar">
          <small>选中文本与图片会自动提供，无需写入提示词。留空使用默认风格。</small>
          <button type="button" @click="restoreCommentPrompt">恢复默认</button>
        </div>
        <textarea ref="commentPromptEditor" v-model="config.comment.prompt" data-i18n-ignore :maxlength="COMMENT_PROMPT_MAX_LENGTH"
          :placeholder="DEFAULT_COMMENT_PROMPT" aria-label="评论风格提示词" spellcheck="false" />
        <div class="harness-comment-prompt-variables">
          <span>点击插入占位符</span>
          <button v-for="variable in COMMENT_PROMPT_VARIABLES" :key="variable.token" type="button" @mousedown.prevent @click="insertCommentVariable(variable.token)">
            <code data-i18n-ignore>{{ variable.token }}</code><span>{{ variable.label }}</span>
          </button>
        </div>
        <small class="harness-comment-prompt-count" data-i18n-ignore>{{ config.comment.prompt.length }} / {{ COMMENT_PROMPT_MAX_LENGTH }}</small>
      </div>
    </details>
  </SettingsGroup>
</template>

<script setup lang="ts">
import HarnessPromptSettings from './HarnessPromptSettings.vue';
import FeatureEnableCard from '@/src/ui/components/FeatureEnableCard.vue';
import {computed, defineAsyncComponent, nextTick, ref, toRef, watch} from 'vue'
import {models, options} from '@/src/core/config/catalog'
import {getCustomOpenAIProviderLabel, getCustomOpenAIProviderModels, isCustomOpenAIProviderId} from '@/src/core/config/customOpenAI'
import {HARNESS_ACTIONS, isHarnessService, type HarnessActionId} from '@/src/core/config/harness'
import {isCommentServiceUsable} from '@/src/core/config/comment'
import {COMMENT_PROMPT_MAX_LENGTH, COMMENT_PROMPT_VARIABLES, DEFAULT_COMMENT_PROMPT} from '@/src/core/comment/prompts'
import type {Config} from '@/src/core/config/model'
import SettingsGroup from './components/SettingsGroup.vue'
import SettingsItem from './components/SettingsItem.vue'
import SegmentedControl from './components/SegmentedControl.vue'
import {ReadingAnswer} from '@/src/features/reading-assistant/public'
import {useUiI18n} from '@/src/ui/i18n'

const CustomHotkeyInput = defineAsyncComponent(() => import('@/src/ui/components/CustomHotkeyInput.vue'));

const props = defineProps<{config: Config}>()
const config = toRef(props, 'config')
const {t} = useUiI18n()
const showHotkeyDialog = ref(false)
const triggerOptions = computed(() => [
  {value: 'click', label: t('reading.triggerClick')},
  {value: 'hover', label: t('reading.triggerHover')},
  {value: 'shortcut', label: t('reading.triggerShortcut')},
])
const serviceOptions = computed(() => [
  ...options.services.filter((item) => !item.disabled && isHarnessService(item.value)),
  ...config.value.customOpenAIProviders.filter((provider) => !options.services.some((item) => item.value === provider.id)).map((provider) => ({value: provider.id, label: getCustomOpenAIProviderLabel(config.value.customOpenAIProviders, provider.id)})),
])
const modelOptions = computed(() => {
  const service = config.value.harness.service || config.value.service
  return (isCustomOpenAIProviderId(service) ? getCustomOpenAIProviderModels(config.value.customOpenAIProviders, service) : models.get(service) || []).filter((model) => model !== '自定义模型')
})
const effectiveServiceSupportsHarness = computed(() => isHarnessService(config.value.harness.service || config.value.service, config.value.customOpenAIProviders))
// 评论服务候选沿用 Harness 白名单并补充未与目录重名的自定义 OpenAI 供应商，与已删除的评论助手设置页保持同一规则。
const commentServiceOptions = computed(() => [
  ...options.services.filter((item) => !item.disabled && isHarnessService(item.value)),
  ...config.value.customOpenAIProviders.filter((provider) => !options.services.some((item) => item.value === provider.id)).map((provider) => ({value: provider.id, label: getCustomOpenAIProviderLabel(config.value.customOpenAIProviders, provider.id)})),
])
// 空服务跟随当前默认服务；空模型跟随服务的已配置模型。
const commentModelOptions = computed(() => {
  const service = config.value.comment.service || config.value.service
  return (isCustomOpenAIProviderId(service) ? getCustomOpenAIProviderModels(config.value.customOpenAIProviders, service) : models.get(service) || []).filter((model) => model !== '自定义模型')
})
const effectiveCommentServiceUsable = computed(() => isCommentServiceUsable(config.value.comment.service || config.value.service, config.value.customOpenAIProviders))
const visibleActions = computed(() => HARNESS_ACTIONS.filter((action) => config.value.harness.actions.includes(action.id)))
const previewAction = ref<HarnessActionId>(config.value.harness.defaultAction)
const previewResults = computed<Record<HarnessActionId, string>>(() => ({
  meaning: t('reading.demo.meaning'),
  grammar: t('reading.demo.grammar'),
  usage: t('reading.demo.usage'),
  practice: t('reading.demo.practice'),
}))
watch(() => config.value.harness.defaultAction, (action) => { previewAction.value = action })
watch(visibleActions, (actions) => {
  if (!actions.some((action) => action.id === previewAction.value)) previewAction.value = config.value.harness.defaultAction
})
const contextModeOptions = [{value: 'paragraph', label: '可参考本段'}, {value: 'selection', label: '仅选中文字'}]
const explanationDepthOptions = [{value: 'concise', label: '简洁'}, {value: 'detailed', label: '详细'}]

function toggleAction(id: HarnessActionId) {
  if (id === 'meaning') return
  const actions = config.value.harness.actions.includes(id) ? config.value.harness.actions.filter((item) => item !== id) : [...config.value.harness.actions, id]
  config.value.harness.actions = actions.includes('meaning') ? actions : ['meaning', ...actions]
  if (!config.value.harness.actions.includes(config.value.harness.defaultAction)) config.value.harness.defaultAction = 'meaning'
}

const commentPromptEditor = ref<HTMLTextAreaElement | null>(null)
function restoreCommentPrompt(): void { config.value.comment.prompt = DEFAULT_COMMENT_PROMPT }
async function insertCommentVariable(token: string): Promise<void> {
  const field = commentPromptEditor.value
  const current = config.value.comment.prompt
  if (!field || current.length + token.length > COMMENT_PROMPT_MAX_LENGTH) return
  const start = field.selectionStart
  const end = field.selectionEnd
  config.value.comment.prompt = current.slice(0, start) + token + current.slice(end)
  await nextTick()
  field.focus()
  field.setSelectionRange(start + token.length, start + token.length)
}
</script>

<style scoped>
.harness-hotkey-button { border:1px solid var(--line); border-radius:8px; background:var(--surface); color:var(--ink); padding:8px 14px; cursor:pointer; font:inherit; }
.harness-attribution { display:flex; flex-wrap:wrap; align-items:center; gap:6px 12px; width:min(100%,1080px); margin:0 auto 10px; padding:4px 4px 12px; color:var(--muted); font-size:12px; line-height:1.7; }
.harness-attribution a { color:var(--brand); text-decoration:underline; text-underline-offset:3px; overflow-wrap:anywhere; }
.harness-attribution a:focus-visible { outline:2px solid var(--brand); outline-offset:4px; border-radius:3px; }
.harness-preview-wrap { display:flex; justify-content:center; }
.harness-preview { width:100%; max-width:640px; margin-inline:auto; padding:16px; border:1px solid var(--line); border-radius:12px; background:var(--surface-soft); color:var(--ink); }
.harness-preview-caption { display:flex; flex-wrap:wrap; justify-content:space-between; gap:5px 12px; margin-bottom:12px; color:var(--muted); font-size:11px; }
.harness-preview-caption small { font-size:10px; }
.harness-sentence { margin:0 0 12px; color:var(--ink); font-size:13px; line-height:1.8; overflow-wrap:anywhere; }
.harness-sentence mark { color:inherit; background:color-mix(in srgb, var(--brand) 12%, transparent); border-radius:3px; padding:2px 1px; box-decoration-break:clone; -webkit-box-decoration-break:clone; }
.harness-preview-actions { display:flex; flex-wrap:wrap; gap:6px; padding-bottom:13px; }
.harness-preview-actions button { border:1px solid var(--line); border-radius:7px; padding:6px 12px; background:var(--surface); color:var(--ink); cursor:pointer; font:inherit; font-size:12px; }
.harness-preview-actions button.is-default { border-color:color-mix(in srgb, var(--brand) 40%, var(--line)); color:var(--brand); }
.harness-preview-actions button.active { border-color:var(--brand); background:color-mix(in srgb, var(--brand) 9%, var(--surface)); color:var(--brand); }
.harness-preview-answer { min-height:150px; padding:14px 0; border-top:1px solid var(--line); background:transparent; }
.harness-preview-footer { margin:12px 0 0; color:var(--muted); font-size:10.5px; line-height:1.6; }
.harness-demo-body { padding:0 16px 16px; }
.harness-demo-help { margin:0 0 12px; color:var(--muted); font-size:11px; }
.harness-demo > summary { padding:16px 18px; color:var(--ink); font-size:14px; font-weight:700; cursor:pointer; }
.harness-demo > summary:focus-visible { outline:2px solid var(--brand); outline-offset:-4px; }
.harness-provider-row { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:24px; padding:16px; border-bottom:1px solid var(--line); }
.harness-provider-field { display:flex; flex-direction:column; gap:8px; min-width:0; }
.harness-provider-field > label { color:var(--ink); font-size:12.5px; font-weight:700; line-height:1.45; }
.harness-provider-help { color:var(--muted); font-size:10.5px; line-height:1.55; }
.harness-provider-row .harness-select { width:100%; max-width:none; }
@media (max-width:600px) { .harness-provider-row { grid-template-columns:1fr; gap:16px; padding-inline:12px; } }
.harness-service-control { display:flex; flex-direction:column; gap:8px; width:100%; min-width:0; }
.service-hint { display:block; margin-top:12px; }
.service-hint { color:var(--warning, #b26a00); font-size:10.5px; line-height:1.5; }
:global(:root.dark .harness-select .el-select__wrapper) { border-color:var(--line); background:var(--surface-soft); transition-property:border-color,box-shadow; }
:global(:root.dark .harness-select .el-select__wrapper:hover),
:global(:root.dark .harness-select .el-select__wrapper.is-focused) { background:var(--surface); }
:global(:root.dark .harness-select .el-select__selected-item),
:global(:root.dark .harness-select .el-select__input) { color:var(--ink); }
:global(:root.dark .harness-select .el-select__placeholder.is-transparent),
:global(:root.dark .harness-select .el-select__caret) { color:var(--muted); }
.harness-context-limit { display:flex; align-items:center; gap:9px; width:100%; color:var(--muted); font-size:11px; }
.harness-context-limit .el-input-number { flex:1; min-width:0; }
.harness-context-limit span { flex-shrink:0; }
.harness-actions { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
.harness-action { display:flex; gap:8px; align-items:flex-start; padding:10px; border:1px solid var(--line); border-radius:8px; cursor:pointer; }
.harness-action input { accent-color:var(--brand); margin:3px 0 0; }
.harness-action span { display:flex; flex-direction:column; gap:3px; color:var(--ink); font-size:12px; }
.harness-action small { color:var(--muted); font-size:10.5px; line-height:1.5; }
.harness-comment-prompts { padding:16px; color:var(--ink); }
.harness-comment-prompts summary { cursor:pointer; font-size:13px; font-weight:700; }
.harness-comment-prompts summary:focus-visible { outline:2px solid var(--brand); outline-offset:4px; }
.harness-comment-prompt-body { display:grid; gap:12px; margin-top:16px; }
.harness-comment-prompt-toolbar { display:flex; justify-content:space-between; align-items:center; gap:12px; }
.harness-comment-prompt-toolbar small { color:var(--muted); font-size:11px; line-height:1.6; }
.harness-comment-prompts button { border:1px solid var(--line); border-radius:8px; padding:6px 10px; color:var(--ink); background:var(--surface); cursor:pointer; font:inherit; font-size:11px; }
.harness-comment-prompt-toolbar button { flex-shrink:0; color:var(--brand); }
.harness-comment-prompts textarea { display:block; width:100%; min-height:150px; max-height:440px; resize:vertical; border:1px solid var(--line); border-radius:10px; padding:14px; background:var(--surface-soft); color:var(--ink); font:12px/1.8 ui-monospace,monospace; }
.harness-comment-prompts textarea:focus { outline:2px solid color-mix(in srgb,var(--brand) 45%,transparent); outline-offset:1px; }
.harness-comment-prompt-variables { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.harness-comment-prompt-variables > span { color:var(--muted); font-size:11px; }
.harness-comment-prompt-variables button { display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
.harness-comment-prompt-variables code { color:var(--brand); }
.harness-comment-prompt-count { justify-self:end; color:var(--muted); font-size:10px; }
@media (max-width:700px) { .harness-actions { grid-template-columns:1fr; } }
@media (max-width:480px) {
  .harness-preview { padding:12px; }
  .harness-preview-answer { padding:12px; }
  .harness-preview-caption { gap:4px; }
}
</style>
