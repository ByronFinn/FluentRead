import {beforeEach, describe, expect, it, vi} from 'vitest';

const storageHarness = vi.hoisted(() => ({
    values: new Map<string, unknown>(),
    watchers: new Map<string, (value: unknown) => void>(),
    getItem: vi.fn(),
    setItem: vi.fn(),
    watch: vi.fn(),
}));

const configHarness = vi.hoisted(() => ({
    config: {
        on: true,
        service: 'openai',
        from: 'auto',
        to: 'zh-Hans',
        token: {openai: 'current-secret'},
        count: 42,
        persistCredentials: true,
        videoServiceDefaultMigrated: true,
    } as Record<string, unknown>,
    saveConfig: vi.fn(),
    history: {
        schemaVersion: 1,
        entries: [],
        cursor: 0,
        nextVersion: 1,
    },
}));

vi.mock('@wxt-dev/storage', () => ({
    storage: {
        getItem: storageHarness.getItem,
        setItem: storageHarness.setItem,
        watch: storageHarness.watch,
    },
}));

vi.mock('@/src/platform/storage/configStorageRuntime', () => ({
    configStorage: {
        getItem: storageHarness.getItem,
        setItem: storageHarness.setItem,
        watch: storageHarness.watch,
    },
}));

vi.mock('@/src/services/config/store', () => ({
    config: configHarness.config,
    configReady: Promise.resolve(),
    configHistoryReady: Promise.resolve(),
    getConfigHistorySnapshot: () => structuredClone(configHarness.history),
    saveConfig: configHarness.saveConfig,
}));

async function loadStore() {
    vi.resetModules();
    const module = await import('@/src/services/config/autoBackupStore');
    await module.configAutoBackupsReady;
    return module;
}

describe('自动配置备份 store', () => {
    beforeEach(() => {
        storageHarness.values.clear();
        storageHarness.watchers.clear();
        storageHarness.getItem.mockReset().mockImplementation(async (key: string) => (
            storageHarness.values.get(key) ?? null
        ));
        storageHarness.setItem.mockReset().mockImplementation(async (key: string, value: unknown) => {
            const snapshot = structuredClone(value);
            storageHarness.values.set(key, snapshot);
            storageHarness.watchers.get(key)?.(snapshot);
        });
        storageHarness.watch.mockReset().mockImplementation((key: string, listener: (value: unknown) => void) => {
            storageHarness.watchers.set(key, listener);
            return () => storageHarness.watchers.delete(key);
        });
        Object.assign(configHarness.config, {
            on: true,
            service: 'openai',
            from: 'auto',
            to: 'zh-Hans',
            token: {openai: 'current-secret'},
            count: 42,
            persistCredentials: true,
            videoServiceDefaultMigrated: true,
        });
        configHarness.saveConfig.mockReset().mockImplementation(async (value: Record<string, unknown>) => {
            Object.assign(configHarness.config, structuredClone(value));
        });
    });

    it('无原子条件写的初始化保留脱敏内存基线，显式捕获再持久化', async () => {
        const store = await loadStore();
        const state = store.getConfigAutoBackupsSnapshot();

        expect(state.entries).toHaveLength(1);
        expect(state.entries[0]?.config).toMatchObject({to: 'zh-Hans'});
        expect(state.entries[0]?.config).not.toHaveProperty('token');
        expect(state.entries[0]?.config).not.toHaveProperty('count');
        expect(state.entries[0]?.config).not.toHaveProperty('persistCredentials');
        expect(storageHarness.setItem).not.toHaveBeenCalled();
        expect(storageHarness.values.has(store.CONFIG_AUTO_BACKUP_STORAGE_KEY)).toBe(false);

        await store.captureConfigAutoBackup({savedAt: 'explicit-capture'});
        expect(storageHarness.setItem).toHaveBeenCalledOnce();
        expect(storageHarness.setItem).toHaveBeenCalledWith(
            store.CONFIG_AUTO_BACKUP_STORAGE_KEY,
            expect.objectContaining({entries: expect.any(Array)}),
        );
        const persisted = JSON.stringify(storageHarness.values.get(store.CONFIG_AUTO_BACKUP_STORAGE_KEY));
        expect(persisted).not.toContain('current-secret');
        expect(store.getConfigAutoBackupsSnapshot().entries).toHaveLength(2);
    });

    it('串行捕获重复时间检查点并只保留最近十份', async () => {
        const store = await loadStore();
        await Promise.all(Array.from({length: 11}, (_, index) => store.captureConfigAutoBackup({
            config: {...configHarness.config, to: `target-${index}`},
            savedAt: `2026-08-25T${String(index).padStart(2, '0')}:00:00.000Z`,
        })));

        const state = store.getConfigAutoBackupsSnapshot();
        expect(state.entries).toHaveLength(10);
        expect(state.entries[0]?.version).toBe(3);
        expect(state.entries.at(-1)).toMatchObject({
            version: 12,
            config: {to: 'target-10'},
        });
        expect(new Set(state.entries.map((entry) => entry.version)).size).toBe(10);
    });

    it('初次订阅异常仍返回清理函数，后续通知继续隔离异常并保留其他订阅者', async () => {
        const store = await loadStore();
        const failure = new Error('controlled subscriber failure');
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const throwing = vi.fn(() => {throw failure;});
        const healthy = vi.fn();
        let unsubscribe: (() => void) | undefined;
        let unsubscribeHealthy: (() => void) | undefined;
        try {
            expect(() => {unsubscribe = store.subscribeConfigAutoBackups(throwing);}).not.toThrow();
            expect(unsubscribe).toBeTypeOf('function');
            expect(warning).toHaveBeenCalledWith('[FluentRead] 自动配置备份订阅通知失败', failure);
            unsubscribeHealthy = store.subscribeConfigAutoBackups(healthy);
            await store.captureConfigAutoBackup({savedAt: 'while-subscribed'});
            expect(throwing).toHaveBeenCalledTimes(2);
            expect(healthy).toHaveBeenCalledTimes(2);
            expect(warning).toHaveBeenCalledTimes(2);
            unsubscribe!();
            await store.captureConfigAutoBackup({savedAt: 'after-unsubscribe'});
            expect(throwing).toHaveBeenCalledTimes(2);
            expect(healthy).toHaveBeenCalledTimes(3);
        } finally {
            unsubscribe?.(); unsubscribeHealthy?.(); warning.mockRestore();
        }
    });

    it('无原子条件写时立即脱敏内存，保留外部订阅并在显式捕获清理旧存储', async () => {
        storageHarness.values.set('local:configAutoBackups', {
            schemaVersion: 1,
            entries: [{
                version: 7,
                savedAt: 'old-time',
                config: {
                    on: true,
                    service: 'openai',
                    from: 'auto',
                    to: 'ja',
                    token: {openai: 'legacy-secret'},
                    count: 1,
                    persistCredentials: false,
                    videoServiceDefaultMigrated: false,
                },
            }],
            nextVersion: 8,
        });
        const store = await loadStore();
        expect(JSON.stringify(store.getConfigAutoBackupsSnapshot())).not.toContain('legacy-secret');
        expect(store.getConfigAutoBackupsSnapshot().entries[0]?.config).not.toHaveProperty('count');
        expect(store.getConfigAutoBackupsSnapshot().entries[0]?.config).not.toHaveProperty('persistCredentials');
        expect(storageHarness.setItem).not.toHaveBeenCalled();
        expect(JSON.stringify(storageHarness.values.get(store.CONFIG_AUTO_BACKUP_STORAGE_KEY)))
            .toContain('legacy-secret');

        const listener = vi.fn();
        const unsubscribe = store.subscribeConfigAutoBackups(listener);
        expect(listener).toHaveBeenCalledOnce();
        const external = {
            schemaVersion: 1,
            entries: [{
                version: 8,
                savedAt: 'external-time',
                config: {on: true, service: 'openai', from: 'auto', to: 'ko'},
            }],
            nextVersion: 9,
        };
        storageHarness.watchers.get(store.CONFIG_AUTO_BACKUP_STORAGE_KEY)?.(external);
        expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({
            entries: [expect.objectContaining({version: 8, config: expect.objectContaining({to: 'ko'})})],
        }));
        unsubscribe();
        await store.captureConfigAutoBackup({savedAt: 'explicit-after-external'});
        expect(storageHarness.setItem).toHaveBeenCalledOnce();
        expect(JSON.stringify(storageHarness.values.get(store.CONFIG_AUTO_BACKUP_STORAGE_KEY)))
            .not.toContain('legacy-secret');
        expect(store.getConfigAutoBackupsSnapshot().entries[0]).toMatchObject({version: 8, config: {to: 'ko'}});
        expect(store.getConfigAutoBackupsSnapshot().entries.at(-1)).toMatchObject({version: 9, savedAt: 'explicit-after-external'});
    });

    it('恢复备份时保留当前凭据、统计和迁移标记，并忽略旧策略字段', async () => {
        storageHarness.values.set('local:configAutoBackups', {
            schemaVersion: 1,
            entries: [{
                version: 3,
                savedAt: 'backup-time',
                config: {on: true, service: 'openai', from: 'auto', to: 'ja'},
            }],
            nextVersion: 4,
        });
        const store = await loadStore();

        const result = await store.restoreConfigAutoBackup(3);

        expect(configHarness.saveConfig).toHaveBeenCalledWith(expect.objectContaining({
            to: 'ja',
            token: {openai: 'current-secret'},
            count: 42,
            videoServiceDefaultMigrated: true,
        }), {recordHistory: true, immediateHistory: true});
        expect(configHarness.saveConfig.mock.calls[0]?.[0]).not.toHaveProperty('persistCredentials');
        expect(result.backups.entries[0]?.version).toBe(3);
        expect(result.history).toEqual(configHarness.history);
    });

    it('requestRestore 优先通过后台消息返回结果', async () => {
        const store = await loadStore();
        const expected = {
            backups: store.getConfigAutoBackupsSnapshot(),
            history: structuredClone(configHarness.history),
        };
        const sendMessage = vi.fn().mockResolvedValue({success: true, result: expected});

        await expect(store.requestConfigAutoBackupRestore(1, sendMessage)).resolves.toEqual(expected);
        expect(sendMessage).toHaveBeenCalledWith({
            type: store.CONFIG_AUTO_BACKUP_RESTORE_MESSAGE,
            version: 1,
        });
        expect(configHarness.saveConfig).not.toHaveBeenCalled();
    });

    it('只有后台接收端不存在时才本地兜底，明确失败不能重复恢复', async () => {
        const store = await loadStore();

        await expect(store.requestConfigAutoBackupRestore(
            1,
            vi.fn().mockResolvedValue({success: false, error: 'background restore failed'}),
        )).rejects.toThrow('background restore failed');
        await expect(store.requestConfigAutoBackupRestore(
            1,
            vi.fn().mockResolvedValue({success: true}),
        )).rejects.toThrow('没有返回结果');
        await expect(store.requestConfigAutoBackupRestore(
            1,
            vi.fn().mockRejectedValue(new Error('unexpected transport failure')),
        )).rejects.toThrow('unexpected transport failure');
        expect(configHarness.saveConfig).not.toHaveBeenCalled();

        await expect(store.requestConfigAutoBackupRestore(
            1,
            vi.fn().mockRejectedValue(new Error('Receiving end does not exist')),
        )).resolves.toEqual(expect.objectContaining({backups: expect.any(Object)}));
        expect(configHarness.saveConfig).toHaveBeenCalledOnce();
    });
});
