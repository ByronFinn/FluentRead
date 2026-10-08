/**
 * @file tests/offscreenModelCallPipeline.test.ts
 * 文件职责：用真实 AI SDK 管线锁定离屏代理消息边界的时间戳契约——doGenerate 结果在
 * 通道被 JSON 化（Date 退化为 ISO 字符串）回传后，代理必须在落地时把 response.timestamp
 * 还原为 Date，真实 generateText 的遥测属性构造（timestamp.toISOString()，属性对象在遥测
 * 开关判定前急切求值，未配置遥测也执行）不得崩溃。
 * 主要内容：构造真实 OpenAI 兼容 provider 与恒定成功的 fetch mock 充当「离屏侧」，ports 的
 * getClient/subscribe 模拟后台↔离屏往返并对结果事件强制 JSON.parse(JSON.stringify())，
 * 断言真实 generateText 经代理模型正常返回文本；restoreModelCallTimestamps 一旦失效，
 * 本测试即以「timestamp.toISOString is not a function」变红。
 * 模块边界：只测代理与真实 SDK 的接缝；不测浏览器消息通道（序列化行为由测试内显式注入）
 * 与真实网络（fetch 恒定成功），也不测执行器受理/心跳（offscreenModelClient 单测已覆盖）。
 */
import {describe, expect, it} from 'vitest';
import {generateText} from 'ai';
import {createOpenAICompatible} from '@ai-sdk/openai-compatible';
import type {Config} from '@/src/core/config/model';
import type {OffscreenClient} from '@/src/platform/offscreen/client';
import {createOffscreenHarnessLanguageModel} from '@/src/services/harness/offscreenModelClient';
import {MODEL_CALL_EVENT_MESSAGE_TYPE} from '@/src/services/harness/modelCallProtocol';

/** OpenAI chat completion 响应：created 字段经 provider 转成 result.response.timestamp 的 Date。 */
const chatCompletion = () => new Response(JSON.stringify({
    id: 'chatcmpl-guard', object: 'chat.completion', created: 0, model: 'guard-model',
    choices: [{index: 0, finish_reason: 'stop', message: {role: 'assistant', content: '边界守卫通过'}}],
    usage: {prompt_tokens: 3, completion_tokens: 5, total_tokens: 8},
}), {status: 200, headers: {'content-type': 'application/json'}});

describe('offscreen model proxy against the real AI SDK pipeline', () => {
    it('survives a JSON-serializing channel by restoring response timestamps on landing', async () => {
        // 离屏侧：真实 provider + 恒定成功的 fetch。
        const provider = createOpenAICompatible({
            name: 'pipeline-guard',
            baseURL: 'http://127.0.0.1:9/v1',
            fetch: async () => chatCompletion(),
        });
        const offscreenModel = provider('guard-model');

        let dispatchEvent: ((message: unknown) => void) | undefined;
        const proxyModel = createOffscreenHarnessLanguageModel({
            getClient: () => ({
                // 受理即回执；随后模拟离屏执行并把结果事件经 JSON 化通道回推。
                send: (message: unknown) => {
                    const start = message as {requestId: string; options: Record<string, unknown>};
                    void (async () => {
                        const result = await offscreenModel.doGenerate(start.options as never);
                        dispatchEvent?.({
                            type: MODEL_CALL_EVENT_MESSAGE_TYPE,
                            requestId: start.requestId,
                            event: JSON.parse(JSON.stringify({kind: 'result', result})),
                        });
                    })();
                    return Promise.resolve();
                },
            } as unknown as Pick<OffscreenClient, 'send'>),
            subscribe: (listener) => {
                dispatchEvent = listener;
                return () => {
                    dispatchEvent = undefined;
                };
            },
            now: () => Date.now(),
        })({} as Config, 'openai', 'guard-model');

        // 若落地时未把 timestamp 还原为 Date，SDK 遥测在此抛出
        // 「responseData.timestamp.toISOString is not a function」（未配置遥测也会急切求值）。
        const {text} = await generateText({model: proxyModel, prompt: 'hello'});
        expect(text).toBe('边界守卫通过');
    });
});
