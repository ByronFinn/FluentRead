import {beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
    config: {
        harness: undefined as {enabled: boolean} | undefined,
        disableSelectionTranslator: false,
        selectionTranslatorMode: 'bilingual',
        selectionAreaEnabled: true,
        comment: undefined as {enabled: boolean} | undefined,
    },
    createVueShadowUi: vi.fn(),
    createModalDialogHostController: vi.fn(),
}));

vi.mock('@/src/services/config/store', () => ({config: mocks.config}));
vi.mock('@/src/platform/shadow-ui', () => ({createVueShadowUi: mocks.createVueShadowUi}));
vi.mock('@/src/features/selection-translation/content/modalDialogHost', () => ({
    createModalDialogHostController: mocks.createModalDialogHostController,
}));
vi.mock('@/src/features/selection-translation/ui/SelectionTranslator.vue', () => ({default: {name: 'SelectionTranslator'}}));
vi.mock('@/src/features/area-translation/ui/AreaTranslator.vue', () => ({default: {name: 'AreaTranslator'}}));

interface MockUi {
    mounted?: {app?: unknown; instance?: unknown};
    remove: ReturnType<typeof vi.fn>;
}

function ui(instance: unknown = {feature: 'mounted'}): MockUi {
    return {
        mounted: {app: {unmount: vi.fn()}, instance},
        remove: vi.fn(),
    };
}

function pendingUi(): {
    promise: Promise<MockUi>;
    resolve: (value: MockUi) => void;
} {
    let resolve!: (value: MockUi) => void;
    return {
        promise: new Promise<MockUi>((done) => {
            resolve = done;
        }),
        resolve,
    };
}

beforeEach(() => {
    vi.resetModules();
    mocks.createVueShadowUi.mockReset();
    mocks.createModalDialogHostController.mockReset();
    mocks.config.harness = undefined;
    mocks.config.disableSelectionTranslator = false;
    mocks.config.selectionTranslatorMode = 'bilingual';
    mocks.config.selectionAreaEnabled = true;
    mocks.config.comment = undefined;
    vi.stubGlobal('document', {getElementById: vi.fn(() => null)});
});

describe('划词翻译挂载生命周期', () => {
    it('选区仅转发给当前 host，卸载先恢复 modal 所有权再移除界面', async () => {
        const pending = pendingUi();
        const shadowHost = {style: {setProperty: vi.fn()}};
        const controller = {placeForRange: vi.fn(), dispose: vi.fn()};
        const mountedUi = {...ui(), shadowHost};
        mocks.createModalDialogHostController.mockReturnValue(controller);
        mocks.createVueShadowUi.mockReturnValue(pending.promise);
        const runtime = await import('@/src/features/selection-translation/content/runtime');
        const request = runtime.mountSelectionTranslator({} as never);
        const reportRange = mocks.createVueShadowUi.mock.calls[0][1].props.onSelectionRangeChange;
        const range = {startContainer: {nodeType: 3}};

        reportRange(range);
        expect(controller.placeForRange).not.toHaveBeenCalled();
        pending.resolve(mountedUi);
        await request;
        expect(shadowHost.style.setProperty).toHaveBeenCalledWith('position', 'static', 'important');
        expect(mocks.createModalDialogHostController).toHaveBeenCalledWith(shadowHost);
        reportRange(range);
        reportRange(null);
        expect(controller.placeForRange.mock.calls).toEqual([[range], [null]]);

        runtime.unmountSelectionTranslator();
        expect(controller.dispose).toHaveBeenCalledOnce();
        expect(controller.dispose.mock.invocationCallOrder[0]).toBeLessThan(mountedUi.remove.mock.invocationCallOrder[0]);
        reportRange(range);
        expect(controller.placeForRange).toHaveBeenCalledTimes(2);
    });

    it('不完整挂载句柄缺少 host 样式时仍可安全卸载', async () => {
        const mountedUi = {...ui(), shadowHost: {}};
        mocks.createVueShadowUi.mockResolvedValue(mountedUi);
        const runtime = await import('@/src/features/selection-translation/content/runtime');
        await runtime.mountSelectionTranslator({} as never);
        expect(mocks.createModalDialogHostController).not.toHaveBeenCalled();
        runtime.unmountSelectionTranslator();
        expect(mountedUi.remove).toHaveBeenCalledOnce();
    });

    it('Harness 独立启用时保留共享挂载，并在两个入口都停用后丢弃待挂载 UI', async () => {
        mocks.config.harness = {enabled: true};
        mocks.config.disableSelectionTranslator = true;
        mocks.config.selectionTranslatorMode = 'disabled';
        const runtime = await import('@/src/features/selection-translation/content/runtime');
        const mounted = ui();
        mocks.createVueShadowUi.mockResolvedValueOnce(mounted);
        await expect(runtime.mountSelectionTranslator({} as never)).resolves.toEqual({feature: 'mounted'});
        runtime.unmountSelectionTranslator();
        const pending = pendingUi();
        const late = ui();
        mocks.createVueShadowUi.mockReturnValueOnce(pending.promise);
        const request = runtime.mountSelectionTranslator({} as never);
        mocks.config.harness.enabled = false;
        pending.resolve(late);
        await expect(request).resolves.toBeNull();
        expect(late.remove).toHaveBeenCalledOnce();
    });

    it('Harness 共享实例重挂载后，旧组件 Range 回调不得移动新 modal host', async () => {
        mocks.config.harness = {enabled: true};
        mocks.config.disableSelectionTranslator = true;
        mocks.config.selectionTranslatorMode = 'disabled';
        const firstHost = {style: {setProperty: vi.fn()}};
        const secondHost = {style: {setProperty: vi.fn()}};
        const firstController = {placeForRange: vi.fn(), dispose: vi.fn()};
        const secondController = {placeForRange: vi.fn(), dispose: vi.fn()};
        const firstUi = {...ui(), shadowHost: firstHost};
        const secondUi = {...ui(), shadowHost: secondHost};
        mocks.createVueShadowUi.mockResolvedValueOnce(firstUi).mockResolvedValueOnce(secondUi);
        mocks.createModalDialogHostController.mockReturnValueOnce(firstController).mockReturnValueOnce(secondController);
        const runtime = await import('@/src/features/selection-translation/content/runtime');

        await runtime.mountSelectionTranslator({} as never);
        const firstReport = mocks.createVueShadowUi.mock.calls[0][1].props.onSelectionRangeChange;
        const range = {startContainer: {nodeType: 3}};
        firstReport(range);
        expect(firstController.placeForRange).toHaveBeenCalledWith(range);
        runtime.unmountSelectionTranslator();
        expect(firstController.dispose.mock.invocationCallOrder[0]).toBeLessThan(firstUi.remove.mock.invocationCallOrder[0]);

        await runtime.mountSelectionTranslator();
        const secondReport = mocks.createVueShadowUi.mock.calls[1][1].props.onSelectionRangeChange;
        firstReport(range);
        firstReport(null);
        expect(secondController.placeForRange).not.toHaveBeenCalled();
        secondReport(range);
        secondReport(null);
        expect(secondController.placeForRange.mock.calls).toEqual([[range], [null]]);
        runtime.unmountSelectionTranslator();
        expect(secondController.dispose.mock.invocationCallOrder[0]).toBeLessThan(secondUi.remove.mock.invocationCallOrder[0]);
    });

    it('没有内容脚本上下文或功能关闭时不挂载', async () => {
        const runtime = await import('@/src/features/selection-translation/content/runtime');

        expect(runtime.mountSelectionTranslator()).toBeUndefined();
        mocks.config.disableSelectionTranslator = true;
        expect(runtime.mountSelectionTranslator({} as never)).toBeNull();
        mocks.config.disableSelectionTranslator = false;
        mocks.config.selectionTranslatorMode = 'disabled';
        expect(runtime.mountSelectionTranslator({} as never)).toBeNull();
        expect(mocks.createVueShadowUi).not.toHaveBeenCalled();
    });

    it('评论启用时仅为评论保留卡片，评论关闭后与选区翻译一同彻底关闭', async () => {
        const runtime = await import('@/src/features/selection-translation/content/runtime');

        // 选区翻译关闭、评论开启：卡片仅为评论挂载。
        mocks.config.disableSelectionTranslator = true;
        mocks.config.comment = {enabled: true};
        const mountedUi = ui();
        mocks.createVueShadowUi.mockResolvedValueOnce(mountedUi);
        await expect(runtime.mountSelectionTranslator({} as never)).resolves.toEqual({feature: 'mounted'});
        runtime.unmountSelectionTranslator();

        // 选区翻译与评论都关闭：不再挂载。
        mocks.config.comment = {enabled: false};
        expect(runtime.mountSelectionTranslator({} as never)).toBeNull();

        // 挂载在途时评论关闭：迟到的界面同样被移除。
        const pending = pendingUi();
        const late = ui();
        mocks.config.comment = {enabled: true};
        mocks.createVueShadowUi.mockReturnValueOnce(pending.promise);
        const request = runtime.mountSelectionTranslator({} as never);
        mocks.config.comment = {enabled: false};
        pending.resolve(late);
        await expect(request).resolves.toBeNull();
        expect(late.remove).toHaveBeenCalledOnce();
    });

    it('只创建一个关闭 Shadow DOM，并在卸载时清理', async () => {
        const mountedUi = ui();
        mocks.createVueShadowUi.mockResolvedValue(mountedUi);
        const runtime = await import('@/src/features/selection-translation/content/runtime');
        const context = {name: 'content'} as never;

        await expect(runtime.mountSelectionTranslator(context)).resolves.toEqual({feature: 'mounted'});
        expect(mocks.createVueShadowUi).toHaveBeenCalledWith(context, expect.objectContaining({
            name: 'fluent-read-selection-translator-ui',
            hostId: 'fluent-read-selection-translator-container',
            zIndex: 2_147_483_646,
            mode: 'closed',
        }));
        expect(runtime.mountSelectionTranslator()).toBeNull();

        runtime.unmountSelectionTranslator();
        expect(mountedUi.remove).toHaveBeenCalledOnce();
        runtime.unmountSelectionTranslator();
        expect(mountedUi.remove).toHaveBeenCalledOnce();
    });

    it('复用正在挂载的请求，并丢弃卸载后的迟到结果', async () => {
        const pending = pendingUi();
        const mountedUi = ui();
        mocks.createVueShadowUi.mockReturnValue(pending.promise);
        const runtime = await import('@/src/features/selection-translation/content/runtime');

        const request = runtime.mountSelectionTranslator({} as never);
        expect(runtime.mountSelectionTranslator()).toBe(request);
        runtime.unmountSelectionTranslator();
        pending.resolve(mountedUi);

        await expect(request).resolves.toBeNull();
        expect(mountedUi.remove).toHaveBeenCalledOnce();
    });

    it.each([
        ['disableSelectionTranslator', true],
        ['selectionTranslatorMode', 'disabled'],
    ] as const)('挂载期间配置字段 %s 关闭时移除迟到界面', async (key, value) => {
        const pending = pendingUi();
        const mountedUi = ui();
        mocks.createVueShadowUi.mockReturnValue(pending.promise);
        const runtime = await import('@/src/features/selection-translation/content/runtime');

        const request = runtime.mountSelectionTranslator({} as never);
        mocks.config[key] = value as never;
        pending.resolve(mountedUi);

        await expect(request).resolves.toBeNull();
        expect(mountedUi.remove).toHaveBeenCalledOnce();
    });

    it('允许挂载器返回没有 Vue 实例的安全空结果', async () => {
        const mountedUi = {remove: vi.fn()};
        mocks.createVueShadowUi.mockResolvedValue(mountedUi);
        const runtime = await import('@/src/features/selection-translation/content/runtime');

        await expect(runtime.mountSelectionTranslator({} as never)).resolves.toBeNull();
        runtime.unmountSelectionTranslator();
        expect(mountedUi.remove).toHaveBeenCalledOnce();
    });
});

describe('圈选翻译挂载生命周期', () => {
    it('通过宿主元素报告挂载状态', async () => {
        const getElementById = vi.fn()
            .mockReturnValueOnce(null)
            .mockReturnValueOnce({id: 'fluent-read-area-translator-container'});
        vi.stubGlobal('document', {getElementById});
        const runtime = await import('@/src/features/area-translation/content/runtime');

        expect(runtime.isAreaTranslatorMounted()).toBe(false);
        expect(runtime.isAreaTranslatorMounted()).toBe(true);
    });

    it('没有上下文或功能关闭时不挂载', async () => {
        const runtime = await import('@/src/features/area-translation/content/runtime');

        expect(runtime.mountAreaTranslator()).toBeUndefined();
        mocks.config.selectionAreaEnabled = false;
        expect(runtime.mountAreaTranslator({} as never)).toBeNull();
        expect(mocks.createVueShadowUi).not.toHaveBeenCalled();
    });

    it('只创建一个关闭 Shadow DOM，并在卸载后允许重新挂载', async () => {
        const firstUi = ui({feature: 'area'});
        const secondUi = ui({feature: 'area-again'});
        mocks.createVueShadowUi.mockResolvedValueOnce(firstUi).mockResolvedValueOnce(secondUi);
        const runtime = await import('@/src/features/area-translation/content/runtime');
        const context = {name: 'content'} as never;

        await expect(runtime.mountAreaTranslator(context)).resolves.toEqual({feature: 'area'});
        expect(mocks.createVueShadowUi).toHaveBeenNthCalledWith(1, context, expect.objectContaining({
            name: 'fluent-read-area-translator-ui',
            hostId: 'fluent-read-area-translator-container',
            zIndex: 2_147_483_647,
            mode: 'closed',
        }));
        expect(runtime.mountAreaTranslator()).toBeNull();

        runtime.unmountAreaTranslator();
        expect(firstUi.remove).toHaveBeenCalledOnce();
        await expect(runtime.mountAreaTranslator()).resolves.toEqual({feature: 'area-again'});
        runtime.unmountAreaTranslator();
        runtime.unmountAreaTranslator();
        expect(secondUi.remove).toHaveBeenCalledOnce();
    });

    it('复用正在挂载的请求，并丢弃卸载后的迟到结果', async () => {
        const pending = pendingUi();
        const mountedUi = ui();
        mocks.createVueShadowUi.mockReturnValue(pending.promise);
        const runtime = await import('@/src/features/area-translation/content/runtime');

        const request = runtime.mountAreaTranslator({} as never);
        expect(runtime.mountAreaTranslator()).toBe(request);
        runtime.unmountAreaTranslator();
        pending.resolve(mountedUi);

        await expect(request).resolves.toBeNull();
        expect(mountedUi.remove).toHaveBeenCalledOnce();
    });

    it('挂载期间被关闭时移除迟到界面', async () => {
        const pending = pendingUi();
        const mountedUi = ui();
        mocks.createVueShadowUi.mockReturnValue(pending.promise);
        const runtime = await import('@/src/features/area-translation/content/runtime');

        const request = runtime.mountAreaTranslator({} as never);
        mocks.config.selectionAreaEnabled = false;
        pending.resolve(mountedUi);

        await expect(request).resolves.toBeNull();
        expect(mountedUi.remove).toHaveBeenCalledOnce();
    });

    it('允许挂载器返回没有 Vue 实例的安全空结果', async () => {
        const mountedUi = {remove: vi.fn()};
        mocks.createVueShadowUi.mockResolvedValue(mountedUi);
        const runtime = await import('@/src/features/area-translation/content/runtime');

        await expect(runtime.mountAreaTranslator({} as never)).resolves.toBeNull();
        runtime.unmountAreaTranslator();
        expect(mountedUi.remove).toHaveBeenCalledOnce();
    });
});
