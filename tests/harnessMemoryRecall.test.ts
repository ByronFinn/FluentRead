import {describe, expect, it, vi} from 'vitest';
import {createLearningMemoryRecall, readMemory} from '@/src/services/harness/memoryRecall';
import type {LearningMemory} from '@/src/services/harness/learningMemory';

const now = Date.now();
const entry = (id: string, content: string, kind: LearningMemory['kind'] = 'lesson', updatedAt = now): LearningMemory => ({id, content, kind, createdAt: now, updatedAt});

describe('learning memory browser adapter', () => {
    it('recalls relevant lessons across calls and preserves only the latest general learning preference', async () => {
        const entries = [entry('old', 'Please use advanced terms', 'preference', now - 10), entry('new', 'Please use short examples', 'preference'), entry('a', 'Practice helps improve grammar'), entry('b', 'Practice grammar with a short sentence'), entry('c', 'Grammar improves with practice'), entry('d', 'Unrelated shopping list')];
        const store = {list: vi.fn(async () => entries)};
        const recall = createLearningMemoryRecall(store);
        const result = await recall('practice grammar');
        expect(result).toHaveLength(3); expect(result[0].id).toBe('new');
        expect(result.slice(1).map(item => item.id)).not.toContain('d');
        expect(await recall('ok了吗')).toEqual([entries[1]]);
        expect(store.list).toHaveBeenCalledTimes(2);
    });
    it('returns no unrelated facts, deduplicates matching preferences, and reloads after edits/deletion', async () => {
        const entries = [entry('a', 'grammar practice preference', 'preference')];
        const recall = createLearningMemoryRecall({list: async () => entries});
        expect(await recall('grammar')).toEqual(entries);
        entries.splice(0, 1, entry('b', 'vocabulary flashcards'));
        expect(await recall('unrelated sentence')).toEqual([]);
        expect(await recall('vocabulary')).toEqual(entries);
        entries.splice(0); expect(await recall('vocabulary')).toEqual([]);
        expect(await recall('')).toEqual([]);
    });
    it('lets runtime report repository failures without treating failed storage as an empty successful recall', async () => {
        await expect(createLearningMemoryRecall({list: async () => {throw new Error('storage');}})('practice')).rejects.toThrow('storage');
    });
    it('does not read notes when the caller has already cancelled', async () => {
        const controller = new AbortController(); controller.abort();
        const reader = {recall: vi.fn(async () => [])};
        await expect(readMemory(reader, 'grammar', controller.signal)).rejects.toThrow('已取消');
        expect(reader.recall).not.toHaveBeenCalled();
    });
    it('skips search projections for filler queries at the 200-note limit and still reads current preferences', async () => {
        const entries = Array.from({length: 198}, (_, index) => entry(`lesson-${index}`, `grammar lesson ${index}`));
        const earlier = entry('first', 'Use short examples', 'preference');
        const later = entry('second', 'Use everyday words', 'preference');
        entries.push(earlier, later);
        const store = {list: vi.fn(async () => entries)}, recall = createLearningMemoryRecall(store);
        const iso = vi.spyOn(Date.prototype, 'toISOString');
        try {
            expect(await recall('ok了吗')).toEqual([earlier]);
            later.updatedAt += 1;
            expect(await recall('')).toEqual([later]);
            expect(iso).not.toHaveBeenCalled();
            expect((await recall('grammar'))[0]).toBe(later);
            expect(iso).toHaveBeenCalledTimes(400);
            expect(store.list).toHaveBeenCalledTimes(3);
        } finally {iso.mockRestore();}
    });
});
