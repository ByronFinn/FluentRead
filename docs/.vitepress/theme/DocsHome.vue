<script setup lang="ts">
import { computed } from 'vue'
import { useData, withBase } from 'vitepress'
const { lang } = useData()
const en = computed(() => lang.value.startsWith('en'))
const t = (zh: string, english: string) => (en.value ? english : zh)
const link = (path: string) => withBase((en.value ? '/en' : '') + path)
const groups = computed(() => [
  {
    title: t('安装与使用环境', 'Installation & platforms'),
    id: 'installation',
    items: [
      [t('离线下载与安装', 'Offline installation'), '/guide/offline-install'],
      [t('手机与 Safari', 'Mobile & Safari'), '/guide/mobile-safari'],
      [t('油猴脚本', 'Userscripts'), '/guide/userscript'],
      [t('Thunderbird 邮件翻译', 'Thunderbird email translation'), '/guide/thunderbird'],
      [t('Zotero 文献翻译', 'Zotero literature translation'), '/guide/zotero'],
    ],
  },
  {
    title: t('网页翻译', 'Webpage translation'),
    id: 'webpage',
    items: [
      [
        t('双语翻译与局部翻译', 'Bilingual page & section translation'),
        '/guide/webpage-translation',
      ],
      [t('划词翻译', 'Selection translation'), '/guide/deepseek-harness'],
      [t('悬浮段落翻译', 'Hover translation'), '/guide/hover-translation'],
      [t('输入框翻译', 'Input translation'), '/guide/input-translation'],
      [t('翻译中心', 'Translation Center'), '/guide/translation-center'],
    ],
  },
  {
    title: t('图片、文档与视频', 'Images, documents & video'),
    id: 'media',
    items: [
      [t('图片与漫画翻译', 'Image & comic translation'), '/guide/image-translation'],
      [t('圈选翻译', 'Area translation'), '/guide/area-translation'],
      [t('文档翻译', 'Document translation'), '/guide/document-translation'],
      [t('视频与会议翻译', 'Video & meeting translation'), '/guide/video-subtitles'],
    ],
  },
  {
    title: t('学习与表达', 'Learning & writing'),
    id: 'learning',
    items: [
      [t('学习中心', 'Learning center'), '/guide/vocabulary-book'],
      [t('词性与句法', 'Sentence structure'), '/guide/sentence-analysis'],
      [t('双语分享卡片', 'Share cards'), '/guide/share-cards'],
      [t('写作助手', 'Writing assistant'), '/guide/writing-assistant'],
    ],
  },
  {
    title: t('服务与设置', 'Providers & settings'),
    id: 'settings',
    items: [
      [t('翻译服务', 'Translation providers'), '/config/translation-engines'],
      [t('外观与阅读辅助', 'Appearance & reading aids'), '/config/appearance'],
      [t('快捷键与触发方式', 'Shortcuts & triggers'), '/guide/custom-hotkey'],
      [t('术语库', 'Glossaries'), '/guide/glossary'],
      [t('网站规则', 'Site rules'), '/config/site-adaptation'],
      [t('备份与同步', 'Backup & sync'), '/config/backup-sync'],
      [t('WebDAV 云备份', 'WebDAV backup'), '/guide/webdav'],
      [t('翻译统计', 'Translation statistics'), '/guide/translation-stats'],
      [t('模型用量', 'Model usage'), '/guide/model-usage'],
    ],
  },
])
</script>
<template>
  <div class="fr-docs">
    <div class="fr-docs-intro">
      <p class="fr-docs-eyebrow">{{ t('流畅阅读', 'FluentRead') }}</p>
      <h1>{{ t('使用文档', 'Documentation') }}</h1>
      <p>
        {{
          t(
            '查找安装、翻译、学习和设置的操作步骤。',
            'Find steps for installation, translation, learning, and settings.'
          )
        }}
      </p>
    </div>
    <section class="fr-docs-start" aria-labelledby="fr-start-title">
      <h2 id="fr-start-title">{{ t('快速开始', 'Quick start') }}</h2>
      <p>
        {{
          t(
            '安装插件、固定图标、选择目标语言，翻译第一篇网页。',
            'Install and pin the extension, choose a target language, and translate your first webpage.'
          )
        }}
      </p>
      <a class="bv-button bv-primary" :href="link('/guide/getting-started')"
        >{{ t('查看快速开始', 'Open the quick start guide') }} →</a
      >
    </section>
    <h2>{{ t('指南目录', 'Browse guides') }}</h2>
    <div class="fr-docs-directory">
      <section v-for="group in groups" :key="group.id" class="fr-docs-group">
        <h3 :id="en ? group.title.toLowerCase().replace(/[^a-z]+/g, '-') : group.title">
          {{ group.title }}
        </h3>
        <div class="fr-docs-links">
          <a v-for="item in group.items" :key="item[1]" :href="link(item[1])"
            >{{ item[0] }} <span aria-hidden="true">→</span></a
          >
        </div>
      </section>
    </div>
    <section class="fr-docs-help">
      <h2>{{ t('设计与贡献', 'Design & contribution') }}</h2>
      <p>{{ t('查看视觉规范与真实组件，在不同主题和尺寸下体验界面交互。', 'Explore visual guidelines and real components across themes and screen sizes.') }}</p>
      <a :href="link('/guide/design-system')">{{ t('设计系统与组件预览', 'Design system & component previews') }} →</a>
    </section>
    <section class="fr-docs-help">
      <h2>{{ t('帮助', 'Help') }}</h2>
      <a :href="link('/guide/faq')">{{ t('常见问题与排查', 'Questions & troubleshooting') }} →</a>
      <a :href="link('/guide/privacy')">{{ t('数据与隐私', 'Data & privacy') }} →</a>
    </section>
  </div>
</template>
