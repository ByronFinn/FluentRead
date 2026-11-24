/**
 * @file src/core/translation/inlineCodeMarkers.ts
 * 文件职责：校验网页简单行内代码整句占位符的纯文本协议。
 * 主要内容：从正文重建连续编号和确定性标记、恢复安全文本槽，并以同一规则判断译文是否可展示和缓存。
 * 模块边界：只读取可发送的正文及供应商译文，不访问 DOM、配置、代码内容或网络；节点身份与页面保护由调用方负责。
 */
import {sha256Hex} from '@/src/shared/function/sha256';
import {isClearlyWrongLanguageResponse, isUnchangedTranslationResponse} from './resultValidation';
import {hasDistinctTargetTranslation} from './targetResult';

const reservedMarker = /__FRCODE/iu;
/** 零宽字符、双向控制及非 ASCII 空白不能作为普通槽边界处理。 */
export const inlineCodeNonSimpleWhitespace = /[^\S ]|[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/u;
const markerPattern = /__FRCODE_([a-f0-9]{16})_(0|[1-9]\d*)__/gu;
const maximumCharacters = 65536;
const maximumMarkers = 64;
const maximumRequestBytes = 450;

interface InlineCodeTextSlot {
    readonly prefix: string;
    readonly source: string;
    readonly suffix: string;
}

/** 只保存发送给供应商的正文与标记，不包含被保护的代码或 DOM。 */
export interface InlineCodeMarkerPlan {
    readonly source: string;
    readonly nonce: string;
    readonly markers: readonly string[];
    readonly slots: readonly InlineCodeTextSlot[];
}

/** 仅识别当前 nonce 与有效序号的有限大小写/空格/下划线变体，不猜测其他改写。 */
function hasKnownMarkerVariant(text: string, nonce: string, count: number): boolean {
    const pattern = new RegExp(`(?<![A-Za-z0-9_])_{0,8}FRCODE[ _]{0,8}${nonce}[ _]{0,8}(0|[1-9]\\d?)_{0,8}(?![A-Za-z0-9_])`, 'giu');
    for (const match of text.matchAll(pattern)) if (Number(match[1]) < count) return true;
    return false;
}

/** 拒绝非规范、空槽、碰撞和不由当前正文生成的标记。 */
export function parseInlineCodeSource(source: unknown): InlineCodeMarkerPlan | null {
    if (typeof source !== 'string' || !source || source.length > maximumCharacters + maximumMarkers * 50 || inlineCodeNonSimpleWhitespace.test(source)) return null;
    const markers: string[] = [];
    const rawSlots: string[] = [];
    let offset = 0;
    let nonce: string | undefined;
    for (const match of source.matchAll(markerPattern)) {
        if (markers.length >= maximumMarkers || (nonce !== undefined && match[1] !== nonce) ||
            Number(match[2]) !== markers.length) return null;
        nonce ??= match[1];
        const part = source.slice(offset, match.index);
        if (reservedMarker.test(part)) return null;
        rawSlots.push(part);
        markers.push(match[0]);
        offset = match.index + match[0].length;
    }
    const tail = source.slice(offset);
    if (!markers.length || !nonce || reservedMarker.test(tail)) return null;
    rawSlots.push(tail);
    if (sha256Hex(rawSlots.join('\0')).slice(0, 16) !== nonce) return null;
    if (rawSlots.some(part => hasKnownMarkerVariant(part, nonce, markers.length))) return null;
    const slots: InlineCodeTextSlot[] = [];
    for (const part of rawSlots) {
        const match = /^( *)([\s\S]*?\S)( *)$/u.exec(part);
        if (!match) return null;
        slots.push({prefix: match[1]!, source: match[2]!, suffix: match[3]!});
    }
    return {source, nonce, markers, slots};
}

/** 入口来源校验额外遵循发起试探的字节预算。 */
export function isValidInlineCodeSource(source: unknown): boolean {
    return typeof source === 'string' && source.length <= maximumRequestBytes &&
        new TextEncoder().encode(source).length <= maximumRequestBytes && parseInlineCodeSource(source) !== null;
}

/** 严格按原顺序拆分译文，中文可补回原槽的普通空格，其余空白差异回退。 */
export function decodeInlineCodeTranslation(plan: InlineCodeMarkerPlan, result: unknown, targetLanguage?: string): string[] | null {
    if (typeof result !== 'string' || result.length > maximumCharacters || inlineCodeNonSimpleWhitespace.test(result)) return null;
    const parts: string[] = [];
    let offset = 0;
    for (const marker of plan.markers) {
        const index = result.indexOf(marker, offset);
        if (index < 0) return null;
        const part = result.slice(offset, index);
        if (reservedMarker.test(part)) return null;
        parts.push(part);
        offset = index + marker.length;
    }
    const tail = result.slice(offset);
    if (reservedMarker.test(tail)) return null;
    parts.push(tail);
    if (parts.length !== plan.slots.length) return null;
    if (parts.some(part => hasKnownMarkerVariant(part, plan.nonce, plan.markers.length))) return null;
    const translations: string[] = [];
    for (const [index, part] of parts.entries()) {
        const {prefix, suffix} = plan.slots[index]!;
        let translation: string;
        if ((!prefix && part.startsWith(' ')) || (!suffix && part.endsWith(' '))) return null;
        if (part.startsWith(prefix) && part.endsWith(suffix) && part.length >= prefix.length + suffix.length) {
            translation = part.slice(prefix.length, part.length - suffix.length);
        } else {
            if (!['zh-Hans', 'zh-Hant'].includes(targetLanguage ?? '')) return null;
            const match = /^( *)([\s\S]*?)( *)$/u.exec(part)!;
            if (match[1]!.length > prefix.length || match[3]!.length > suffix.length) return null;
            translation = match[2]!;
        }
        if (!translation.trim()) return null;
        translations.push(translation);
    }
    return translations;
}

/** 缓存只接受与页面相同的完整、非回显、非明显错语种的译文。 */
export function isValidInlineCodeTranslation(source: string, result: unknown, targetLanguage: string): boolean {
    if (!isValidInlineCodeSource(source)) return false;
    const plan = parseInlineCodeSource(source)!;
    const translations = decodeInlineCodeTranslation(plan, result, targetLanguage);
    if (!translations) return false;
    const origins = plan.slots.map(slot => slot.source);
    return !isUnchangedTranslationResponse(origins.join(' '), translations.join(' ')) &&
        !isClearlyWrongLanguageResponse(origins.join(' '), translations.join(' '), targetLanguage) &&
        translations.some((text, index) => hasDistinctTargetTranslation(origins[index]!, text, targetLanguage));
}
