/**
 * @file src/services/harness/memoryRecall.ts
 * 文件职责：把浏览器中由用户主动保存的学习笔记适配给 Harness 社区插件的纯检索内核。
 * 主要内容：映射本地时间与类型字段，单次遍历选择最近学习偏好，仅在查询有检索信息时构建搜索投影并补充相关学习要点，总量不超过三条。
 * 模块边界：不采集网页、不写入记忆、不调用模型或向量服务；具体仓库由后台注入，开关与隐私窗口隔离由各 runtime 负责；共享读取等待有取消和超时边界。
 */
import {hasMeaningfulQuery, rankRecords, type MemoryRecord} from '@/src/core/harness/memorySearch';
import type {LearningMemory} from './learningMemory';

export function createLearningMemoryRecall(store: {list(): Promise<LearningMemory[]>}) {
    return async (query: string): Promise<LearningMemory[]> => {
        const entries = await store.list();
        let preference: LearningMemory | undefined;
        for (const item of entries) {
            if (item.kind === 'preference' && (!preference || item.updatedAt > preference.updatedAt)) preference = item;
        }
        if (!hasMeaningfulQuery(query)) return preference ? [preference] : [];
        const records: MemoryRecord[] = entries.map(item => ({
            id: item.id, content: item.content, kind: item.kind, tags: [], scope: 'user', project: null,
            importance: 2, createdAt: new Date(item.createdAt).toISOString(), updatedAt: new Date(item.updatedAt).toISOString(),
            accessedAt: null, accessCount: 0, expiresAt: null,
        }));
        const relevant = rankRecords(records, query, 3);
        const ids = new Set([...(preference ? [preference.id] : []), ...relevant.map(hit => hit.record.id)]);
        return [...ids].slice(0, 3).map(id => entries.find(item => item.id === id)!);
    };
}

export interface HarnessMemoryReader {recall(query: string): Promise<readonly LearningMemory[]>}

export async function readMemory(reader: HarnessMemoryReader, query: string, signal: AbortSignal): Promise<readonly LearningMemory[]> {
    if (signal.aborted) throw new Error('学习记忆读取已取消');
    let abort!: () => void;
    let timer!: ReturnType<typeof setTimeout>;
    const interrupted = new Promise<never>((_, reject) => {
        abort = () => reject(new Error('学习笔记读取已取消'));
        signal.addEventListener('abort', abort, {once: true});
        timer = setTimeout(() => reject(new Error('学习笔记读取超时')), 1500);
    });
    try { return await Promise.race([reader.recall(query), interrupted]); }
    finally { signal.removeEventListener('abort', abort); clearTimeout(timer); }
}
