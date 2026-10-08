/**
 * @file src/core/config/harness.ts
 * 文件职责：定义 Harness 学习辅助功能的动作注册表、配置类型、默认值与纯规范化规则。
 * 主要内容：提供 HarnessActionId/HarnessPreferences、动作注册表、支持服务判断和规范化函数，限制触发方式、快捷键、悬停延迟、服务/模型覆盖和动作白名单、上下文长度和学习难度，并定义可编辑提示词、默认模板、占位符替换规则、阅读模型缓存的配置标识，以及 HarnessCallHost 模型调用执行宿主（offscreen 常驻运行时 / background 直连回滚）的联合类型、默认值与非法值回落。
 * 模块边界：本文件只处理领域数据，不读取浏览器存储、不发起 AI 请求，也不决定选区或网页生命周期；执行宿主的最终裁决由 services/harness/modelGateway 结合浏览器能力完成。
 */
import {DEFAULT_HARNESS_ACTION_PROMPTS, DEFAULT_HARNESS_SYSTEM_PROMPT, HARNESS_PROMPT_MAX_LENGTH} from '../harness/prompts';
export {DEFAULT_HARNESS_ACTION_PROMPTS, DEFAULT_HARNESS_SYSTEM_PROMPT, HARNESS_PROMPT_MAX_LENGTH, HARNESS_PROMPT_VARIABLES, getDefaultHarnessPrompt, resolveHarnessPrompt, renderHarnessPrompt, type HarnessPromptKind} from '../harness/prompts';
import {parseHotkey} from '../hotkey';
import {customModelString, resolveConfiguredModel, services, servicesType} from './catalog';
import {isConfiguredCustomOpenAIProvider, isCustomOpenAIProviderId, type CustomOpenAIProvider} from './customOpenAI';

export const HARNESS_ACTIONS = [
    {id: 'meaning', label: '读懂', description: '解释这段内容在说什么。'},
    {id: 'grammar', label: '拆句', description: '拆解句子结构和关键语法。'},
    {id: 'usage', label: '用法', description: '说明词语或表达的自然用法。'},
    {id: 'practice', label: '练习', description: '根据内容生成一个小练习。'},
] as const;

export type HarnessActionId = typeof HARNESS_ACTIONS[number]['id'];
export type HarnessContextMode = 'paragraph' | 'selection';
export type HarnessExplanationDepth = 'concise' | 'detailed';

/**
 * Harness 模型调用的执行宿主：'offscreen' 经后台代理 LanguageModel 把调用转发到常驻
 * DOM 运行时执行（协议/执行器/宿主三层）；'background' 在后台进程内直连执行，是显式
 * 回滚开关。网关会再叠加浏览器能力裁决：无 offscreen 能力的环境（Firefox MV2、node
 * 测试、未知浏览器）即使配置 offscreen 也强制回落 background。
 */
export type HarnessCallHost = 'offscreen' | 'background';

/** 默认经离屏常驻执行，防止 MV3 service worker 空闲休眠中断长生成；旧配置无此键时同样落到该默认值。 */
export const DEFAULT_HARNESS_CALL_HOST: HarnessCallHost = 'offscreen';

/** 非法值（含旧配置缺失、未知字符串）一律回落离屏默认，与 deeplApiPlan 等现有枚举键的收敛方式一致。 */
export function normalizeHarnessCallHost(value: unknown): HarnessCallHost {
    return value === 'background' ? 'background' : DEFAULT_HARNESS_CALL_HOST;
}

export interface HarnessPreferences {
    enabled: boolean;
    trigger: 'click' | 'hover' | 'shortcut';
    customHotkey: string;
    hoverDelay: number;
    service: string;
    model: string;
    defaultAction: HarnessActionId;
    actions: HarnessActionId[];
    contextMode: HarnessContextMode;
    maxContextChars: number;
    explanationDepth: HarnessExplanationDepth;
    learningLevel: 'beginner' | 'intermediate' | 'advanced';
    memoryEnabled: boolean;
    systemPrompt: string;
    actionPrompts: Record<HarnessActionId, string>;
}

export const DEFAULT_HARNESS_PREFERENCES: HarnessPreferences = {
    enabled: false,
    trigger: 'click',
    customHotkey: 'Alt+R',
    hoverDelay: 600,
    service: '',
    model: '',
    defaultAction: 'meaning',
    actions: HARNESS_ACTIONS.map((action) => action.id),
    contextMode: 'paragraph',
    maxContextChars: 1500,
    explanationDepth: 'concise',
    learningLevel: 'intermediate',
    memoryEnabled: false,
    systemPrompt: DEFAULT_HARNESS_SYSTEM_PROMPT,
    actionPrompts: {...DEFAULT_HARNESS_ACTION_PROMPTS},
};

const HARNESS_UNSUPPORTED_SERVICES = new Set([services.huanYuanTranslation]);

/** Harness 支持兼容会话及原生 Claude/Gemini，目录与 gateway 共用此规则。 */
export function isHarnessService(service: unknown, customProviders: readonly CustomOpenAIProvider[] = []): service is string {
    if (typeof service !== 'string' || service.length > 128) return false;
    if (isCustomOpenAIProviderId(service)) return isConfiguredCustomOpenAIProvider(customProviders, service);
    return servicesType.isAI(service) && !HARNESS_UNSUPPORTED_SERVICES.has(service);
}

const HARNESS_ACTION_IDS = new Set<HarnessActionId>(HARNESS_ACTIONS.map((action) => action.id));

export function normalizeHarnessPreferences(value: unknown, customProviders: readonly CustomOpenAIProvider[] = []): HarnessPreferences {
    const source = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Partial<HarnessPreferences>
        : {};
    const hotkey = typeof source.customHotkey === 'string' ? source.customHotkey.trim().slice(0, 100) : '';
    const hoverDelay = source.hoverDelay;
    const actions = Array.isArray(source.actions)
        ? [...new Set(source.actions.filter((action): action is HarnessActionId => (
            typeof action === 'string' && HARNESS_ACTION_IDS.has(action as HarnessActionId)
        )))]
        : [...DEFAULT_HARNESS_PREFERENCES.actions];
    if (!actions.includes('meaning')) actions.unshift('meaning');
    const rawChars = typeof source.maxContextChars === 'number' ? source.maxContextChars : Number(source.maxContextChars);
    const promptSource = source.actionPrompts && typeof source.actionPrompts === 'object' && !Array.isArray(source.actionPrompts) ? source.actionPrompts : {} as Partial<Record<HarnessActionId, unknown>>;
    const normalizePrompt = (value: unknown, fallback: string): string => typeof value === 'string' ? value.slice(0, HARNESS_PROMPT_MAX_LENGTH) : fallback;
    return {
        systemPrompt: normalizePrompt(source.systemPrompt, DEFAULT_HARNESS_SYSTEM_PROMPT),
        actionPrompts: Object.fromEntries(HARNESS_ACTIONS.map(({id}) => [id, normalizePrompt(promptSource[id], DEFAULT_HARNESS_ACTION_PROMPTS[id])])) as Record<HarnessActionId, string>,
        enabled: source.enabled === true,
        trigger: source.trigger === 'hover' || source.trigger === 'shortcut' ? source.trigger : 'click',
        customHotkey: parseHotkey(hotkey).isValid ? hotkey : DEFAULT_HARNESS_PREFERENCES.customHotkey,
        hoverDelay: typeof hoverDelay === 'number' && Number.isFinite(hoverDelay) ? Math.min(3000, Math.max(200, Math.round(hoverDelay))) : 600,
        service: isHarnessService(typeof source.service === 'string' ? source.service.trim() : '', customProviders) ? source.service!.trim().slice(0, 128) : '',
        model: typeof source.model === 'string' && source.model.trim() !== customModelString ? source.model.trim().slice(0, 128) : '',
        defaultAction: typeof source.defaultAction === 'string' && HARNESS_ACTION_IDS.has(source.defaultAction as HarnessActionId) && actions.includes(source.defaultAction as HarnessActionId)
            ? source.defaultAction as HarnessActionId
            : 'meaning',
        actions,
        contextMode: source.contextMode === 'selection' ? 'selection' : 'paragraph',
        maxContextChars: Number.isFinite(rawChars) ? Math.min(4000, Math.max(500, Math.round(rawChars))) : 1500,
        explanationDepth: source.explanationDepth === 'detailed' ? 'detailed' : 'concise',
        learningLevel: source.learningLevel === 'beginner' || source.learningLevel === 'advanced'
            ? source.learningLevel
            : 'intermediate',
        memoryEnabled: source.memoryEnabled === true,
    };
}

/** 仅用于内存比较，不持久化或展示；无关界面配置刷新不能清除阅读回答。 */
export function getHarnessModelCacheKey(config: {
    harness: Pick<HarnessPreferences, 'service' | 'model'>;
    service: string;
    model: Record<string, string>;
    customModel: Record<string, string>;
    token: Record<string, string>;
    proxy: Record<string, string>;
    on: boolean;
    uiLanguage: string;
    modelThinking: unknown;
    customOpenAIProviders: unknown;
    custom: string;
    newApiUrl: string;
    azureOpenaiEndpoint: string;
    deepseekApiType: string;
    minimaxBillingPlan: string;
    minimaxRegion: string;
    mimoBillingPlan: string;
    mimoRegion: string;
}): string {
    const service = config.harness.service || config.service;
    const model = config.harness.model || resolveConfiguredModel(config.model[service], config.customModel[service]);
    return JSON.stringify([
        config.on, config.uiLanguage, service, model, config.token[service], config.proxy[service],
        config.modelThinking, config.customOpenAIProviders, config.custom, config.newApiUrl,
        config.azureOpenaiEndpoint, config.deepseekApiType, config.minimaxBillingPlan,
        config.minimaxRegion, config.mimoBillingPlan, config.mimoRegion,
    ]);
}
