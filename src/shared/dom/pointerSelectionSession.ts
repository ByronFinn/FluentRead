/**
 * @file src/shared/dom/pointerSelectionSession.ts
 * 文件职责：让同一内容脚本中的临时指针选择模式共享唯一手势所有权，防止多个选择器同时接管点击。
 * 主要内容：新会话认领时同步取消上一会话；释放函数只释放自己的所有权，显式取消先撤销身份再调用所属清理，保证旧清理不会取消新会话。
 * 模块边界：仅维护内存中的回调身份，不读取配置或 DOM，不注册事件、扫描页面或停止已经确认的翻译任务；各功能负责自己的界面与监听清理。
 */
interface PointerSelectionOwner {cancel(): void}
let activeOwner: PointerSelectionOwner | null = null;

/** 认领仅用于选择阶段；先登记新身份，再取消旧会话，旧 cleanup 只能释放旧身份。 */
export function claimPointerSelectionSession(cancel: () => void): () => void {
    const owner: PointerSelectionOwner = {cancel};
    const previous = activeOwner;
    activeOwner = owner;
    previous?.cancel();
    return () => { if (activeOwner === owner) activeOwner = null; };
}

/** 在执行其他主动阅读动作前取消当前选择，不影响取消回调中新建立的会话。 */
export function cancelPointerSelectionSession(): void {
    const previous = activeOwner;
    activeOwner = null;
    previous?.cancel();
}
