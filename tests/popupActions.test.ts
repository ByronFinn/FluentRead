import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {buildConfigDiff} from '@/src/core/config/diff';
import {createPopupPageFontActions, type PopupPageFontState} from '@/src/app/popup/pageFontActions';

describe('Popup actions across configuration and page state', () => {
    it('关闭前的记忆字段保存在配置中但不重复进入用户差异预览', () => {
        expect(buildConfigDiff({hoverShortcutBeforeDisable: 'Control', selectionTranslatorModeBeforeDisable: 'bilingual'},
            {hoverShortcutBeforeDisable: 'Alt', selectionTranslatorModeBeforeDisable: 'translation-only'}).changeCount).toBe(0);
    });

    it('总开关保留在设置页，Popup 只展示暂停状态', () => {
        const popup = readFileSync(resolve(__dirname, '../src/app/popup/PopupApp.vue'), 'utf8');
        const settings = readFileSync(resolve(__dirname, '../src/features/settings/ui/SettingsSections.vue'), 'utf8');
        expect(popup).not.toContain('setPluginEnabled');
        expect(popup).toContain('v-if="!config.on"');
        expect(settings).toContain('v-model="config.on"');
    });
});

function pageFontFixture() {
    const state: PopupPageFontState = {busy: false, error: ''};
    const preference = {value: false};
    let active = true;
    const save = vi.fn(async (browserDefault: boolean): Promise<void> => {preference.value = browserDefault;});
    const actions = createPopupPageFontActions({state, read: () => preference.value, save, active: () => active});
    return {state, preference, save, actions, pause: () => {active = false;}, resume: () => {active = true;},
        deactivate: () => {active = false;actions.invalidate();}};
}
function pendingFontReply() {
    let resolve!: () => void;
    const promise = new Promise<void>(yes => {resolve = yes;});
    return {promise, resolve};
}
async function flushFontTasks() {for (let index = 0; index < 12; index++) await Promise.resolve();}

describe('Popup global translation-font preference save feedback', () => {
    it('通过已有配置端口保存双向选择，controller 不另存字体状态', async () => {
        const f = pageFontFixture();
        const pending = f.actions.set(true);expect(f.state.busy).toBe(true);await pending;
        expect(f.preference.value).toBe(true);expect(f.state).toEqual({busy: false, error: ''});
        await f.actions.set(false);expect(f.preference.value).toBe(false);expect(f.save.mock.calls).toEqual([[true], [false]]);
        expect(f.state).not.toHaveProperty('browserDefault');
    });

    it('相同选择、损坏值、忙碌和失活均不产生重复保存', async () => {
        const f = pageFontFixture();await f.actions.retry();await f.actions.set(false);await f.actions.set('true' as never);
        expect(f.save).not.toHaveBeenCalled();
        const gate = pendingFontReply();f.save.mockReturnValueOnce(gate.promise);const pending = f.actions.set(true);
        await f.actions.set(false);await f.actions.retry();expect(f.save).toHaveBeenCalledTimes(1);
        f.deactivate();gate.resolve();await pending;await f.actions.set(true);expect(f.save).toHaveBeenCalledTimes(1);
        expect(f.state).toEqual({busy: false, error: ''});
    });

    it.each(['reject', 'throw'] as const)('保存 %s 后保留失败目标，同按钮直接重试', async kind => {
        const f = pageFontFixture();
        if (kind === 'reject') f.save.mockRejectedValueOnce(Error('save rejected'));
        else f.save.mockImplementationOnce(() => {throw Error('save threw');});
        await f.actions.set(true);expect(f.preference.value).toBe(false);expect(f.state).toEqual({busy: false, error: 'popup.pageFont.changeError'});
        await f.actions.retry();expect(f.preference.value).toBe(true);expect(f.save.mock.calls).toEqual([[true], [true]]);
        expect(f.state).toEqual({busy: false, error: ''});await f.actions.retry();expect(f.save).toHaveBeenCalledTimes(2);
    });

    it('失败后即便配置已由外部改成目标值，重试仍交给配置端口确认', async () => {
        const f = pageFontFixture();f.save.mockRejectedValueOnce(Error('unknown confirmation'));await f.actions.set(true);
        f.preference.value = true;await f.actions.retry();expect(f.save.mock.calls).toEqual([[true], [true]]);expect(f.state.error).toBe('');
    });

    it('等待期间外部配置胜出，迟到成功不覆盖配置订阅', async () => {
        const f = pageFontFixture(), gate = pendingFontReply();f.save.mockReturnValueOnce(gate.promise);
        const pending = f.actions.set(true);f.preference.value = false;gate.resolve();await pending;
        expect(f.preference.value).toBe(false);expect(f.state).toEqual({busy: false, error: ''});
    });

    it('关闭只结束界面等待，已接受保存继续持久化且重开读取现有真值', async () => {
        const f = pageFontFixture(), gate = pendingFontReply();
        f.save.mockImplementationOnce(async value => {await gate.promise;f.preference.value = value;});
        const pending = f.actions.set(true);f.deactivate();await pending;expect(f.state).toEqual({busy: false, error: ''});
        gate.resolve();await flushFontTasks();expect(f.preference.value).toBe(true);expect(f.state.error).toBe('');
        f.resume();await f.actions.set(false);expect(f.preference.value).toBe(false);
    });

    it('失活后的失败不写回错误，且旧 finally 不能清除新一轮忙碌', async () => {
        const f = pageFontFixture(), old = pendingFontReply(), fresh = pendingFontReply();
        f.save.mockReturnValueOnce(old.promise);const first = f.actions.set(true);f.actions.invalidate();
        f.save.mockReturnValueOnce(fresh.promise);const second = f.actions.set(true);await first;old.resolve();await flushFontTasks();
        expect(f.state.busy).toBe(true);fresh.resolve();await second;expect(f.state.busy).toBe(false);expect(f.state.error).toBe('');
        f.save.mockImplementationOnce(async () => {f.pause();throw Error('late failure');});await f.actions.set(true);expect(f.state.error).toBe('');
    });

    it('失活期间完成的成功不保留可重试目标', async () => {
        const f = pageFontFixture(), gate = pendingFontReply();f.save.mockReturnValueOnce(gate.promise);
        const pending = f.actions.set(true);f.pause();gate.resolve();await pending;
        expect(f.state).toEqual({busy: false, error: ''});f.resume();await f.actions.retry();expect(f.save).toHaveBeenCalledTimes(1);
    });

    it('等待有上限，迟到保存仍可完成但不清除超时反馈', async () => {
        vi.useFakeTimers();
        try {
            const f = pageFontFixture(), gate = pendingFontReply();
            f.save.mockImplementationOnce(async value => {await gate.promise;f.preference.value = value;});
            const pending = f.actions.set(true);await vi.advanceTimersByTimeAsync(10_000);await pending;
            expect(f.state).toEqual({busy: false, error: 'popup.pageFont.changeError'});
            gate.resolve();await flushFontTasks();expect(f.preference.value).toBe(true);expect(f.state.error).toBe('popup.pageFont.changeError');
            await f.actions.retry();expect(f.state.error).toBe('');expect(vi.getTimerCount()).toBe(0);
        } finally {vi.useRealTimers();}
    });
});
