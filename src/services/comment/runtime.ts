/**
 * @file src/services/comment/runtime.ts
 * 文件职责：把评论请求组装为一次强制工具调用的模型生成，并把结果校验、清洗为可展示的评论列表。
 * 主要内容：偏好与服务的最终规范化、安全壳提示词与选区包装、submit_comments 工具的 zod 严格契约、
 * toolChoice required 的 generateText 调用、按条数裁剪与泄漏清洗、模型用量事件上报，以及供应商错误的统一归一。
 * 模块边界：只在后台执行，不读取网页 DOM、不管理取消与并发（由 feature handler 负责）、不持久化评论结果。
 */
import {generateText, tool, type LanguageModel} from 'ai';
import {z} from 'zod';
import {buildCommentSystemPrompt, buildCommentUserText, sanitizeComments} from '@/src/core/comment/prompts';
import {COMMENT_MAX_IMAGE_CHARS, COMMENT_MAX_IMAGES, COMMENT_MAX_TEXT, normalizeCommentPreferences, resolveCommentModel} from '@/src/core/config/comment';
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
}).strict();

export type CommentModelFactory = (config: Config, service: string, model: string) => LanguageModel;
export type CommentUsageSink = (event: ModelUsageEvent) => void;

function failure(error: string): CommentResponse { return {success: false, error}; }

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
            if (isApiKeyRequired(service, config) && !config.token[service]?.trim()) return failure('当前服务尚未配置 API 密钥');
            const system = buildCommentSystemPrompt(preferences.prompt, preferences.count, config.to);
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
                    .map(comment => ({content: comment.content.trim(), translation: comment.translation === undefined ? null : comment.translation}));
                if (comments.some(comment => !comment.content)) return failure('模型返回的评论结构不完整，请重试');
                return {success: true, comments: sanitizeComments(comments)};
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
