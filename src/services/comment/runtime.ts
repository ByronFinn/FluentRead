/**
 * @file src/services/comment/runtime.ts
 * 文件职责：把评论请求组装为一次强制工具调用的模型生成，并把结果校验、清洗为可展示的双语评论列表与选区译文。
 * 主要内容：偏好与服务的最终规范化（本地免密服务不强制密钥）、安全壳提示词与选区包装、语言判定前置
 * （resolveCommentLanguagePlan 的结论注入提示词三态语言段）、submit_comments 工具的 zod 严格契约（含 sourceTranslation）、
 * toolChoice required 的 generateText 调用、按条数裁剪、同语时译文强制 null、按条目内容门控（isCommentTranslationRedundant）
 * 的定向补译与选区译文补齐调用与取消透传、补译失败降级 notice、泄漏清洗、模型用量事件上报，以及供应商错误的统一归一。
 * 模块边界：只在后台执行，不读取网页 DOM、不管理取消与并发（由 feature handler 负责）、不持久化评论结果。
 */
import {generateText, tool, type LanguageModel} from 'ai';
import {z} from 'zod';
import {buildCommentSystemPrompt, buildCommentUserText, sanitizeComments} from '@/src/core/comment/prompts';
import {
    buildCommentTranslationRepairPrompt, isCommentTranslationRedundant, parseCommentRepairOutput, resolveCommentLanguagePlan,
} from '@/src/core/comment/repair';
import {COMMENT_MAX_IMAGE_CHARS, COMMENT_MAX_IMAGES, COMMENT_MAX_TEXT, normalizeCommentPreferences, resolveCommentModel} from '@/src/core/config/comment';
import {servicesType} from '@/src/core/config/catalog';
import {isHarnessService} from '@/src/core/config/harness';
import {isApiKeyRequired} from '@/src/core/config/validation';
import {createHarnessUsageEvent} from '@/src/services/harness/usage';
import type {Config} from '@/src/core/config/model';
import type {ModelUsageEvent} from '@/src/services/model-usage/types';
import {normalizeHarnessModelError} from '@/src/services/harness/modelGateway';
import type {CommentItem, CommentRequest, CommentResponse} from '@/src/features/comment-assistant/types';

const COMMENT_INPUT = z.object({
    comments: z.array(z.object({
        content: z.string().min(1).max(500),
        translation: z.union([z.string().max(500), z.null()]).optional(),
    }).strict()).min(1).max(10),
    sourceTranslation: z.union([z.string().max(COMMENT_MAX_TEXT), z.null()]).optional(),
}).strict();

export type CommentModelFactory = (config: Config, service: string, model: string) => LanguageModel;
export type CommentUsageSink = (event: ModelUsageEvent) => void;

function failure(error: string): CommentResponse { return {success: false, error}; }

/** 定向补译失败时的降级提示：评论照常展示，译文由用户重新生成补救。 */
const TRANSLATION_REPAIR_NOTICE = '部分评论的译文生成失败，可点击重新生成。';

/** 页面输入不可信：文本与 data URL 图片在入口再校验一次，与 handler 共用同一组上限常量。 */
function validateRequest(request: CommentRequest): string | undefined {
    const text = request.text.trim();
    if (!text || text.length > COMMENT_MAX_TEXT) return '选中内容不适合作为评论素材';
    if (!Array.isArray(request.images) || request.images.length > COMMENT_MAX_IMAGES) return '图片数量超出限制';
    return request.images.every(image => /^data:image\/(?:png|jpeg|webp);base64,/u.test(image)
        && image.length > 0 && image.length <= COMMENT_MAX_IMAGE_CHARS) ? undefined : '图片格式不支持';
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
                const result = await generateText({
                    model: createModel(config, service, model),
                    system,
                    messages: [{role: 'user', content}],
                    tools: {submit_comments: tool({description: '提交生成的评论列表。', inputSchema: COMMENT_INPUT})},
                    toolChoice: 'required',
                    maxRetries: 0,
                    abortSignal: signal,
                });
                const usage = await result.usage;
                const response = await result.response;
                record(createHarnessUsageEvent({service, model, actualModel: response?.modelId, startedAt,
                    durationMs: Date.now() - startedAt, usage, outcome: 'success'}));
                const call = result.toolCalls.find(toolCall => toolCall.toolName === 'submit_comments');
                if (!call) return failure('模型未按要求提交评论，请重试');
                const parsed = COMMENT_INPUT.safeParse(call.input);
                if (!parsed.success) return failure('模型返回的评论结构不完整，请重试');
                const comments: CommentItem[] = parsed.data.comments.slice(0, preferences.count)
                    .map(comment => ({
                        content: comment.content.trim(),
                        // 同语选区即使模型给出了译文也不展示：与选区重复的译文没有信息量。
                        translation: plan.sameLanguage ? null : (comment.translation?.trim() || null),
                    }));
                if (comments.some(comment => !comment.content)) return failure('模型返回的评论结构不完整，请重试');
                let sourceTranslation = typeof parsed.data.sourceTranslation === 'string' ? parsed.data.sourceTranslation.trim() : '';
                let notice: string | undefined;
                if (!plan.sameLanguage) {
                    // 条目级门控：内容确属目标语言的缺失译文是重复劳动，不进补译；其余宁可多补不可漏补。
                    const missing = comments.filter(comment => !comment.translation
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
                                notice = TRANSLATION_REPAIR_NOTICE;
                            }
                        } catch (repairError) {
                            // 用户取消必须继续向外抛，让外层统一走取消路径；其余补译失败只降级提示，不丢已生成的评论。
                            if (signal.aborted) throw repairError;
                            record(createHarnessUsageEvent({service, model, startedAt: repairStartedAt,
                                durationMs: Date.now() - repairStartedAt, outcome: 'error'}));
                            notice = TRANSLATION_REPAIR_NOTICE;
                        }
                    }
                }
                // 纯成功路径不能携带 notice 键：面板与测试都依赖成功响应的可选字段语义。
                // 同语选区的选区译文没有跨语言价值，一律为 null；跨语言时模型译文或补译结果缺一即为 null。
                return {success: true, comments: sanitizeComments(comments),
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
