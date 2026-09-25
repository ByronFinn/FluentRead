import {describe, expect, it} from 'vitest';
import {
    buildCommentTranslationRepairPrompt, isCommentTranslationRedundant, parseCommentRepairOutput, resolveCommentLanguagePlan,
} from '@/src/core/comment/repair';

// 选区与内容语言均已在本地实证：中文长句识别 zh-Hans，英文长句识别 en，
// 混入简体专用字形的日文命中 identifyCjk 的 MIXED 分支（假名 + 简体字形证据）。
const CHINESE = '这是一个用来验证语言检测行为的中文句子。';
const ENGLISH = 'I really need a job but none of the job postings are real I literally do not know what to do';
const JAPANESE_MIXED = '皆さん、この新機能についてどう思いますか。同志们も待っていたようです。';

describe('comment language plan and repair core', () => {
    it('plans same language for trusted Chinese selections against Chinese targets', () => {
        expect(resolveCommentLanguagePlan(CHINESE, 'zh-Hans')).toEqual({sameLanguage: true, selectionLanguage: undefined});
        // 空目标回落简体中文，中文选区依旧同语。
        expect(resolveCommentLanguagePlan(CHINESE, '')).toEqual({sameLanguage: true, selectionLanguage: undefined});
        // 中文家族内部互认：可信简体对繁体目标不强制互译。
        expect(resolveCommentLanguagePlan(CHINESE, 'zh-Hant').sameLanguage).toBe(true);
        expect(resolveCommentLanguagePlan(ENGLISH, 'en').sameLanguage).toBe(true);
    });

    it('keeps cross-language planning for Japanese selections mixed with simplified-only glyphs', () => {
        // 历史失败条件：旧实现用 detectlang 对汉字为主的日文猜测成 cmn，再被中文家族一票否决，
        // 拒绝补译导致日文选区只显示日文；新规划不采信统计猜测，混合正文依旧判跨语言。
        expect(resolveCommentLanguagePlan(JAPANESE_MIXED, 'zh-Hans')).toEqual({sameLanguage: false, selectionLanguage: undefined});
        // 可信识别出的纯日文才点名语言代码。
        expect(resolveCommentLanguagePlan('今日は良い天気です。私たちの考えが必要です。', 'zh-Hans'))
            .toEqual({sameLanguage: false, selectionLanguage: 'ja'});
    });

    it('never names a language for unidentified or empty selections', () => {
        // 纯表情识别为 empty，未识别绝不点名：猜错语言比不点名更糟。
        expect(resolveCommentLanguagePlan('😂🔥', 'zh-Hans')).toEqual({sameLanguage: false, selectionLanguage: undefined});
        // 书写体系未知的短中文（如"原文"）对简体目标不做同语判定，也不点名。
        expect(resolveCommentLanguagePlan('原文', 'zh-Hans')).toEqual({sameLanguage: false, selectionLanguage: undefined});
        // 英文选区对空白目标回落简体中文：跨语言并点名 en。
        expect(resolveCommentLanguagePlan(ENGLISH, '')).toEqual({sameLanguage: false, selectionLanguage: 'en'});
        // 中文选区对非中文目标：跨语言且点名中文代码。
        expect(resolveCommentLanguagePlan(CHINESE, 'en')).toEqual({sameLanguage: false, selectionLanguage: 'zh-Hans'});
    });

    it('treats trusted target-language content as redundant repair work', () => {
        expect(isCommentTranslationRedundant(CHINESE, 'zh')).toBe(true);
        expect(isCommentTranslationRedundant(CHINESE, 'zh-Hant')).toBe(true);
        expect(isCommentTranslationRedundant(ENGLISH, 'en')).toBe(true);
    });

    it('lets unidentified, mixed and other-language content through for repair', () => {
        // 宁可多补不可漏补：条目级门控只采信"内容确属目标语言"的正向证据。
        expect(isCommentTranslationRedundant('今日は良い天気です。私たちの考えが必要です。', 'zh-Hans')).toBe(false);
        // 历史失败条件：混入简体字形的日文内容曾被选区级猜测门控误杀，现在按未识别放行补译。
        expect(isCommentTranslationRedundant(JAPANESE_MIXED, 'zh-Hans')).toBe(false);
        expect(isCommentTranslationRedundant(ENGLISH, '')).toBe(false);
        expect(isCommentTranslationRedundant(CHINESE, 'en')).toBe(false);
        // 空串与纯表情按未识别放行。
        expect(isCommentTranslationRedundant('', 'zh-Hans')).toBe(false);
        expect(isCommentTranslationRedundant('😂🔥', 'zh-Hans')).toBe(false);
    });

    it('builds the repair prompt with the target language, JSON object contract and simplified Chinese fallback', () => {
        expect(buildCommentTranslationRepairPrompt('en')).toContain('语言代码 en');
        expect(buildCommentTranslationRepairPrompt('')).toContain('语言代码 zh-Hans');
        expect(buildCommentTranslationRepairPrompt('  ')).toContain('语言代码 zh-Hans');
        const prompt = buildCommentTranslationRepairPrompt('zh-Hant');
        expect(prompt).toContain('JSON 对象');
        expect(prompt).toContain('"source"');
        expect(prompt).toContain('"comments"');
        expect(prompt).toContain('只输出这一个 JSON 对象');
    });

    it('parses full repair payloads with trimming', () => {
        const expected = {source: '选区原文', comments: ['评论一', '评论二']};
        expect(parseCommentRepairOutput('{"source":" 译文一 ","comments":[" 甲 ","乙"]}', expected))
            .toEqual({source: '译文一', comments: ['甲', '乙']});
        // 代码围栏与前后缀说明宽容：整体解析失败后截取首尾花括号重试。
        expect(parseCommentRepairOutput('```json\n{"source":"译文","comments":["甲"]}\n```', {source: '原文', comments: ['一']}))
            .toEqual({source: '译文', comments: ['甲']});
        expect(parseCommentRepairOutput('结果如下：{"source":"译文","comments":["甲"]}', {source: '原文', comments: ['一']}))
            .toEqual({source: '译文', comments: ['甲']});
    });

    it('parses payloads that omit source or comments when not expected', () => {
        // 期望 source 为 null：返回对象缺 source 键或值为 null 均可，结果 source 为 null。
        expect(parseCommentRepairOutput('{"comments":["甲"]}', {source: null, comments: ['一']}))
            .toEqual({source: null, comments: ['甲']});
        expect(parseCommentRepairOutput('{"source":null,"comments":["甲"]}', {source: null, comments: ['一']}))
            .toEqual({source: null, comments: ['甲']});
        // 模型意外返回了非空 source 译文时接受并采用。
        expect(parseCommentRepairOutput('{"source":"意外译文","comments":["甲"]}', {source: null, comments: ['一']}))
            .toEqual({source: '意外译文', comments: ['甲']});
        // 仅补选区译文：comments 期望为空数组。
        expect(parseCommentRepairOutput('{"source":"选区译文","comments":[]}', {source: '原文', comments: []}))
            .toEqual({source: '选区译文', comments: []});
    });

    it('rejects malformed repair output wholesale', () => {
        const expected = {source: '原文', comments: ['一', '二']};
        // 数量不符、混入非字符串、空白串都视为整体失败。
        expect(parseCommentRepairOutput('{"source":"译文","comments":["甲"]}', expected)).toBeUndefined();
        expect(parseCommentRepairOutput('{"source":"译文","comments":["甲",1]}', expected)).toBeUndefined();
        expect(parseCommentRepairOutput('{"source":"译文","comments":["甲","  "]}', expected)).toBeUndefined();
        // 需要 source 时缺失、为 null 或为空白都整体失败。
        expect(parseCommentRepairOutput('{"comments":["甲","乙"]}', expected)).toBeUndefined();
        expect(parseCommentRepairOutput('{"source":null,"comments":["甲","乙"]}', expected)).toBeUndefined();
        expect(parseCommentRepairOutput('{"source":"   ","comments":["甲","乙"]}', expected)).toBeUndefined();
        // comments 非数组、解析结果为数组或原始值、纯噪声同样失败。
        expect(parseCommentRepairOutput('{"source":"译文","comments":"甲乙"}', expected)).toBeUndefined();
        expect(parseCommentRepairOutput('["甲","乙"]', expected)).toBeUndefined();
        expect(parseCommentRepairOutput('"甲乙"', expected)).toBeUndefined();
        expect(parseCommentRepairOutput('42', expected)).toBeUndefined();
        expect(parseCommentRepairOutput('null', expected)).toBeUndefined();
        expect(parseCommentRepairOutput('not json at all', expected)).toBeUndefined();
        expect(parseCommentRepairOutput('', expected)).toBeUndefined();
    });
});
