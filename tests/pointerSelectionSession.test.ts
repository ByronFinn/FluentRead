/**
 * @file tests/pointerSelectionSession.test.ts
 * 文件职责：验证临时指针选区会话的互斥交接与释放归属，避免旧关闭回调使新模式失效。
 * 主要内容：覆盖认领、主动取消、无会话取消、完成后的无副作用释放，以及旧清理重入和取消中新建会话的身份保护。
 * 模块边界：只执行共享内存所有权，不创建 DOM、不注入内容脚本，也不模拟翻译服务。
 */
import {afterEach, describe, expect, it, vi} from 'vitest';
import {cancelPointerSelectionSession, claimPointerSelectionSession} from '@/src/shared/dom/pointerSelectionSession';

afterEach(() => cancelPointerSelectionSession());

describe('临时指针选区会话所有权', () => {
    it('新模式同步取消上一模式，旧cleanup与重复cleanup均不会释放当前模式', () => {
        const previous = vi.fn(), current = vi.fn(), next = vi.fn();
        const releasePrevious = claimPointerSelectionSession(previous);
        expect(previous).not.toHaveBeenCalled();
        const releaseCurrent = claimPointerSelectionSession(current);
        expect(previous).toHaveBeenCalledOnce(); expect(current).not.toHaveBeenCalled();
        releasePrevious(); releasePrevious();
        const releaseNext = claimPointerSelectionSession(next);
        expect(current).toHaveBeenCalledOnce(); expect(previous).toHaveBeenCalledOnce();
        releaseCurrent(); cancelPointerSelectionSession();
        expect(next).toHaveBeenCalledOnce(); releaseNext(); cancelPointerSelectionSession();
        expect(next).toHaveBeenCalledOnce();
    });

    it('完成选择只释放会话，后续动作不把已确认的结果再次取消', () => {
        const confirmed = vi.fn(), current = vi.fn();
        const releaseConfirmed = claimPointerSelectionSession(confirmed);
        releaseConfirmed(); releaseConfirmed();
        const releaseCurrent = claimPointerSelectionSession(current);
        expect(confirmed).not.toHaveBeenCalled();
        releaseCurrent(); cancelPointerSelectionSession(); cancelPointerSelectionSession();
        expect(current).not.toHaveBeenCalled();
    });

    it('旧取消回调释放自身时不会清除正在接管的新身份', () => {
        let releaseOld!: () => void;
        const cancelOld = vi.fn(() => releaseOld());
        const cancelNew = vi.fn();
        releaseOld = claimPointerSelectionSession(cancelOld);
        claimPointerSelectionSession(cancelNew);
        expect(cancelOld).toHaveBeenCalledOnce();
        cancelPointerSelectionSession(); expect(cancelNew).toHaveBeenCalledOnce();
    });

    it('主动取消先清除旧身份，取消回调中新建的会话保持有效', () => {
        const next = vi.fn();
        const old = vi.fn(() => { claimPointerSelectionSession(next); });
        const releaseOld = claimPointerSelectionSession(old);
        cancelPointerSelectionSession(); expect(old).toHaveBeenCalledOnce(); expect(next).not.toHaveBeenCalled();
        releaseOld(); cancelPointerSelectionSession(); expect(next).toHaveBeenCalledOnce();
    });

    it('交接时旧清理触发第三个模式，最后认领者仍拥有会话', () => {
        const pending = vi.fn(), latest = vi.fn();
        const old = vi.fn(() => {claimPointerSelectionSession(latest);});
        const releaseOld = claimPointerSelectionSession(old);
        const releasePending = claimPointerSelectionSession(pending);
        expect(old).toHaveBeenCalledOnce(); expect(pending).toHaveBeenCalledOnce();
        releaseOld(); releasePending(); cancelPointerSelectionSession(); expect(latest).toHaveBeenCalledOnce();
    });
});
