/**
 * @file src/core/comment/repair.ts
 * 文件职责：为评论双语输出生成选区级与条目级的语言规划，并负责定向补译的系统提示词构建与补译输出解析。
 * 主要内容：resolveCommentLanguagePlan 只采信可信识别（identified）结论判定选区与目标语言是否同语并给出可点名的选区语言代码，
 * 未识别、混合与空文本一律不点名（提示词走泛化措辞，绝不用统计猜测去点名语言）；isCommentTranslationRedundant 用同一套规则
 * 对单条评论内容做补译门控——可信命中目标或中文家族对中文目标视为补译重复，其余一律放行补译（宁可多补不可漏补）；
 * buildCommentTranslationRepairPrompt 生成把缺失评论译文与选区译文一次补齐的中文系统提示词（空目标回落简体中文）；
 * parseCommentRepairOutput 以宽容候选切片解析 {"source","comments"} JSON 对象（容忍代码围栏与前后缀说明）。
 * 模块边界：纯规则模块，只依赖语言识别与语言代码规范化的可信结论，不用统计猜测做否决；不调用模型、不读取配置存储、不接触浏览器 API。
 */
import {isTextInLanguage} from '@/src/core/language/detect';
import {identifyTextLanguage} from '@/src/core/language/identify';
import {isLanguageCodeMatch, normalizeDetectedLanguageCode, normalizeLanguageCode} from '@/src/core/language/codes';

export interface CommentLanguagePlan {
    /** 选区与目标语言同语（可信识别命中目标，或中文家族内部互认）：评论与选区译文都无需跨语言。 */
    readonly sameLanguage: boolean;
    /** 可信识别出的选区语言代码（如 'ja'、'zh-Hans'），用于提示词点名；不可信/未识别时为 undefined。 */
    readonly selectionLanguage: string | undefined;
}

/** 补译调用提交给模型的负载与解析期望：待译选区原文（可为 null）与待译评论正文数组。 */
export interface CommentRepairPayload {
    readonly source: string | null;
    readonly comments: readonly string[];
}

/** 可信识别结论里的语言代码列表；未识别（unknown/mixed/empty）时视为无可信语言。 */
function trustedLanguages(text: string): readonly string[] {
    const identification = identifyTextLanguage(text);
    return identification.status === 'identified' ? identification.languages : [];
}

/**
 * 规划评论双语的选区级语言策略：可信识别命中目标语言、或中文家族内部互认（简繁互认、裸 zh/cmn 视作中文）
 * 时判定同语，评论与选区译文都无需跨语言；其余情形需要跨语言，并只在可信识别给出唯一倾向时点名选区语言。
 * 目标语言空白回落简体中文；猜错语言比不点名更糟，因此未识别与混合绝不点名。
 */
export function resolveCommentLanguagePlan(selectionText: string, targetLanguage: string): CommentLanguagePlan {
    const target = targetLanguage.trim() || 'zh-Hans';
    const languages = trustedLanguages(selectionText);
    const trustedChinese = languages.length > 0
        && languages.every(code => normalizeDetectedLanguageCode(code).startsWith('zh'));
    const targetChinese = normalizeLanguageCode(target).startsWith('zh');
    const sameLanguage = languages.some(code => isLanguageCodeMatch(code, target)) || (trustedChinese && targetChinese);
    return {sameLanguage, selectionLanguage: sameLanguage ? undefined : languages[0]};
}

/**
 * 判断单条评论缺失译文时补译是否属于重复劳动：内容被可信识别为目标语言、或中文内容对中文目标时返回 true。
 * 未识别、混合与其他语言一律返回 false（宁可多补不可漏补）；空串与纯表情按未识别放行。这是旧版选区级
 * 统计猜测门控误杀日文等场景的修正：条目级门控只采信"内容确属目标语言"的正向证据。
 */
export function isCommentTranslationRedundant(content: string, targetLanguage: string): boolean {
    const target = targetLanguage.trim() || 'zh-Hans';
    if (isTextInLanguage(content, target)) return true;
    const languages = trustedLanguages(content);
    if (languages.length === 0) return false;
    const contentChinese = languages.every(code => normalizeDetectedLanguageCode(code).startsWith('zh'));
    return contentChinese && normalizeLanguageCode(target).startsWith('zh');
}

/**
 * 构建补译调用的系统提示词：把缺失的评论译文与选区译文一次补齐，只允许输出一个 {"source","comments"} JSON 对象。
 * 目标语言缺省（空白）时回落到简体中文，与主提示词的缺省双语契约保持一致。
 */
export function buildCommentTranslationRepairPrompt(targetLanguage: string): string {
    const language = targetLanguage.trim().slice(0, 35) || 'zh-Hans';
    return [
        '你是翻译引擎，负责把已生成的社交媒体评论与选区译文补齐。',
        '用户提交一个 JSON 对象：{"source": 字符串或 null, "comments": 字符串数组}。',
        `把 comments 中的每条评论按原顺序逐条翻译成语言代码 ${language} 对应的语言，保持原文口语语气与长度。`,
        `source 非 null 时同样翻译成语言代码 ${language} 对应的语言；source 为 null 时输出 null。`,
        '只输出这一个 JSON 对象，不输出编号、解释或代码围栏以外的任何内容。',
    ].join('\n');
}

/** 解析结果：选区译文（可为 null）与按序对应的评论译文数组。 */
interface CommentRepairResult {
    source: string | null;
    comments: string[];
}

/**
 * 解析补译输出：comments 必须是字符串数组、条数严格等于期望、每项 trim 后非空；source 在期望为 null 时
 * 缺失或为 null 均可（意外返回非空字符串也采用），期望非 null 时必须存在且为非空字符串。
 * 对模型输出的代码围栏与前后缀说明保持宽容：先整体解析，失败后截取首尾花括号之间的切片重试；任一条件不满足返回 undefined。
 */
export function parseCommentRepairOutput(text: string, expected: CommentRepairPayload): CommentRepairResult | undefined {
    const raw = text.trim();
    const candidates = [raw, raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)];
    for (const candidate of candidates) {
        try {
            const parsed: unknown = JSON.parse(candidate);
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
            const record = parsed as Record<string, unknown>;
            const comments = record.comments;
            if (!Array.isArray(comments) || comments.length !== expected.comments.length) continue;
            if (!comments.every(item => typeof item === 'string' && item.trim())) continue;
            const source = record.source;
            if (expected.source === null) {
                const trimmed = typeof source === 'string' ? source.trim() : '';
                return {source: trimmed || null, comments: comments.map(item => (item as string).trim())};
            }
            if (typeof source !== 'string' || !source.trim()) continue;
            return {source: source.trim(), comments: comments.map(item => (item as string).trim())};
        } catch { /* 候选解析失败时尝试下一个候选切片。 */ }
    }
    return undefined;
}
