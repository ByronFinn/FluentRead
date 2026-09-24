/**
 * @file src/core/config/comment.ts
 * 文件职责：定义评论助手偏好的类型、默认值与纯规范化规则。
 * 主要内容：启用开关、可选服务与模型覆盖、评论条数、可编辑风格提示词，以及沿用 Harness 服务白名单的规范化边界。
 * 模块边界：本文件只处理领域数据，不读写浏览器存储、不调用模型，也不决定选区或页面生命周期。
 */
import {customModelString, resolveConfiguredModel} from './catalog';
import {isHarnessService} from './harness';
import {COMMENT_PROMPT_MAX_LENGTH} from '../comment/prompts';
import type {CustomOpenAIProvider} from './customOpenAI';

export interface CommentPreferences {
    enabled: boolean;
    /** 空值跟随当前默认翻译服务；必须是 Harness 白名单内的大模型服务。 */
    service: string;
    /** 空值跟随服务已配置模型。 */
    model: string;
    count: number;
    /** 用户风格指令段；空值使用内置默认，安全壳与输出契约不可被覆盖。 */
    prompt: string;
}

export const DEFAULT_COMMENT_PREFERENCES: CommentPreferences = {
    enabled: false,
    service: '',
    model: '',
    count: 3,
    prompt: '',
};

// 页面输入上限由后台校验与模型运行时共用同一份常量，避免两层各自硬编码后漂移。
export const COMMENT_MAX_TEXT = 8192;
export const COMMENT_MAX_IMAGES = 4;
// 编码后的单图上限按 1024px JPEG 的实测体积留出十倍余量，避免页面用超长 data URL 放大内存与 token 成本。
export const COMMENT_MAX_IMAGE_CHARS = 512_000;
export const COMMENT_COUNT_MIN = 1;
export const COMMENT_COUNT_MAX = 5;

export function normalizeCommentPreferences(value: unknown, customProviders: readonly CustomOpenAIProvider[] = []): CommentPreferences {
    const source = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Partial<CommentPreferences>
        : {};
    const service = typeof source.service === 'string' ? source.service.trim() : '';
    const rawCount = typeof source.count === 'number' ? source.count : Number(source.count);
    return {
        enabled: source.enabled === true,
        service: isHarnessService(service, customProviders) ? service.slice(0, 128) : '',
        model: typeof source.model === 'string' && source.model.trim() !== customModelString ? source.model.trim().slice(0, 128) : '',
        count: Number.isFinite(rawCount) ? Math.min(COMMENT_COUNT_MAX, Math.max(COMMENT_COUNT_MIN, Math.round(rawCount))) : DEFAULT_COMMENT_PREFERENCES.count,
        prompt: typeof source.prompt === 'string' ? source.prompt.slice(0, COMMENT_PROMPT_MAX_LENGTH) : '',
    };
}

/** 评论与阅读共用 AI 服务判定；此处给出评论侧的有效服务与模型解析。 */
export function resolveCommentModel(config: {
    comment: Pick<CommentPreferences, 'service' | 'model'>;
    service: string;
    model: Record<string, string>;
    customModel: Record<string, string>;
}): {service: string; model: string} {
    const service = config.comment.service || config.service;
    return {
        service,
        model: config.comment.model || resolveConfiguredModel(config.model[service], config.customModel[service]),
    };
}

/** 评论可用服务即 Harness 白名单（含自定义 OpenAI 兼容供应商），空服务表示跟随默认。 */
export function isCommentServiceUsable(service: unknown, customProviders: readonly CustomOpenAIProvider[] = []): boolean {
    return typeof service === 'string' && service.length > 0 && isHarnessService(service, customProviders);
}
