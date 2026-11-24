<!--
 * @file src/features/settings/ui/ParagraphHandlingSettings.vue
 * 文件职责：在高级选项中集中呈现段落级翻译设置，包括参与翻译的最少字符数、免滚动预翻译字符数、长段落换行与译文位置。
 * 主要内容：把四项配置绑定到共享 config 对象，数值输入按公共范围函数归一化；双语顺序使用明确的上下选项，单语时保留并禁用偏好，提供切回双语的就近入口；说明文案全部走稳定 message key。
 * 模块边界：本组件只做绑定与取值约束，不自行持久化、不决定候选发现算法，也不渲染网页译文；阈值语义由 core 配置模块统一提供。
 -->
<template>
  <SettingsGroup :title="t('settings.paragraph.title')" :description="t('settings.paragraph.description')">
    <SettingsItem :label="t('settings.paragraph.minLength')" :description="t('settings.paragraph.minLengthDescription')">
      <SettingsNumberInput
        v-model="props.config.minTranslationTextLength"
        :aria-label="t('settings.paragraph.minLength')"
        :min="MIN_TRANSLATION_TEXT_LENGTH_MIN"
        :max="MIN_TRANSLATION_TEXT_LENGTH_MAX"
        :step="1"
        @change="changeMinLength"
      />
    </SettingsItem>
    <SettingsItem :label="t('settings.paragraph.eagerCharacters')" :description="t('settings.paragraph.eagerCharactersDescription')">
      <SettingsNumberInput
        v-model="props.config.eagerTranslationCharacters"
        :aria-label="t('settings.paragraph.eagerCharacters')"
        :min="EAGER_TRANSLATION_CHARACTERS_MIN"
        :max="EAGER_TRANSLATION_CHARACTERS_MAX"
        :step="100"
        @change="changeEagerCharacters"
      />
    </SettingsItem>
    <SettingsItem :label="t('settings.paragraph.lineBreak')" :description="t('settings.paragraph.lineBreakDescription')">
      <el-switch v-model="props.config.longParagraphLineBreakEnabled" class="settings-toggle"
        :aria-label="t('settings.paragraph.lineBreak')" />
    </SettingsItem>
    <SettingsItem :label="t('settings.paragraph.order')" :description="t('settings.paragraph.orderDescription')">
      <div class="paragraph-order-control">
        <SegmentedControl :model-value="props.config.translationBeforeOriginal ? 'translation-first' : 'original-first'"
          :options="orderOptions" :label="t('settings.paragraph.order')" :disabled="props.config.display !== 1"
          data-page-translation-order @update:model-value="props.config.translationBeforeOriginal = $event === 'translation-first'" />
        <p v-if="props.config.display !== 1" class="paragraph-order-note" role="status">
          <button type="button" @click="props.config.display = 1">{{ t('settings.translationStyle.switchToBilingual') }}</button>
        </p>
      </div>
    </SettingsItem>
  </SettingsGroup>
</template>

<script lang="ts" setup>
import type {Config} from '@/src/core/config/model';
import {computed} from 'vue';
import {
  EAGER_TRANSLATION_CHARACTERS_MAX,
  EAGER_TRANSLATION_CHARACTERS_MIN,
  MIN_TRANSLATION_TEXT_LENGTH_MAX,
  MIN_TRANSLATION_TEXT_LENGTH_MIN,
  normalizeEagerTranslationCharacters,
  normalizeMinTranslationTextLength,
} from '@/src/core/config/pageTranslation';
import {useUiI18n} from '@/src/ui/i18n';
import SettingsGroup from './components/SettingsGroup.vue';
import SettingsItem from './components/SettingsItem.vue';
import SettingsNumberInput from './components/SettingsNumberInput.vue';
import SegmentedControl from './components/SegmentedControl.vue';

const props = defineProps<{config: Config}>();
const {t} = useUiI18n();
const orderOptions = computed(() => [
  {value: 'original-first', label: t('settings.paragraph.originalFirst')},
  {value: 'translation-first', label: t('settings.paragraph.translationFirstOption')},
]);

const changeMinLength = (value: number | undefined): void => {
  props.config.minTranslationTextLength = normalizeMinTranslationTextLength(value);
};

const changeEagerCharacters = (value: number | undefined): void => {
  props.config.eagerTranslationCharacters = normalizeEagerTranslationCharacters(value);
};
</script>
<style scoped>
.paragraph-order-control { display:grid; gap:8px; min-width:0; }
.paragraph-order-note { display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin:0; color:var(--muted); font-size:12px; line-height:1.5; }
.paragraph-order-note button { border:0; border-radius:6px; padding:4px 6px; background:var(--brand-soft); color:var(--brand-strong); cursor:pointer; font:inherit; }
.paragraph-order-note button:focus-visible { outline:2px solid var(--brand); outline-offset:2px; }
</style>
