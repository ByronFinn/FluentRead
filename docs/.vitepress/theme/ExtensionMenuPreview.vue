<!-- 使用隔离生产扩展的原始界面截图；标记位置来自同次采集的 DOM。 -->
<script setup lang="ts">
import { computed } from 'vue'
import { withBase } from 'vitepress'
import captures from './guide-ui.json'
const props = defineProps<{
  en?: boolean
  mode?: 'main' | 'welcome' | 'language' | 'hover' | 'selection'
  target?: 'hover' | 'selection' | 'translate' | 'language'
  number?: number
}>()
const t = (zh: string, en: string) => props.en ? en : zh
const capture = computed(() => {
  const name = props.mode === 'welcome' ? 'popup-language-initial'
    : props.mode === 'language' ? 'popup-language'
    : props.mode === 'hover' || props.mode === 'selection' ? `popup-${props.mode}` : 'popup'
  return captures[props.en ? 'en-US' : 'zh-CN'][name as keyof typeof captures['zh-CN']]
})
const point = computed(() => {
  const index = props.mode === 'language' ? 1
    : props.mode === 'welcome' || props.mode === 'hover' || props.mode === 'selection' ? 0
    : { language: 0, translate: 1, hover: 2, selection: 3 }[props.target ?? 'translate']
  return capture.value.points[index]
})
</script>
<template>
  <a class="em" :class="{ 'em-drawer': mode === 'hover' || mode === 'selection' }" :href="withBase(capture.src)" target="_blank" rel="noopener" :aria-label="t('查看扩展界面原图', 'Open the original extension screenshot')">
    <img :src="withBase(capture.src)" :width="capture.width" :height="capture.height" :alt="t('流畅阅读菜单的真实界面', 'Actual FluentRead menu')" loading="lazy" />
    <span v-if="point" class="em-focus" :style="{ left: point.x + '%', top: point.y + '%', width: point.width + '%', height: point.height + '%' }" aria-hidden="true"><b>{{ number ?? 1 }}</b></span>
  </a>
</template>
<style scoped>
.em{position:absolute;top:0;right:10px;z-index:3;display:block;width:238px;max-width:calc(100% - 20px);border:1px solid #e1e4ee;border-radius:0 0 10px 10px;background:white;box-shadow:0 10px 28px #26232c16;overflow:hidden}
.em img{display:block;width:100%;height:auto}
.em-drawer{top:auto;bottom:0;width:280px;border-radius:18px 18px 0 0}
.em-focus{position:absolute;display:block;transform:translate(-50%,-50%);border:2px solid #b92252;border-radius:8px;background:#ed3d7310;pointer-events:none}
.em-focus b{position:absolute;top:-9px;left:-9px;display:grid;place-items:center;min-width:19px;height:19px;padding:0 3px;border-radius:50%;background:#b92252;color:#fff;font:600 10px/1 sans-serif}
.em:focus-visible{outline:2px solid var(--vp-c-brand-1);outline-offset:3px}
@container(max-width:430px){.em{right:5px;width:210px}.em-drawer{width:260px}}
</style>
