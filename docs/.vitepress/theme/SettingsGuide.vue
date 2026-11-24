<!-- 操作位置由 capture-docs-ui.cjs 从真实生产扩展的 DOM 提取；图片为同一版本的无损截图。 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { withBase } from 'vitepress'
import DemoSteps from './DemoSteps.vue'
import captures from './guide-ui.json'
import { useDemoPlayback } from './useDemoPlayback'
const props = defineProps<{ kind: string; en?: boolean }>()
const t = (zh: string, en: string) => (props.en ? en : zh)
const root = ref<HTMLElement | null>(null)
const { step, playing, running, reduced, select, replay } = useDemoPlayback(root, 3, true, 4500)
const plans = computed<
  Record<string, { image: string; title: string; steps: string[]; descriptions: string[] }>
>(() => ({
  settings: {
    image: 'settings-general',
    title: t('设置翻译语言和默认服务', 'Choose your language and default provider'),
    steps: [
      t('打开通用设置', 'Open General'),
      t('设置目标语言', 'Choose a language'),
      t('选择默认服务', 'Choose a provider'),
    ],
    descriptions: [
      t('点击通用设置', 'Open General settings'),
      t('在翻译语言中选择目标语言', 'Choose your target language'),
      t('选择默认网页翻译服务', 'Choose the default webpage provider'),
    ],
  },
  provider: {
    image: 'settings-provider',
    title: t('配置翻译服务：API Key 示例', 'Configure a provider: API key example'),
    steps: [
      t('选择服务', 'Choose a provider'),
      t('填写连接信息', 'Configure connection'),
      t('设为默认服务', 'Set the default'),
    ],
    descriptions: [
      t('选择要配置的服务', 'Choose a provider to configure'),
      t('此图以需要 API Key 的服务为例；填写所选服务要求的连接信息', 'This example uses an API key provider. Enter the connection details required by your chosen provider.'),
      t('返回通用设置选择默认服务', 'Return to General to choose your default'),
    ],
  },
  appearance: {
    image: 'settings-interface',
    title: t('调整译文样式', 'Change translation appearance'),
    steps: [
      t('打开界面风格', 'Open Appearance'),
      t('选择样式', 'Choose a style'),
      t('查看预览', 'Preview'),
    ],
    descriptions: [
      t('点击界面风格', 'Open Appearance'),
      t('选择一种译文样式', 'Choose a translation style'),
      t('在左侧查看原文和译文预览', 'Preview the original and translation'),
    ],
  },
  compare: {
    image: 'settings-translation-center',
    title: t('在翻译中心对比译文', 'Compare providers in Translation Center'),
    steps: [
      t('输入原文', 'Enter text'),
      t('管理服务', 'Manage providers'),
      t('开始翻译', 'Translate'),
    ],
    descriptions: [
      t('输入或粘贴需要翻译的文字', 'Enter or paste the text to translate'),
      t('选择需要参与对比的服务', 'Choose providers for this comparison'),
      t('点击开始翻译后查看右侧结果', 'Start translating to see results on the right'),
    ],
  },
  backup: {
    image: 'settings-data',
    title: t('导出备份和恢复数据', 'Export a backup and restore data'),
    steps: [
      t('打开备份与恢复', 'Open Backup & restore'),
      t('导出备份', 'Export backup'),
      t('从备份恢复', 'Restore from backup'),
    ],
    descriptions: [
      t('点击备份与恢复', 'Open Backup & restore'),
      t('导出后妥善保存备份文件', 'Export and store your backup securely'),
      t('选择备份文件并核对恢复内容', 'Choose a backup and review what will be restored'),
    ],
  },
  glossary: {
    image: 'settings-glossary',
    title: t('设置术语的固定译法', 'Set consistent translations for terms'),
    steps: [
      t('打开术语库', 'Open Glossary'),
      t('添加词条', 'Add a term'),
      t('开启术语库', 'Enable the glossary'),
    ],
    descriptions: [
      t('点击术语库', 'Open Glossary'),
      t('添加原词和希望使用的译法', 'Add a term and its preferred translation'),
      t('开启术语库总开关，让已启用的词库参与翻译', 'Turn on the glossary so enabled libraries can apply to translations'),
    ],
  },
  rules: {
    image: 'settings-sites',
    title: t('设置网站偏好', 'Set preferences for a website'),
    steps: [
      t('打开网站规则', 'Open Site rules'),
      t('添加网站', 'Add a website'),
      t('查看生效预览', 'Preview applied rules'),
    ],
    descriptions: [
      t('点击网站规则', 'Open Site rules'),
      t('填写域名并选择初始偏好', 'Enter a domain and choose its preferences'),
      t('打开生效预览，输入完整网址检查规则', 'Open the applied-rules preview and enter a full URL'),
    ],
  },
  stats: {
    image: 'settings-translation-stats',
    title: t('查看翻译统计', 'Review translation statistics'),
    steps: [
      t('打开翻译统计', 'Open Statistics'),
      t('选择时间范围', 'Choose a period'),
      t('查看请求与耗时', 'Review activity'),
    ],
    descriptions: [
      t('点击翻译统计', 'Open Translation statistics'),
      t('切换今日、7 天或 30 天', 'Choose Today, 7 days or 30 days'),
      t('查看请求量、文本量和耗时', 'Review requests, text volume and timing'),
    ],
  },
  webdav: {
    image: 'settings-webdav-connection',
    title: t('用坚果云连接 WebDAV', 'Connect Nutstore with WebDAV'),
    steps: [t('填写目录地址', 'Enter the directory URL'), t('填写账号', 'Enter your account'), t('测试并保存连接', 'Test and save')],
    descriptions: [t('目录地址填 https://dav.jianguoyun.com/dav/', 'Use https://dav.jianguoyun.com/dav/ for Nutstore'), t('用户名填坚果云账号邮箱', 'Use your Nutstore account email'), t('填入应用密码，测试并保存本机连接；之后还需手动同步并确认上传', 'Enter the app password and test and save this device’s connection. Uploading a backup requires a separate sync and confirmation.')],
  },
  learning: {
    image: 'settings-vocabulary',
    title: t('在学习中心查看收藏', 'Review saved items in Learning Center'),
    steps: [
      t('打开学习中心', 'Open Learning Center'),
      t('选择收藏类型', 'Filter saved items'),
      t('查看收藏内容', 'Review your collection'),
    ],
    descriptions: [
      t('点击学习中心', 'Open Learning Center'),
      t('按单词或句子筛选收藏', 'Filter your saved words and sentences'),
      t('在这里查看收藏和复习内容', 'Review saved items here'),
    ],
  },
}))
const plan = computed(() => plans.value[props.kind])
const capture = computed(
  () => captures[props.en ? 'en-US' : 'zh-CN'][plan.value.image as keyof (typeof captures)['zh-CN']]
)
const point = computed(() => capture.value.points[step.value])
const fullPage = ref(false)
const frameWidth = ref(600)
let resize: ResizeObserver | undefined
onMounted(() => {
  if (!root.value) return
  frameWidth.value = root.value.clientWidth
  resize = new ResizeObserver(([entry]) => { frameWidth.value = entry.contentRect.width })
  resize.observe(root.value)
})
onBeforeUnmount(() => resize?.disconnect())
const crop = computed(() => {
  const { width, height } = capture.value
  const cropWidth = Math.min(width, frameWidth.value < 430 ? 640 : 1080)
  const cropHeight = Math.min(height, cropWidth * 0.46)
  const x = Math.max(0, Math.min(width - cropWidth, point.value.x * width / 100 - cropWidth / 2))
  const y = Math.max(0, Math.min(height - cropHeight, point.value.y * height / 100 - cropHeight / 2))
  return `${x} ${y} ${cropWidth} ${cropHeight}`
})
</script>
<template>
  <section ref="root" class="sg" :data-visual="kind" :data-step="step" :data-playing="playing" :data-running="running">
    <header class="sg-heading">
      <strong>{{ plan.title }}</strong>
      <button type="button" class="sg-view" :aria-pressed="fullPage" @click="fullPage = !fullPage">
        {{ fullPage ? t('放大操作位置', 'Zoom to the control') : t('查看整个页面', 'Show the full page') }}
      </button>
    </header>
    <DemoSteps :labels="plan.steps" :active="step" :label="t('操作步骤', 'Steps')" :playing="playing" :reduced="reduced" :en="en" @select="select" />
    <a class="sg-frame" :class="{'sg-full': fullPage}" :href="withBase(capture.src)" target="_blank" rel="noopener" :aria-label="t('在新标签页查看界面原图', 'Open the original screenshot in a new tab')">
      <img v-if="fullPage" :src="withBase(capture.src)" :width="capture.width" :height="capture.height" :alt="plan.title" loading="lazy" />
      <svg v-else :viewBox="crop" role="img" :aria-label="plan.descriptions[step]" class="sg-zoom">
        <image :href="withBase(capture.src)" :width="capture.width" :height="capture.height" />
        <circle :cx="point.x * capture.width / 100" :cy="point.y * capture.height / 100" r="22" class="sg-ring" />
      </svg>
      <span v-if="fullPage" class="sg-full-ring" :style="{left: point.x + '%', top: point.y + '%'}" aria-hidden="true"></span>
    </a>
    <div class="sg-description" :data-callout-step="step + 1" :aria-live="playing ? 'off' : 'polite'">
      <span class="sg-step-number">{{ step + 1 }}</span><p>{{ plan.descriptions[step] }}</p>
    </div>
    <footer class="sg-controls">
      <small>{{ kind === 'webdav' ? t('真实界面 · 示例账号', 'Real interface · example account') : t('真实扩展界面', 'Actual extension interface') }}</small>
      <div>
        <button v-if="!reduced" type="button" :aria-pressed="playing" @click="playing = !playing">{{ playing ? t('暂停', 'Pause') : t('播放', 'Play') }}</button>
        <button type="button" @click="replay">{{ t('重播', 'Replay') }}</button>
      </div>
    </footer>
  </section>
</template>
<style scoped>
.sg {container-type:inline-size;margin:24px 0;border:1px solid var(--fr-line);border-radius:14px;overflow:hidden;background:var(--vp-c-bg);color:var(--fr-ink)}
.sg-heading {display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px;border-bottom:1px solid var(--fr-line);font-size:14px}
.sg-view,.sg-controls button {min-height:34px;padding:5px 8px;border:1px solid var(--fr-line);border-radius:7px;background:var(--vp-c-bg);color:var(--vp-c-brand-1);font:inherit;font-size:12px;cursor:pointer}
.sg-view {flex-shrink:0}
.sg-frame {position:relative;display:block;margin:0 12px;overflow:hidden;border:1px solid var(--fr-line);border-radius:9px;background:#fff}
.sg-frame img {display:block;width:100%;height:auto}
.sg-zoom {display:block;width:100%;aspect-ratio:1 / .46}
.sg-ring {fill:#ed3d7322;stroke:#b92252;stroke-width:5;vector-effect:non-scaling-stroke}
.sg-full-ring {position:absolute;width:28px;height:28px;border:3px solid #b92252;border-radius:50%;background:#ed3d7322;transform:translate(-50%,-50%);pointer-events:none}
.sg-description {display:flex;align-items:center;gap:10px;min-height:64px;margin:0;padding:12px 18px;font-size:13px;line-height:1.65}
.sg-description p {margin:0}
.sg-step-number {display:grid;place-items:center;flex:none;width:27px;height:27px;border-radius:50%;background:var(--vp-c-brand-soft);color:var(--vp-c-brand-1);font-weight:650}
.sg-controls {display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 16px;border-top:1px solid var(--fr-line)}
.sg-controls small {color:var(--fr-muted);font-size:11px}
.sg-controls > div {display:flex;gap:8px;flex:none}
.sg button:focus-visible,.sg-frame:focus-visible {outline:2px solid var(--vp-c-brand-1);outline-offset:2px}
@container(max-width:430px) {.sg-heading{align-items:flex-start;padding:12px}.sg-heading strong{font-size:13px}.sg-view{font-size:11px}.sg-frame{margin:0 8px}.sg-description{padding:10px 12px;min-height:76px}.sg-controls{padding:8px 12px}}
</style>
