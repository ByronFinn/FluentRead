/**
 * @file src/services/harness/modelGateway.ts
 * 服务启用：创建模型前拒绝关闭项，覆盖普通 AI、自定义服务、B站和套餐分支。
 * 文件职责：把已配置的 FluentRead AI 服务适配为 Harness 可消费的 LanguageModel。
 * 主要内容：解析 OpenAI 兼容端点、注入凭据与供应商头、保留 tools/messages/instructions
 * 语义，直连官方 MiMo 时兼容退役编号而保留配置值，单独适配固定端点与模型的 B站匿名讲解，并对未开放的 ChatGPT 套餐、DeepSeek Responses 配置和其他机器翻译服务给出明确错误；normalizeHarnessModelError
 * 额外把契约类内部 TypeError（is not a function 结尾）映射为可执行的中文提示，避免英文栈信息直出面板。
 * createHarnessLanguageModelDirect 是在当前进程内直接构建并执行 provider 的直连工厂（含多 Key 轮换 Proxy），既是
 * harnessCallHost='background' 的回滚入口，也是 Offscreen 执行宿主（src/app/offscreen/modelExecutorHost.ts）
 * 注入的构建器——绝不能在 Offscreen 内注入带切换的入口，否则会再次代理回后台形成递归；createHarnessLanguageModel
 * 是统一入口，经 resolveHarnessModelCallHost 裁决后走 offscreenModelClient 的代理工厂（默认，转发到常驻 DOM 运行时执行）
 * 或直连工厂（显式回滚 / 无 offscreen 能力的环境兜底）。
 * 模块边界：本文件只负责模型 transport 与宿主分流，不管理会话、UI、提示词、缓存或配置持久化；
 * 请求由 AI SDK 或代理协议执行，网络统一经过 runtimeFetch；浏览器全局（chrome.runtime.onMessage 订阅、
 * extensionDomClient 的 chrome 句柄）只在调用时经惰性 getter 求值，模块顶层零浏览器求值，node 测试可直接加载。
 */
import {createOpenAICompatible} from '@ai-sdk/openai-compatible';
import {createAnthropic} from '@ai-sdk/anthropic';
import {createGoogle} from '@ai-sdk/google';
import type {LanguageModel} from 'ai';
import type {Config} from '@/src/core/config/model';
import {services} from '@/src/core/config/catalog';
import {normalizeAiSdkError} from '@/src/providers/translation/ai-sdk/errors';
import {
  resolveOfficialMimoModel,
} from '@/src/providers/translation/ai-sdk/endpoints';
import {isHarnessService, type HarnessCallHost} from '@/src/core/config/harness';
import {BILIBILI_FREE_TRANSLATION_DOMAIN, BILIBILI_FREE_TRANSLATION_MODEL} from '@/src/core/config/freeTranslation';
import {runtimeFetch} from '@/src/platform/http/runtime';
import {isCustomOpenAIProviderId} from '@/src/core/config/customOpenAI';
import {parseCustomHeaders, mergeCustomHeaders} from '@/src/core/config/customHeaders';
import {getServiceApiKeys} from '@/src/core/config/apiKeys';
import {runWithApiKeyRotation, withServiceApiKey} from '@/src/services/translation/apiKeyRotation';
import {browserCapabilities} from '@/src/platform/browser/capabilities';
// 惰性引用：extensionDomClient 模块顶层只装配惰性 getter，chrome 句柄要到 send 时才访问；
// 这里仅在 getClient 回调内解引用，不在网关模块顶层求值，node 测试加载本文件安全。
import {extensionDomClient} from '@/src/platform/offscreen/extensionClient';
import {createOffscreenHarnessLanguageModel} from './offscreenModelClient';
import {createChatGPTPlanHarnessModel} from './chatgptPlanModel';
import {isTranslationServiceDisabled, TRANSLATION_SERVICE_DISABLED_MESSAGE} from '@/src/core/config/serviceAvailability';
import {getTranslationServiceUnavailableMessage} from '@/src/services/translation/capabilities';
import {endpointFor, zhipuBearer, serviceHeaders, transformBody, snapshotHarnessConfig, sanitizeHarnessModelMessage, normalizeHarnessTransportError} from './modelConfig';
export {getHarnessModelInputKey, sanitizeHarnessModelMessage} from './modelConfig';

function nativeFetch(config: Config, service: string) {
  const proxy = config.proxy[service]?.trim();
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    runtimeFetch(proxy || input, {...init, redirect: 'error'});
}

/**
 * 契约类内部 TypeError 的判别：方法调用在失真对象上崩溃（如 timestamp.toISOString is not
 * a function）时，归一后的消息会以英文栈信息直出面板。仅匹配以「is not a function」结尾的
 * TypeError——网络层 TypeError（Failed to fetch）不命中，保留既有网络分支文案。
 */
const INTERNAL_CONTRACT_TYPEERROR_PATTERN = /\bis not a function\s*$/iu;

const INTERNAL_CONTRACT_TYPEERROR_MESSAGE =
  '模型调用遇到内部数据格式错误，请重试；若持续出现，请在设置中把「模型调用执行位置」切换为后台直连。';

export function normalizeHarnessModelError(error: unknown, service: string, apiKey = '', customHeaders?: string): Error {
  const normalized = normalizeHarnessTransportError(error, service, apiKey, customHeaders, normalizeAiSdkError);
  if (error instanceof Error && error.name === 'TypeError' && INTERNAL_CONTRACT_TYPEERROR_PATTERN.test(error.message)) {
    normalized.message = INTERNAL_CONTRACT_TYPEERROR_MESSAGE;
  }
  return normalized;
}

/**
 * 创建可执行文本生成及工具调用的 LanguageModel。调用方传入的 messages、instructions、tools
 * 会原样交给 AI SDK；这里不注入翻译 prompt，也不改写会话语义。
 */
type ConcreteLanguageModel = Extract<LanguageModel, {specificationVersion: 'v4'}>;

function createSingleHarnessLanguageModel(config: Config, service: string, model: string): ConcreteLanguageModel {
  if (service === services.bilibili) {
    // 免费入口只使用已验证的官方模型；残留凭据、代理、多 Key 和自定义模型均不参与请求。
    const provider = createOpenAICompatible({
      name: 'fluentread-harness-bilibili',
      baseURL: `https://${BILIBILI_FREE_TRANSLATION_DOMAIN}/v1`,
      transformRequestBody: body => ({
        model: BILIBILI_FREE_TRANSLATION_MODEL,
        messages: body.messages,
        stream: body.stream,
        max_tokens: body.max_tokens,
        temperature: 0,
        chat_template_kwargs: {enable_thinking: false},
      }),
      fetch: (input, init) => runtimeFetch(input, {...init, credentials: 'omit', redirect: 'error'}),
    });
    return provider(BILIBILI_FREE_TRANSLATION_MODEL);
  }
  const requestedModel = model.trim();
  if (!requestedModel) throw new Error('请先为阅读助手选择一个模型');
  if (!isHarnessService(service, config.customOpenAIProviders)) throw new Error(`阅读助手尚未适配这个服务: ${service}`);

  const configuredKey = config.token[service]?.trim() || '';
  if (service === services.claude) {
    const provider = createAnthropic({
      name: 'fluentread-harness-claude',
      apiKey: configuredKey || undefined,
      headers: {'anthropic-dangerous-direct-browser-access': 'true'},
      fetch: nativeFetch(config, service),
    });
    return provider(requestedModel);
  }
  if (service === services.gemini) {
    const provider = createGoogle({
      name: 'fluentread-harness-gemini',
      apiKey: configuredKey || undefined,
      fetch: nativeFetch(config, service),
    });
    return provider(requestedModel);
  }
  const customHeaders = parseCustomHeaders(isCustomOpenAIProviderId(service) ? config.customHeaders[service] : undefined);
  if (!customHeaders) throw new Error('自定义请求头必须是有效的 JSON 对象，头名称和值必须符合 HTTP 格式。');
  const endpoint = endpointFor(config, service, requestedModel);
  const apiKey = service === services.zhipu && configuredKey ? zhipuBearer(configuredKey) : configuredKey;
  const provider = createOpenAICompatible({
    name: `fluentread-harness-${service}`,
    baseURL: endpoint.baseURL,
    apiKey: service === services.azureOpenai ? undefined : apiKey || undefined,
    headers: serviceHeaders(service, configuredKey),
    queryParams: endpoint.queryParams,
    transformRequestBody: body => transformBody(service, config, requestedModel, body, endpoint.endpoint),
    fetch: async (input, init) => runtimeFetch(endpoint.exactEndpoint || input, {
      ...init, headers: mergeCustomHeaders(init?.headers, customHeaders), redirect: 'error',
    }),
  });
  return provider(resolveOfficialMimoModel(endpoint.endpoint, requestedModel));
}

type LanguageModelGenerateOptions = Parameters<ConcreteLanguageModel['doGenerate']>[0];
type LanguageModelStreamOptions = Parameters<ConcreteLanguageModel['doStream']>[0];

/**
 * 直连工厂：在当前进程内直接构建并执行 provider 的 LanguageModel。多 Key 服务按每次
 * 调用冻结的配置重新创建底层 provider，避免某次调用中途读取到 UI 正在编辑的凭据。
 *
 * 「直连」指不做任何宿主切换、就在调用方所在进程发起请求。Offscreen 执行宿主
 * （src/app/offscreen/modelExecutorHost.ts）必须注入本直连版——绝不能注入带后台代理
 * 切换的入口，否则在 Offscreen 内会再次代理回后台、形成递归。
 */
export function createHarnessLanguageModelDirect(config: Config, service: string, model: string): LanguageModel {
  if (isTranslationServiceDisabled(config.disabledTranslationServices, service)) throw new Error(TRANSLATION_SERVICE_DISABLED_MESSAGE);
  if (service === services.chatgptPlan) {
    const unavailable = getTranslationServiceUnavailableMessage(service);
    if (unavailable) throw Object.assign(new Error(unavailable), {kind: 'bad-request', retryable: false});
    return createChatGPTPlanHarnessModel(model);
  }
  if (service === services.bilibili) return createSingleHarnessLanguageModel(config, service, model);
  const keys = getServiceApiKeys(config, service);
  if (keys.length < 2) return createSingleHarnessLanguageModel(withServiceApiKey(config, service, keys[0] ?? ''), service, model);

  const frozenConfig = snapshotHarnessConfig(config);
  const baseModel = createSingleHarnessLanguageModel(frozenConfig, service, model);
  const operationConfig = () => {
    const headers = isCustomOpenAIProviderId(service) ? parseCustomHeaders(frozenConfig.customHeaders[service]) : undefined;
    return [...keys, ...Object.values(headers ?? {})];
  };
  const invoke = async <R>(operation: (selected: Config) => Promise<R>, signal?: AbortSignal): Promise<R> => runWithApiKeyRotation(
    frozenConfig,
    service,
    async selected => {
      try { return await operation(selected); }
      catch (error) {
        const normalized = normalizeAiSdkError(service, error, operationConfig());
        normalized.message = sanitizeHarnessModelMessage(normalized.message);
        throw normalized;
      }
    },
    {signal, model},
  );
  return new Proxy(baseModel, {
    get(target, property) {
      if (property === 'doGenerate') return (options: LanguageModelGenerateOptions) => invoke(selected => Promise.resolve(createSingleHarnessLanguageModel(selected, service, model).doGenerate(options)), options.abortSignal);
      if (property === 'doStream') return (options: LanguageModelStreamOptions) => invoke(selected => Promise.resolve(createSingleHarnessLanguageModel(selected, service, model).doStream(options)), options.abortSignal);
      return Reflect.get(target, property, target);
    },
  });
}

/** 网关消费的宿主能力视图：只读 offscreenDocument 字段，缺失或读取异常一律按无能力处理。 */
interface HarnessHostCapabilityView {
  readonly offscreenDocument?: boolean;
}

/**
 * 解析 Harness 模型调用的执行宿主：显式 background 尊重回滚；无原生 Offscreen 能力
 * （Firefox MV2、node 测试、未知浏览器）即使配置 offscreen 也强制 background 兜底；
 * 其余（默认或显式 offscreen 且有能力）走 offscreen 代理。纯函数，供网关内部与测试核对。
 */
export function resolveHarnessModelCallHost(
  config: Pick<Config, 'harnessCallHost'>,
  capabilities: HarnessHostCapabilityView,
): HarnessCallHost {
  if (config.harnessCallHost === 'background') return 'background';
  return capabilities.offscreenDocument === true ? 'offscreen' : 'background';
}

/** 惰性、容错地读取原生 Offscreen 能力：browserCapabilities 读取失败或字段缺失视为 false。 */
function readHarnessOffscreenCapability(): boolean {
  try {
    return browserCapabilities.offscreenDocument === true;
  } catch {
    return false;
  }
}

/**
 * 后台进程共享的唯一代理工厂：首次走 offscreen 宿主时创建并复用。单一 ports 对应进程内
 * 唯一事件订阅（offscreenModelClient 按 ports 实例共享 dispatcher），避免每个模型重复挂
 * listener。ports 的浏览器求值全部惰性：extensionDomClient 只在 getClient 回调内解引用
 * （chrome 句柄到 send 时才访问），chrome.runtime.onMessage 只在 subscribe 被调用时求值。
 */
let offscreenHarnessModelFactory: ReturnType<typeof createOffscreenHarnessLanguageModel> | undefined;

function sharedOffscreenHarnessModelFactory(): ReturnType<typeof createOffscreenHarnessLanguageModel> {
  offscreenHarnessModelFactory ??= createOffscreenHarnessLanguageModel({
    getClient: () => extensionDomClient,
    // 包装 chrome.runtime.onMessage：listener 恒返回 undefined 不占同步响应通道（P2 订阅契约）。
    subscribe: (listener) => {
      const runtimeListener = (message: unknown): void => {
        listener(message);
      };
      chrome.runtime.onMessage.addListener(runtimeListener);
      return () => {
        chrome.runtime.onMessage.removeListener(runtimeListener);
      };
    },
    now: () => Date.now(),
  });
  return offscreenHarnessModelFactory;
}

/**
 * 统一入口：按 config.harnessCallHost 与浏览器能力分流——offscreen 宿主返回后台代理
 * LanguageModel（doGenerate/doStream 经协议转发到常驻 DOM 运行时执行），background 宿主
 * 返回直连工厂（显式回滚，或在无 offscreen 能力的环境兜底）。既有调用方
 * （harness/writing/comment 后台运行时）签名不变，Offscreen 执行宿主继续注入直连版防递归。
 */
export function createHarnessLanguageModel(config: Config, service: string, model: string): LanguageModel {
  if (resolveHarnessModelCallHost(config, {offscreenDocument: readHarnessOffscreenCapability()}) === 'offscreen') {
    return sharedOffscreenHarnessModelFactory()(config, service, model);
  }
  return createHarnessLanguageModelDirect(config, service, model);
}
