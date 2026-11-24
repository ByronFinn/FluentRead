import {describe, expect, it, vi} from 'vitest';
import {sha256Hex} from '@/src/shared/function/sha256';
import {decodeInlineCodeTranslation, isValidInlineCodeSource, isValidInlineCodeTranslation,
    parseInlineCodeSource} from '@/src/core/translation/inlineCodeMarkers';

function packet(slots: string[]) {
    const nonce = sha256Hex(slots.join('\0')).slice(0, 16);
    const markers = slots.slice(1).map((_, index) => `__FRCODE_${nonce}_${index}__`);
    return {markers, source: slots.map((slot, index) => slot + (markers[index] ?? '')).join('')};
}

describe('行内代码整句纯文本协议', () => {
    it('从来源独立重建槽和标记，接收与页面解码相同的中文空白', () => {
        const {source, markers: [a, b]} = packet(['The variable ', ' is different from ', ' because JavaScript is case sensitive.']);
        const plan = parseInlineCodeSource(source)!;
        expect(isValidInlineCodeSource(source)).toBe(true);
        expect(decodeInlineCodeTranslation(plan, `变量${a}与${b}不同，因为 JavaScript 区分大小写。`, 'zh-Hans'))
            .toEqual(['变量', '与', '不同，因为 JavaScript 区分大小写。']);
        expect(isValidInlineCodeTranslation(source, `变量${a}与${b}不同，因为 JavaScript 区分大小写。`, 'zh-Hans')).toBe(true);
        expect(isValidInlineCodeTranslation(source, `变量 ${a} 与 ${b} 不同，因为 JavaScript 区分大小写。`, 'zh-Hant')).toBe(true);
        expect(isValidInlineCodeTranslation(source, source, 'zh-Hans')).toBe(false);
        expect(isValidInlineCodeTranslation(source, source.replace('sensitive.', 'sensitive。'), 'zh-Hans')).toBe(false);
        expect(isValidInlineCodeTranslation(source, '', 'zh-Hans')).toBe(false);
    });

    it('拒绝不可信来源中的空文本、控制字符、无标记、顺序/nonce/源摘要不符及多余前缀', () => {
        const one = packet(['Use ', ' now.']);
        const two = packet(['Use ', ' before ', ' now.']);
        for (const value of [null, '', 'ordinary prose', `\n${one.source}`, `\u200b${one.source}`,
            one.source.replace('_0__', '_1__'), one.source.replace(/[a-f0-9]{16}/u, '0000000000000000'),
            one.source.replace('Use ', '    '), `__FRCODE_broken__${one.source}`,
            two.source.replace('_1__', '_0__'), two.source.replace(/(_1__)/u, '_01__'),
            two.source.replace(/__FRCODE_[a-f0-9]{16}_1__/u, '__FRCODE_0000000000000000_1__'),
            `${one.source}__FRCODE_other__`, 'x'.repeat(70000)]) {
            expect(parseInlineCodeSource(value), String(value).slice(0, 100)).toBeNull();
            expect(isValidInlineCodeSource(value)).toBe(false);
        }
        const tooMany = packet(Array.from({length: 66}, (_, i) => `Text${i} `));
        expect(parseInlineCodeSource(tooMany.source)).toBeNull();
        expect(parseInlineCodeSource(packet(['    ', ' now.']).source)).toBeNull();
    });

    it('只接受 450 字节以内可发送来源，包括多字节边界', () => {
        const one = packet(['Use ', ' now.']);
        const suffix = one.source.length;
        const ascii = packet(['A'.repeat(450 - suffix + 4), ' now.']);
        expect(new TextEncoder().encode(ascii.source).length).toBe(450);
        expect(isValidInlineCodeSource(ascii.source)).toBe(true);
        const large = packet(['A'.repeat(451 - suffix + 4), ' now.']);
        expect(isValidInlineCodeSource(large.source)).toBe(false);
        const unicode = packet(['界'.repeat(160), ' now.']);
        expect(unicode.source.length).toBeLessThan(450);
        expect(isValidInlineCodeSource(unicode.source)).toBe(false);
    });

    it('拒绝丢失、乱序、重复、损坏、未知标记以及空槽', () => {
        const {source, markers: [a, b]} = packet(['Use ', ' before ', ' now.']);
        const plan = parseInlineCodeSource(source)!;
        for (const result of [null, '', `使用 ${a} 现在。`, `使用 ${b} 之前 ${a} 现在。`,
            `使用 ${a} 之前 ${a} ${b} 现在。`, `使用 ${a} __FRCODE_other__ ${b} 现在。`,
            `使用 ${a} 之前 ${b} 现在。__FRCODE_other__`, `使用 ${a}  ${b} 现在。`,
            `使用 ${a.replace('FRCODE', 'FRCOdE')} 之前 ${b} 现在。`, `使用\n${a}之前${b}现在。`, 'x'.repeat(65537)]) {
            expect(decodeInlineCodeTranslation(plan, result, 'zh-Hans')).toBeNull();
            expect(isValidInlineCodeTranslation(source, result, 'zh-Hans')).toBe(false);
        }
    });

    it('只拒绝当前 nonce、有效序号的已知标记变体，不猜测其他改写', () => {
        const {source, markers: [a, b]} = packet(['Use ', ' before ', ' now.']);
        const plan = parseInlineCodeSource(source)!;
        for (const duplicate of [`FRCODE ${plan.nonce} 0`, `frcode_${plan.nonce}_1`,
            `FRCODE${plan.nonce}0`, `_FRCODE_${plan.nonce}_0_`]) {
            const result = `使用 ${a} ${duplicate} 之前 ${b} 现在。`;
            expect(decodeInlineCodeTranslation(plan, result, 'zh-Hans')).toBeNull();
            expect(isValidInlineCodeTranslation(source, result, 'zh-Hans')).toBe(false);
        }
        for (const literal of [`FRCODE 0000000000000000 0`, `FRCODE ${plan.nonce} 2`,
            `xFRCODE_${plan.nonce}_0`, `FRCODE ${plan.nonce} 01`]) {
            expect(decodeInlineCodeTranslation(plan, `使用 ${a} ${literal} 之前 ${b} 现在。`, 'zh-Hans'))
                .toEqual(['使用', `${literal} 之前`, '现在。']);
        }
    });

    it('来源本身若含同 nonce 的已知变体，禁止建立试探包', async () => {
        const nonce = '0123456789abcdef';
        vi.resetModules();
        vi.doMock('@/src/shared/function/sha256', () => ({sha256Hex: () => nonce + '0'.repeat(48)}));
        try {
            const {parseInlineCodeSource: parse} = await import('@/src/core/translation/inlineCodeMarkers');
            expect(parse(`Use FRCODE ${nonce} 0 __FRCODE_${nonce}_0__ now.`)).toBeNull();
        } finally {
            vi.doUnmock('@/src/shared/function/sha256');
            vi.resetModules();
        }
    });

    it('非中文严格保留边界；中文不接受额外的空格、增加空白或失配槽', () => {
        const {source, markers: [a, b]} = packet(['Call ', ', then ', '!']);
        const plan = parseInlineCodeSource(source)!;
        expect(decodeInlineCodeTranslation(plan, `调用 ${a}，然后 ${b}！`, 'zh-Hans')).toEqual(['调用', '，然后', '！']);
        expect(decodeInlineCodeTranslation(plan, `调用 ${a} ，然后 ${b}！`, 'zh-Hans')).toBeNull();
        expect(decodeInlineCodeTranslation(plan, `调用 ${a}，然后 ${b} ！`, 'zh-Hans')).toBeNull();
        expect(decodeInlineCodeTranslation(plan, `调用${a}，然后${b}！`, 'en')).toBeNull();
        expect(decodeInlineCodeTranslation(plan, `调用  ${a}，然后${b}！`, 'zh-Hans')).toEqual(['调用 ', '，然后', '！']);
        expect(decodeInlineCodeTranslation({...plan, slots: []}, `调用 ${a}，然后 ${b}！`, 'zh-Hans')).toBeNull();
    });

    it('校验整体错语种及非字符串来源', () => {
        expect(isValidInlineCodeTranslation('no markers', '译文', 'zh-Hans')).toBe(false);
        const {source, markers: [a]} = packet(['The researchers carefully evaluate the complete technical document ', ' before presenting the final detailed results to their colleagues.']);
        const wrong = `The researchers thoroughly analyze the complete technical document ${a} before reporting the final detailed findings to their colleagues.`;
        expect(isValidInlineCodeTranslation(source, wrong, 'zh-Hans')).toBe(false);
    });
});
