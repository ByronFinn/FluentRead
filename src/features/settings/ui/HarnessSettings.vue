<!--
 * @file src/features/settings/ui/HarnessSettings.vue
 * 文件职责：作为划词翻译的学习子设置，用示例说明 AI 讲解，明确原文范围、学习笔记和自定义指令的用途，并配置评论动作与模型调用执行位置。
 * 主要内容：左侧用真实回答组件预览学习动作，右侧配置服务、模型、动作、回答偏好与模型调用执行位置（离屏常驻运行时（推荐）/ 后台直连（回滚），绑定 config.harnessCallHost）；B站仅预览基础读懂和用法、禁用暂不可用动作，默认动作临时回退而保留用户偏好，明确免费免密钥并展示固定模型，其他服务恢复完整动作与模型选择；多行偏好使用完整单列控件保持左侧对齐，窄屏下默认动作也纵向排列；独立展示上下文和记忆分区，提供学习中心入口；随后提供评论设置（启用开关、评论服务、模型、条数和风格提示词编辑器）；风格指令编辑器声明提示词契约（只影响语气、视角与风格，语言与条数由代码决定），并内置以未识别选区语言场景实时拼装的系统提示词预览；关闭讲解保留偏好，示例不发送请求。
 * 模块边界：只编辑传入 Config 的 harness、comment 与 harnessCallHost 字段；评论仅在卡内展示、不写入学习记录；阅读记录由学习中心管理，不发起模型请求、不拥有网页选区。
 -->
<template>
  <SettingsGroup data-settings-anchor="learning" data-settings-anchor-label="AI 深入讲解" title="AI 深入讲解" description="切换左侧示例了解学习动作；在网页卡片中触发学习动作后，才向所选 AI 服务发送请求">
    <FeatureEnableCard v-model="config.harness.enabled" title="启用 AI 讲解" description="选择服务讲解原文，B站提供免费基础读懂和用法；关闭后仍可翻译和查词，讲解偏好会保留" />
    <SettingsPreviewLayout label="AI 讲解效果预览">
      <template #preview>
        <p class="harness-preview-source" data-i18n-ignore>{{ sentenceSource }}</p>
        <p class="harness-preview-translation" data-i18n-ignore>{{ sentenceTranslation }}</p>
        <div class="harness-preview-tabs" role="group" aria-label="预览学习动作">
          <button v-for="action in visibleActions" :key="action.id" type="button" :aria-pressed="previewAction === action.id" @click="previewAction = action.id">{{ action.label }}</button>
        </div>
        <ReadingAnswer :text="previewAnswer" :source-text="sentenceSource" />
      </template>
      <div class="harness-provider-row">
        <div class="harness-provider-field">
          <label>AI 讲解服务</label>
          <el-select v-model="config.harness.service" class="harness-select" @change="config.harness.model = ''" clearable aria-label="学习讲解服务" :aria-describedby="!effectiveServiceSupportsHarness ? 'harness-service-hint' : undefined" placeholder="跟随当前默认服务" filterable>
            <el-option v-for="item in serviceOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <small v-if="!effectiveServiceSupportsHarness" id="harness-service-hint" class="service-hint" role="status">当前默认服务不能回答学习问题，请在这里选择一个 AI 服务</small>
          <small v-if="isBilibiliReading" class="harness-free-hint" role="status">免费基础读懂/用法，无需 API Key；完整语法、练习和追问可切换 AI 服务。触发学习动作时发送选中文字和已授权的段落</small>
        </div>
        <div class="harness-provider-field">
          <label>模型</label>
          <div v-if="isBilibiliReading" class="harness-fixed-model" aria-label="学习讲解模型" data-i18n-ignore>{{ effectiveModel.model }}</div>
          <el-select v-else v-model="config.harness.model" class="harness-select" clearable filterable allow-create default-first-option aria-label="学习讲解模型" placeholder="跟随服务模型">
            <el-option v-for="model in modelOptions" :key="model" :label="model" :value="model" />
          </el-select>
        </div>
      </div>
      <div class="harness-preferences">
        <SettingsItem label="卡片中的学习动作" description="“读懂”始终显示，其他动作按需显示；左侧示例同步更新" stacked>
          <div class="harness-actions">
            <label v-for="action in HARNESS_ACTIONS" :key="action.id" class="harness-action" :class="{selected: config.harness.actions.includes(action.id), unavailable: !isReadingActionSupported(effectiveModel.service, action.id)}">
              <input type="checkbox" :checked="config.harness.actions.includes(action.id)" :disabled="action.id === 'meaning' || !isReadingActionSupported(effectiveModel.service, action.id)" @change="toggleAction(action.id)" />
              <span><strong>{{ action.label }}<em v-if="action.id === 'meaning'">固定显示</em></strong><small>{{ isReadingActionSupported(effectiveModel.service, action.id) ? action.description : 'B站暂不支持；切换 AI 服务后恢复此偏好' }}</small></span>
            </label>
          </div>
        </SettingsItem>
        <SettingsItem class="harness-default-action" label="默认学习动作">
          <el-select v-model="effectiveDefaultAction" class="harness-select" aria-label="默认动作"><el-option v-for="action in visibleActions" :key="action.id" :label="action.label" :value="action.id" /></el-select>
          <small v-if="effectiveDefaultAction !== config.harness.defaultAction" class="harness-default-hint" role="status">当前使用“读懂”；切换 AI 服务后恢复原默认动作</small>
        </SettingsItem>
        <SettingsItem label="回答长度" :description="isBilibiliReading ? '先给出重点，可选择更详细的基础讲解' : '先给出重点，需要更多解释时可以继续追问'" stacked>
          <SegmentedControl v-model="config.harness.explanationDepth" :options="explanationDepthOptions" label="解释深度" />
        </SettingsItem>
        <SettingsItem label="学习程度" description="让学习讲解贴近你的水平" stacked>
          <SegmentedControl v-model="config.harness.learningLevel" :options="learningLevelOptions" label="学习程度" />
        </SettingsItem>
      </div>
    </SettingsPreviewLayout>
  </SettingsGroup>
  <SettingsGroup title="参考原文" :description="t('settings.sourceContextDescription')" data-settings-anchor="context" data-settings-anchor-label="参考原文">
    <SettingsItem label="结合哪些原文" :description="config.harness.contextMode === 'paragraph' ? '需要理解指代时参考所选文字所在的段落，不读取整页' : '只发送选中的文字，不补充周围段落'">
      <SegmentedControl v-model="config.harness.contextMode" :options="contextModeOptions" label="上下文范围" />
    </SettingsItem>
    <SettingsItem v-if="config.harness.contextMode === 'paragraph'" label="段落长度上限" description="限制补充段落的长度；不会修改你的选区">
      <SettingsNumberInput v-model="config.harness.maxContextChars" unit="字符" :min="500" :max="4000" :step="100" aria-label="上下文上限" />
    </SettingsItem>

    <SettingsItem label="模型调用执行位置" description="离屏执行防止后台休眠中断长生成；后台直连为回滚路径。">
      <SegmentedControl v-model="config.harnessCallHost" :options="harnessCallHostOptions" label="模型调用执行位置" />
    </SettingsItem>
  </SettingsGroup>
  <SettingsGroup class="harness-memory-settings" :title="t('learning.memory')" :description="t('learning.memoryDescription')" data-settings-anchor="memory" :data-settings-anchor-label="t('learning.memory')">
    <SettingsItem :label="t('settings.memoryEnabled')" :description="t('settings.memoryDescription')">
      <el-switch v-model="config.harness.memoryEnabled" :aria-label="t('settings.memoryEnabled')" />
    </SettingsItem>
    <div class="harness-memory-footer"><p>只使用你主动保存的内容，可在学习中心查看、编辑或删除</p><button type="button" @click="emit('navigate', 'settings-vocabulary')">打开学习中心 →</button></div>
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
      <SettingsNumberInput v-model="config.comment.count" unit="条" :min="1" :max="5" :step="1" aria-label="评论条数" />
    </SettingsItem>
  </SettingsGroup>

  <SettingsGroup title="评论风格提示词" description="自定义风格指令；安全规则、选区包装与输出契约固定内置，用户内容不会覆盖它们。">
    <details class="harness-comment-prompts">
      <summary>编辑风格指令</summary>
      <div class="harness-comment-prompt-body">
        <div class="harness-comment-prompt-toolbar">
          <small>选中文本与图片会自动提供，无需写入提示词。提示词只影响语气、视角与风格；评论语言由目标语言设置与选区语言判定决定，条数由上方计数器决定，均不受提示词影响。留空使用默认风格。</small>
          <button type="button" @click="restoreCommentPrompt">恢复默认</button>
          <button type="button" :aria-expanded="showCommentPromptPreview" aria-controls="harness-comment-prompt-preview" @click="showCommentPromptPreview = !showCommentPromptPreview">{{ showCommentPromptPreview ? '收起预览' : '预览系统提示词' }}</button>
        </div>
        <textarea ref="commentPromptEditor" v-model="config.comment.prompt" data-i18n-ignore :maxlength="COMMENT_PROMPT_MAX_LENGTH"
          :placeholder="DEFAULT_COMMENT_PROMPT" aria-label="评论风格提示词" spellcheck="false" />
        <div class="harness-comment-prompt-variables">
          <span>点击插入占位符</span>
          <button v-for="variable in COMMENT_PROMPT_VARIABLES" :key="variable.token" type="button" @mousedown.prevent @click="insertCommentVariable(variable.token)">
            <code data-i18n-ignore>{{ variable.token }}</code><span>{{ variable.label }}</span>
          </button>
        </div>
        <div v-if="showCommentPromptPreview" id="harness-comment-prompt-preview" class="harness-comment-prompt-preview">
          <pre class="harness-comment-prompt-preview-text" data-i18n-ignore>{{ commentPromptPreview }}</pre>
          <small class="harness-comment-prompt-preview-note">以未识别选区语言的场景预览；实际语言段会按选区语言自动判定注入。</small>
        </div>
        <small class="harness-comment-prompt-count" data-i18n-ignore>{{ config.comment.prompt.length }} / {{ COMMENT_PROMPT_MAX_LENGTH }}</small>
      </div>
    </details>
  </SettingsGroup>
</template>
<script setup lang="ts">
import HarnessPromptSettings from './HarnessPromptSettings.vue';
import SettingsPreviewLayout from './components/SettingsPreviewLayout.vue';
import {ReadingAnswer} from '@/src/features/reading-assistant/ui/answer/public';
import {sentenceSource, sentenceTranslation, sentenceAnalysis, learningPreviewAnswers} from '@/src/core/config/selectionPreview';
import FeatureEnableCard from '@/src/ui/components/FeatureEnableCard.vue';
import {computed, nextTick, ref, toRef, watch} from 'vue'
import {models, options, services} from '@/src/core/config/catalog'
import {getCustomOpenAIProviderLabel, getCustomOpenAIProviderModels, isCustomOpenAIProviderId} from '@/src/core/config/customOpenAI'
import {HARNESS_ACTIONS, isReadingActionSupported, isReadingService, resolveHarnessModel, type HarnessActionId} from '@/src/core/config/harness'
import {isCommentServiceUsable} from '@/src/core/config/comment'
import {buildCommentSystemPrompt, COMMENT_PROMPT_MAX_LENGTH, COMMENT_PROMPT_VARIABLES, DEFAULT_COMMENT_PROMPT} from '@/src/core/comment/prompts'
import type {Config} from '@/src/core/config/model'
import SettingsGroup from './components/SettingsGroup.vue'
import SettingsItem from './components/SettingsItem.vue'
import SettingsNumberInput from './components/SettingsNumberInput.vue'
import SegmentedControl from './components/SegmentedControl.vue'
import {useUiI18n} from '@/src/ui/i18n'

const props = defineProps<{config: Config}>()
const config = toRef(props, 'config')
const emit = defineEmits<{navigate: [section: string]}>()
const previewAction = ref<HarnessActionId>(props.config.harness.defaultAction)
const previewAnswer = computed(() => previewAction.value === 'grammar' ? sentenceAnalysis : learningPreviewAnswers[previewAction.value][config.value.harness.explanationDepth])
const {t} = useUiI18n()
const serviceOptions = computed(() => [
  ...options.services.filter((item) => !item.disabled && isReadingService(item.value)).map(item => item.value === services.bilibili ? {...item, label: 'B站翻译 · 免费'} : item),
  ...config.value.customOpenAIProviders.filter((provider) => !options.services.some((item) => item.value === provider.id)).map((provider) => ({value: provider.id, label: getCustomOpenAIProviderLabel(config.value.customOpenAIProviders, provider.id)})),
])
const modelOptions = computed(() => {
  const service = config.value.harness.service || config.value.service
  return (isCustomOpenAIProviderId(service) ? getCustomOpenAIProviderModels(config.value.customOpenAIProviders, service) : models.get(service) || []).filter((model) => model !== '自定义模型')
})
// 评论服务候选按评论运行时自己的可用判定（isCommentServiceUsable，即 Harness AI 白名单，含自定义 OpenAI 兼容供应商）过滤，
// 不再包含阅读层专用的 B站（运行时 isHarnessService 检查本就会拒绝它），与 effectiveCommentServiceUsable 保持同一规则。
const commentServiceOptions = computed(() => [
  ...options.services.filter((item) => !item.disabled && isCommentServiceUsable(item.value, config.value.customOpenAIProviders)),
  ...config.value.customOpenAIProviders.filter((provider) => !options.services.some((item) => item.value === provider.id)).map((provider) => ({value: provider.id, label: getCustomOpenAIProviderLabel(config.value.customOpenAIProviders, provider.id)})),
])
// 空服务跟随当前默认服务；空模型跟随服务的已配置模型。
const commentModelOptions = computed(() => {
  const service = config.value.comment.service || config.value.service
  return (isCustomOpenAIProviderId(service) ? getCustomOpenAIProviderModels(config.value.customOpenAIProviders, service) : models.get(service) || []).filter((model) => model !== '自定义模型')
})
const effectiveCommentServiceUsable = computed(() => isCommentServiceUsable(config.value.comment.service || config.value.service, config.value.customOpenAIProviders))
const effectiveServiceSupportsHarness = computed(() => isReadingService(config.value.harness.service || config.value.service, config.value.customOpenAIProviders))
const effectiveModel = computed(() => resolveHarnessModel(config.value))
const isBilibiliReading = computed(() => effectiveModel.value.service === services.bilibili)
const visibleActions = computed(() => HARNESS_ACTIONS.filter((action) => config.value.harness.actions.includes(action.id) && isReadingActionSupported(effectiveModel.value.service, action.id)))
// 服务能力只影响当前显示；不能用临时回退覆盖用户在完整AI服务中保存的默认动作。
const effectiveDefaultAction = computed({
  get: () => visibleActions.value.find(action => action.id === config.value.harness.defaultAction)?.id
    || visibleActions.value.find(action => action.id === 'meaning')?.id || visibleActions.value[0]?.id || 'meaning',
  set: (action: HarnessActionId) => { if (visibleActions.value.some(item => item.id === action)) config.value.harness.defaultAction = action },
})
watch(effectiveDefaultAction, (action) => { previewAction.value = action }, {immediate: true})
watch(visibleActions, (actions) => { if (!actions.some(action => action.id === previewAction.value)) previewAction.value = effectiveDefaultAction.value })
const contextModeOptions = [{value: 'paragraph', label: '可参考本段'}, {value: 'selection', label: '仅选中文字'}]
const explanationDepthOptions = [{value: 'concise', label: '简洁'}, {value: 'detailed', label: '详细'}]
const learningLevelOptions = [{value: 'beginner', label: '初级'}, {value: 'intermediate', label: '中级'}, {value: 'advanced', label: '高级'}]
// 模型调用执行位置：默认经离屏常驻运行时执行（防止 MV3 后台休眠中断长生成），后台直连为回滚开关。
const harnessCallHostOptions = [
  {value: 'offscreen', label: '离屏常驻运行时（推荐）'},
  {value: 'background', label: '后台直连（回滚）'},
]

function toggleAction(id: HarnessActionId) {
  if (id === 'meaning' || !isReadingActionSupported(effectiveModel.value.service, id)) return
  const actions = config.value.harness.actions.includes(id) ? config.value.harness.actions.filter((item) => item !== id) : [...config.value.harness.actions, id]
  config.value.harness.actions = actions.includes('meaning') ? actions : ['meaning', ...actions]
  if (!config.value.harness.actions.includes(config.value.harness.defaultAction)) config.value.harness.defaultAction = 'meaning'
}
const commentPromptEditor = ref<HTMLTextAreaElement | null>(null)
// 预览固定按「未识别选区语言」的三态场景拼装；实际运行时语言段由代码按可信识别结果注入。
const showCommentPromptPreview = ref(false)
const commentPromptPreview = computed(() => buildCommentSystemPrompt(
  config.value.comment.prompt, config.value.comment.count, config.value.to,
  {sameLanguage: false, selectionLanguage: undefined},
))
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
.harness-preview-source { margin:0; font-size:15px; line-height:1.7; overflow-wrap:anywhere; }
.harness-preview-translation { margin:8px 0 16px; color:var(--muted); font-size:12px; line-height:1.7; }
.harness-preview-tabs { display:flex; flex-wrap:wrap; gap:6px; margin:0 0 16px; padding-top:16px; border-top:1px solid var(--line); }
.harness-preview-tabs button { padding:6px 10px; border:1px solid var(--line); border-radius:7px; color:var(--muted); background:var(--surface); font:inherit; font-size:11px; cursor:pointer; }
.harness-preview-tabs button[aria-pressed=true] { color:var(--brand); border-color:var(--brand); }
.harness-provider-row { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; padding-bottom:18px; }
.harness-provider-field { display:flex; flex-direction:column; gap:8px; min-width:0; }
.harness-provider-field > label { color:var(--ink); font-size:13px; font-weight:600; }
.service-hint { font-size:12px; line-height:1.6; color:var(--warning,#b26a00); }
.harness-free-hint, .harness-default-hint { font-size:12px; line-height:1.6; color:var(--muted); }
.harness-fixed-model { min-height:32px; display:flex; align-items:center; padding:0 11px; border:1px solid var(--line); border-radius:6px; background:var(--surface-soft); color:var(--ink); font-size:12px; overflow-wrap:anywhere; }
.harness-select { width:100%; }
.harness-preferences :deep(.settings-item) { gap:10px; padding:16px 0; border-top:1px solid var(--line); }
.harness-preferences :deep(.settings-item-control) { width:100%; }
.harness-preferences :deep(.settings-item.harness-default-action) { grid-template-columns:minmax(0,1fr) minmax(120px,60%); align-items:center; }
.harness-actions { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; width:100%; }
.harness-action { display:flex; gap:8px; align-items:flex-start; padding:12px; border:1px solid var(--line); border-radius:9px; cursor:pointer; }
.harness-action.selected { border-color:color-mix(in srgb,var(--brand) 45%,var(--line)); background:color-mix(in srgb,var(--brand) 4%,var(--surface)); }
.harness-action.unavailable { cursor:default; opacity:.65; }
.harness-action input { accent-color:var(--brand); margin:3px 0 0; }
.harness-action span { display:flex; flex-direction:column; gap:5px; color:var(--ink); font-size:12px; }
.harness-action strong { display:flex; flex-wrap:wrap; gap:4px 8px; }
.harness-action em { color:var(--muted); font-size:10px; font-style:normal; font-weight:400; }
.harness-action small { color:var(--muted); font-size:11px; line-height:1.6; }
.harness-memory-footer { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; padding:16px 20px; border-top:1px solid var(--line); }
.harness-memory-footer p { flex:1; min-width:180px; margin:0; color:var(--muted); font-size:12px; line-height:1.6; }
.harness-memory-footer button { padding:8px 12px; border:1px solid var(--line); border-radius:8px; color:var(--brand); background:var(--surface); font:inherit; font-size:12px; cursor:pointer; }
button:focus-visible { outline:2px solid var(--brand); outline-offset:3px; }
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
.harness-comment-prompt-preview { display:grid; gap:8px; }
.harness-comment-prompt-preview-text { margin:0; max-height:280px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; border:1px solid var(--line); border-radius:10px; padding:14px; background:var(--surface-soft); color:var(--ink); font:12px/1.8 ui-monospace,monospace; }
.harness-comment-prompt-preview-note { color:var(--muted); font-size:10.5px; line-height:1.6; }
@media(max-width:480px) { .harness-provider-row, .harness-actions { grid-template-columns:minmax(0,1fr); } .harness-preferences :deep(.settings-item.harness-default-action) { grid-template-columns:minmax(0,1fr); align-items:stretch; } .harness-memory-footer { padding:14px 12px; } }
</style>
