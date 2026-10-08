/**
 * @file tests/harnessModelGateway.test.ts
 * 文件职责：验证 Harness 模型网关的服务边界、端点、凭据、取消、工具调用请求协议与宿主开关分流。
 * 主要内容：使用真实 AI SDK provider 加 mock fetch 检查 OpenAI-compatible payload；宿主开关用
 * 可变能力桩（vi.hoisted）与 offscreenModelClient 工厂桩覆盖 resolveHarnessModelCallHost 全分支、
 * offscreen 分支的共享 ports 代理与 background/能力缺失分支的直连回归。
 * 模块边界：测试不访问真实网络，不覆盖 UI、会话、Config 持久化或背景路由；能力桩默认
 * offscreenDocument=false，与 node 环境实测的 browserCapabilities 一致，既有直连断言语义不变。
 */
import {afterEach, describe, expect, it, vi} from 'vitest';
import {generateText, streamText, tool, type LanguageModel} from 'ai';
import {z} from 'zod';
import {reactive} from 'vue';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {currentModelIds, services} from '@/src/core/config/catalog';
import {createHarnessLanguageModel, normalizeHarnessModelError, resolveHarnessModelCallHost, sanitizeHarnessModelMessage} from '@/src/services/harness/modelGateway';
import type {OffscreenModelClientPorts} from '@/src/services/harness/offscreenModelClient';
import {setRuntimeFetch} from '@/src/platform/http/runtime';

// 宿主开关专属桩：能力默认与 node 实测一致（无浏览器 → offscreenDocument=false → 强制直连），
// 仅在 offscreen 分支用例内切换为 true，throwOnRead 模拟 browserCapabilities 读取抛错；代理工厂
// 用 vi.fn 桩替换，断言网关分流与 ports 装配而不触发消息通道。
const hostCapabilities = vi.hoisted(() => ({offscreenDocument: false, throwOnRead: false}));
const offscreenModelClientMock = vi.hoisted(() => ({factory: vi.fn(), ports: [] as unknown[]}));
vi.mock('@/src/platform/browser/capabilities', () => ({
  get browserCapabilities(): {offscreenDocument?: boolean} {
    if (hostCapabilities.throwOnRead) throw new Error('capability read failure');
    return hostCapabilities;
  },
}));
vi.mock('@/src/services/harness/offscreenModelClient', () => ({
  // 捕获网关注入的 ports（跨 mockReset 保留，网关侧工厂带模块级 memo），再交给可重置的
  // 工厂桩断言分流次数。
  createOffscreenHarnessLanguageModel: (ports: unknown) => {
    offscreenModelClientMock.ports.push(ports);
    return offscreenModelClientMock.factory(ports);
  },
}));

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {status: 200, headers: {'content-type': 'application/json'}});
}

describe('harness model gateway', () => {
  afterEach(() => {
    setRuntimeFetch();
  });

  it('keeps custom endpoint query, model, messages and tools', async () => {
    const config = new Config();
    config.customOpenAIProviders = [{id: 'custom:test', name: 'Test', endpoint: 'https://local.test/v1/chat/completions?tenant=a&tenant=b', models: ['my-model']}];
    config.token['custom:test'] = 'secret-key';
    config.customHeaders['custom:test'] = '{"x-opencode-session":"stable-harness-session"}';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(String(input)).toContain('tenant=a');
      expect(body.model).toBe('my-model');
      expect(new Headers(init?.headers).get('x-opencode-session')).toBe('stable-harness-session');
      expect(body.tools?.[0]?.function?.name).toBe('lookup');
      expect(body.messages).toEqual([{role: 'user', content: 'Explain this sentence'}]);
      expect((init?.headers as Record<string, string>).authorization).toContain('secret-key');
      return response({choices: [{message: {role: 'assistant', content: 'done'}, finish_reason: 'stop'}]});
    });
    setRuntimeFetch(fetchMock);
    const model = createHarnessLanguageModel(config, 'custom:test', 'my-model');
    await generateText({model, messages: [{role: 'user', content: 'Explain this sentence'}], tools: {lookup: tool({description: 'lookup', inputSchema: z.object({q: z.string()})})}});
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects machine services and DeepSeek Responses mode', () => {
    const config = new Config();
    expect(() => createHarnessLanguageModel(config, services.google, 'x')).toThrow('尚未适配');
    expect(() => createHarnessLanguageModel(config, 'unknown-service', 'x')).toThrow('尚未适配');
    expect(() => createHarnessLanguageModel(config, services.openai, '   ')).toThrow('选择一个模型');
    config.deepseekApiType = 'responses';
    expect(() => createHarnessLanguageModel(config, services.deepseek, 'deepseek-chat')).toThrow('Responses');
    expect(() => createHarnessLanguageModel({...config, token: {...config.token, [services.zhipu]: 'invalid'}} as Config, services.zhipu, 'glm-test')).toThrow('id.secret');
  });

  it('adds DeepSeek thinking without replacing session messages', async () => {
    const config = new Config();
    config.modelThinking = {[services.deepseek]: {'deepseek-chat': true}};
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.thinking).toEqual({type: 'enabled'});
      expect(body.messages).toEqual([{role: 'system', content: 'Use Chinese'}, {role: 'user', content: 'Explain'}]);
      return response({choices: [{message: {role: 'assistant', content: 'ok'}, finish_reason: 'stop'}]});
    });
    setRuntimeFetch(fetchMock);
    const model = createHarnessLanguageModel(config, services.deepseek, 'deepseek-chat');
    await generateText({model, system: 'Use Chinese', prompt: 'Explain'});
  });

  it('supports explicit compatible endpoint overrides and disabled thinking', async () => {
    const config = new Config();
    config.proxy[services.deepseek] = 'https://deepseek.test/v1/chat/completions?region=cn';
    config.proxy[services.tongyi] = 'https://qwen.test/v1/chat/completions?region=cn';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (String(input).includes('deepseek.test')) expect(body.thinking).toEqual({type: 'disabled'});
      expect(String(input)).toMatch(/(?:deepseek|qwen)\.test/u);
      return response({choices: [{message: {role: 'assistant', content: 'ok'}, finish_reason: 'stop'}]});
    });
    setRuntimeFetch(fetchMock);
    await generateText({model: createHarnessLanguageModel(config, services.deepseek, 'deepseek-chat'), prompt: 'hello'});
    await generateText({model: createHarnessLanguageModel(config, services.tongyi, currentModelIds.tongyiTokenPlan), prompt: 'hello'});
  });

  it('builds a Zhipu bearer token and preserves a configured endpoint query', async () => {
    const config = new Config();
    config.proxy[services.zhipu] = 'https://zhipu.test/api/chat/completions?tenant=reader';
    config.token[services.zhipu] = 'public-id.private-secret';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain('tenant=reader');
      const authorization = new Headers(init?.headers).get('authorization') || '';
      expect(authorization.startsWith('Bearer ey')).toBe(true);
      expect(authorization).not.toContain('private-secret');
      return response({choices: [{message: {role: 'assistant', content: 'ok'}, finish_reason: 'stop'}]});
    });
    setRuntimeFetch(fetchMock);
    await generateText({model: createHarnessLanguageModel(config, services.zhipu, 'glm-test'), prompt: 'Explain'});
  });

  it('adds service specific headers for Azure and OpenRouter', async () => {
    const azure = new Config();
    azure.token[services.azureOpenai] = 'azure-secret';
    azure.azureOpenaiEndpoint = 'https://azure.test/openai/deployments/reader/chat/completions?api-version=2024-02-15-preview';
    const azureFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(azure.azureOpenaiEndpoint);
      expect(new Headers(init?.headers).get('api-key')).toBe('azure-secret');
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      expect(JSON.parse(String(init?.body)).model).toBe('reader');
      return response({choices: [{message: {role: 'assistant', content: 'ok'}, finish_reason: 'stop'}]});
    });
    setRuntimeFetch(azureFetch);
    await generateText({model: createHarnessLanguageModel(azure, services.azureOpenai, 'reader'), prompt: 'hello'});

    const router = new Config();
    router.token[services.openrouter] = 'router-secret';
    const routerFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('HTTP-Referer')).toBe('https://fluent.thinkstu.com');
      expect(new Headers(init?.headers).get('X-Title')).toBe('FluentRead Harness');
      return response({choices: [{message: {role: 'assistant', content: 'ok'}, finish_reason: 'stop'}]});
    });
    setRuntimeFetch(routerFetch);
    await generateText({model: createHarnessLanguageModel(router, services.openrouter, 'openrouter/test'), prompt: 'hello'});
  });

  it('normalizes the Azure Foundry resource endpoint for v1 without a dated API version', async () => {
    const config = new Config();
    config.token[services.azureOpenai] = 'azure-secret';
    config.azureOpenaiEndpoint = 'https://reader.services.ai.azure.com';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://reader.services.ai.azure.com/openai/v1/chat/completions');
      expect(new Headers(init?.headers).get('api-key')).toBe('azure-secret');
      expect(JSON.parse(String(init?.body)).model).toBe('deepseek-deployment');
      return response({choices: [{message: {role: 'assistant', content: 'ok'}, finish_reason: 'stop'}]});
    });
    setRuntimeFetch(fetchMock);
    await generateText({model: createHarnessLanguageModel(config, services.azureOpenai, 'deepseek-deployment'), prompt: 'hello'});
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('uses native Claude Messages API and honors configured proxy', async () => {
    const config = new Config();
    config.token[services.claude] = 'claude-secret';
    config.proxy[services.claude] = 'https://claude-proxy.test/v1/messages';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://claude-proxy.test/v1/messages');
      expect(new Headers(init?.headers).get('x-api-key')).toBe('claude-secret');
      expect(new Headers(init?.headers).get('anthropic-dangerous-direct-browser-access')).toBe('true');
      return response({id: 'msg_1', type: 'message', role: 'assistant', content: [{type: 'text', text: 'claude answer'}], stop_reason: 'end_turn', usage: {input_tokens: 2, output_tokens: 3}});
    });
    setRuntimeFetch(fetchMock);
    const result = await generateText({model: createHarnessLanguageModel(config, services.claude, 'claude-sonnet-5'), prompt: 'Explain'});
    expect(result.text).toBe('claude answer');
    const directFetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('api.anthropic.com');
      return response({id: 'msg_2', type: 'message', role: 'assistant', content: [{type: 'text', text: 'direct'}], stop_reason: 'end_turn', usage: {input_tokens: 1, output_tokens: 1}});
    });
    setRuntimeFetch(directFetch);
    const directConfig = new Config();
    directConfig.token[services.claude] = 'direct-secret';
    expect((await generateText({model: createHarnessLanguageModel(directConfig, services.claude, 'claude-test'), prompt: 'Explain'})).text).toBe('direct');
    expect(createHarnessLanguageModel(new Config(), services.claude, 'claude-no-key')).toBeTruthy();
  });

  it('uses native Gemini generateContent API and honors configured proxy', async () => {
    const config = new Config();
    config.token[services.gemini] = 'gemini-secret';
    config.proxy[services.gemini] = 'https://gemini-proxy.test/v1beta/models/gemini-test:generateContent';
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('https://gemini-proxy.test/v1beta/models/gemini-test:generateContent');
      return response({candidates: [{content: {role: 'model', parts: [{text: 'gemini answer'}]}, finishReason: 'STOP'}], usageMetadata: {promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5}});
    });
    setRuntimeFetch(fetchMock);
    const result = await generateText({model: createHarnessLanguageModel(config, services.gemini, 'gemini-test'), prompt: 'Explain'});
    expect(result.text).toBe('gemini answer');
    expect(createHarnessLanguageModel(new Config(), services.gemini, 'gemini-test')).toBeTruthy();
  });

  it('uses the Token Plan endpoint for the matching Qwen model', async () => {
    const config = new Config();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('token-plan.cn-beijing.maas.aliyuncs.com');
      return response({choices: [{message: {role: 'assistant', content: 'ok'}, finish_reason: 'stop'}]});
    });
    setRuntimeFetch(fetchMock);
    await generateText({model: createHarnessLanguageModel(config, services.tongyi, currentModelIds.tongyiTokenPlan), prompt: 'hello'});
    expect(createHarnessLanguageModel(config, services.tongyi, 'qwen-normal')).toBeTruthy();
  });

  it('normalizes provider details without leaking credential query values', () => {
    const error = new Error('request failed https://api.test/chat?api_key=secret-value&tenant=reader');
    const normalized = normalizeHarnessModelError(error, services.openai, 'secret-value');
    expect(normalized.message).not.toContain('secret-value');
    expect(normalized.message).toContain('api_key=[已隐藏]');
    expect(sanitizeHarnessModelMessage('https://x.test/?token=raw&ok=1')).toBe('https://x.test/?token=[已隐藏]&ok=1');
  });

  it('propagates cancellation through runtime fetch', async () => {
    const config = new Config();
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      throw new DOMException('Aborted', 'AbortError');
    });
    setRuntimeFetch(fetchMock);
    const model = createHarnessLanguageModel(config, services.openai, 'gpt-test');
    await expect(generateText({model, prompt: 'hello', abortSignal: controller.signal})).rejects.toThrow();
  });
});

describe('harness model gateway multi-key rotation', () => {
  afterEach(() => setRuntimeFetch());

  function multiKeyConfig(id: string): Config {
    const config = new Config();
    config.customOpenAIProviders = [{id, name: 'Rotation fixture', endpoint: 'https://rotation.fixture/v1/chat/completions', models: ['fixture']}];
    config.apiKeys[id] = ['fixture-A', 'fixture-B', 'fixture-C'];
    config.token[id] = 'fixture-A';
    return config;
  }

  it('keeps native model metadata and freezes reactive settings during failover', async () => {
    const config = reactive(new Config());
    config.apiKeys[services.gemini] = ['native-A', 'native-B'];
    config.token[services.gemini] = 'native-A';
    config.proxy[services.gemini] = 'https://native.fixture/generate';
    const model = createHarnessLanguageModel(config, services.gemini, 'gemini-fixture');
    expect(typeof model).toBe('object');
    if (typeof model === 'string') throw new Error('Expected native model');
    expect(model.modelId).toBe('gemini-fixture');
    expect(model.provider).toContain('gemini');
    expect(model.supportedUrls).toHaveProperty('*');
    config.proxy[services.gemini] = 'https://changed.fixture/generate';
    config.apiKeys[services.gemini] = ['changed-key'];
    const seen: string[] = [];
    setRuntimeFetch(async (input, init) => {
      expect(String(input)).toBe('https://native.fixture/generate');
      const key = new Headers(init?.headers).get('x-goog-api-key')!;
      seen.push(key);
      if (key === 'native-A') return new Response(JSON.stringify({error: {message: 'API key not valid'}}), {status: 401});
      return response({candidates: [{content: {role: 'model', parts: [{text: 'native answer'}]}, finishReason: 'STOP'}]});
    });
    expect((await generateText({model, prompt: 'hello'})).text).toBe('native answer');
    expect(seen).toEqual(['native-A', 'native-B']);
  });

  it('tries A then B on auth failure and uses B/C on later requests', async () => {
    const config = multiKeyConfig('custom:rotation-generate');
    const seen: string[] = [];
    setRuntimeFetch(vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const key = new Headers(init?.headers).get('authorization')?.replace(/^Bearer\s+/u, '') || '';
      seen.push(key);
      if (key === 'fixture-A') return new Response(JSON.stringify({error: {message: 'invalid key'}}), {status: 401});
      return response({choices: [{message: {role: 'assistant', content: key}, finish_reason: 'stop'}]});
    }));
    const model = createHarnessLanguageModel(config, 'custom:rotation-generate', 'fixture');
    expect((await generateText({model, prompt: 'one'})).text).toBe('fixture-B');
    expect((await generateText({model, prompt: 'two'})).text).toMatch(/^fixture-[BC]$/u);
    expect(seen.slice(0, 3)).toEqual(['fixture-A', 'fixture-B', expect.any(String)]);
    expect(seen[2]).not.toBe('fixture-A');
  });

  it('retries a stream handshake on the next key but never replays a partial stream', async () => {
    const config = multiKeyConfig('custom:rotation-stream');
    const seen: string[] = [];
    setRuntimeFetch(vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const key = new Headers(init?.headers).get('authorization')?.replace(/^Bearer\s+/u, '') || '';
      seen.push(key);
      if (key === 'fixture-A') return new Response(JSON.stringify({error: {message: 'rate limited'}}), {status: 429});
      const body = [
        `data: ${JSON.stringify({id: 'stream', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{index: 0, delta: {role: 'assistant', content: key}, finish_reason: null}]})}`,
        '',
        `data: ${JSON.stringify({id: 'stream', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{index: 0, delta: {}, finish_reason: 'stop'}]})}`,
        '', 'data: [DONE]', '', '',
      ].join('\n');
      return new Response(body, {status: 200, headers: {'content-type': 'text/event-stream'}});
    }));
    const result = streamText({model: createHarnessLanguageModel(config, 'custom:rotation-stream', 'fixture'), prompt: 'stream'});
    expect(await result.text).toBe('fixture-B');
    expect(seen).toEqual(['fixture-A', 'fixture-B']);

    const partialConfig = multiKeyConfig('custom:rotation-partial');
    let calls = 0;
    let transport: ReadableStreamDefaultController<Uint8Array>;
    setRuntimeFetch(vi.fn(async () => {
      calls += 1;
      const stream = new ReadableStream<Uint8Array>({start(controller) {
        transport = controller;
        controller.enqueue(new TextEncoder().encode('data: {"id":"partial","choices":[{"index":0,"delta":{"role":"assistant","content":"once"},"finish_reason":null}]}\n\n'));
      }});
      return new Response(stream, {status: 200, headers: {'content-type': 'text/event-stream'}});
    }));
    const partial = streamText({model: createHarnessLanguageModel(partialConfig, 'custom:rotation-partial', 'fixture'), prompt: 'partial'});
    const chunks = partial.textStream[Symbol.asyncIterator]();
    expect(await chunks.next()).toEqual({value: 'once', done: false});
    transport!.error(new Error('partial stream failure'));
    await expect(chunks.next()).rejects.toThrow('partial stream failure');
    expect(calls).toBe(1);
  });
});


it('网关拒绝非法头并遮罩错误回显，头配置快照不随后续编辑改变', async () => {
    const config = new Config();
    config.customOpenAIProviders = [{id: 'custom:headers', name: 'Headers', endpoint: 'https://fixture.example/v1/chat/completions', models: ['model']}];
    config.customHeaders['custom:headers'] = '{"x":1}';
    expect(() => createHarnessLanguageModel(config, 'custom:headers', 'model')).toThrow('自定义请求头');
    expect(normalizeHarnessModelError(new Error('failure'), 'custom:headers', '', '{oops').message).toContain('failure');
    config.customHeaders['custom:headers'] = '{"x-auth":"private-header"}';
    expect(normalizeHarnessModelError(new Error('private-header rejected'), 'custom:headers', '', config.customHeaders['custom:headers']).message).not.toContain('private-header');
    const model = createHarnessLanguageModel(config, 'custom:headers', 'model');
    config.customHeaders['custom:headers'] = '{"x-auth":"changed"}';
    setRuntimeFetch(async (_input, init) => {
        expect(new Headers(init?.headers).get('x-auth')).toBe('private-header');
        return response({choices: [{message: {role: 'assistant', content: 'done'}, finish_reason: 'stop'}]});
    });
    try { await generateText({model, prompt: 'fixture'}); } finally { setRuntimeFetch(); }
});

describe('harness model call host switch', () => {
  afterEach(() => {
    setRuntimeFetch();
    hostCapabilities.offscreenDocument = false;
    hostCapabilities.throwOnRead = false;
    offscreenModelClientMock.factory.mockReset();
    vi.unstubAllGlobals();
  });

  it('harnessCallHost 默认离屏、显式 background 保留、非法值回落离屏', () => {
    expect(new Config().harnessCallHost).toBe('offscreen');
    expect(normalizeConfig({harnessCallHost: 'background'}).harnessCallHost).toBe('background');
    expect(normalizeConfig({harnessCallHost: 'unknown-host'}).harnessCallHost).toBe('offscreen');
    // 旧配置无此键无需迁移，直接落到离屏默认值。
    expect(normalizeConfig({}).harnessCallHost).toBe('offscreen');
  });

  it('resolveHarnessModelCallHost 覆盖显式回滚、能力齐备走离屏、能力缺失强制直连', () => {
    const offscreenConfig = new Config();
    const backgroundConfig = new Config();
    backgroundConfig.harnessCallHost = 'background';
    expect(resolveHarnessModelCallHost(backgroundConfig, {offscreenDocument: true})).toBe('background');
    expect(resolveHarnessModelCallHost(offscreenConfig, {offscreenDocument: true})).toBe('offscreen');
    expect(resolveHarnessModelCallHost(offscreenConfig, {offscreenDocument: false})).toBe('background');
    // 字段缺失（node 测试、未知环境）与显式 false 一样兜底直连。
    expect(resolveHarnessModelCallHost(offscreenConfig, {})).toBe('background');
  });

  it('能力齐备时统一入口经共享 ports 返回代理模型', () => {
    hostCapabilities.offscreenDocument = true;
    const proxyModel = {proxy: true} as unknown as LanguageModel;
    const proxied: Array<[string, string]> = [];
    offscreenModelClientMock.factory.mockImplementation(() => (_config: unknown, service: string, model: string) => {
      proxied.push([service, model]);
      return proxyModel;
    });
    const config = new Config();
    expect(createHarnessLanguageModel(config, services.openai, 'gpt-test')).toBe(proxyModel);
    expect(createHarnessLanguageModel(config, services.claude, 'claude-test')).toBe(proxyModel);
    expect(proxied).toEqual([[services.openai, 'gpt-test'], [services.claude, 'claude-test']]);
    // 共享 ports 只装配一次：同一进程内全部模型复用唯一的代理工厂与事件订阅。
    expect(offscreenModelClientMock.factory).toHaveBeenCalledTimes(1);
    const ports = offscreenModelClientMock.ports[0] as OffscreenModelClientPorts;
    expect(ports).toBeTruthy();
    expect(typeof ports.subscribe).toBe('function');
    // getClient 惰性解引用 extensionDomClient，node 下不触碰 chrome 也能返回客户端。
    expect(ports.getClient()).toBeTruthy();
    expect(ports.now()).toBeGreaterThanOrEqual(0);
  });

  it('回滚显式 background 或能力缺失时统一入口仍走直连 provider', async () => {
    const fetchMock = vi.fn(async () => response({choices: [{message: {role: 'assistant', content: 'ok'}, finish_reason: 'stop'}]}));
    setRuntimeFetch(fetchMock);
    // node 能力缺失：默认 offscreen 配置也被强制直连（既有调用方在测试环境的语义）。
    await generateText({model: createHarnessLanguageModel(new Config(), services.openai, 'gpt-test'), prompt: 'hello'});
    // 能力齐备但显式回滚：尊重 background 直连。
    hostCapabilities.offscreenDocument = true;
    const rollback = new Config();
    rollback.harnessCallHost = 'background';
    await generateText({model: createHarnessLanguageModel(rollback, services.openai, 'gpt-test'), prompt: 'hello'});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(offscreenModelClientMock.factory).not.toHaveBeenCalled();
  });

  it('ports 订阅包装 runtime.onMessage，listener 恒返回 undefined 不占响应通道', () => {
    hostCapabilities.offscreenDocument = true;
    offscreenModelClientMock.factory.mockImplementation(() => () => ({proxy: true} as unknown as LanguageModel));
    createHarnessLanguageModel(new Config(), services.openai, 'gpt-test');
    // 网关侧工厂带模块级 memo：无论本用例是否首次触发装配，ports[0] 都是共享端口实例。
    const ports = offscreenModelClientMock.ports[0] as OffscreenModelClientPorts;
    expect(ports).toBeTruthy();
    const registered: Array<(message: unknown) => unknown> = [];
    const removeListener = vi.fn();
    vi.stubGlobal('chrome', {runtime: {onMessage: {
      addListener: (listener: (message: unknown) => unknown) => {registered.push(listener);},
      removeListener,
    }}});
    const seen: unknown[] = [];
    const unsubscribe = ports.subscribe(message => {seen.push(message);});
    expect(registered).toHaveLength(1);
    // P2 订阅契约：包装层把消息原样转交 listener，返回值恒为 undefined。
    expect(registered[0]!({type: 'unrelated'})).toBeUndefined();
    expect(seen).toEqual([{type: 'unrelated'}]);
    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith(registered[0]);
  });

  it('browserCapabilities 读取抛错时视为无能力并兜底直连', async () => {
    hostCapabilities.throwOnRead = true;
    setRuntimeFetch(async () => response({choices: [{message: {role: 'assistant', content: 'ok'}, finish_reason: 'stop'}]}));
    await generateText({model: createHarnessLanguageModel(new Config(), services.openai, 'gpt-test'), prompt: 'hello'});
    expect(offscreenModelClientMock.factory).not.toHaveBeenCalled();
  });
});
