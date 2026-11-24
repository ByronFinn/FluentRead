/**
 * @file src/core/translation/slotProtocol.ts
 * 文件职责：以稳定且不与任一原文槽碰撞的标记编码纯文本槽，并严格解析服务返回的槽位顺序。
 * 主要内容：确定性来源摘要、跨槽 nonce 避让、按原始包边界重建并验证译文，按同一命名空间前向扫描标准标记，拒绝重复、缺项、交错及标记外正文；保留非标准字面标记的兼容解析。
 * 模块边界：仅处理字符串和协议快照，不读写 DOM、不读取配置、不调用 provider；serialization 直接重导出公开协议。
 */
export interface SerializedTranslationSlots {
    payload: string;
    starts: readonly string[];
    ends: readonly string[];
}

function hashSlotSources(sources: readonly string[]): string {
    let hash = 2166136261;
    for (const source of sources) {
        for (let index = 0; index < source.length; index += 1) {
            hash ^= source.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        hash ^= 0xff;
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

/** nonce 已限制为字母、数字、下划线与连字符；零宽前瞻同时发现共享末尾下划线的重叠标记。 */
function slotMarkerPattern(nonce: string): RegExp {
    return new RegExp(`(?=(___FLUENTREAD_${nonce}_(0|[1-9]\\d*)_(?:BEGIN|END)___))`, 'gu');
}

/** 稳定 nonce 保持缓存身份，任一来源包含任一实际槽标记时均避让。 */
export function serializeTranslationSlots(
    sources: readonly string[],
    requestedNonce = hashSlotSources(sources),
): SerializedTranslationSlots {
    let nonce = requestedNonce.replace(/[^a-z0-9_-]/giu, '') || 'slots';
    let collision = 0;
    const hasCollision = (candidate: string): boolean => {
        const pattern = slotMarkerPattern(candidate);
        return sources.some((source) => {
            pattern.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = pattern.exec(source))) {
                if (Number(match[2]) < sources.length) return true;
                // 零宽匹配必须前进，不能在无关的超范围标记处反复匹配。
                pattern.lastIndex = match.index + 1;
            }
            return false;
        });
    };
    while (hasCollision(nonce)) {
        collision += 1;
        nonce = `${requestedNonce}_${collision}`.replace(/[^a-z0-9_-]/giu, '');
    }

    const starts = sources.map((_, index) => `___FLUENTREAD_${nonce}_${index}_BEGIN___`);
    const ends = sources.map((_, index) => `___FLUENTREAD_${nonce}_${index}_END___`);
    const payload = sources.map((source, index) => `${starts[index]}${source}${ends[index]}`).join('\n');
    return {payload, starts, ends};
}

/** 译文沿用已验证的原包标记；不能重新猜 nonce，或因译文含活动标记而静默换名。 */
export function rebuildTranslationSlots(packet: SerializedTranslationSlots, translations: readonly string[]): string | null {
    if (translations.length !== packet.starts.length || packet.starts.length !== packet.ends.length) return null;
    const payload = translations.map((text, index) => `${packet.starts[index]}${text}${packet.ends[index]}`).join('\n');
    return parseTranslationSlots(packet, payload) === null ? null : payload;
}

function parseGeneratedSlots(starts: string[], ends: string[], translated: string, nonce: string): string[] | null {
    const ordinals = new Map<string, number>();
    starts.forEach((start, index) => {
        ordinals.set(start, index * 2);
        ordinals.set(ends[index], index * 2 + 1);
    });
    const pattern = slotMarkerPattern(nonce);
    const results: string[] = [];
    const countedEnds = new Array<number>(starts.length * 2).fill(0);
    let expected = 0;
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(translated))) {
        pattern.lastIndex = match.index + 1;
        const ordinal = ordinals.get(match[1]);
        // 超范围标记是来源/译文的字面内容，不属于这个请求包。
        if (ordinal === undefined) continue;
        // 保留原字面协议对同一标记的非重叠计数；不同标记仍独立检查，不能漏掉交错。
        if (match.index < countedEnds[ordinal]) continue;
        countedEnds[ordinal] = match.index + match[1].length;
        if (ordinal !== expected || match.index < cursor) return null;
        if (expected % 2 === 0) {
            if (translated.slice(cursor, match.index).trim()) return null;
        } else results.push(translated.slice(cursor, match.index));
        cursor = match.index + match[1].length;
        expected += 1;
    }
    return expected === starts.length * 2 && !translated.slice(cursor).trim() ? results : null;
}

/** 严格按顺序接受每槽一个结果；标准内部协议只对整个文本做一次前向标记扫描。 */
export function parseTranslationSlots(packet: SerializedTranslationSlots, translated: string): string[] | null {
    const starts = Array.from(packet.starts);
    const ends = Array.from(packet.ends);
    if (starts.length !== ends.length) return null;
    const nonce = starts[0]?.match(/^___FLUENTREAD_([a-z0-9_-]+)_0_BEGIN___$/iu)?.[1];
    if (nonce && starts.every((start, index) => start === `___FLUENTREAD_${nonce}_${index}_BEGIN___` &&
        ends[index] === `___FLUENTREAD_${nonce}_${index}_END___`)) {
        return parseGeneratedSlots(starts, ends, translated, nonce);
    }

    // 公开类型也允许非标准字面标记，保留原有重复/重叠与顺序校验语义。
    const countMarker = (marker: string): number => {
        let count = 0;
        let offset = 0;
        while (offset <= translated.length - marker.length) {
            const next = translated.indexOf(marker, offset);
            if (next < 0) break;
            count += 1;
            offset = next + marker.length;
        }
        return count;
    };
    if ([...starts, ...ends].some((marker) => !marker || countMarker(marker) !== 1)) return null;
    const results: string[] = [];
    let cursor = 0;
    for (let index = 0; index < starts.length; index += 1) {
        const start = starts[index];
        const end = ends[index];
        const startIndex = translated.indexOf(start, cursor);
        if (startIndex < 0 || translated.slice(cursor, startIndex).trim()) return null;
        const valueStart = startIndex + start.length;
        const endIndex = translated.indexOf(end, valueStart);
        if (endIndex < 0) return null;
        results.push(translated.slice(valueStart, endIndex));
        cursor = endIndex + end.length;
    }
    return translated.slice(cursor).trim() ? null : results;
}
