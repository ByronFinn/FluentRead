/**
 * @file src/core/comment/parse.ts
 * 文件职责：为评论助手的模型输出提供纯解析与宽容归一化，是强制工具调用之外的输出容错降级链第一环。
 * 主要内容：normalizeModelComments 把模型负载宽容归一化为规范评论列表——未知键忽略、坏条目跳过、正文与译文
 * trim 后截断到条目上限、sourceTranslation 按选区文本上限截断、清洗后无有效条目返回 undefined；
 * parseCommentsFromText 在模型未调用工具时从纯文本输出兜底解析评论负载——剥 ``` 代码围栏后依次尝试
 * 整串解析、首尾花括号切片、裸数组包装（数组结果包装为 {comments} 交给归一化判定），全失败返回 undefined。
 * 模块边界：纯算法模块，只消费字符串与已解析的 JSON 值；不调用模型、不读取配置存储、不接触浏览器 API；
 * 与 repair.ts 的 parseCommentRepairOutput 是不同契约（补译专用），不合并复用。
 */
import {COMMENT_MAX_TEXT} from '@/src/core/config/comment';

/** 归一化后的评论负载：可展示条目（译文可空）与整段选区译文（可空）。 */
export interface NormalizedCommentPayload {
    comments: Array<{content: string; translation: string | null}>;
    sourceTranslation: string | null;
}

/** 单条评论正文硬上限，与工具 schema 的 content 约束同源。 */
export const COMMENT_CONTENT_MAX = 500;

/**
 * 宽容归一化模型负载：输入必须是含 comments 数组的 plain object（工具输入或文本兜底解析结果），
 * 未知键忽略、坏条目跳过、超长截断；清洗后没有任何有效条目时返回 undefined，由调用方决定重试或失败。
 */
export function normalizeModelComments(input: unknown, maxCount: number): NormalizedCommentPayload | undefined {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
    const record = input as Record<string, unknown>;
    const rawComments = record.comments;
    if (!Array.isArray(rawComments)) return undefined;
    const comments: Array<{content: string; translation: string | null}> = [];
    for (const entry of rawComments) {
        if (entry === null || typeof entry !== 'object') continue;
        const comment = entry as Record<string, unknown>;
        const content = comment.content;
        if (typeof content !== 'string' || !content.trim()) continue;
        const translation = comment.translation;
        comments.push({
            content: content.trim().slice(0, COMMENT_CONTENT_MAX),
            // 译文三态：非空字符串 trim 后与正文同样截到条目上限；空白字符串、null/undefined 与意外类型一律宽容归 null。
            translation: typeof translation === 'string' && translation.trim()
                ? translation.trim().slice(0, COMMENT_CONTENT_MAX)
                : null,
        });
    }
    if (comments.length === 0) return undefined;
    const rawSource = record.sourceTranslation;
    const sourceTrimmed = typeof rawSource === 'string' ? rawSource.trim() : '';
    return {
        comments: comments.slice(0, maxCount),
        sourceTranslation: sourceTrimmed ? sourceTrimmed.slice(0, COMMENT_MAX_TEXT) : null,
    };
}

/** 剥掉完整包裹的 ``` 围栏（首行 ```json 或 ```、末行 ```）；其余情形原样返回。 */
function stripCodeFence(text: string): string {
    const lines = text.split('\n');
    if (lines.length < 2) return text;
    const first = lines[0]!.trim();
    const last = lines[lines.length - 1]!.trim();
    if ((first === '```' || first === '```json') && last === '```') return lines.slice(1, -1).join('\n').trim();
    return text;
}

/**
 * 从纯文本输出兜底解析评论负载（工具未被调用时）：剥代码围栏后依次尝试整串、首尾花括号切片、
 * 首尾方括号切片；解析出数组结果时包装为 {comments: 数组} 返回。任一候选 JSON.parse 成功即返回
 * 解析值，形状合法性交给 normalizeModelComments 判定；全部失败返回 undefined。
 */
export function parseCommentsFromText(text: string): unknown {
    const body = stripCodeFence(text.trim());
    const candidates = [body, body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1)];
    for (const candidate of candidates) {
        try {
            const parsed: unknown = JSON.parse(candidate);
            // 整串恰好是裸数组时与方括号切片同源：包装成负载形状，避免数组被归一化直接否决。
            return Array.isArray(parsed) ? {comments: parsed} : parsed;
        } catch { /* 候选解析失败时尝试下一个候选切片。 */ }
    }
    const arrayCandidate = body.slice(body.indexOf('['), body.lastIndexOf(']') + 1);
    try {
        return {comments: JSON.parse(arrayCandidate)};
    } catch { /* 全部候选失败：没有可兜底的负载。 */ }
    return undefined;
}
