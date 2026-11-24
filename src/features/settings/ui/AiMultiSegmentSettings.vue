<!--
 * @file src/features/settings/ui/AiMultiSegmentSettings.vue
 * 文件职责：在全文翻译设置中紧凑呈现 AI 多段开关和每批文本片段、原文字符两项预算。
 * 主要内容：开启后在一行显示两项数值，关闭保留偏好；整数确认后交给父组件原子保存，本地回写保留输入实例与焦点，外部同步及非法输入才重建控件；恢复默认只重置预算；分区隐藏、缓存停用、配置同步和卸载使旧控件回调失效。
 * 模块边界：只编辑传入的配置并发出预算更新，不读写存储、不判断供应商能力、不收集段落或执行请求。
 -->
<template>
  <div class="ai-multi-segment-settings" data-testid="ai-multi-segment-settings">
    <SettingsItem :label="t('settings.fullPage.multiSegmentTitle')" :description="t('settings.fullPage.multiSegmentDescription')" :help="t('settings.fullPage.multiSegmentHelp')">
      <el-switch :model-value="config.enableAIMultiSegment" :disabled="!context.active.value"
        class="settings-toggle" :aria-label="t('settings.fullPage.multiSegmentTitle')" :onUpdate:modelValue="actions.enabled" />
    </SettingsItem>
    <SettingsItem v-if="config.enableAIMultiSegment" :label="t('settings.fullPage.multiSegmentLimits')" data-testid="ai-multi-segment-limits">
      <template #copy>
        <div class="ai-multi-segment-heading">
          <strong>{{ t('settings.fullPage.multiSegmentLimits') }}</strong>
          <button type="button" class="ai-multi-segment-reset" data-testid="ai-multi-segment-reset"
            :aria-label="t('settings.fullPage.multiSegmentResetAria')" :disabled="!context.active.value || defaultsApplied" :onClick="actions.reset">
            {{ t('settings.fullPage.multiSegmentReset') }}
          </button>
        </div>
        <small>{{ t('settings.fullPage.multiSegmentLimitsHelp') }}</small>
      </template>
      <div class="ai-multi-segment-fields">
        <label>
          <span>{{ t('settings.fullPage.multiSegmentFragments') }}</span>
          <SettingsNumberInput :key="`segments-${externalRevision}-${segmentsRevision}-${context.active.value}`" :model-value="config.aiMultiSegmentMaxSegments"
            :disabled="!context.active.value" :min="MIN_AI_MULTI_SEGMENT_MAX_SEGMENTS" :max="MAX_AI_MULTI_SEGMENT_MAX_SEGMENTS" :step="1"
            :precision="0" :aria-label="t('settings.fullPage.multiSegmentFragmentsAria')" :onChange="actions.segments" />
        </label>
        <label>
          <span>{{ t('settings.fullPage.multiSegmentCharacters') }}</span>
          <SettingsNumberInput :key="`characters-${externalRevision}-${charactersRevision}-${context.active.value}`" :model-value="config.aiMultiSegmentMaxCharacters"
            :disabled="!context.active.value" :min="MIN_AI_MULTI_SEGMENT_MAX_CHARACTERS" :max="MAX_AI_MULTI_SEGMENT_MAX_CHARACTERS" :step="100"
            :precision="0" :aria-label="t('settings.fullPage.multiSegmentCharactersAria')" :onChange="actions.characters" />
        </label>
      </div>
    </SettingsItem>
  </div>
</template>

<script setup lang="ts">
import {computed, ref, watch} from 'vue';
import type {Config} from '@/src/core/config/model';
import {
  DEFAULT_AI_MULTI_SEGMENT_MAX_SEGMENTS, MIN_AI_MULTI_SEGMENT_MAX_SEGMENTS, MAX_AI_MULTI_SEGMENT_MAX_SEGMENTS,
  DEFAULT_AI_MULTI_SEGMENT_MAX_CHARACTERS, MIN_AI_MULTI_SEGMENT_MAX_CHARACTERS, MAX_AI_MULTI_SEGMENT_MAX_CHARACTERS,
  type AiMultiSegmentLimits,
} from '@/src/core/config/aiMultiSegment';
import {useUiI18n} from '@/src/ui/i18n';
import {useSettingsActionContext} from '../model/useSettingsActionContext';
import SettingsItem from './components/SettingsItem.vue';
import SettingsNumberInput from './components/SettingsNumberInput.vue';

const props = withDefaults(defineProps<{config: Config; active?: boolean}>(), {active: true});
const emit = defineEmits<{'update:limits': [limits: AiMultiSegmentLimits]}>();
const {t} = useUiI18n();
const externalRevision = ref(0);
const segmentsRevision = ref(0);
const charactersRevision = ref(0);
let expectedLocalLimits: AiMultiSegmentLimits | undefined;
const context = useSettingsActionContext(() => props.active, () => [props.config, props.config.enableAIMultiSegment,
  props.config.aiMultiSegmentMaxSegments, props.config.aiMultiSegmentMaxCharacters, segmentsRevision.value, charactersRevision.value]);
watch(() => [props.config, props.config.aiMultiSegmentMaxSegments, props.config.aiMultiSegmentMaxCharacters], () => {
  const localCommit = expectedLocalLimits
    && expectedLocalLimits.aiMultiSegmentMaxSegments === props.config.aiMultiSegmentMaxSegments
    && expectedLocalLimits.aiMultiSegmentMaxCharacters === props.config.aiMultiSegmentMaxCharacters;
  expectedLocalLimits = undefined;
  if (!localCommit) externalRevision.value += 1;
}, {flush: 'sync'});
const defaultsApplied = computed(() => props.config.aiMultiSegmentMaxSegments === DEFAULT_AI_MULTI_SEGMENT_MAX_SEGMENTS
  && props.config.aiMultiSegmentMaxCharacters === DEFAULT_AI_MULTI_SEGMENT_MAX_CHARACTERS);
function validBudget(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
function publishLimits(limits: AiMultiSegmentLimits): void {
  expectedLocalLimits = limits;
  emit('update:limits', limits);
}
const actions = computed(() => {
  const current = context.capture();
  return {
    enabled: (value: unknown) => {if (current() && typeof value === 'boolean') props.config.enableAIMultiSegment = value;},
    segments: (value: unknown) => {
      if (!current()) return;
      if (!validBudget(value, MIN_AI_MULTI_SEGMENT_MAX_SEGMENTS, MAX_AI_MULTI_SEGMENT_MAX_SEGMENTS)) {segmentsRevision.value += 1;return;}
      if (value !== props.config.aiMultiSegmentMaxSegments) {
        publishLimits({aiMultiSegmentMaxSegments: value, aiMultiSegmentMaxCharacters: props.config.aiMultiSegmentMaxCharacters});
      }
    },
    characters: (value: unknown) => {
      if (!current()) return;
      if (!validBudget(value, MIN_AI_MULTI_SEGMENT_MAX_CHARACTERS, MAX_AI_MULTI_SEGMENT_MAX_CHARACTERS)) {charactersRevision.value += 1;return;}
      if (value !== props.config.aiMultiSegmentMaxCharacters) {
        publishLimits({aiMultiSegmentMaxSegments: props.config.aiMultiSegmentMaxSegments, aiMultiSegmentMaxCharacters: value});
      }
    },
    reset: () => {
      if (current() && !defaultsApplied.value) publishLimits({
        aiMultiSegmentMaxSegments: DEFAULT_AI_MULTI_SEGMENT_MAX_SEGMENTS,
        aiMultiSegmentMaxCharacters: DEFAULT_AI_MULTI_SEGMENT_MAX_CHARACTERS,
      });
    },
  };
});
</script>

<style scoped>
.ai-multi-segment-settings { min-width: 0; }
.ai-multi-segment-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; }
.ai-multi-segment-reset { padding: 3px 4px; border: 0; border-radius: 4px; background: transparent; color: var(--brand-strong); font: inherit; font-size: 12px; cursor: pointer; }
.ai-multi-segment-reset:disabled { color: var(--muted); cursor: default; }
.ai-multi-segment-reset:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.ai-multi-segment-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; width: 272px; max-width: 100%; }
.ai-multi-segment-fields label { display: grid; gap: 4px; min-width: 0; }
.ai-multi-segment-fields label > span { color: var(--muted); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.ai-multi-segment-fields :deep(.settings-number-input) { width: 100%; }
</style>
