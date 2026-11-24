import {beforeEach, describe, expect, it, vi} from 'vitest';
import type * as Rotation from '@/src/services/translation/apiKeyRotation';

let run: typeof Rotation.runWithApiKeyRotation;
let redact: typeof Rotation.redactApiKeyError;
const first = 'fixture-first-secret';
const second = 'fixture-second-secret';
const third = 'fixture-third-secret';
const config = () => ({token: {demo: first}, apiKeys: {demo: [first, second, third]}, apiKeyRotationEnabled: {demo: true}, translationMaxRetries: 3});
const failure = (statusCode: number) => Object.assign(new Error(`HTTP ${statusCode}`), {statusCode});

describe('multi-key request orchestration', () => {
    beforeEach(async () => {
        vi.resetModules();
        ({runWithApiKeyRotation: run, redactApiKeyError: redact} = await import('@/src/services/translation/apiKeyRotation'));
    });

    it('preserves no-key and single-key execution and legacy token compatibility', async () => {
        const noKey = {};
        const operation = vi.fn(async (source: any) => source);
        expect(await run(noKey, 'demo', operation)).toMatchObject({token: {demo: ''}, apiKeys: {demo: ['']}});
        expect(await run({token: {demo: first}}, 'demo', operation)).toMatchObject({token: {demo: first}});
        expect(await run({...config(), apiKeys: {demo: [second]}}, 'demo', operation)).toMatchObject({token: {demo: second}, translationMaxRetries: 3});
        await expect(run({token: {}}, 'demo', async () => { throw failure(401); })).rejects.toMatchObject({statusCode: 401});
    });

    it('keeps multiple saved keys but uses only the first until rotation is enabled', async () => {
        const used: string[] = [];
        await run({...config(), apiKeyRotationEnabled: {demo: false}}, 'demo', async selected => {
            used.push(selected.token.demo);
            return 'ok';
        });
        expect(used).toEqual([first]);
    });

    it.each([false, true])('does not compute unused rotation scope for a single key (enabled=%s)', async enabled => {
        const readEndpoint = vi.fn(() => 'https://fixture.invalid');
        const proxy = Object.defineProperty({}, 'demo', {get: readEndpoint});
        const source = {token: {demo: first}, proxy, apiKeyRotationEnabled: {demo: enabled}};
        const operation = vi.fn(async selected => selected.token.demo);
        await expect(run(source, 'demo', operation)).resolves.toBe(first);
        expect(readEndpoint).not.toHaveBeenCalled();
        expect(operation).toHaveBeenCalledTimes(1);
    });

    it.each([
        {token: {demo: first}},
        {...config(), apiKeyRotationEnabled: {demo: false}},
        {},
    ])('rejects a late single-attempt result after the owner aborts (%j)', async source => {
        for (const succeeds of [true, false]) {
            const owner = new AbortController();
            const operation = vi.fn(async () => {
                owner.abort();
                if (!succeeds) throw failure(503);
                return 'late translation';
            });
            await expect(run(source, 'demo', operation, {signal: owner.signal}))
                .rejects.toMatchObject({name: 'AbortError'});
            expect(operation).toHaveBeenCalledOnce();
        }
    });

    it.each([false, true])('redacts provider key echoes when rotation is disabled or unnecessary (%s)', async disabled => {
        const key = 'fixture/+single-secret';
        const source = {token: {demo: key}, apiKeys: {demo: disabled ? [key, second] : [key]},
            apiKeyRotationEnabled: {demo: !disabled}};
        const echoed = Object.assign(new Error(`HTTP 401 ${key} ${encodeURIComponent(key)} ${second}`), {
            statusCode: 401, code: key, requestId: encodeURIComponent(key), retryAfterMs: 500,
        });
        const error = await run(source, 'demo', async () => {throw echoed;}).catch(reason => reason);
        expect(error.message).not.toContain(key);
        expect(error.message).not.toContain(encodeURIComponent(key));
        if (disabled) expect(error.message).not.toContain(second);
        expect(error).toMatchObject({statusCode: 401, code: '[已隐藏的密钥]', requestId: '[已隐藏的密钥]', retryAfterMs: 500});
    });

    it('keeps no-key failures and provider cancellation recognizable on the single-attempt path', async () => {
        const noKeyFailure = failure(503);
        await expect(run({}, 'demo', async () => {throw noKeyFailure;})).rejects.toBe(noKeyFailure);
        class ProviderDeadlineError extends Error {}
        const deadline = new ProviderDeadlineError('provider deadline');
        await expect(run({token: {demo: first}}, 'demo', async () => {throw deadline;})).rejects.toBe(deadline);
        await expect(run({token: {demo: first}}, 'demo', async () => {
            throw new DOMException(`cancelled ${first}`, 'AbortError');
        })).rejects.toMatchObject({name: 'AbortError', message: 'cancelled [已隐藏的密钥]'});
    });

    it('clears stale tokens when an explicit service key list is empty or blank', async () => {
        const operation = vi.fn(async (source: any) => source);
        const stale = {token: {demo: 'stale-secret'}, apiKeys: {demo: []}};
        expect(await run(stale, 'demo', operation)).toMatchObject({token: {demo: ''}, apiKeys: {demo: ['']}});
        const blank = {token: {demo: 'stale-secret'}, apiKeys: {demo: ['']}};
        expect(await run(blank, 'demo', operation)).toMatchObject({token: {demo: ''}, apiKeys: {demo: ['']}});
    });

    it('distributes concurrent work beyond the key count and freezes selected credentials', async () => {
        const selected: string[] = [];
        const source = config();
        const results = await Promise.all(Array.from({length: 9}, () => run(source, 'demo', async selectedConfig => {
            selected.push(selectedConfig.token.demo);
            expect(Object.isFrozen(selectedConfig)).toBe(true);
            expect(Object.isFrozen(selectedConfig.token)).toBe(true);
            expect(selectedConfig.translationMaxRetries).toBe(0);
            await Promise.resolve();
            return '译文';
        })));
        expect(results).toHaveLength(9);
        expect(selected).toEqual([first, second, third, first, second, third, first, second, third]);
        expect(source.token.demo).toBe(first);
    });

    it('switches immediately on authentication failure and avoids that key until one minute', async () => {
        let time = 0;
        const used: string[] = [];
        const operation = async (selected: ReturnType<typeof config>) => {
            used.push(selected.token.demo);
            if (selected.token.demo === first && time === 0) throw failure(401);
            return 'ok';
        };
        await expect(run(config(), 'demo', operation, {now: () => time})).resolves.toBe('ok');
        expect(used).toEqual([first, second]);
        used.length = 0;
        for (let i = 0; i < 8; i++) await run(config(), 'demo', operation, {now: () => time});
        expect(used).not.toContain(first);
        time = 60_000;
        used.length = 0;
        for (let i = 0; i < 6; i++) await run(config(), 'demo', operation, {now: () => time});
        expect(used.filter(key => key === first)).toHaveLength(2);
    });

    it('uses the configured recovery window while keeping the default at one minute', async () => {
        const operation = vi.fn().mockRejectedValue(failure(401));
        await expect(run({...config(), apiKeyRecoveryMs: 2 * 60_000}, 'demo', operation, {now: () => 0}))
            .rejects.toMatchObject({statusCode: 401});
        await expect(run({...config(), apiKeyRecoveryMs: 2 * 60_000}, 'demo', operation, {now: () => 1_000}))
            .rejects.toMatchObject({retryAfterMs: 119_000});
        expect(operation).toHaveBeenCalledTimes(3);
    });

    it.each([401, 403, 429, 408, 425, 500, 503])('changes key on HTTP %i', async status => {
        const used: string[] = [];
        await run(config(), 'demo', async selected => {
            used.push(selected.token.demo);
            if (used.length === 1) throw failure(status);
            return 'ok';
        });
        expect(used).toEqual([first, second]);
    });

    it.each(['API_KEY_INVALID', 'invalidToken'])('changes key on explicit credential error returned as HTTP 400 (%s)', async code => {
        const used: string[] = [];
        await run(config(), 'demo', async selected => {
            used.push(selected.token.demo);
            if (used.length === 1) throw Object.assign(new Error('request rejected'), {statusCode: 400, code});
            return 'ok';
        });
        expect(used).toEqual([first, second]);
    });

    it('keeps ordinary HTTP 400 model errors on the current key', async () => {
        const operation = vi.fn().mockRejectedValue(Object.assign(new Error('invalid model'), {statusCode: 400, code: 'MODEL_INVALID'}));
        await expect(run(config(), 'demo', operation)).rejects.toBeTruthy();
        expect(operation).toHaveBeenCalledOnce();
    });

    it.each([new Error('Failed to fetch'), new Error('翻译请求超时')])('switches on transient transport failures', async error => {
        const operation = vi.fn().mockRejectedValueOnce(error).mockResolvedValue('ok');
        await expect(run(config(), 'demo', operation)).resolves.toBe('ok');
        expect(operation).toHaveBeenCalledTimes(2);
    });

    it.each([failure(400), failure(404), new Error('invalid model'), new Error('unrecognized response'), new DOMException('cancelled', 'AbortError')])('does not rotate for shared configuration or cancellation errors', async error => {
        const operation = vi.fn().mockRejectedValue(error);
        await expect(run(config(), 'demo', operation)).rejects.toBeTruthy();
        expect(operation).toHaveBeenCalledOnce();
    });

    it('stops all-key authentication failures without a retry storm', async () => {
        const operation = vi.fn().mockRejectedValue(failure(401));
        await expect(run(config(), 'demo', operation, {now: () => 0})).rejects.toMatchObject({statusCode: 401});
        expect(operation).toHaveBeenCalledTimes(3);
        await expect(run(config(), 'demo', operation, {now: () => 1000})).rejects.toMatchObject({retryable: false, retryAfterMs: 59_000});
        expect(operation).toHaveBeenCalledTimes(3);
    });

    it('respects the server retry window rather than extending every rate limit to ten minutes', async () => {
        const error = Object.assign(failure(429), {retryAfterMs: 30_000});
        const operation = vi.fn().mockRejectedValue(error);
        await expect(run(config(), 'demo', operation, {now: () => 0})).rejects.toMatchObject({statusCode: 429});
        await expect(run(config(), 'demo', operation, {now: () => 1000})).rejects.toMatchObject({retryAfterMs: 29_000});
        const success = vi.fn(async selected => selected.token.demo);
        await expect(run(config(), 'demo', success, {now: () => 30_000})).resolves.toBe(first);
    });

    it('attempts every distinct key at most once and reports a safe last failure', async () => {
        const source = {...config(), apiKeys: {demo: [first, first, second]}};
        const operation = vi.fn().mockRejectedValue(new Error(`Failed to fetch ${second}`));
        await expect(run(source, 'demo', operation)).rejects.toThrow('已隐藏的密钥');
        expect(operation).toHaveBeenCalledTimes(2);
    });

    it('tests the original row only, bypasses cooling, and restores a passing key', async () => {
        const source = {...config(), apiKeys: {demo: [first, '', second]}};
        const fail = vi.fn().mockRejectedValue(failure(401));
        await expect(run(source, 'demo', fail, {keyIndex: 0, now: () => 0})).rejects.toMatchObject({statusCode: 401});
        expect(fail).toHaveBeenCalledOnce();
        const operation = vi.fn(async selected => selected.token.demo);
        await expect(run(source, 'demo', operation, {keyIndex: 2, now: () => 1})).resolves.toBe(second);
        await expect(run(source, 'demo', operation, {keyIndex: 0, now: () => 2})).resolves.toBe(first);
        const used = await Promise.all([run(source, 'demo', operation, {now: () => 3}), run(source, 'demo', operation, {now: () => 3})]);
        expect(used.sort()).toEqual([first, second].sort());
        await expect(run(source, 'demo', async () => {throw new Error('bad response');}, {keyIndex: 0})).rejects.toThrow('bad response');
        await expect(run(source, 'demo', async () => {throw new Error('Failed to fetch');}, {keyIndex: 0})).rejects.toThrow('Failed to fetch');
    });

    it.each([-1, 0.5, 6, Number.NaN, 1])('rejects invalid or blank key row %s before network', async keyIndex => {
        const operation = vi.fn();
        await expect(run({...config(), apiKeys: {demo: [first, '', second]}}, 'demo', operation, {keyIndex})).rejects.toThrow('更改或为空');
        expect(operation).not.toHaveBeenCalled();
    });

    it('shares the overall budget and never restarts an expired request', async () => {
        let time = 0;
        const budgets: unknown[] = [];
        await expect(run(config(), 'demo', async (_selected, attempt) => {
            budgets.push(attempt.attemptTimeoutMs);
            time += 5000;
            if (budgets.length === 1) throw new Error('翻译请求超时');
            return 'ok';
        }, {deadlineAt: 30_000, now: () => time})).resolves.toBe('ok');
        expect(budgets).toEqual([10_000, 12_500]);
        const operation = vi.fn().mockResolvedValue('unused');
        await expect(run(config(), 'demo', operation, {deadlineAt: 0, now: () => 1})).rejects.toThrow('超时');
        expect(operation).not.toHaveBeenCalled();
        await expect(run(config(), 'other', async () => 'no-key', {deadlineAt: 0})).resolves.toBe('no-key');
        await expect(run(config(), 'demo', async () => {time = 99_000; throw failure(500);}, {deadlineAt: 40_000, now: () => time})).rejects.toMatchObject({statusCode: 500});
    });

    it('honors abort before starting and between attempts including a successful late result', async () => {
        const controller = new AbortController();
        const operation = vi.fn();
        controller.abort();
        await expect(run(config(), 'demo', operation, {signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'});
        expect(operation).not.toHaveBeenCalled();
        for (const keyIndex of [undefined, 0]) {
            for (const succeeds of [false, true]) {
                const abort = new AbortController();
                const request = vi.fn(async () => {abort.abort(); if (!succeeds) throw failure(500); return 'late';});
                await expect(run(config(), 'demo', request, {signal: abort.signal, keyIndex})).rejects.toMatchObject({name: 'AbortError'});
                expect(request).toHaveBeenCalledOnce();
            }
        }
    });

    it('isolates services/endpoints/models and synchronizes added or removed keys', async () => {
        const source = {...config(), proxy: {demo: 'https://one.test'}, model: {demo: 'model'}, customOpenAIProviders: [{id: 'demo', endpoint: 'https://one.test'}]};
        await expect(run(source, 'demo', async () => {throw failure(401);}, {now: () => 0})).rejects.toBeTruthy();
        const operation = vi.fn(async selected => selected.token.demo);
        expect(await run({...source, proxy: {demo: 'https://two.test'}}, 'demo', operation, {now: () => 0})).toBe(first);
        expect(await run(source, 'demo', operation, {now: () => 0, model: 'different'})).toBe(first);
        const edited = {...source, apiKeys: {demo: ['fixture-added-secret']}};
        expect(await run(edited, 'demo', operation)).toBe('fixture-added-secret');
        expect(await run({...source, apiKeys: {demo: ['fixture-added-secret', 'fixture-new-secret']}}, 'demo', operation)).toBe('fixture-added-secret');
    });

    it('isolates custom service routing from unrelated global edits while endpoint edits reset its scope', async () => {
        const source = {...config(), token: {custom: first}, apiKeys: {custom: [first, second]}, custom: 'https://custom-one.test'};
        const used: string[] = [];
        await expect(run(source, 'custom', async selected => {
            used.push(selected.token.custom);
            if (used.length === 1) throw failure(401);
            return 'ok';
        }, {now: () => 0})).resolves.toBe('ok');
        used.length = 0;
        await expect(run({...source, mimoRegion: 'unrelated-edit'}, 'custom', async selected => {
            used.push(selected.token.custom);
            return 'ok';
        }, {now: () => 1})).resolves.toBe('ok');
        expect(used[0]).toBe(second);
        used.length = 0;
        await expect(run({...source, custom: 'https://custom-two.test'}, 'custom', async selected => {
            used.push(selected.token.custom);
            return 'ok';
        }, {now: () => 2})).resolves.toBe('ok');
        expect(used[0]).toBe(first);
    });

    it('redacts raw/encoded key echoes in public error metadata', () => {
        const key = 'fixture/+secret';
        const result = redact(Object.assign(new Error(`HTTP 500 ${key} ${encodeURIComponent(key)}`), {statusCode: 500, code: key, requestId: key}), ['', key]);
        expect(result.message).not.toContain(key);
        expect(result.message).not.toContain(encodeURIComponent(key));
        expect(result.code).toBe('[已隐藏的密钥]');
        expect(result.requestId).toBe('[已隐藏的密钥]');
        expect(result.statusCode).toBe(500);
        expect(redact('plain error', []).message).toBe('plain error');
    });

    it('reports an earlier failure when the remaining keys are already cooling down', async () => {
        let now = 0;
        const source = config();
        await expect(run(source, 'demo', async selected => {
            if (selected.token.demo === first) throw failure(401);
            return 'ok';
        }, {now: () => now})).resolves.toBe('ok');
        const operation = vi.fn().mockRejectedValue(new Error('Failed to fetch'));
        await expect(run(source, 'demo', operation, {now: () => now})).rejects.toThrow('其他 Key 暂时不可用');
        expect(operation).toHaveBeenCalledTimes(2);
    });

    it('redacts key-bearing code and request id when cooling down keys exhaust after a prior error', async () => {
        const source = {...config(), token: {leak: first}, apiKeys: {leak: [first, second, third]}};
        await expect(run(source, 'leak', async selected => {
            if (selected.token.leak === first) throw failure(401);
            return 'ok';
        }, {now: () => 0})).resolves.toBe('ok');
        const operation = vi.fn().mockRejectedValue(Object.assign(new Error('provider unavailable'), {
            code: first,
            requestId: first,
            statusCode: 503,
        }));
        const error = await run(source, 'leak', operation, {now: () => 0}).catch(reason => reason) as {code: string; requestId: string; message: string};
        expect(error).toMatchObject({name: 'TranslationRequestError'});
        expect(error.code).not.toContain(first);
        expect(error.requestId).not.toContain(first);
        expect(error.message).not.toContain(first);
    });

    it('rotates after a non-Error transport rejection', async () => {
        const operation = vi.fn().mockRejectedValueOnce('Failed to fetch').mockResolvedValue('ok');
        await expect(run(config(), 'demo', operation)).resolves.toBe('ok');
        expect(operation).toHaveBeenCalledTimes(2);
    });
});
