/**
 * @file src/services/comment/runtime.ts
 * 文件职责：把评论请求组装为一次强制工具调用的模型生成，并把结果解析、清洗为可展示的双语评论列表与选区译文。
 * 主要内容：偏好与服务的最终规范化（本地免密服务不强制密钥）、安全壳提示词与选区包装、语言判定前置
 * （resolveCommentLanguagePlan 的结论注入提示词三态语言段）、submit_comments 工具的 zod 契约（wire 层带字段描述引导模型，
 * 校验层宽容、响应侧由 normalizeModelComments 接管）、toolChoice required 的 generateText 调用（按最坏合法输出推导的
 * 动态护栏预算，思考模型按配置加余量）、输出容错降级链（工具输入或纯文本兜底解析 → 宽容归一化 → 语言对齐，
 * 仅格式类失败自动重试一次且注入纠偏指令，截断失败同时升级预算；首试被端点 400 点名拒绝的两类问题各降级重试一次
 * （输出预算超模型硬上限时收缩预算、点名拒绝 toolChoice 时降级 auto），其余供应商错误与取消绝不重试）、
 * invalid 工具调用的原文接管（对象交归一化、字符串转纯文本兜底）、
 * 按条目内容门控（isCommentTranslationRedundant）的定向补译与选区译文补齐调用与取消透传、
 * 补译失败与语言对齐丢弃的降级 notice、泄漏清洗、模型用量事件上报（每次尝试独立计时、格式失败记 error），
 * 以及供应商错误的统一归一。
 * 模块边界：只在后台执行，不读取网页 DOM、不管理取消与并发（由 feature handler 负责）、不持久化评论结果。
 */
import {generateText, tool, type LanguageModel} from 'ai';
import {z} from 'zod';
import {
    buildCommentFormatRepairHint, buildCommentSystemPrompt, buildCommentUserText, sanitizeComments,
    type CommentFormatFailureKind,
} from '@/src/core/comment/prompts';
import {normalizeModelComments, parseCommentsFromText} from '@/src/core/comment/parse';
import {
    buildCommentTranslationRepairPrompt, isCommentTranslationRedundant, parseCommentRepairOutput,
    realignCommentLanguages, resolveCommentLanguagePlan,
} from '@/src/core/comment/repair';
import {COMMENT_MAX_IMAGE_CHARS, COMMENT_MAX_IMAGES, COMMENT_MAX_TEXT, normalizeCommentPreferences, resolveCommentModel} from '@/src/core/config/comment';
import {isModelThinkingEnabled} from '@/src/core/config/modelThinking';
import {servicesType} from '@/src/core/config/catalog';
import {isHarnessService} from '@/src/core/config/harness';
import {isApiKeyRequired} from '@/src/core/config/validation';
import {createHarnessUsageEvent} from '@/src/services/harness/usage';
import type {Config} from '@/src/core/config/model';
import type {ModelUsageEvent} from '@/src/services/model-usage/types';
import {normalizeHarnessModelError} from '@/src/services/harness/modelGateway';
import type {CommentItem, CommentRequest, CommentResponse} from '@/src/features/comment-assistant/types';

// 工具契约只对模型侧的 wire schema 严格：SDK 会为对象字段递归加 additionalProperties:false 并把字段描述下发，
// 引导模型产出正确结构；这里刻意不使用 .strict()（zod 校验层沿用宽容语义），额外键、缺键或超长值交由
// normalizeModelComments 兜底，schema 校验失败也会落入 invalid 工具调用被下方解析链接管，而不是直接判死。
const COMMENT_INPUT = z.object({
    comments: z.array(z.object({
        content: z.string().min(1).max(500).describe('评论正文，使用语言判定要求的语言书写'),
        translation: z.string().max(500).nullable()
            .describe('评论正文的目标语言译文；按语言判定要求无需翻译时为 null'),
    }).describe('一条双语评论')).min(1).max(10).describe('生成的评论列表，一次提交恰好要求的条数'),
    sourceTranslation: z.string().max(COMMENT_MAX_TEXT).nullable()
        .describe('整个选区的目标语言译文；无需翻译时为 null'),
});

export type CommentModelFactory = (config: Config, service: string, model: string) => LanguageModel;
export type CommentUsageSink = (event: ModelUsageEvent) => void;

function failure(error: string): CommentResponse { return {success: false, error}; }

// 输出预算是护栏不是配额：按实际用量计费，把上限设得略高于最坏合法输出不会多花钱，
// 而护栏低于最坏合法输出时截断本身会制造失败（截断的 JSON 无法解析，整个请求作废）。
// 32768 覆盖最大输入 8192 字符 + 5 条评论 + 思考余量，仅对更极端的失控输出兜底。
const COMMENT_MAX_OUTPUT_TOKENS = 32_768;

// 云端思考模型的 reasoning token 与正文共享输出预算，护栏需为思考预留额外空间。
const COMMENT_THINKING_EXTRA_TOKENS = 8_000;

// 部分模型/网关对输出上限有低于护栏的硬上限（常见 16384/8192/4096），超限直接 400；
// 各端点上限无法在请求前得知，被拒后收缩到 4096 重试——现代对话模型几乎都接受该输出量，也容纳评论本身的合法输出。
const COMMENT_FALLBACK_OUTPUT_TOKENS = 4_096;

/** 最坏合法输出的动态护栏：固定底座 + 每条评论的正文与译文预算 + 源文本 2 token/字符的译文空间，思考模型再加余量。 */
function commentOutputBudget(sourceChars: number, commentCount: number, thinkingEnabled: boolean): number {
    const needed = 2_000 + commentCount * 1_200 + Math.ceil(sourceChars * 2);
    return Math.min(COMMENT_MAX_OUTPUT_TOKENS, needed + (thinkingEnabled ? COMMENT_THINKING_EXTRA_TOKENS : 0));
}

/** 保守识别"端点不支持 toolChoice required"类 400 错误：仅当状态码为 400 且消息点名 tool_choice/toolChoice 时降级；
 * 模型整体不支持工具（"does not support tools"）或工具 schema 被拒的 400 不在此列——降级 auto 仍会携带同一套 tools，重试注定失败。 */
function isToolChoiceUnsupportedError(error: unknown): boolean {
    const statusCode = (error as {statusCode?: unknown} | undefined)?.statusCode;
    const message = error instanceof Error ? error.message : String(error ?? '');
    return statusCode === 400 && /tool[\s_-]?choice/iu.test(message);
}

/** 识别"输出预算超过模型/网关硬上限"类 400：消息点名 max_tokens 或输出 token 上限；此时收缩预算重试一次，而不是把请求判死。 */
function isOutputBudgetRejectedError(error: unknown): boolean {
    const statusCode = (error as {statusCode?: unknown} | undefined)?.statusCode;
    const message = error instanceof Error ? error.message : String(error ?? '');
    return statusCode === 400 && /max[_\s-]?tokens?|output tokens?|token limit/iu.test(message);
}

/** 定向补译失败时的降级提示：评论照常展示，译文由用户重新生成补救。 */
const TRANSLATION_REPAIR_NOTICE = '部分评论的译文生成失败，可点击重新生成。';

/** 语言对齐丢弃条目的降级提示：其余评论照常展示，由用户决定是否重新生成补足条数。 */
const DROPPED_LANGUAGE_NOTICE = '部分评论的语言与选区不符已丢弃，可重新生成。';

/** 页面输入不可信：文本与 data URL 图片在入口再校验一次，与 handler 共用同一组上限常量。 */
function validateRequest(request: CommentRequest): string | undefined {
    const text = request.text.trim();
    if (!text || text.length > COMMENT_MAX_TEXT) return '选中内容不适合作为评论素材';
    if (!Array.isArray(request.images) || request.images.length > COMMENT_MAX_IMAGES) return '图片数量超出限制';
    return request.images.every(image => /^data:image\/(?:png|jpeg|webp);base64,/u.test(image)
        && image.length > 0 && image.length <= COMMENT_MAX_IMAGE_CHARS) ? undefined : '图片格式不支持';
}

/** 从 invalid 工具调用中提取校验失败摘要，供纠偏指令引用。ai@6 挂 InvalidToolInputError，message 为
 * "Invalid input for tool …: Type validation failed: Value: <模型输入全文回显>\nError message: <zod 逐字段问题>"——
 * 有指导意义的问题列表在 "Error message:" 之后，只取它；拿不到结构化信息时取消息尾部并返回 undefined 兜底。 */
function formatFailureDetail(call: {error?: unknown} | undefined): string | undefined {
    if (call === undefined || call.error === undefined) return undefined;
    const message = call.error instanceof Error ? call.error.message
        : typeof call.error === 'string' ? call.error : JSON.stringify(call.error);
    if (typeof message !== 'string' || !message.trim()) return undefined;
    // 用 lastIndexOf：模型输入的回显里也可能出现该字样，真正的问题列表总在消息尾部。
    const marker = message.lastIndexOf('Error message: ');
    const detail = marker >= 0 ? message.slice(marker + 'Error message: '.length) : message.slice(-300);
    return detail.trim().slice(0, 300) || undefined;
}

export function createCommentRuntime(getConfig: () => Config, createModel: CommentModelFactory,
    createUsageSink?: () => CommentUsageSink | undefined) {
    return {
        async run(request: CommentRequest, signal: AbortSignal): Promise<CommentResponse> {
            const config = getConfig();
            const preferences = normalizeCommentPreferences(config.comment, config.customOpenAIProviders);
            if (!config.on || !preferences.enabled) return failure('评论功能已停用');
            const invalid = validateRequest(request);
            if (invalid) return failure(invalid);
            const {service, model} = resolveCommentModel(config);
            if (!isHarnessService(service, config.customOpenAIProviders)) return failure('请先在评论设置中选择一个 AI 服务');
            if (!model) return failure('请先为评论选择一个模型');
            // 本地免密服务（如 Ollama）不在 useToken 名单内，与主翻译链路一致不强制密钥；
            // 其余服务按"服务 + 评论实际使用模型"的开关判定，密钥开关跟随所选模型。
            if (servicesType.isUseToken(service)
                && isApiKeyRequired(service, {...config, model: {...config.model, [service]: model}})
                && !config.token[service]?.trim()) return failure('当前服务尚未配置 API 密钥');
            // 语言判定前置：可信识别结论决定提示词三态语言段与后续补译策略，不再让模型自由裁量。
            const plan = resolveCommentLanguagePlan(request.text, config.to);
            const system = buildCommentSystemPrompt(preferences.prompt, preferences.count, config.to, plan);
            const userText = buildCommentUserText(request.text, request.images.length);
            const content = request.images.length
                ? [{type: 'text' as const, text: userText}, ...request.images.map(image => ({type: 'image' as const, image}))]
                : userText;
            const sink = createUsageSink?.();
            const record = (event: ModelUsageEvent) => {
                try { sink?.(event); } catch { /* 本地统计故障不能影响评论，也不能覆盖供应商错误。 */ }
            };
            const startedAt = Date.now();
            try {
                // 输出容错降级链：最多 2 次尝试，仅格式类失败（未提交工具/结构无效/输出截断/语言全错）自动重试一次，
                // 且重试的 system 追加针对上一轮失败方式的纠偏指令（盲重试只会原样重复），截断失败同时把护栏提到上限；
                // 例外：首试被端点 400 点名拒绝的两类问题各降级重试一次——预算超模型硬上限时收缩预算、
                // 点名拒绝 toolChoice 时降级 auto；其余供应商错误与用户取消在 generateText 抛错时直接冲出循环，
                // 由外层 catch 一次性处理，绝不重试。
                let prepared: {comments: CommentItem[]; sourceTranslation: string} | undefined;
                let droppedCount = 0;
                // 循环不变量：任何未产出 prepared 的路径都会覆写该文案，声明处默认值仅满足类型收窄。
                let formatError = '模型未按要求提交评论，请重试';
                // 纠偏指令与预算升级只在重试轮生效；toolChoice 降级后保持 auto，避免同一端点再次 400。
                let repairHint: string | undefined;
                let budgetOverride: number | undefined;
                let toolChoiceSupported = true;
                // 思考模型按"服务 + 评论实际使用模型"判定，reasoning 与正文共享输出预算，护栏需加余量。
                const thinkingEnabled = isModelThinkingEnabled(config.modelThinking, service, model);
                for (let attempt = 0; attempt < 2 && !prepared; attempt += 1) {
                    // 每次尝试独立计时：格式类失败后的重试若沿用请求级起点，会把失败尝试的耗时计入成功事件。
                    const attemptStartedAt = Date.now();
                    const attemptBudget = budgetOverride
                        ?? commentOutputBudget(request.text.length, preferences.count, thinkingEnabled);
                    // ai@6 的 generateText 返回类型随 tools 泛型特化，显式标注会被宽化成 ToolSet 导致赋值不兼容，
                    // 因此让类型从赋值推断；catch 的各路径（降级 continue / 原样 throw）都离开当前流，后续使用仍是特化类型。
                    let result;
                    try {
                        result = await generateText({
                            model: createModel(config, service, model),
                            system: repairHint ? `${system}\n\n${repairHint}` : system,
                            messages: [{role: 'user', content}],
                            tools: {submit_comments: tool({description: '提交生成的评论列表。', inputSchema: COMMENT_INPUT})},
                            toolChoice: toolChoiceSupported ? 'required' : 'auto',
                            maxRetries: 0,
                            maxOutputTokens: attemptBudget,
                            abortSignal: signal,
                        });
                    } catch (error) {
                        // 预算超过端点硬上限的 400：收缩到通用安全量重试一次（不大于本次请求的预算，避免反向放大）。
                        if (attempt === 0 && !signal.aborted && isOutputBudgetRejectedError(error)) {
                            budgetOverride = Math.min(COMMENT_FALLBACK_OUTPUT_TOKENS, attemptBudget);
                            record(createHarnessUsageEvent({service, model, startedAt: attemptStartedAt,
                                durationMs: Date.now() - attemptStartedAt, outcome: 'error'}));
                            continue;
                        }
                        // 部分端点对 toolChoice required 直接回 400：仅首试降级 auto 再试一次，模型可走纯文本由兜底解析接住。
                        if (attempt === 0 && !signal.aborted && isToolChoiceUnsupportedError(error)) {
                            toolChoiceSupported = false;
                            record(createHarnessUsageEvent({service, model, startedAt: attemptStartedAt,
                                durationMs: Date.now() - attemptStartedAt, outcome: 'error'}));
                            continue;
                        }
                        throw error;
                    }
                    const usage = await result.usage;
                    const response = await result.response;
                    // 解析容错链：invalid 工具调用的 input 保留模型原文（JSON 合法时是解析后的对象，截断时是原始字符串），
                    // 对象直接交宽容归一化抢救，字符串转纯文本兜底；工具未被调用同样走纯文本兜底。
                    const call = result.toolCalls.find(toolCall => toolCall.toolName === 'submit_comments');
                    const raw = call === undefined
                        ? parseCommentsFromText(await result.text)
                        : typeof call.input === 'string' ? parseCommentsFromText(call.input) : call.input;
                    const normalized = raw === undefined ? undefined : normalizeModelComments(raw, preferences.count);
                    const truncated = result.finishReason === 'length';
                    if (!normalized) {
                        formatError = call === undefined ? '模型未按要求提交评论，请重试' : '模型返回的评论结构不完整，请重试';
                        // 截断是预算不足的信号：升级到护栏上限再试；其余失败按具体方式注入纠偏指令。
                        budgetOverride = truncated ? COMMENT_MAX_OUTPUT_TOKENS : undefined;
                        // 显式标注失败分类：prompts 的纠偏构建按 CommentFormatFailureKind 穷举，漏改这里会被类型检查拦下。
                        const failureKind: CommentFormatFailureKind = truncated ? 'truncated'
                            : call === undefined ? 'missing_tool' : 'invalid_tool';
                        repairHint = buildCommentFormatRepairHint(failureKind, formatFailureDetail(call));
                        record(createHarnessUsageEvent({service, model, actualModel: response?.modelId, startedAt: attemptStartedAt,
                            durationMs: Date.now() - attemptStartedAt, usage, outcome: 'error'}));
                        continue;
                    }
                    let comments: CommentItem[] = normalized.comments.map(comment => ({
                        content: comment.content,
                        // 同语选区即使模型给出译文也不展示：与选区重复的译文没有信息量。
                        translation: plan.sameLanguage ? null : comment.translation,
                    }));
                    if (!plan.sameLanguage && plan.selectionLanguage) {
                        const realigned = realignCommentLanguages(comments, plan, config.to);
                        comments = realigned.comments;
                        droppedCount = realigned.dropped;
                        if (comments.length === 0) {
                            formatError = '模型未按要求的语言生成评论，请重试';
                            repairHint = buildCommentFormatRepairHint('language');
                            record(createHarnessUsageEvent({service, model, actualModel: response?.modelId, startedAt: attemptStartedAt,
                                durationMs: Date.now() - attemptStartedAt, usage, outcome: 'error'}));
                            continue;
                        }
                    }
                    record(createHarnessUsageEvent({service, model, actualModel: response?.modelId, startedAt: attemptStartedAt,
                        durationMs: Date.now() - attemptStartedAt, usage, outcome: 'success'}));
                    prepared = {comments, sourceTranslation: normalized.sourceTranslation ?? ''};
                }
                if (!prepared) return failure(formatError);
                let sourceTranslation = prepared.sourceTranslation;
                // 部分丢弃与补译失败可能同时发生：两句各自带句号直接拼接，一次告知用户。
                let notice = droppedCount > 0 ? DROPPED_LANGUAGE_NOTICE : undefined;
                if (!plan.sameLanguage) {
                    // 条目级门控：内容确属目标语言的缺失译文是重复劳动，不进补译；其余宁可多补不可漏补。
                    const missing = prepared.comments.filter(comment => !comment.translation
                        && !isCommentTranslationRedundant(comment.content, config.to));
                    const needsSource = !sourceTranslation;
                    if (needsSource || missing.length > 0) {
                        const payload = {source: needsSource ? request.text : null, comments: missing.map(comment => comment.content)};
                        const repairStartedAt = Date.now();
                        try {
                            const repair = await generateText({
                                model: createModel(config, service, model),
                                system: buildCommentTranslationRepairPrompt(config.to),
                                messages: [{role: 'user', content: JSON.stringify(payload)}],
                                maxRetries: 0,
                                maxOutputTokens: commentOutputBudget(needsSource ? request.text.length : 0, missing.length, thinkingEnabled),
                                abortSignal: signal,
                            });
                            const repairUsage = await repair.usage;
                            const repairResponse = await repair.response;
                            record(createHarnessUsageEvent({service, model, actualModel: repairResponse?.modelId, startedAt: repairStartedAt,
                                durationMs: Date.now() - repairStartedAt, usage: repairUsage, outcome: 'success'}));
                            const repaired = parseCommentRepairOutput(await repair.text, payload);
                            if (repaired) {
                                missing.forEach((comment, index) => { comment.translation = repaired.comments[index]!; });
                                if (repaired.source) sourceTranslation = repaired.source;
                            } else {
                                notice = `${notice ?? ''}${TRANSLATION_REPAIR_NOTICE}`;
                            }
                        } catch (repairError) {
                            // 用户取消必须继续向外抛，让外层统一走取消路径；其余补译失败只降级提示，不丢已生成的评论。
                            if (signal.aborted) throw repairError;
                            record(createHarnessUsageEvent({service, model, startedAt: repairStartedAt,
                                durationMs: Date.now() - repairStartedAt, outcome: 'error'}));
                            notice = `${notice ?? ''}${TRANSLATION_REPAIR_NOTICE}`;
                        }
                    }
                }
                // 纯成功路径不能携带 notice 键：面板与测试都依赖成功响应的可选字段语义。
                // 同语选区的选区译文没有跨语言价值，一律为 null；跨语言时模型译文或补译结果缺一即为 null。
                return {success: true, comments: sanitizeComments(prepared.comments),
                    sourceTranslation: plan.sameLanguage ? null : (sourceTranslation || null),
                    ...(notice ? {notice} : {})};
            } catch (error) {
                record(createHarnessUsageEvent({service, model, startedAt, durationMs: Date.now() - startedAt,
                    outcome: signal.aborted ? 'cancelled' : 'error'}));
                if (signal.aborted) return {success: false, error: '已取消', cancelled: true};
                // 网关与端点解析的文案按阅读助手措辞，这里与写作助手同样改成本功能名称。
                return failure(normalizeHarnessModelError(error, service, config.token[service] ?? '', config.customHeaders[service]).message
                    .replace(/阅读助手/gu, '评论') || '评论请求失败，请重试');
            }
        },
    };
}
