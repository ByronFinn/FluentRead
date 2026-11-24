<!--
 * @file src/features/settings/ui/services/CompositeTranslationSettings.vue
 * 文件职责：编辑已保存的组合服务，并提供有当前服务归属的删除确认。
 * 主要内容：草稿显式保存名称、成员顺序、三种策略和逐路超时，保存后由共享配置观察器持久化；校验统一交给草稿验证，为无效等待时间提供字段旁反馈；底部以分隔线承接统一表单，左侧删除与右侧保存及反馈分开排列；配置或服务切换、停用和删除确认重开时淘汰旧事件。
 * 模块边界：只更新不含凭据的组合配置；删除事件由 SettingsSections 清理默认引用，连接测试由 ServiceConfiguration 经已有后台消息执行。
 -->
<template>
  <form v-if="provider" class="composite-settings" novalidate data-composite-service-settings :onSubmit="withModifiers(actions.save, ['prevent'])">
    <CompositeTranslationFields :draft="draft" :members="members" :errors="errors" :active="active" :context="props.config" :onUpdate="actions.update" />
    <footer>
      <button type="button" class="delete-button" data-testid="composite-service-delete" :disabled="!active" :onClick="actions.remove"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h14M8 3h4m-7 2 1 12h8l1-12M8 8v6m4-6v6" /></svg>{{ t('settings.services.composite.delete') }}</button>
      <div class="composite-save-actions">
        <span v-if="saved" class="saved-status" role="status">{{ t('settings.services.library.saved') }}</span>
        <button type="submit" class="save-button" data-testid="composite-service-edit-save" :disabled="!active">{{ t('common.save') }}</button>
      </div>
    </footer>
  </form>
  <el-dialog :key="revision" :model-value="deleteOpen && active" :onUpdate:modelValue="deleteActions.open" :title="t('settings.services.composite.deleteTitle')" width="min(460px, calc(100vw - 32px))" append-to-body destroy-on-close>
    <p>{{ t('settings.services.composite.deleteConfirm', {name: provider?.name || ''}) }}</p>
    <template #footer><el-button :onClick="deleteActions.cancel">{{ t('common.cancel') }}</el-button><el-button type="danger" :onClick="deleteActions.confirm">{{ t('common.confirm') }}</el-button></template>
  </el-dialog>
</template>
<script setup lang="ts">
import {computed, reactive, ref, watch, withModifiers} from 'vue'
import type {Config} from '@/src/core/config/model'
import {getCompositeTranslationProvider} from '@/src/core/config/compositeTranslation'
import {useUiI18n, localizeServiceOptions} from '@/src/ui/i18n'
import {createCompositeTranslationDraft, getCompositeMemberOptions, validateCompositeTranslationDraft, type CompositeTranslationDraft, type CompositeTranslationDraftErrors} from '@/src/ui/view-model/compositeServiceEditor'
import {useSettingsActionContext} from '../../model/useSettingsActionContext'
import CompositeTranslationFields from './CompositeTranslationFields.vue'

const props = withDefaults(defineProps<{config: Config; service: string; active?: boolean}>(), {active: true})
const emit = defineEmits<{remove: []}>()
const {t, translateLegacy} = useUiI18n()
const provider = computed(() => getCompositeTranslationProvider(props.config.compositeTranslationProviders, props.service))
const members = computed(() => localizeServiceOptions(getCompositeMemberOptions(props.config), props.config.customOpenAIProviders, translateLegacy))
const draft = reactive(createCompositeTranslationDraft(provider.value))
const errors = ref<CompositeTranslationDraftErrors>({})
const saved = ref(false)
const deleteOpen = ref(false)
const {active, capture, revision} = useSettingsActionContext(() => props.active, () => [props.config, props.service, provider.value, deleteOpen.value])
const actions = computed(() => {
  const current = capture(), owner = props.config, source = provider.value
  return {
    update: (patch: Partial<CompositeTranslationDraft>) => {if (current()) {Object.assign(draft, patch);errors.value = {};saved.value = false}},
    save: () => {
      if (!current() || !source) return
      const result = validateCompositeTranslationDraft(draft, members.value)
      errors.value = result.errors
      if (!result.valid) return
      owner.compositeTranslationProviders = owner.compositeTranslationProviders.map(item => item.id === source.id ? {id: source.id, ...result.draft} : item)
      saved.value = true
    },
    remove: () => {if (current() && source) deleteOpen.value = true},
  }
})
const deleteActions = computed(() => {
  const current = capture(), source = provider.value
  return {
    open: (open: boolean) => {if (current() && !open) deleteOpen.value = false},
    cancel: () => {if (current()) deleteOpen.value = false},
    confirm: () => {if (current() && deleteOpen.value && source && provider.value === source) {deleteOpen.value = false;emit('remove')}},
  }
})
watch(() => [props.config, props.service, provider.value], () => {Object.assign(draft, createCompositeTranslationDraft(provider.value));errors.value = {};saved.value = false;deleteOpen.value = false}, {flush: 'sync'})
watch(() => active.value, () => {deleteOpen.value = false}, {flush: 'sync'})
</script>
<style scoped>
.composite-settings { container: composite-editor / inline-size; display: grid; gap: 0; width: 100%; }
footer { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 16px; padding-top: 16px; border-top: 1px solid var(--line); }
.composite-save-actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 10px; min-width: 0; margin-inline-start: auto; }
button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: var(--fr-service-control-height, 40px); padding: 8px 16px; border: 1px solid var(--line); border-radius: 8px; color: var(--ink); background: var(--surface); font: inherit; font-size: 12px; font-weight: 550; line-height: 1.5; cursor: pointer; }
.delete-button { border-color: transparent; color: var(--el-color-danger); }
.delete-button svg { flex: none; width: 16px; height: 16px; }
.save-button { border-color: var(--brand, #ef4776); color: white; background: var(--brand, #ef4776); }
.delete-button:hover:not(:disabled) { background: var(--el-color-danger-light-9); }
.save-button:hover:not(:disabled) { background: var(--brand-strong); border-color: var(--brand-strong); }
button:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.saved-status { color: var(--muted); font-size: 12px; }
button:disabled { opacity: .5; cursor: default; }
</style>
