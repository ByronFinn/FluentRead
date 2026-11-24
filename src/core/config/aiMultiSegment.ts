/**
 * @file src/core/config/aiMultiSegment.ts
 * 文件职责：定义 AI 全文多段翻译的批次预算，使配置、设置控件和请求调度共享默认值及有限范围。
 * 主要内容：按可翻译文本槽数和原文字符数分别限制一批请求；兼容有限数字及数字字符串，去除小数并约束范围，非法旧值回到默认预算。
 * 模块边界：只处理纯配置规则，不读取全局配置、不接触 DOM、存储或供应商请求；原生数组翻译保持自己的预算。
 */
export const DEFAULT_AI_MULTI_SEGMENT_MAX_SEGMENTS = 8;
export const MIN_AI_MULTI_SEGMENT_MAX_SEGMENTS = 2;
export const MAX_AI_MULTI_SEGMENT_MAX_SEGMENTS = 32;
export const DEFAULT_AI_MULTI_SEGMENT_MAX_CHARACTERS = 2_000;
export const MIN_AI_MULTI_SEGMENT_MAX_CHARACTERS = 500;
export const MAX_AI_MULTI_SEGMENT_MAX_CHARACTERS = 12_000;

export interface AiMultiSegmentLimits {
    aiMultiSegmentMaxSegments: number;
    aiMultiSegmentMaxCharacters: number;
}

function normalizeBudget(value: unknown, fallback: number, min: number, max: number): number {
    const numeric = typeof value === 'number' ? value
        : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
    return Number.isFinite(numeric) ? Math.min(max, Math.max(min, Math.trunc(numeric))) : fallback;
}

export function normalizeAiMultiSegmentMaxSegments(value: unknown): number {
    return normalizeBudget(value, DEFAULT_AI_MULTI_SEGMENT_MAX_SEGMENTS,
        MIN_AI_MULTI_SEGMENT_MAX_SEGMENTS, MAX_AI_MULTI_SEGMENT_MAX_SEGMENTS);
}

export function normalizeAiMultiSegmentMaxCharacters(value: unknown): number {
    return normalizeBudget(value, DEFAULT_AI_MULTI_SEGMENT_MAX_CHARACTERS,
        MIN_AI_MULTI_SEGMENT_MAX_CHARACTERS, MAX_AI_MULTI_SEGMENT_MAX_CHARACTERS);
}
