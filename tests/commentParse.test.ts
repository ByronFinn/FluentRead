import {describe, expect, it} from 'vitest';
import {COMMENT_CONTENT_MAX, normalizeModelComments, parseCommentsFromText} from '@/src/core/comment/parse';
import {COMMENT_MAX_TEXT} from '@/src/core/config/comment';

describe('comment model output normalization', () => {
    it('rejects non-object payloads, arrays and non-array comments fields', () => {
        // 输入非 plain object：原始值、null、数组一律整体无效。
        expect(normalizeModelComments('{"comments":[]}', 3)).toBeUndefined();
        expect(normalizeModelComments(42, 3)).toBeUndefined();
        expect(normalizeModelComments(true, 3)).toBeUndefined();
        expect(normalizeModelComments(null, 3)).toBeUndefined();
        expect(normalizeModelComments([], 3)).toBeUndefined();
        // comments 字段缺失或不是数组同样整体无效。
        expect(normalizeModelComments({}, 3)).toBeUndefined();
        expect(normalizeModelComments({comments: 'not array'}, 3)).toBeUndefined();
        expect(normalizeModelComments({comments: {length: 0}}, 3)).toBeUndefined();
        expect(normalizeModelComments({comments: null}, 3)).toBeUndefined();
    });

    it('skips malformed entries and keeps the healthy ones in order', () => {
        // 坏条目跳过：null、原始值、content 缺失或非字符串、trim 后为空。
        const normalized = normalizeModelComments({comments: [
            null,
            42,
            'text',
            {content: 55},
            {translation: '甲'},
            {content: '   '},
            {content: ''},
            {content: ' 评论一 '},
            {content: '评论二'},
        ], extra: 'ignored'}, 5);
        expect(normalized).toEqual({comments: [{content: '评论一', translation: null}, {content: '评论二', translation: null}],
            sourceTranslation: null});
    });

    it('trims and caps content to the entry hard limit', () => {
        const long = `头${'甲'.repeat(COMMENT_CONTENT_MAX + 100)}尾`;
        const normalized = normalizeModelComments({comments: [{content: `  ${long}  `}]}, 3);
        expect(normalized?.comments[0]?.content).toHaveLength(COMMENT_CONTENT_MAX);
        expect(normalized?.comments[0]?.content).toBe(`头${'甲'.repeat(COMMENT_CONTENT_MAX - 1)}`);
    });

    it('caps translation to the same entry hard limit as content', () => {
        // 译文与正文共用条目上限：旧实现只 trim 不截断，超长译文会原样进入展示与补译链。
        const long = `译${'文'.repeat(COMMENT_CONTENT_MAX + 50)}`;
        const normalized = normalizeModelComments({comments: [{content: 'a', translation: long}]}, 3);
        expect(normalized?.comments[0]?.translation).toHaveLength(COMMENT_CONTENT_MAX);
        expect(normalized?.comments[0]?.translation).toBe(`译${'文'.repeat(COMMENT_CONTENT_MAX - 1)}`);
    });

    it('coerces translation leniently across its three states', () => {
        const normalized = normalizeModelComments({comments: [
            {content: 'a', translation: '  译文  '},
            {content: 'b', translation: '   '},
            {content: 'c', translation: ''},
            {content: 'd', translation: null},
            {content: 'e'},
            {content: 'f', translation: 42},
            {content: 'g', translation: {text: '对象'}},
            {content: 'h', translation: ['数组']},
        ]}, 8);
        expect(normalized?.comments).toEqual([
            {content: 'a', translation: '译文'},
            {content: 'b', translation: null},
            {content: 'c', translation: null},
            {content: 'd', translation: null},
            {content: 'e', translation: null},
            {content: 'f', translation: null},
            {content: 'g', translation: null},
            {content: 'h', translation: null},
        ]);
    });

    it('trims, empties and caps sourceTranslation against the selection bound', () => {
        expect(normalizeModelComments({comments: [{content: 'a'}], sourceTranslation: '  选区译文  '}, 3)?.sourceTranslation)
            .toBe('选区译文');
        // 空串与纯空白归 null；非字符串宽容归 null。
        expect(normalizeModelComments({comments: [{content: 'a'}], sourceTranslation: ''}, 3)?.sourceTranslation).toBeNull();
        expect(normalizeModelComments({comments: [{content: 'a'}], sourceTranslation: '   '}, 3)?.sourceTranslation).toBeNull();
        expect(normalizeModelComments({comments: [{content: 'a'}]}, 3)?.sourceTranslation).toBeNull();
        expect(normalizeModelComments({comments: [{content: 'a'}], sourceTranslation: null}, 3)?.sourceTranslation).toBeNull();
        expect(normalizeModelComments({comments: [{content: 'a'}], sourceTranslation: 42}, 3)?.sourceTranslation).toBeNull();
        // 超长译文截断到选区文本上限，与入口校验共用同一常量。
        const oversized = `首${'译'.repeat(COMMENT_MAX_TEXT + 10)}尾`;
        expect(normalizeModelComments({comments: [{content: 'a'}], sourceTranslation: oversized}, 3)?.sourceTranslation)
            .toHaveLength(COMMENT_MAX_TEXT);
    });

    it('returns undefined when no entry survives and truncates to maxCount', () => {
        // 清洗后没有任何有效条目：整体无效，由调用方决定重试或失败。
        expect(normalizeModelComments({comments: [{content: '  '}, {content: 1}, 'x']}, 3)).toBeUndefined();
        expect(normalizeModelComments({comments: []}, 3)).toBeUndefined();
        // maxCount 截断只保留前 N 条。
        const normalized = normalizeModelComments({comments: [
            {content: '一'}, {content: '二'}, {content: '三'}, {content: '四'},
        ]}, 2);
        expect(normalized?.comments).toEqual([{content: '一', translation: null}, {content: '二', translation: null}]);
    });
});

describe('comment fallback text parsing', () => {
    it('parses a whole-string JSON object directly', () => {
        const payload = {comments: [{content: 'a', translation: '甲'}], sourceTranslation: '译文'};
        expect(parseCommentsFromText('  {"comments":[{"content":"a","translation":"甲"}],"sourceTranslation":"译文"}  '))
            .toEqual(payload);
    });

    it('strips ```json and bare ``` fences before parsing', () => {
        const object = {comments: [{content: 'a'}]};
        expect(parseCommentsFromText('```json\n{"comments":[{"content":"a"}]}\n```')).toEqual(object);
        expect(parseCommentsFromText('```\n{"comments":[{"content":"a"}]}\n```')).toEqual(object);
        // 围栏剥掉后裸数组同样包装为负载形状。
        expect(parseCommentsFromText('```json\n[{"content":"a"},{"content":"b"}]\n```'))
            .toEqual({comments: [{content: 'a'}, {content: 'b'}]});
    });

    it('falls back to the brace slice for fenced output wrapped in prose', () => {
        // 围栏不在首尾行时剥不掉：整体解析失败后用首尾花括号切片救回。
        expect(parseCommentsFromText('好的，以下是评论：\n```json\n{"comments":[{"content":"a"}],"sourceTranslation":"译"}\n```\n请查收。'))
            .toEqual({comments: [{content: 'a'}], sourceTranslation: '译'});
        // 没有围栏的前后缀说明同样由花括号切片兜底。
        expect(parseCommentsFromText('结果如下：{"comments":[{"content":"a"}]}，请查收。'))
            .toEqual({comments: [{content: 'a'}]});
        // 首行是围栏但末行不是：不剥围栏，走切片候选。
        expect(parseCommentsFromText('```json\n{"comments":[{"content":"a"}]}\n以上是全部内容。'))
            .toEqual({comments: [{content: 'a'}]});
    });

    it('wraps array results as a comments payload', () => {
        // 整串恰好是裸数组：包装成 {comments: 数组}，避免被归一化按"数组输入"直接否决。
        expect(parseCommentsFromText('[{"content":"a"},{"content":"b"}]'))
            .toEqual({comments: [{content: 'a'}, {content: 'b'}]});
        // 前后缀说明文字中的裸数组：花括号切片（两个对象夹逗号）解析失败后由方括号切片救回。
        expect(parseCommentsFromText('评论如下：[{"content":"a"},{"content":"b"}] 请查收。'))
            .toEqual({comments: [{content: 'a'}, {content: 'b'}]});
    });

    it('returns whatever whole-string JSON parses to and leaves shape checking to normalization', () => {
        // 标量 JSON 也原样返回：形状合法性交给 normalizeModelComments 判定。
        expect(parseCommentsFromText('42')).toBe(42);
        expect(parseCommentsFromText('"纯字符串"')).toBe('纯字符串');
        expect(parseCommentsFromText('null')).toBeNull();
    });

    it('returns undefined for prose without any parsable candidate', () => {
        expect(parseCommentsFromText('这只是一段说明文字，没有 JSON。')).toBeUndefined();
        expect(parseCommentsFromText('')).toBeUndefined();
        // 单行围栏不成对：剥不了围栏也没有可解析切片。
        expect(parseCommentsFromText('```json')).toBeUndefined();
        expect(parseCommentsFromText('```json\n随便说说\n```')).toBeUndefined();
    });
});
