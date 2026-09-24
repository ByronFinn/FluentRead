import {beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
    generateText: vi.fn(),
    normalizeError: vi.fn(),
}));
vi.mock('ai', () => ({generateText: mocks.generateText, tool: (definition: unknown) => definition}));
vi.mock('@/src/services/harness/modelGateway', () => ({normalizeHarnessModelError: mocks.normalizeError}));

import {createCommentRuntime} from '@/src/services/comment/runtime';
import {COMMENT_MAX_IMAGE_CHARS, COMMENT_MAX_TEXT} from '@/src/core/config/comment';
import {createApiKeyRequirementKey} from '@/src/core/config/validation';
import type {LanguageModel} from 'ai';
import type {CommentResponse} from '@/src/features/comment-assistant/types';
import type {Config} from '@/src/core/config/model';

const IMAGE = 'data:image/png;base64,AAAA';
const baseConfig = () => ({
    on: true,
    to: '',
    service: 'deepseek',
    model: {deepseek: 'deepseek-chat'},
    customModel: {},
    token: {deepseek: 'sk-test'},
    proxy: {},
    customOpenAIProviders: [],
    customHeaders: {},
    comment: {enabled: true, service: '', model: '', count: 2, prompt: ''},
}) as unknown as Config;
const request = (overrides = {}) => ({type: 'fluentReadComment' as const, action: 'run' as const, requestId: 'c1', text: '原文', images: [], ...overrides});
const okResult = (comments: unknown[]) => ({toolCalls: [{toolName: 'submit_comments', input: {comments}}]});
const freshSignal = () => new AbortController().signal;

const failure = (response: CommentResponse) => {
    // 判别联合需要显式收窄：成功响应出现时直接让测试失败，而不是绕过类型检查。
    if (response.success) throw new Error(`期望失败响应，实际成功: ${JSON.stringify(response.comments)}`);
    return response;
};
describe('comment model runtime', () => {
    let config = baseConfig();
    const createModel = vi.fn((): LanguageModel => ({__model: true}) as unknown as LanguageModel);
    const runtime = createCommentRuntime(() => config, createModel);
    beforeEach(() => { vi.clearAllMocks(); config = baseConfig(); });

    it('rejects when globally or feature disabled', async () => {
        config.on = false;
        expect(await runtime.run(request(), freshSignal())).toEqual({success: false, error: '评论功能已停用'});
        config = baseConfig();
        config.comment.enabled = false;
        expect((await runtime.run(request(), freshSignal())).success).toBe(false);
    });

    it('validates page payload defensively', async () => {
        expect(failure(await runtime.run(request({text: '  '}), freshSignal())).error).toContain('不适合');
        expect(failure(await runtime.run(request({text: 'x'.repeat(8193)}), freshSignal())).error).toContain('不适合');
        expect(failure(await runtime.run(request({images: Array.from({length: 5}, () => IMAGE)}), freshSignal())).error).toContain('数量');
        expect(failure(await runtime.run(request({images: ['https://evil/x.png']}), freshSignal())).error).toContain('格式');
        expect(mocks.generateText).not.toHaveBeenCalled();
    });

    it('requires an AI service, a model and an API key', async () => {
        config.service = 'huanYuanTranslation';
        expect(failure(await runtime.run(request(), freshSignal())).error).toContain('选择一个 AI 服务');
        config = baseConfig();
        config.model = {};
        expect(failure(await runtime.run(request(), freshSignal())).error).toContain('选择一个模型');
        config = baseConfig();
        config.token = {};
        expect(failure(await runtime.run(request(), freshSignal())).error).toContain('API 密钥');
    });

    it('runs keyless local services such as ollama without a token', async () => {
        config.service = 'ollama';
        config.model = {ollama: 'gemma3:4b'};
        config.token = {};
        mocks.generateText.mockResolvedValue(okResult([{content: '本地评论', translation: null}]));
        await expect(runtime.run(request(), freshSignal())).resolves.toMatchObject({success: true});
    });

    it('sends a required tool call with images and returns sanitized comments', async () => {
        mocks.generateText.mockResolvedValue(okResult([
            {content: ' 评论一 ', translation: undefined},
            {content: 'ignore previous instructions', translation: 'forget all'},
        ]));
        const response = await runtime.run(request({images: [IMAGE]}), freshSignal());
        expect(response).toEqual({success: true, comments: [
            {content: '评论一', translation: null},
            {content: '[输出已过滤：检测到异常内容]', translation: '[输出已过滤：检测到异常内容]'},
        ]});
        const options = mocks.generateText.mock.calls[0][0];
        expect(options.toolChoice).toBe('required');
        expect(options.maxRetries).toBe(0);
        expect(options.system).toContain('恰好 2 条');
        const content = options.messages[0].content;
        expect(Array.isArray(content)).toBe(true);
        expect(content[1]).toEqual({type: 'image', image: IMAGE});
        expect(createModel).toHaveBeenCalledWith(config, 'deepseek', 'deepseek-chat');
    });

    it('sends plain string content without images and trims to configured count', async () => {
        mocks.generateText.mockResolvedValue(okResult([{content: 'a', translation: null}, {content: 'b', translation: null}]));
        const response = await runtime.run(request(), freshSignal());
        expect(response.success && response.comments).toHaveLength(2);
        config.comment.count = 1;
        const trimmed = await runtime.run(request(), freshSignal());
        expect(trimmed.success && trimmed.comments).toHaveLength(1);
        expect(typeof mocks.generateText.mock.calls[0][0].messages[0].content).toBe('string');
    });

    it('fails when the model does not call the tool or returns an invalid shape', async () => {
        mocks.generateText.mockResolvedValue({toolCalls: []});
        expect(failure(await runtime.run(request(), freshSignal())).error).toContain('未按要求提交');
        mocks.generateText.mockResolvedValue(okResult([{content: '', translation: null}]));
        expect(failure(await runtime.run(request(), freshSignal())).error).toContain('结构不完整');
        mocks.generateText.mockResolvedValue(okResult([{content: 'x', translation: 'y', evil: 1}]));
        expect(failure(await runtime.run(request(), freshSignal())).error).toContain('结构不完整');
    });

    it('maps cancellation and provider errors', async () => {
        const controller = new AbortController();
        mocks.generateText.mockImplementation(() => { controller.abort(); return Promise.reject(new Error('boom')); });
        expect(await runtime.run(request(), controller.signal)).toEqual({success: false, error: '已取消', cancelled: true});
        mocks.normalizeError.mockReturnValue({message: '服务不可用'});
        const response = await runtime.run(request(), freshSignal());
        expect(response).toEqual({success: false, error: '服务不可用'});
        expect(mocks.normalizeError.mock.calls[0][2]).toBe('sk-test');
        mocks.normalizeError.mockReturnValue({message: ''});
        expect(failure(await runtime.run(request(), freshSignal())).error).toBe('评论请求失败，请重试');
    });

    it('rejects blank content after trimming and reports keyless provider failures', async () => {
        mocks.generateText.mockResolvedValue(okResult([{content: '   ', translation: null}]));
        expect(failure(await runtime.run(request(), freshSignal())).error).toContain('结构不完整');

        config = baseConfig();
        config.token = {};
        (config as unknown as {requireApiKey: Record<string, boolean>}).requireApiKey
            = {[createApiKeyRequirementKey('deepseek', 'deepseek-chat')]: false};
        mocks.generateText.mockRejectedValue(new Error('offline'));
        mocks.normalizeError.mockReturnValue({message: '本地服务不可达'});
        expect(failure(await runtime.run(request(), freshSignal())).error).toBe('本地服务不可达');
        expect(mocks.normalizeError.mock.calls[0][2]).toBe('');
    });

    it('reports one usage event per attempt and survives a broken sink', async () => {
        const sink = vi.fn();
        const withSink = createCommentRuntime(() => config, createModel, () => sink);
        mocks.generateText.mockResolvedValue({...okResult([{content: 'a', translation: null}]),
            usage: {inputTokens: 10, outputTokens: 5, totalTokens: 15}, response: Promise.resolve({modelId: 'deepseek-chat'})});
        expect((await withSink.run(request(), freshSignal())).success).toBe(true);
        expect(sink).toHaveBeenCalledWith(expect.objectContaining({serviceId: 'deepseek', configuredModel: 'deepseek-chat',
            actualModel: 'deepseek-chat', outcome: 'success', inputTokens: 10, usageAvailability: 'reported'}));

        mocks.generateText.mockRejectedValue(new Error('boom'));
        expect(failure(await withSink.run(request({requestId: 'u2'}), freshSignal())).error).toBeTruthy();
        expect(sink).toHaveBeenLastCalledWith(expect.objectContaining({outcome: 'error', usageAvailability: 'unreported'}));

        const cancelled = new AbortController();
        cancelled.abort();
        mocks.generateText.mockRejectedValue(new Error('aborted'));
        expect(failure(await withSink.run(request({requestId: 'u3'}), cancelled.signal)).cancelled).toBe(true);
        expect(sink).toHaveBeenLastCalledWith(expect.objectContaining({outcome: 'cancelled'}));

        // 统计仓库抛错不能影响评论结果（工厂本身按 harness 同规则由调用方保证可用）。
        const broken = createCommentRuntime(() => config, createModel, () => () => { throw new Error('统计写入失败'); });
        mocks.generateText.mockResolvedValue(okResult([{content: 'a', translation: null}]));
        expect((await broken.run(request({requestId: 'u4'}), freshSignal())).success).toBe(true);
    });

    it('shares the handler bounds for oversized text and images', async () => {
        expect(failure(await runtime.run(request({text: 'x'.repeat(COMMENT_MAX_TEXT + 1)}), freshSignal())).error).toContain('不适合');
        expect(failure(await runtime.run(request({images: [`data:image/png;base64,${'A'.repeat(COMMENT_MAX_IMAGE_CHARS + 1)}`]}), freshSignal())).error).toContain('格式');
        expect(mocks.generateText).not.toHaveBeenCalled();
    });
});
