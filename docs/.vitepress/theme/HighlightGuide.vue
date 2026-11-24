<!-- 本地交互示例：演示原文、高亮和外观对照，不运行模型或读取网页。 -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import DemoSteps from './DemoSteps.vue'
import { useDemoPlayback } from './useDemoPlayback'
const props = defineProps<{ en?: boolean }>()
const t = (zh: string, en: string) => props.en ? en : zh
const root = ref<HTMLElement | null>(null)
const { step, playing, running, reduced, select, replay } = useDemoPlayback(root, 3, true, 4500)
const underline = ref(false)
const labels = computed(() => [t('阅读原文', 'Read the original'), t('开启高亮', 'Turn on highlighting'), t('对照外观', 'Compare styles')])
const notes = computed(() => [
  t('这是一段示例文章。先读一遍原文。', 'Start with this short sample article.'),
  t('高亮帮助找到部分词语，阅读时仍要留意条件与否定。', 'Highlighting helps you find some words. Keep reading conditions and negations too.'),
  t('点击下方按钮切换底色和下划线，选择适合自己的阅读方式。', 'Switch between a background and an underline to compare readability.'),
])
</script>
<template>
  <section ref="root" class="hg" data-visual="highlight" :data-step="step" :data-playing="playing" :data-running="running">
    <header><strong>{{ t('看看高亮前后的正文', 'Compare the original and highlighted text') }}</strong><small>{{ t('交互示例', 'Interactive example') }}</small></header>
    <DemoSteps :labels="labels" :active="step" :label="t('操作步骤', 'Steps')" :playing="playing" :reduced="reduced" :en="en" @select="select" />
    <article :class="{ highlighted: step > 0, underline }">
      <small>FIELD NOTES · {{ t('阅读示例', 'Reading sample') }}</small>
      <h3>{{ t('A greener neighbourhood', '更绿的社区') }}</h3>
      <p v-if="!en">A small <mark>community garden</mark> can change the way people use a neighbourhood. Trees provide <mark>shade</mark>, and shared paths bring neighbours together. But planting alone does not guarantee success: the garden needs <mark>regular care</mark> and enough water.</p>
      <p v-else>一座小小的<mark>社区花园</mark>，能改变人们使用社区空间的方式。树木带来<mark>阴凉</mark>，共享步道让邻居相聚。但种下植物并不保证成功：花园还需要<mark>持续照料</mark>和足够的水。</p>
    </article>
    <div v-if="step === 2" class="hg-style" role="group" :aria-label="t('示例外观', 'Example style')">
      <button type="button" :aria-pressed="!underline" @click="underline = false">{{ t('柔和底色', 'Soft background') }}</button>
      <button type="button" :aria-pressed="underline" @click="underline = true">{{ t('细下划线', 'Thin underline') }}</button>
    </div>
    <p class="hg-note" :aria-live="playing ? 'off' : 'polite'">{{ notes[step] }}</p>
    <footer><small>{{ t('示例标记仅用于说明外观', 'Sample marks illustrate the appearance') }}</small><div><button v-if="!reduced" type="button" :aria-pressed="playing" @click="playing = !playing">{{ playing ? t('暂停', 'Pause') : t('播放', 'Play') }}</button><button type="button" @click="replay">{{ t('重播', 'Replay') }}</button></div></footer>
  </section>
</template>
<style scoped>
.hg{container-type:inline-size;overflow:hidden;margin:24px 0;border:1px solid var(--fr-line);border-radius:14px;background:var(--vp-c-bg);color:var(--fr-ink)}
.hg header,.hg footer{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 18px;font-size:14px}
.hg header{border-bottom:1px solid var(--fr-line)}
.hg small{font-size:11px;color:var(--fr-muted)}
.hg article{margin:0 18px;padding:24px;border:1px solid var(--fr-line);border-radius:10px;background:var(--vp-c-bg-soft)}
.hg h3{margin:10px 0;font:600 23px/1.4 Georgia,serif}
.hg article p{margin:12px 0 0;font:16px/1.9 Georgia,serif}
.hg mark{padding:1px 2px;background:transparent;color:inherit;box-decoration-break:clone}
.hg .highlighted mark{background:#d9ebd5;color:#172c23}
.hg .highlighted.underline mark{background:transparent;color:inherit;text-decoration:underline;text-decoration-color:#498445;text-decoration-thickness:2px;text-underline-offset:4px}
.hg-note{min-height:54px;margin:0;padding:14px 18px;font-size:13px;line-height:1.7}
.hg-style{display:flex;gap:8px;margin:12px 18px 0}
.hg button{min-height:32px;padding:5px 10px;border:1px solid var(--fr-line);border-radius:6px;background:var(--vp-c-bg);color:var(--vp-c-brand-1);font:inherit;font-size:12px;cursor:pointer}
.hg button[aria-pressed=true]{background:var(--vp-c-brand-soft)}
.hg button:focus-visible{outline:2px solid var(--vp-c-brand-1);outline-offset:2px}
.hg footer{border-top:1px solid var(--fr-line)}
.hg footer div{display:flex;gap:8px;flex:none}
@container(max-width:430px){.hg header,.hg footer{padding:12px}.hg article{margin:0 12px;padding:16px}.hg h3{font-size:20px}.hg article p{font-size:14px}.hg header>small{display:none}}
</style>
