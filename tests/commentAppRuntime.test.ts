import {beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
    config: {on: true, disabledExtensionDomains: ['blocked.example'], customOpenAIProviders: [], comment: {enabled: true, service: '', model: '', count: 2, prompt: ''}},
    subscribe: vi.fn(), createHandler: vi.fn(), createRuntime: vi.fn(), attachPort: vi.fn(),
    handler: {handle: vi.fn(), cancelAll: vi.fn(), cancelDisallowed: vi.fn(), cancelTab: vi.fn()},
    runtime: {run: vi.fn()},
    connect: vi.fn(), removed: vi.fn(), updated: vi.fn(),
    usageRepo: {captureGeneration: vi.fn(() => 7), recordMany: vi.fn(async () => undefined)},
}));
vi.mock('webextension-polyfill', () => ({default: {
    runtime: {id: 'ext', onConnect: {addListener: mocks.connect}},
    tabs: {onRemoved: {addListener: mocks.removed}, onUpdated: {addListener: mocks.updated}},
}}));
vi.mock('@/src/services/config/store', () => ({config: mocks.config, configReady: Promise.resolve(), subscribeConfig: mocks.subscribe}));
vi.mock('@/src/features/comment-assistant/background', async () => {
    const actual = await vi.importActual<typeof import('@/src/features/comment-assistant/background')>('@/src/features/comment-assistant/background');
    return {...actual, createCommentHandler: mocks.createHandler};
});
vi.mock('@/src/features/comment-assistant/streamPort', () => ({attachCommentStreamPort: mocks.attachPort}));
vi.mock('@/src/services/comment/runtime', () => ({createCommentRuntime: mocks.createRuntime}));
vi.mock('@/src/services/harness/modelGateway', () => ({createHarnessLanguageModel: vi.fn()}));
vi.mock('@/src/platform/storage/modelUsageRepository', () => ({modelUsageRepository: mocks.usageRepo}));
vi.mock('@/src/core/site-rules/domain', () => ({isExtensionDisabledOnSite: (url: string) => url.includes('blocked')}));

import {installCommentBackgroundRuntime} from '@/src/app/background/commentRuntime';

describe('comment background composition', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.config.on = true;
        mocks.config.comment = {enabled: true, service: '', model: '', count: 2, prompt: ''};
        mocks.createHandler.mockReturnValue(mocks.handler);
        mocks.createRuntime.mockReturnValue(mocks.runtime);
        mocks.handler.handle.mockResolvedValue({success: true, comments: []});
    });

    it('wires handler, ports, tabs and the message router type', async () => {
        const router = installCommentBackgroundRuntime();
        expect(router.type).toBe('fluentReadComment');
        expect(mocks.connect).toHaveBeenCalledOnce();
        expect(mocks.attachPort).not.toHaveBeenCalled();
        const fakePort = {name: 'fluentReadCommentStream'};
        mocks.connect.mock.calls[0][0](fakePort);
        expect(mocks.attachPort).toHaveBeenCalledWith(fakePort, mocks.handler);
        mocks.removed.mock.calls[0][0](7);
        expect(mocks.handler.cancelTab).toHaveBeenCalledWith(7);
        mocks.updated.mock.calls[0][0](8, {status: 'loading'});
        mocks.updated.mock.calls[0][0](8, {status: 'complete'});
        mocks.updated.mock.calls[0][0](9, {url: 'https://weibo.example/detail'});
        expect(mocks.handler.cancelTab).toHaveBeenCalledTimes(3);
        expect(mocks.handler.cancelTab).toHaveBeenLastCalledWith(9);
        expect(await router.handle({requestId: 'r'} as never, {sender: {id: 'ext', tab: {id: 1}}})).toEqual({success: true, comments: []});
        await router.handle({requestId: 'r'} as never, {});
        expect(mocks.handler.handle).toHaveBeenLastCalledWith({requestId: 'r'}, {});
    });

    it('eligibility follows global switch, feature preference and site rules', () => {
        installCommentBackgroundRuntime();
        const eligibility = mocks.createHandler.mock.calls[0][0].eligibility;
        expect(eligibility({id: 'ext', url: 'https://ok.example/x', tab: {id: 1}})).toBeUndefined();
        mocks.config.comment.enabled = false;
        expect(eligibility({id: 'ext', url: 'https://ok.example/x'})).toContain('停用');
        mocks.config.comment.enabled = true;
        expect(eligibility({id: 'ext', url: 'https://blocked.example/x'})).toContain('禁用');
        mocks.config.on = false;
        expect(eligibility({id: 'ext', url: 'https://ok.example/x'})).toContain('停用');
        mocks.config.on = true;
        expect(eligibility({id: 'ext', tab: {id: 4}})).toBeUndefined();
    });

    it('cancels on comment preference changes and re-checks eligibility on unrelated updates', () => {
        installCommentBackgroundRuntime();
        const subscribe = mocks.subscribe.mock.calls[0][0];
        subscribe({on: true, disabledExtensionDomains: [], customOpenAIProviders: [], comment: {enabled: true, service: '', model: '', count: 2, prompt: ''}});
        expect(mocks.handler.cancelAll).not.toHaveBeenCalled();
        expect(mocks.handler.cancelDisallowed).toHaveBeenCalledOnce();
        subscribe({on: true, disabledExtensionDomains: [], customOpenAIProviders: [], comment: {enabled: true, service: 'deepseek', model: '', count: 2, prompt: ''}});
        expect(mocks.handler.cancelAll).toHaveBeenCalledOnce();
    });

    it('binds the injected runtime to live config', async () => {
        installCommentBackgroundRuntime();
        const getConfig = mocks.createRuntime.mock.calls[0][0];
        expect(getConfig()).toBe(mocks.config);
        const run = mocks.createHandler.mock.calls[0][0].run;
        mocks.runtime.run.mockResolvedValue({success: true, comments: []});
        const signal = new AbortController().signal;
        expect(await run({requestId: 'r', text: 't', images: []} as never, signal)).toEqual({success: true, comments: []});
        expect(mocks.runtime.run).toHaveBeenCalledWith(expect.objectContaining({requestId: 'r'}), signal);
    });
    it('records comment usage through the shared model usage repository', async () => {
        installCommentBackgroundRuntime();
        const sinkFactory = mocks.createRuntime.mock.calls[0][2];
        const event = {startedAt: 1, serviceId: 'deepseek'} as never;
        sinkFactory()(event);
        expect(mocks.usageRepo.captureGeneration).toHaveBeenCalledOnce();
        expect(mocks.usageRepo.recordMany).toHaveBeenCalledWith([event], 7);
        mocks.usageRepo.recordMany.mockRejectedValueOnce(new Error('存储已满'));
        sinkFactory()(event);
        await Promise.resolve();
        expect(mocks.usageRepo.recordMany).toHaveBeenCalledTimes(2);
    });
});
