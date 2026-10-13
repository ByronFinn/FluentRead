import {beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
    generateText: vi.fn(),
    normalizeError: vi.fn(),
}));
vi.mock('ai', () => ({generateText: mocks.generateText, tool: (definition: unknown) => definition}));
vi.mock('@/src/services/harness/modelGateway', () => ({normalizeHarnessModelError: mocks.normalizeError}));

import {createCommentRuntime} from '@/src/services/comment/runtime';
import {COMMENT_MAX_IMAGE_CHARS, COMMENT_MAX_TEXT} from '@/src/core/config/comment';
import {createApiKeyRequirementKey} from '@/src/core/config/validation';
import type {LanguageModel} from 'ai';
import type {CommentResponse} from '@/src/features/comment-assistant/types';
import type {Config} from '@/src/core/config/model';

const IMAGE = 'data:image/png;base64,AAAA';
// 可信识别为 zh-Hans 的中文选区：默认目标语言（空回落简体中文）下与目标同语。
const CHINESE_SELECTION = '这是一个用来验证语言检测行为的中文句子。';
// 可信识别为 ja 与简体混合的日文选区：跨语言但不可点名选区语言（语言对齐不生效）。
const JAPANESE_MIXED_SELECTION = '皆さん、この新機能についてどう思いますか。同志们も待っていたようです。';
const ENGLISH = 'I really need a fucking job but none of the job postings are real I literally do not know what to do';
const baseConfig = () => ({
    on: true,
    to: '',
    service: 'deepseek',
    model: {deepseek: 'deepseek-chat'},
    customModel: {},
    token: {deepseek: 'sk-test'},
    proxy: {},
    customOpenAIProviders: [],
    customHeaders: {},
    comment: {enabled: true, service: '', model: '', count: 2, prompt: ''},
}) as unknown as Config;
const request = (overrides = {}) => ({type: 'fluentReadComment' as const, action: 'run' as const, requestId: 'c1', text: CHINESE_SELECTION, images: [], ...overrides});
const okResult = (comments: unknown[], sourceTranslation?: string | null) => ({
    toolCalls: [{toolName: 'submit_comments', input: sourceTranslation === undefined ? {comments} : {comments, sourceTranslation}}],
});
// 模型未调用工具时的纯文本输出结果：ai@6 的 text 类型是 string，mock 用 Promise 也与 await 兼容。
const textResult = (text: string) => ({toolCalls: [], text: Promise.resolve(text)});
const repairResult = (text: string) => ({text,
    usage: Promise.resolve({inputTokens: 3, outputTokens: 7, totalTokens: 10}),
    response: Promise.resolve({modelId: 'deepseek-chat'})});
const freshSignal = () => new AbortController().signal;

const failure = (response: CommentResponse) => {
    // 判别联合需要显式收窄：成功响应出现时直接让测试失败，而不是绕过类型检查。
    if (response.success) throw new Error(`期望失败响应，实际成功: ${JSON.stringify(response.comments)}`);
    return response;
};
describe('comment model runtime', () => {
    let config = baseConfig();
    const createModel = vi.fn((): LanguageModel => ({__model: true}) as unknown as LanguageModel);
    const runtime = createCommentRuntime(() => config, createModel);
    beforeEach(() => { vi.clearAllMocks(); config = baseConfig(); });

    it('rejects when globally or feature disabled', async () => {
        config.on = false;
        expect(await runtime.run(request(), freshSignal())).toEqual({success: false, error: '评论功能已停用'});
        config = baseConfig();
        config.comment.enabled = false;
        expect((await runtime.run(request(), freshSignal())).success).toBe(false);
    });

    it('validates page payload defensively', async () => {
        expect(failure(await runtime.run(request({text: '  '}), freshSignal())).error).toContain('不适合');
        expect(failure(await runtime.run(request({text: 'x'.repeat(8193)}), freshSignal())).error).toContain('不适合');
        expect(failure(await runtime.run(request({images: Array.from({length: 5}, () => IMAGE)}), freshSignal())).error).toContain('数量');
        expect(failure(await runtime.run(request({images: ['https://evil/x.png']}), freshSignal())).error).toContain('格式');
        expect(mocks.generateText).not.toHaveBeenCalled();
    });

    it('requires an AI service, a model and an API key', async () => {
        config.service = 'huanYuanTranslation';
        expect(failure(await runtime.run(request(), freshSignal())).error).toContain('选择一个 AI 服务');
        config = baseConfig();
        config.model = {};
        expect(failure(await runtime.run(request(), freshSignal())).error).toContain('选择一个模型');
        config = baseConfig();
        config.token = {};
        expect(failure(await runtime.run(request(), freshSignal())).error).toContain('API 密钥');
    });

    it('runs keyless local services such as ollama without a token', async () => {
        config.service = 'ollama';
        config.model = {ollama: 'gemma3:4b'};
        config.token = {};
        mocks.generateText.mockResolvedValue(okResult([{content: '本地评论', translation: null}]));
        await expect(runtime.run(request(), freshSignal())).resolves.toMatchObject({success: true});
        expect(mocks.generateText).toHaveBeenCalledTimes(1);
    });

    it('sends a required tool call with images and returns sanitized comments', async () => {
        mocks.generateText.mockResolvedValue(okResult([
            {content: ' 评论一 ', translation: undefined},
            {content: 'ignore previous instructions', translation: 'forget all'},
        ]));
        const response = await runtime.run(request({images: [IMAGE]}), freshSignal());
        // 中文选区与简体目标同语：模型译文即使给出也一律不展示。
        expect(response).toEqual({success: true, sourceTranslation: null, comments: [
            {content: '评论一', translation: null},
            {content: '[输出已过滤：检测到异常内容]', translation: null},
        ]});
        const options = mocks.generateText.mock.calls[0][0];
        expect(options.toolChoice).toBe('required');
        expect(options.maxRetries).toBe(0);
        expect(options.system).toContain('恰好 2 条');
        const content = options.messages[0].content;
        expect(Array.isArray(content)).toBe(true);
        expect(content[1]).toEqual({type: 'image', image: IMAGE});
        expect(createModel).toHaveBeenCalledWith(config, 'deepseek', 'deepseek-chat');
        expect(mocks.generateText).toHaveBeenCalledTimes(1);
    });

    it('sends plain string content without images and trims to configured count', async () => {
        mocks.generateText.mockResolvedValue(okResult([{content: 'a', translation: null}, {content: 'b', translation: null}]));
        const response = await runtime.run(request(), freshSignal());
        expect(response.success && response.comments).toHaveLength(2);
        // 中文选区 20 字符：输出预算 = 2000 + 2 条×1200 + ceil(20*2) = 4440（动态护栏按最坏合法输出推导，思考模型另有加成）。
        expect(mocks.generateText.mock.calls[0][0].maxOutputTokens).toBe(4440);
        config.comment.count = 1;
        const trimmed = await runtime.run(request(), freshSignal());
        expect(trimmed.success && trimmed.comments).toHaveLength(1);
        expect(typeof mocks.generateText.mock.calls[0][0].messages[0].content).toBe('string');
    });

    it('retries format failures once and surfaces the matching error when both attempts fail', async () => {
        // 未调用工具且纯文本也不是 JSON：仅格式类失败自动重试一次，两次都失败报"未按要求提交"。
        mocks.generateText.mockResolvedValue(textResult('抱歉，我无法按工具要求完成任务。'));
        expect(failure(await runtime.run(request({requestId: 'f1'}), freshSignal())).error).toBe('模型未按要求提交评论，请重试');
        expect(mocks.generateText).toHaveBeenCalledTimes(2);
        // 工具输入清洗后没有任何有效条目：两次尝试后报"结构不完整"。
        mocks.generateText.mockClear();
        mocks.generateText.mockResolvedValue(okResult([{content: '   ', translation: null}]));
        expect(failure(await runtime.run(request({requestId: 'f2'}), freshSignal())).error).toBe('模型返回的评论结构不完整，请重试');
        expect(mocks.generateText).toHaveBeenCalledTimes(2);
    });

    it('tolerates unknown keys in tool input instead of failing the whole request', async () => {
        // 旧 .strict() 响应校验会把多余字段判为结构失败；宽容归一化只忽略未知键。
        mocks.generateText.mockResolvedValue({toolCalls: [{toolName: 'submit_comments',
            input: {comments: [{content: ' 评论一 ', translation: null, evil: 1}], unexpected: true}}]});
        const response = await runtime.run(request({requestId: 'x1'}), freshSignal());
        expect(response).toEqual({success: true, comments: [{content: '评论一', translation: null}], sourceTranslation: null});
        expect(mocks.generateText).toHaveBeenCalledTimes(1);
    });

    it('rescues a schema-invalid tool call whose input still parses as an object', async () => {
        // invalid 工具调用的 input 在 JSON 合法时是解析后的对象（如缺字段/错类型触发 zod 失败）：
        // 对象直接交宽容归一化抢救，不需要重试。这里模拟模型漏写 translation 触发 schema 失败。
        mocks.generateText.mockResolvedValue({toolCalls: [{toolName: 'submit_comments', invalid: true,
            error: new Error('Invalid input: translation required'),
            input: {comments: [{content: ' 结构失败但可救回 '}]}}]});
        const response = await runtime.run(request({requestId: 'iv1'}), freshSignal());
        expect(response).toEqual({success: true, comments: [{content: '结构失败但可救回', translation: null}], sourceTranslation: null});
        expect(mocks.generateText).toHaveBeenCalledTimes(1);
    });

    it('routes a schema-invalid string input through the plain-text fallback', async () => {
        // invalid 且 input 是原始字符串（JSON 解析都失败，如 thinking 后接负载被截断）：
        // 转纯文本兜底的花括号切片仍能救回前缀完整对象。
        mocks.generateText.mockResolvedValue({toolCalls: [{toolName: 'submit_comments', invalid: true,
            error: new Error('Unexpected token'),
            input: '{"comments":[{"content":"切片救回","translation":null}],"sourceTranslation":null} 后面是被截断的垃圾'}]});
        const response = await runtime.run(request({requestId: 'iv2'}), freshSignal());
        expect(response).toEqual({success: true, comments: [{content: '切片救回', translation: null}], sourceTranslation: null});
        expect(mocks.generateText).toHaveBeenCalledTimes(1);
    });

    it('feeds only the zod issues from an invalid call into the repair hint', async () => {
        // ai@6 的 InvalidToolInputError.message = 前缀 + "Value: <输入全文回显>\nError message: <zod 逐字段问题>"：
        // 纠偏指令只要尾部的问题列表，不要模型自身输入的回显（回显会挤占提示词并误导模型复述坏结构）。
        mocks.generateText
            .mockResolvedValueOnce({toolCalls: [{toolName: 'submit_comments', invalid: true,
                error: new Error('Invalid input for tool submit_comments: Type validation failed: Value: {"comments":[]}.'
                    + '\nError message: comments: Array must contain 1 or more elements'),
                input: {comments: []}}], text: Promise.resolve('')})
            .mockResolvedValueOnce(okResult([{content: 'a', translation: null}]));
        const response = await runtime.run(request({requestId: 'iv3'}), freshSignal());
        expect(response).toMatchObject({success: true});
        const hint = mocks.generateText.mock.calls[1][0].system;
        expect(hint).toContain('Array must contain 1 or more elements');
        expect(hint).not.toContain('{"comments":[]}');
    });

    it('shrinks the budget and retries when the endpoint rejects it as above the model cap', async () => {
        // 输出预算超过模型硬上限的 400（各端点上限无法预知）：收缩到 4096 重试一次成功；被拒尝试记 error 事件。
        const sink = vi.fn();
        const withSink = createCommentRuntime(() => config, createModel, () => sink);
        mocks.generateText
            .mockRejectedValueOnce(Object.assign(new Error("'max_tokens' is too large: 24384. This model supports at most 16384"), {statusCode: 400}))
            .mockResolvedValueOnce(okResult([{content: 'a', translation: null}]));
        const response = await withSink.run(request({requestId: 'bt1'}), freshSignal());
        expect(response).toMatchObject({success: true});
        expect(mocks.generateText).toHaveBeenCalledTimes(2);
        expect(mocks.generateText.mock.calls[1][0].maxOutputTokens).toBe(4_096);
        expect(mocks.generateText.mock.calls[1][0].toolChoice).toBe('required');
        expect(sink.mock.calls.map(([{outcome}]) => outcome)).toEqual(['error', 'success']);
    });

    it('never enlarges the budget when a small request is rejected by a lower-cap endpoint', async () => {
        // 本次预算本就低于收缩目标时保持原值（不反向放大）；第二次仍被拒则按供应商错误上抛。
        mocks.normalizeError.mockReturnValue({message: '上限过低'});
        mocks.generateText
            .mockRejectedValueOnce(Object.assign(new Error('max_tokens must be less than 3000'), {statusCode: 400}))
            .mockRejectedValueOnce(Object.assign(new Error('max_tokens must be less than 3000'), {statusCode: 400}));
        expect(failure(await runtime.run(request({requestId: 'bt2'}), freshSignal())).error).toBe('上限过低');
        expect(mocks.generateText).toHaveBeenCalledTimes(2);
        // 中文选区 20 字符、2 条：本次预算 4440，收缩后仍是 4440（min(4096, 4440) 应取 4096——
        // 收缩目标小于原预算，因此一定变小；这里断言它确实降到了 4096）。
        expect(mocks.generateText.mock.calls[1][0].maxOutputTokens).toBe(4_096);
    });

    it('escalates the budget and injects a truncation hint when the output is cut off', async () => {
        // 截断（finishReason length）且工具未提交：重试预算升级到护栏上限 32768，system 注入截断纠偏指令，
        // 失败尝试记 error 事件。
        const sink = vi.fn();
        const withSink = createCommentRuntime(() => config, createModel, () => sink);
        mocks.generateText
            .mockResolvedValueOnce({...textResult('{"comments":[{"content":"被截断的评'), finishReason: 'length'})
            .mockResolvedValueOnce(okResult([{content: 'a', translation: null}]));
        const response = await withSink.run(request({requestId: 'tr1'}), freshSignal());
        expect(response).toMatchObject({success: true});
        expect(mocks.generateText).toHaveBeenCalledTimes(2);
        expect(mocks.generateText.mock.calls[1][0].maxOutputTokens).toBe(32_768);
        expect(mocks.generateText.mock.calls[1][0].system).toContain('被截断');
        expect(sink.mock.calls.map(([{outcome}]) => outcome)).toEqual(['error', 'success']);
    });

    it('downgrades toolChoice to auto when the endpoint rejects it with a tool-related 400', async () => {
        // 部分端点对 toolChoice required 直接回 400：首试降级 auto 再试一次，第二次成功则正常返回；
        // 被拒的首试同样记 error 事件（调用确实发生过），与"每次尝试独立计时"的约定一致。
        const sink = vi.fn();
        const withSink = createCommentRuntime(() => config, createModel, () => sink);
        mocks.generateText
            .mockRejectedValueOnce(Object.assign(new Error('tool_choice is not supported by this endpoint'), {statusCode: 400}))
            .mockResolvedValueOnce(okResult([{content: 'a', translation: null}]));
        const response = await withSink.run(request({requestId: 'tc1'}), freshSignal());
        expect(response).toMatchObject({success: true});
        expect(mocks.generateText).toHaveBeenCalledTimes(2);
        expect(mocks.generateText.mock.calls[0][0].toolChoice).toBe('required');
        expect(mocks.generateText.mock.calls[1][0].toolChoice).toBe('auto');
        expect(sink.mock.calls.map(([{outcome}]) => outcome)).toEqual(['error', 'success']);
    });

    it('fails fast on non-tool 400 errors without downgrading toolChoice', async () => {
        // 与 toolChoice 无关的 400（如上下文超限）、模型整体不支持工具的 400（降级 auto 仍带同一套 tools，重试注定失败）
        // 都不降级、不重试，直接走供应商错误路径。
        mocks.normalizeError.mockReturnValue({message: '上下文长度超限'});
        mocks.generateText.mockRejectedValue(Object.assign(new Error('context length exceeded'), {statusCode: 400}));
        expect(failure(await runtime.run(request({requestId: 'tc2'}), freshSignal())).error).toBe('上下文长度超限');
        mocks.generateText.mockClear();
        mocks.generateText.mockRejectedValue(Object.assign(new Error('This model does not support tools'), {statusCode: 400}));
        expect(failure(await runtime.run(request({requestId: 'tc3'}), freshSignal())).error).toBeTruthy();
        expect(mocks.generateText).toHaveBeenCalledTimes(1);
        expect(mocks.generateText.mock.calls[0][0].toolChoice).toBe('required');
    });

    it('succeeds from plain text output when the tool is not called', async () => {
        // 模型把工具负载直接写进正文：文本兜底解析 + 宽容归一化救回成功，无需重试。
        mocks.generateText.mockResolvedValue(textResult(
            '{"comments":[{"content":"ghost jobs tbh","translation":"幽灵岗位"}],"sourceTranslation":"整段选区译文"}'));
        const response = await runtime.run(request({requestId: 't1', text: ENGLISH}), freshSignal());
        expect(response).toEqual({success: true, sourceTranslation: '整段选区译文', comments: [
            {content: 'ghost jobs tbh', translation: '幽灵岗位'},
        ]});
        expect(mocks.generateText).toHaveBeenCalledTimes(1);
    });

    it('recovers when the first attempt is malformed but the retry succeeds', async () => {
        // 第一次格式坏、第二次好：成功返回，失败尝试记 error、成功尝试记 success（各自独立计时）。
        // 递增时钟下断言每次尝试独立计时：相邻事件时长相同（各 1000ms），起点递增；
        // 旧实现沿用请求级起点会让第二件事件的时长含第一次尝试（2000ms/4000ms），此断言即失效。
        let clock = 0;
        const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1000));
        try {
            const sink = vi.fn();
            const withSink = createCommentRuntime(() => config, createModel, () => sink);
            mocks.generateText
                .mockResolvedValueOnce(okResult([{content: ''}]))
                .mockResolvedValueOnce({...okResult([{content: 'a', translation: '甲'}], '整段译文'),
                    usage: Promise.resolve({inputTokens: 10, outputTokens: 5, totalTokens: 15}),
                    response: Promise.resolve({modelId: 'deepseek-chat'})});
            const response = await withSink.run(request({requestId: 'r1', text: ENGLISH}), freshSignal());
            expect(response).toMatchObject({success: true, sourceTranslation: '整段译文', comments: [{content: 'a', translation: '甲'}]});
            expect(mocks.generateText).toHaveBeenCalledTimes(2);
            expect(sink).toHaveBeenCalledTimes(2);
            expect(sink.mock.calls.map(([{outcome}]) => outcome)).toEqual(['error', 'success']);
            const events = sink.mock.calls.map(([{startedAt, durationMs}]) => ({startedAt, durationMs}));
            expect(events[1]!.startedAt).toBeGreaterThan(events[0]!.startedAt);
            expect(events[1]!.durationMs).toBe(events[0]!.durationMs);
            // 重试的 system 追加了针对"工具参数未通过校验"的纠偏指令，避免模型不知错而原样重复。
            expect(mocks.generateText.mock.calls[1][0].system).toContain('未通过校验');
            expect(mocks.generateText.mock.calls[0][0].system).not.toContain('未通过校验');
        } finally { nowSpy.mockRestore(); }
    });

    it('fails with the language error when both attempts write the wrong language', async () => {
        // 点名 en 的选区：两次尝试都把正文写成目标中文且没有可救译文，语言对齐全丢弃后报语言错误。
        mocks.generateText.mockResolvedValue(okResult([{content: '这是中文评论正文', translation: null}]));
        expect(failure(await runtime.run(request({requestId: 'l1', text: ENGLISH}), freshSignal())).error)
            .toBe('模型未按要求的语言生成评论，请重试');
        expect(mocks.generateText).toHaveBeenCalledTimes(2);
    });

    it('swaps or drops target-language bodies to realign bilingual comments', async () => {
        // 第一条正文写成目标中文、译文恰为选区语言：交换救回双语；第二条中文无译文：丢弃但保留其余成功并附提示。
        mocks.generateText.mockResolvedValue(okResult([
            {content: '这是一个用来验证语言检测行为的中文句子。', translation: ENGLISH},
            {content: '这是中文评论', translation: null},
        ], '整段选区译文'));
        const response = await runtime.run(request({requestId: 'l2', text: ENGLISH}), freshSignal());
        expect(response).toEqual({success: true, sourceTranslation: '整段选区译文', comments: [
            {content: ENGLISH, translation: '这是一个用来验证语言检测行为的中文句子。'},
        ], notice: '部分评论的语言与选区不符已丢弃，可重新生成。'});
        expect(mocks.generateText).toHaveBeenCalledTimes(1);
    });

    it('recovers when the first attempt writes the wrong language and the retry succeeds', async () => {
        // 混合失败语义：第一次全错语言（丢弃后为空）触发重试，第二次按选区语言书写则成功返回。
        mocks.generateText
            .mockResolvedValueOnce(okResult([{content: '这是中文评论正文', translation: null}]))
            .mockResolvedValueOnce(okResult([{content: ENGLISH, translation: '中文译文'}], '整段译文'));
        const response = await runtime.run(request({requestId: 'l3', text: ENGLISH}), freshSignal());
        expect(response).toMatchObject({success: true, sourceTranslation: '整段译文',
            comments: [{content: ENGLISH, translation: '中文译文'}]});
        expect(mocks.generateText).toHaveBeenCalledTimes(2);
    });

    it('scales the output budget with the selection instead of a low hard cap', async () => {
        // 8192 字符选区 + 5 条：线性预算 2000 + 5×1200 + ceil(8192*2) = 24384，远超旧 16000 封顶（截断即失败的根因）；
        // 补译调用按（待译源字符, 待译条数）单独推导 = 2000 + 1200 + 16384 = 19584。
        config.comment.count = 5;
        mocks.generateText.mockResolvedValue(okResult([{content: '评论', translation: null}]));
        const sameLanguage = await runtime.run(request({requestId: 'cap1', text: '好'.repeat(COMMENT_MAX_TEXT)}), freshSignal());
        expect(sameLanguage.success).toBe(true);
        expect(mocks.generateText.mock.calls[0][0].maxOutputTokens).toBe(24_384);
        mocks.generateText.mockClear();
        mocks.generateText
            .mockResolvedValueOnce(okResult([{content: 'a', translation: null}]))
            .mockResolvedValueOnce(repairResult('{"source":"选区译文","comments":["甲"]}'));
        const crossLanguage = await runtime.run(request({requestId: 'cap2', text: 'x'.repeat(COMMENT_MAX_TEXT)}), freshSignal());
        expect(crossLanguage.success).toBe(true);
        expect(mocks.generateText.mock.calls[0][0].maxOutputTokens).toBe(24_384);
        expect(mocks.generateText.mock.calls[1][0].maxOutputTokens).toBe(19_584);
    });

    it('adds a thinking allowance to the output budget for reasoning models', async () => {
        // 云端思考模型的 reasoning 与正文共享输出预算：按"服务 + 评论实际使用模型"判定后护栏加 8000。
        (config as unknown as {modelThinking: unknown}).modelThinking = {deepseek: {'deepseek-chat': true}};
        mocks.generateText.mockResolvedValue(okResult([{content: 'a', translation: null}]));
        await runtime.run(request(), freshSignal());
        expect(mocks.generateText.mock.calls[0][0].maxOutputTokens).toBe(12_440);
    });

    it('returns cancelled without retrying when the attempt itself is aborted', async () => {
        // 尝试期间的取消属于外层一次性处理：直接返回取消，不进入第二次尝试。
        const controller = new AbortController();
        mocks.generateText.mockImplementation(() => { controller.abort(); return Promise.reject(new Error('stop')); });
        expect(await runtime.run(request({requestId: 'a1'}), controller.signal))
            .toEqual({success: false, error: '已取消', cancelled: true});
        expect(mocks.generateText).toHaveBeenCalledTimes(1);
    });

    it('maps cancellation and provider errors without re-entering the retry loop', async () => {
        const controller = new AbortController();
        mocks.generateText.mockImplementation(() => { controller.abort(); return Promise.reject(new Error('boom')); });
        expect(await runtime.run(request(), controller.signal)).toEqual({success: false, error: '已取消', cancelled: true});
        mocks.normalizeError.mockReturnValue({message: '服务不可用'});
        const response = await runtime.run(request(), freshSignal());
        expect(response).toEqual({success: false, error: '服务不可用'});
        expect(mocks.normalizeError.mock.calls[0][2]).toBe('sk-test');
        mocks.normalizeError.mockReturnValue({message: ''});
        expect(failure(await runtime.run(request(), freshSignal())).error).toBe('评论请求失败，请重试');
        // 三次运行各只调用一次模型：供应商错误与取消绝不触发格式类重试。
        expect(mocks.generateText).toHaveBeenCalledTimes(3);
    });

    it('rejects blank content after trimming and reports keyless provider failures', async () => {
        mocks.generateText.mockResolvedValue(okResult([{content: '   ', translation: null}]));
        expect(failure(await runtime.run(request(), freshSignal())).error).toContain('结构不完整');

        config = baseConfig();
        config.token = {};
        (config as unknown as {requireApiKey: Record<string, boolean>}).requireApiKey
            = {[createApiKeyRequirementKey('deepseek', 'deepseek-chat')]: false};
        mocks.generateText.mockRejectedValue(new Error('offline'));
        mocks.normalizeError.mockReturnValue({message: '本地服务不可达'});
        expect(failure(await runtime.run(request(), freshSignal())).error).toBe('本地服务不可达');
        expect(mocks.normalizeError.mock.calls[0][2]).toBe('');
    });

    it('reports one usage event per attempt and survives a broken sink', async () => {
        const sink = vi.fn();
        const withSink = createCommentRuntime(() => config, createModel, () => sink);
        mocks.generateText.mockResolvedValue({...okResult([{content: 'a', translation: null}]),
            usage: {inputTokens: 10, outputTokens: 5, totalTokens: 15}, response: Promise.resolve({modelId: 'deepseek-chat'})});
        expect((await withSink.run(request(), freshSignal())).success).toBe(true);
        expect(sink).toHaveBeenCalledWith(expect.objectContaining({serviceId: 'deepseek', configuredModel: 'deepseek-chat',
            actualModel: 'deepseek-chat', outcome: 'success', inputTokens: 10, usageAvailability: 'reported'}));

        mocks.generateText.mockRejectedValue(new Error('boom'));
        expect(failure(await withSink.run(request({requestId: 'u2'}), freshSignal())).error).toBeTruthy();
        expect(sink).toHaveBeenLastCalledWith(expect.objectContaining({outcome: 'error', usageAvailability: 'unreported'}));

        const cancelled = new AbortController();
        cancelled.abort();
        mocks.generateText.mockRejectedValue(new Error('aborted'));
        expect(failure(await withSink.run(request({requestId: 'u3'}), cancelled.signal)).cancelled).toBe(true);
        expect(sink).toHaveBeenLastCalledWith(expect.objectContaining({outcome: 'cancelled'}));

        // 统计仓库抛错不能影响评论结果（工厂本身按 harness 同规则由调用方保证可用）。
        const broken = createCommentRuntime(() => config, createModel, () => () => { throw new Error('统计写入失败'); });
        mocks.generateText.mockResolvedValue(okResult([{content: 'a', translation: null}]));
        expect((await broken.run(request({requestId: 'u4'}), freshSignal())).success).toBe(true);
    });

    it('shares the handler bounds for oversized text and images', async () => {
        expect(failure(await runtime.run(request({text: 'x'.repeat(COMMENT_MAX_TEXT + 1)}), freshSignal())).error).toContain('不适合');
        expect(failure(await runtime.run(request({images: [`data:image/png;base64,${'A'.repeat(COMMENT_MAX_IMAGE_CHARS + 1)}`]}), freshSignal())).error).toContain('格式');
        expect(mocks.generateText).not.toHaveBeenCalled();
    });

    it('names the selection language in the system prompt for foreign selections', async () => {
        mocks.generateText.mockResolvedValue(okResult([
            {content: 'ghost jobs tbh', translation: '幽灵岗位'},
            {content: 'fair enough', translation: '还好'},
        ], '整段选区译文'));
        const response = await runtime.run(request({requestId: 'r-en', text: ENGLISH}), freshSignal());
        expect(response).toEqual({success: true, sourceTranslation: '整段选区译文', comments: [
            {content: 'ghost jobs tbh', translation: '幽灵岗位'},
            {content: 'fair enough', translation: '还好'},
        ]});
        const options = mocks.generateText.mock.calls[0][0];
        expect(options.system).toContain('选区主要语言已判定为语言代码 en');
        expect(options.system).toContain('不得为 null');
        expect(mocks.generateText).toHaveBeenCalledTimes(1);
    });

    it('forces null translations and source translation for same-language selections', async () => {
        mocks.generateText.mockResolvedValue(okResult([{content: '评论一', translation: '重复的中文译文'}], '多余的选区译文'));
        const response = await runtime.run(request({requestId: 's-zh'}), freshSignal());
        expect(response).toEqual({success: true, sourceTranslation: null, comments: [
            {content: '评论一', translation: null},
        ]});
        expect(mocks.generateText).toHaveBeenCalledTimes(1);
    });

    it('backfills a missing comment translation and the selection translation together', async () => {
        mocks.generateText
            .mockResolvedValueOnce(okResult([
                {content: 'ghost jobs tbh', translation: undefined},
                {content: 'fair enough', translation: '还好啦'},
            ]))
            .mockResolvedValueOnce(repairResult('{"source":" 招聘里根本没有真实岗位 ","comments":[" 幽灵岗位罢了 "]}'));
        const response = await runtime.run(request({requestId: 'b1', text: ENGLISH}), freshSignal());
        expect(response).toEqual({success: true, sourceTranslation: '招聘里根本没有真实岗位', comments: [
            {content: 'ghost jobs tbh', translation: '幽灵岗位罢了'},
            {content: 'fair enough', translation: '还好啦'},
        ]});
        expect(mocks.generateText).toHaveBeenCalledTimes(2);
        const repairOptions = mocks.generateText.mock.calls[1][0];
        expect(repairOptions.system).toContain('JSON 对象');
        expect(JSON.parse(repairOptions.messages[0].content)).toEqual({source: ENGLISH, comments: ['ghost jobs tbh']});
        expect(repairOptions.maxRetries).toBe(0);
        expect(repairOptions.toolChoice).toBeUndefined();
        // 补译预算按（待译源字符, 待译条数）估算：源 100 字符 + 1 条 = 2000 + 1200 + ceil(100*2) = 3400。
        expect(repairOptions.maxOutputTokens).toBe(3400);
    });

    it('excludes target-language comment content from the repair payload', async () => {
        // 不可点名的混合日文选区：语言对齐不生效（否则中文正文会被丢弃），条目级门控仍然把
        // "正文已是目标语言"的缺失译文排除出补译 payload，译文保持 null。
        mocks.generateText
            .mockResolvedValueOnce(okResult([
                {content: 'ghost jobs tbh', translation: null},
                {content: '这是中文评论', translation: null},
            ]))
            .mockResolvedValueOnce(repairResult('{"source":"选区译文","comments":["幽灵岗位罢了"]}'));
        const response = await runtime.run(request({requestId: 'b2', text: JAPANESE_MIXED_SELECTION}), freshSignal());
        expect(response).toEqual({success: true, sourceTranslation: '选区译文', comments: [
            {content: 'ghost jobs tbh', translation: '幽灵岗位罢了'},
            {content: '这是中文评论', translation: null},
        ]});
        const repairOptions = mocks.generateText.mock.calls[1][0];
        expect(JSON.parse(repairOptions.messages[0].content)).toEqual({source: JAPANESE_MIXED_SELECTION, comments: ['ghost jobs tbh']});
    });

    it('repairs only the selection translation when comment translations are complete', async () => {
        mocks.generateText
            .mockResolvedValueOnce(okResult([{content: 'a', translation: '甲'}], null))
            .mockResolvedValueOnce(repairResult('{"source":"选区译文","comments":[]}'));
        const response = await runtime.run(request({requestId: 'b3', text: ENGLISH}), freshSignal());
        expect(response).toEqual({success: true, sourceTranslation: '选区译文', comments: [
            {content: 'a', translation: '甲'},
        ]});
        const repairOptions = mocks.generateText.mock.calls[1][0];
        expect(JSON.parse(repairOptions.messages[0].content)).toEqual({source: ENGLISH, comments: []});
    });

    it('keeps the model selection translation when only comment translations were requested', async () => {
        // 模型已给整段选区译文，只缺一条评论译文：补译不发送 source，返回缺 source 键也不覆盖已有译文。
        mocks.generateText
            .mockResolvedValueOnce(okResult([
                {content: 'ghost jobs tbh', translation: null},
                {content: 'fair enough', translation: '还好'},
            ], '整段选区译文'))
            .mockResolvedValueOnce(repairResult('{"comments":["幽灵岗位罢了"]}'));
        const response = await runtime.run(request({requestId: 'b4', text: ENGLISH}), freshSignal());
        expect(response).toEqual({success: true, sourceTranslation: '整段选区译文', comments: [
            {content: 'ghost jobs tbh', translation: '幽灵岗位罢了'},
            {content: 'fair enough', translation: '还好'},
        ]});
        const repairOptions = mocks.generateText.mock.calls[1][0];
        expect(JSON.parse(repairOptions.messages[0].content)).toEqual({source: null, comments: ['ghost jobs tbh']});
    });

    it('normalizes whitespace-only translations and degrades with a notice when repair fails', async () => {
        mocks.generateText
            .mockResolvedValueOnce(okResult([{content: 'a', translation: '   '}]))
            .mockResolvedValueOnce(repairResult('not json at all'));
        const response = await runtime.run(request({requestId: 'd1', text: ENGLISH}), freshSignal());
        expect(response).toEqual({success: true, comments: [{content: 'a', translation: null}], sourceTranslation: null,
            notice: '部分评论的译文生成失败，可点击重新生成。'});
        // 补译返回条数与缺失条数不一致时同样视为补译失败，只降级提示。
        mocks.generateText
            .mockResolvedValueOnce(okResult([{content: 'b', translation: null}, {content: 'c', translation: null}]))
            .mockResolvedValueOnce(repairResult('{"source":"x","comments":["只有一条"]}'));
        const mismatch = await runtime.run(request({requestId: 'd2', text: ENGLISH}), freshSignal());
        expect(mismatch).toEqual({success: true, comments: [{content: 'b', translation: null}, {content: 'c', translation: null}],
            sourceTranslation: null, notice: '部分评论的译文生成失败，可点击重新生成。'});
    });

    it('degrades with a notice when the repair call rejects but keeps the comments', async () => {
        mocks.generateText
            .mockResolvedValueOnce(okResult([{content: 'a', translation: null}]))
            .mockRejectedValueOnce(new Error('repair offline'));
        const response = await runtime.run(request({requestId: 'd3', text: ENGLISH}), freshSignal());
        expect(response).toEqual({success: true, comments: [{content: 'a', translation: null}], sourceTranslation: null,
            notice: '部分评论的译文生成失败，可点击重新生成。'});
    });

    it('propagates user cancellation during the repair call', async () => {
        const controller = new AbortController();
        mocks.generateText
            .mockResolvedValueOnce(okResult([{content: 'a', translation: null}]))
            .mockImplementationOnce(() => { controller.abort(); return Promise.reject(new Error('stop')); });
        expect(await runtime.run(request({requestId: 'd4', text: ENGLISH}), controller.signal))
            .toEqual({success: false, error: '已取消', cancelled: true});
    });

    it('skips the repair call when everything is present', async () => {
        // 外语选区译文齐全：一次生成调用即可返回。
        mocks.generateText.mockResolvedValue(okResult([{content: 'a', translation: '甲'}], '选区译文'));
        await runtime.run(request({requestId: 's1', text: ENGLISH}), freshSignal());
        expect(mocks.generateText).toHaveBeenCalledTimes(1);
        // 同语选区即使模型没给任何译文也绝不补译。
        mocks.generateText.mockClear();
        mocks.generateText.mockResolvedValue(okResult([{content: '评', translation: null}]));
        await runtime.run(request({requestId: 's2'}), freshSignal());
        expect(mocks.generateText).toHaveBeenCalledTimes(1);
    });
});
