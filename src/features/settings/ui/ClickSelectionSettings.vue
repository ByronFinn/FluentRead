<!--
 * @file src/features/settings/ui/ClickSelectionSettings.vue
 * 文件职责：在划词设置内提供默认关闭的两点选取入口与紧凑快捷键编辑。
 * 主要内容：说明快捷键启动后点击起终点、自动退出与 Esc 取消；录制复用既有对话框，所属配置、功能启停或设置分区变化立即失效，开启及确认时校验其他动作的快捷键占用；已开启但热键被占用时在原行说明，划词停用时仍可编辑或取消点选偏好以解除恢复冲突。
 * 模块边界：组件只修改传入配置，不持久化、不监听网页动作、不处理选区；配置与冲突归 core/config/clickSelection，实际点选由划词内容运行时负责。
 -->
<template>
  <SettingsItem label="两点选取" :description="description">
    <div class="fr-click-selection-controls">
      <el-button size="small" :type="hotkeyConflict ? 'danger' : 'default'" :title="hotkeyConflict ? description : '编辑两点选取快捷键'" :disabled="!context.active.value" aria-label="编辑两点选取快捷键" @click="openEditor">
        <kbd data-i18n-ignore>{{ hotkeyDisplayName }}</kbd>
      </el-button>
      <el-switch :model-value="props.config.selectionClickSelectEnabled" :disabled="!context.active.value" class="settings-toggle" aria-label="两点选取" @change="setEnabled" />
    </div>
  </SettingsItem>
  <CustomHotkeyInput v-if="showEditor" v-model="showEditor" :current-value="props.config.selectionClickSelectHotkey" :validate="validateHotkey" @confirm="editorHandlers.confirm" @cancel="editorHandlers.cancel" />
</template>

<script setup lang="ts">
import {computed, defineAsyncComponent, ref, watch} from 'vue';
import {ElMessage} from 'element-plus';
import type {Config} from '@/src/core/config/model';
import {parseHotkey} from '@/src/core/hotkey';
import {findClickSelectionHotkeyConflict, normalizeClickSelectionHotkey} from '@/src/core/config/clickSelection';
import {useSettingsActionContext} from '../model/useSettingsActionContext';
import SettingsItem from './components/SettingsItem.vue';

const CustomHotkeyInput = defineAsyncComponent(() => import('@/src/ui/components/CustomHotkeyInput.vue'));
const props = withDefaults(defineProps<{config: Config; active?: boolean}>(), {active: true});
const showEditor = ref(false);
const context = useSettingsActionContext(
  () => props.active,
  () => [props.config, props.config.selectionClickSelectEnabled, props.config.selectionClickSelectHotkey, props.config.selectionTranslatorMode],
);
const editorEpoch = ref(0);
const hotkeyDisplayName = computed(() => parseHotkey(normalizeClickSelectionHotkey(props.config.selectionClickSelectHotkey)).displayName);
const hotkeyConflict = computed(() => props.config.selectionClickSelectEnabled
  ? findClickSelectionHotkeyConflict(props.config, props.config.selectionClickSelectHotkey) : '');
const description = computed(() => hotkeyConflict.value
  ? `快捷键已用于${hotkeyConflict.value}，请点击快捷键更换后使用`
  : '开启后按快捷键，再依次点击文字起点和终点，无需按住鼠标；完成自动退出，Esc 取消');

function closeEditor(): void { editorEpoch.value += 1; showEditor.value = false; }
const openEditor = computed(() => {
  const owns = context.capture();
  return () => {
    if (!owns()) return;
    editorEpoch.value += 1;
    showEditor.value = true;
  };
});
watch(context.revision, closeEditor, {flush: 'sync'});
function validateHotkey(value: string): string {
  if (value) {
    const parsed = parseHotkey(value);
    if (!parsed.isValid || parsed.modifiers.length === 0 || parsed.modifiers.includes('meta')) return '请选择带 Ctrl、Alt 或 Shift 的组合键';
  }
  const owner = findClickSelectionHotkeyConflict(props.config, normalizeClickSelectionHotkey(value));
  return owner ? `此快捷键已用于${owner}，请更换组合键` : '';
}
const setEnabled = computed(() => {
  const owns = context.capture();
  return (value: string | number | boolean): void => {
    if (!owns() || typeof value !== 'boolean') return;
    if (value) {
      const conflict = validateHotkey(props.config.selectionClickSelectHotkey);
      if (conflict) { ElMessage.warning(conflict); return; }
    }
    props.config.selectionClickSelectEnabled = value;
  };
});
const editorHandlers = computed(() => {
  const owns = context.capture(), epoch = editorEpoch.value;
  const current = () => owns() && showEditor.value && epoch === editorEpoch.value;
  return {
    confirm(value: string): void {
      if (!current()) return;
      const conflict = validateHotkey(value);
      if (conflict) { ElMessage.warning(conflict); return; }
      closeEditor();
      props.config.selectionClickSelectHotkey = normalizeClickSelectionHotkey(value);
    },
    cancel(): void { if (current()) closeEditor(); },
  };
});
</script>

<style scoped>
.fr-click-selection-controls { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
.fr-click-selection-controls kbd { font-family: inherit; font-size: 12px; }
</style>
