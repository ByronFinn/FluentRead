import {parseHTML} from 'linkedom';
import {ContentFeatureRegistry} from '@/src/app/content/featureRegistry';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
const mocks = vi.hoisted(() => ({create: vi.fn(), notice: vi.fn(), config: {on: true, uiLanguage: 'zh-CN'}}));
vi.mock('@/src/platform/shadow-ui', () => ({createVueShadowUi: mocks.create}));
vi.mock('@/src/features/page-notice/public', () => ({showPageNotice: mocks.notice}));
vi.mock('@/src/services/config/store', () => ({config: mocks.config}));
vi.mock('@/src/features/share-card/ui/ShareCardStudio.vue', () => ({default: {}}));
import {isShareCardMounted, mountShareCard, openShareCard, unmountShareCard} from '@/src/features/share-card/content/runtime';
import type {ContentScriptContext} from 'wxt/utils/content-script-context';
const ctx = {} as ContentScriptContext;
function studio() {
    const shadowHost = document.createElement('div'); document.documentElement.append(shadowHost);
    const open = vi.fn(), remove = vi.fn(() => shadowHost.remove());
    return {shadowHost, mounted: {instance: {open}}, remove};
}
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(yes => {resolve = yes;}); return {promise, resolve};}

beforeEach(() => {
    vi.resetAllMocks(); mocks.config.on = true;
    const dom = parseHTML('<html><body></body></html>');
    vi.stubGlobal('document', dom.document); vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('location', {href: 'https://example.com/private?secret=1'});
});
afterEach(() => {unmountShareCard(); vi.unstubAllGlobals();});
describe('分享卡片按需挂载所有权', () => {
    it('启动不监听宿主页面或创建 UI，两个主动入口复用单个闭合 Shadow UI', async () => {
        const documentListener = vi.spyOn(document, 'addEventListener');
        const windowListener = vi.spyOn(window, 'addEventListener');
        const ui = studio(), {open} = ui.mounted.instance, {remove} = ui;
        mocks.create.mockResolvedValue(ui);
        mountShareCard(ctx); mountShareCard(ctx); expect(mocks.create).not.toHaveBeenCalled();
        expect(documentListener).not.toHaveBeenCalled(); expect(windowListener).not.toHaveBeenCalled();
        expect(isShareCardMounted()).toBe(true);
        await Promise.all([openShareCard({original: 'first', translation: '第一'}), openShareCard({original: 'second', translation: '第二'})]);
        expect(mocks.create).toHaveBeenCalledOnce(); expect(mocks.create.mock.calls[0][1].mode).toBe('closed');
        expect(open).toHaveBeenLastCalledWith({original: 'second', translation: '第二', source: 'example.com'});
        await openShareCard({original: 'third', translation: '第三'}); expect(mocks.create).toHaveBeenCalledOnce();
        unmountShareCard(); expect(remove).toHaveBeenCalledOnce(); expect(isShareCardMounted()).toBe(false);
    });
    it('异步挂载迟到时不能重建已停用 UI，重新启用可重新打开', async () => {
        let resolve!: (value: unknown) => void;
        mocks.create.mockReturnValueOnce(new Promise(r => {resolve = r;}));
        mountShareCard(ctx); const task = openShareCard({original: 'first', translation: '第一'});
        unmountShareCard(); mountShareCard(ctx);
        const stale = studio(), staleOpen = stale.mounted.instance.open, staleRemove = stale.remove;
        resolve(stale); await task;
        expect(staleRemove).toHaveBeenCalledOnce(); expect(staleOpen).not.toHaveBeenCalled();
        const fresh = studio(), {open} = fresh.mounted.instance; mocks.create.mockResolvedValue(fresh);
        await openShareCard({original: 'new', translation: '新'}); expect(open).toHaveBeenCalledOnce();
    });
    it('旧挂载失败不向新页面报告错误，缺少实例时不打开', async () => {
        let reject!: (reason: Error) => void;
        mocks.create.mockReturnValueOnce(new Promise((_resolve, no) => {reject = no;}));
        mountShareCard(ctx); const task = openShareCard({original: 'first', translation: '第一'});
        unmountShareCard(); mountShareCard(ctx); reject(Error('late')); await task;
        expect(mocks.notice).not.toHaveBeenCalled();
        const missing = studio(); mocks.create.mockResolvedValue({...missing, mounted: undefined});
        await openShareCard({original: 'second', translation: '第二'});
        await openShareCard({original: 'third', translation: '第三'});
        expect(mocks.create).toHaveBeenCalledTimes(2);
    });
    it('真实 registry 保留懒挂载可用状态，宿主移除后并发入口重建一次并清理旧 UI', async () => {
        const errors = vi.fn(), owner = new AbortController();
        // 与 learningFeatures 的 share-card 注册项一致，使用真实 registry 与 runtime。
        const registry = new ContentFeatureRegistry([{id: 'share-card', isEnabled: () => mocks.config.on,
            mount: () => mountShareCard(ctx), unmount: unmountShareCard, isMounted: isShareCardMounted}], {onError: errors});
        await registry.mountEnabled({ctx, signal: owner.signal, isCurrent: () => !owner.signal.aborted});
        expect(isShareCardMounted()).toBe(true); expect(mocks.create).not.toHaveBeenCalled();
        const old = studio(); mocks.create.mockResolvedValueOnce(old);
        await openShareCard({original: 'first', translation: '第一'}); old.shadowHost.remove();
        const waiting = deferred<ReturnType<typeof studio>>(); mocks.create.mockReturnValueOnce(waiting.promise);
        const second = openShareCard({original: 'second', translation: '第二'}), third = openShareCard({original: 'third', translation: '第三'});
        expect(mocks.create).toHaveBeenCalledTimes(2); expect(old.remove).toHaveBeenCalledOnce();
        const fresh = studio(); waiting.resolve(fresh); await Promise.all([second, third]);
        expect(old.mounted.instance.open).toHaveBeenCalledOnce(); expect(fresh.mounted.instance.open).toHaveBeenCalledTimes(2);
        expect(fresh.shadowHost.isConnected).toBe(true); await registry.reconcileEnabled(); expect(mocks.create).toHaveBeenCalledTimes(2);
        mocks.config.on = false; await registry.reconcileEnabled();
        expect(fresh.remove).toHaveBeenCalledOnce(); expect(isShareCardMounted()).toBe(false); expect(errors).not.toHaveBeenCalled();
    });
    it('宿主重建期间停用再恢复，迟到旧 UI 和 finally 不移除或重复创建新 UI', async () => {
        mountShareCard(ctx); const old = studio(); mocks.create.mockResolvedValueOnce(old);
        await openShareCard({original: 'first', translation: '第一'}); old.shadowHost.remove();
        const staleWait = deferred<ReturnType<typeof studio>>(), freshWait = deferred<ReturnType<typeof studio>>();
        mocks.create.mockReturnValueOnce(staleWait.promise).mockReturnValueOnce(freshWait.promise);
        const staleTask = openShareCard({original: 'stale', translation: '旧'});
        unmountShareCard(); mountShareCard(ctx); const freshTask = openShareCard({original: 'fresh', translation: '新'});
        const stale = studio(); staleWait.resolve(stale); await staleTask;
        expect(stale.remove).toHaveBeenCalledOnce(); expect(stale.mounted.instance.open).not.toHaveBeenCalled();
        const sharedTask = openShareCard({original: 'shared', translation: '同代'}); expect(mocks.create).toHaveBeenCalledTimes(3);
        const fresh = studio(); freshWait.resolve(fresh); await Promise.all([freshTask, sharedTask]);
        expect(fresh.mounted.instance.open).toHaveBeenCalledTimes(2); expect(fresh.remove).not.toHaveBeenCalled();
        expect(old.remove).toHaveBeenCalledOnce(); expect(mocks.notice).not.toHaveBeenCalled();
        unmountShareCard(); expect(fresh.remove).toHaveBeenCalledOnce();
    });
    it('宿主重建失败报告可恢复错误，下一次主动入口重试且不重复清理旧 UI', async () => {
        mountShareCard(ctx); const old = studio(); mocks.create.mockResolvedValueOnce(old);
        await openShareCard({original: 'first', translation: '第一'}); old.shadowHost.remove();
        mocks.create.mockRejectedValueOnce(Error('rebuild failed'));
        await openShareCard({original: 'failed', translation: '失败'}); expect(mocks.notice).toHaveBeenCalledOnce();
        const fresh = studio(); mocks.create.mockResolvedValueOnce(fresh); await openShareCard({original: 'retry', translation: '重试'});
        expect(old.remove).toHaveBeenCalledOnce(); expect(fresh.mounted.instance.open).toHaveBeenCalledOnce();
    });

    it('失效的 WXT 上下文不创建 UI；有效入口挂载后再次失效也静默拒绝', async () => {
        const owned = {isInvalid: true} as ContentScriptContext; mountShareCard(owned); expect(isShareCardMounted()).toBe(false);
        Object.assign(owned, {isInvalid: false}); mountShareCard(owned); Object.assign(owned, {isInvalid: true});
        await openShareCard({original: 'first', translation: '第一'});
        expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.notice).not.toHaveBeenCalled();
    });
    it.each(['config-off', 'invalid-context'] as const)('等待创建期间 %s，迟到 UI 被清理，恢复后下一次主动打开可重试', async reason => {
        const owned = {isInvalid: false} as ContentScriptContext, waiting = deferred<ReturnType<typeof studio>>();
        mountShareCard(owned); mocks.create.mockReturnValueOnce(waiting.promise);
        const task = openShareCard({original: 'first', translation: '第一'});
        if (reason === 'config-off') mocks.config.on = false; else Object.assign(owned, {isInvalid: true});
        const stale = studio(); waiting.resolve(stale); await task;
        expect(stale.remove).toHaveBeenCalledOnce(); expect(stale.mounted.instance.open).not.toHaveBeenCalled(); expect(mocks.notice).not.toHaveBeenCalled();
        mocks.config.on = true; Object.assign(owned, {isInvalid: false}); const fresh = studio(); mocks.create.mockResolvedValueOnce(fresh);
        await openShareCard({original: 'retry', translation: '重试'}); expect(fresh.mounted.instance.open).toHaveBeenCalledOnce();
    });

    it('停用、空内容和创建失败不会留下可操作工作台', async () => {
        await openShareCard({original: 'first', translation: '第一'}); expect(mocks.create).not.toHaveBeenCalled();
        mountShareCard(ctx); await openShareCard({original: '  ', translation: '第一'});
        await openShareCard({original: 'first', translation: '  '}); expect(mocks.create).not.toHaveBeenCalled();
        mocks.config.on = false; await openShareCard({original: 'first', translation: '第一'}); expect(mocks.create).not.toHaveBeenCalled();
        mocks.config.on = true; mocks.create.mockRejectedValue(new Error('mount failed'));
        await openShareCard({original: 'first', translation: '第一'}); expect(mocks.notice).toHaveBeenCalledOnce();
    });
});
