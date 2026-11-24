/**
 * @file entrypoints/options/main.ts
 * 文件职责：启动 FluentRead 设置页的 Vue 应用。
 * 主要内容：把 #app 容器交给 mountOptionsApp，并复用轻量启动反馈承接加载缓慢或失败，提供手动重新打开入口。
 * 模块边界：入口不读取或保存用户配置，不展示原始异常；页面退出后反馈和迟到挂载保持静默，页面状态与持久化由 options app 和 settings feature 管理。
 */
import { mountOptionsApp } from '@/src/app/options'
import { createPopupStartupFeedback } from '@/src/app/popup/startupFeedback'

const feedback = createPopupStartupFeedback('#app')
void mountOptionsApp('#app').then(feedback.dispose, feedback.fail)
