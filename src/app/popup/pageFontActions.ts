/**
 * @file src/app/popup/pageFontActions.ts
 * 文件职责：为快捷面板的全局译文字体偏好提供保存中、失败重试与反馈失效控制。
 * 主要内容：从已有配置读取当前选择，将新选择交给既有配置补丁端口；关闭或停用只结束界面等待，不取消已经接受的持久化，超时与迟到回复不能覆盖新一轮反馈。
 * 模块边界：不维护字体真值、不读取标签页或发送页内消息，也不创建存储；全局配置订阅、后台确认与页面关闭交接仍由现有配置服务负责。
 */
import {waitForSettingsTask} from '@/src/features/settings/model/taskWait'

export interface PopupPageFontState {
  busy: boolean
  error: '' | 'popup.pageFont.changeError'
}
interface PageFontPorts {
  state: PopupPageFontState
  active: () => boolean
  read: () => boolean
  save: (browserDefault: boolean) => Promise<void>
}

export function createPopupPageFontActions(ports: PageFontPorts) {
  const {state} = ports
  let revision = 0, controller: AbortController | undefined, retryTarget: boolean | undefined
  function invalidate() {
    revision += 1;controller?.abort();controller = undefined;retryTarget = undefined
    state.busy = false;state.error = ''
  }
  async function set(browserDefault: boolean) {
    if (!ports.active() || state.busy || typeof browserDefault !== 'boolean'
      || (browserDefault === ports.read() && !state.error)) return
    const ownedController = new AbortController(), ownedRevision = ++revision
    controller = ownedController;retryTarget = browserDefault;state.busy = true;state.error = ''
    const current = () => ports.active() && revision === ownedRevision && !ownedController.signal.aborted
    try {
      // 保存端口在同一调用栈捕获完整草稿；取消这里只终止等待，后台保存仍继续完成。
      await waitForSettingsTask(ports.save(browserDefault), ownedController.signal, 10_000, 'Global translation font save timed out')
      if (current()) retryTarget = undefined
    } catch {
      if (current()) state.error = 'popup.pageFont.changeError'
    } finally {
      if (controller === ownedController) {controller = undefined;state.busy = false}
    }
  }
  return {set, invalidate, retry: () => retryTarget === undefined || !state.error ? Promise.resolve() : set(retryTarget)}
}
