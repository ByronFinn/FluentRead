/**
 * @file tests/commentRuntimePipeline.test.ts
 * 文件职责：用真实 AI SDK 管线（非 mock generateText）锁定评论降级链的关键契约——strict 工具 schema 在 SDK 层的解析行为。
 * 主要内容：构造 OpenAI 兼容 provider 与 fetch mock，让模型在工具入参里夹带未知字段与多余顶层键，断言 ai@6 不因
 * zod .strict() 校验失败而抛错或丢失数据，而是以原始 JSON 经 toolCall.input 透传，由 normalizeModelComments 宽容归一化接管。
 * 该契约一旦在 SDK 升级中改变（例如改为抛错传播），本测试变红，提示需要引入 repairToolCall 或放宽响应侧 schema。
 * 模块边界：只测 comment runtime 与真实 SDK 的接缝，不测供应商网络（fetch 恒定成功）与提示词内容。
 */
import {describe, expect, it} from 'vitest';
import {createOpenAICompatible} from '@ai-sdk/openai-compatible';

import {createCommentRuntime} from '@/src/services/comment/runtime';
import type {Config} from '@/src/core/config/model';
import type {LanguageModel} from 'ai';

// 可信识别为 zh-Hans 的中文选区：默认目标语言下同语，成功路径不触发补译。
const CHINESE_SELECTION = '这是一个用来验证语言检测行为的中文句子。';
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

/** OpenAI chat completion 响应：工具入参夹带未知字段与多余顶层键，模拟不守约的云端模型。 */
const toolCallWithUnknownKeys = (argumentsText: string) => new Response(JSON.stringify({
    id: 'chatcmpl-1', object: 'chat.completion', created: 0, model: 'deepseek-chat',
    choices: [{index: 0, finish_reason: 'tool_calls', message: {role: 'assistant', content: '',
        tool_calls: [{id: 'call-1', type: 'function', function: {name: 'submit_comments', arguments: argumentsText}}]}}],
    usage: {prompt_tokens: 3, completion_tokens: 7, total_tokens: 10},
}), {status: 200, headers: {'content-type': 'application/json'}});

describe('comment runtime against the real AI SDK pipeline', () => {
    it('tolerates unknown tool-argument keys through the real SDK instead of throwing', async () => {
        const provider = createOpenAICompatible({name: 'pipeline-verify', baseURL: 'http://127.0.0.1:9/v1',
            fetch: async () => toolCallWithUnknownKeys(
                '{"comments":[{"content":"真实管线评论","extra":1}],"note":"多余顶层键"}')});
        const runtime = createCommentRuntime(baseConfig, () => provider('deepseek-chat') as LanguageModel);
        const response = await runtime.run({type: 'fluentReadComment', action: 'run', requestId: 'p1',
            text: CHINESE_SELECTION, images: []}, new AbortController().signal);
        // ai@6 对 schema 校验失败的工具调用不抛错：input 以原始 JSON 透传，宽容归一化忽略未知键后成功返回。
        expect(response).toEqual({success: true, sourceTranslation: null,
            comments: [{content: '真实管线评论', translation: null}]});
    });
});
