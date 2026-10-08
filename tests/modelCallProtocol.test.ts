import {describe, expect, it, vi} from 'vitest';
import type {Config} from '@/src/core/config/model';
import {
    MODEL_CALL_CANCEL_OFFSCREEN_MESSAGE_TYPE,
    MODEL_CALL_EVENT_MESSAGE_TYPE,
    MODEL_CALL_HEARTBEAT_INTERVAL_MS,
    MODEL_CALL_START_OFFSCREEN_MESSAGE_TYPE,
    createModelCallRequestId,
    restoreModelCallError,
    serializeModelCallError,
    stripAbortSignal,
    type ModelCallOptions,
    type ModelCallStartMessage,
} from '@/src/services/harness/modelCallProtocol';

const UUID_BODY_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

describe('model call protocol constants and messages', () => {
    it('keeps message type constants aligned with offscreen naming conventions', () => {
        expect(MODEL_CALL_START_OFFSCREEN_MESSAGE_TYPE).toBe('MODEL_CALL_START_OFFSCREEN');
        expect(MODEL_CALL_CANCEL_OFFSCREEN_MESSAGE_TYPE).toBe('MODEL_CALL_CANCEL_OFFSCREEN');
        expect(MODEL_CALL_EVENT_MESSAGE_TYPE).toBe('fluentReadModelCallEvent');
        expect(MODEL_CALL_HEARTBEAT_INTERVAL_MS).toBe(20_000);
    });

    it('carries the start payload without abortSignal', () => {
        const message: ModelCallStartMessage = {
            type: MODEL_CALL_START_OFFSCREEN_MESSAGE_TYPE,
            requestId: 'model-call-r1',
            service: 'openai',
            model: 'gpt-test',
            kind: 'generate',
            config: {} as Config,
            options: {prompt: [], temperature: 0.3},
        };
        expect(message.type).toBe('MODEL_CALL_START_OFFSCREEN');
        expect('abortSignal' in message.options).toBe(false);
    });
});

describe('stripAbortSignal', () => {
    it('removes only abortSignal and keeps other fields untouched', () => {
        const prompt = [{role: 'user', content: [{type: 'text', text: '你好'}]}] as unknown as ModelCallOptions['prompt'];
        const abortSignal = new AbortController().signal;
        const payload = stripAbortSignal({prompt, temperature: 0.7, abortSignal});
        expect('abortSignal' in payload).toBe(false);
        expect(payload.prompt).toBe(prompt);
        expect(payload.temperature).toBe(0.7);
    });

    it('accepts options without abortSignal', () => {
        const prompt = [] as unknown as ModelCallOptions['prompt'];
        const payload = stripAbortSignal({prompt, maxOutputTokens: 128});
        expect(payload).toEqual({prompt, maxOutputTokens: 128});
    });
});

describe('createModelCallRequestId', () => {
    it('uses randomUUID when available and prefixes the feature namespace', () => {
        const randomSource = {randomUUID: () => '0f0e0d0c-0b0a-4909-8807-060504030201', getRandomValues: vi.fn()};
        expect(createModelCallRequestId(randomSource)).toBe('model-call-0f0e0d0c-0b0a-4909-8807-060504030201');
        expect(randomSource.getRandomValues).not.toHaveBeenCalled();
    });

    it('falls back to getRandomValues with an RFC 4122 v4 identity', () => {
        // vi.fn 会把返回类型放宽成 Uint8Array<ArrayBufferLike>，与 Crypto 端口签名不符，普通函数即可。
        const randomSource: Parameters<typeof createModelCallRequestId>[0] = {
            getRandomValues: <T extends ArrayBufferView | null>(array: T): T => {
                if (array instanceof Uint8Array) array.fill(0xff);
                return array;
            },
        };
        // 全 0xff 输入经版本位与变体位覆写后固定为 4fff / bfff。
        expect(createModelCallRequestId(randomSource)).toBe('model-call-ffffffff-ffff-4fff-bfff-ffffffffffff');
    });

    it('generates unique ids from the default crypto source', () => {
        const ids = Array.from({length: 64}, () => createModelCallRequestId());
        expect(new Set(ids).size).toBe(64);
        for (const id of ids) expect(id).toMatch(new RegExp(`^model-call-${UUID_BODY_PATTERN}$`, 'u'));
    });
});

describe('serializeModelCallError', () => {
    it('serializes a plain error to name and message only', () => {
        expect(serializeModelCallError(new TypeError('boom'))).toEqual({kind: 'error', name: 'TypeError', message: 'boom'});
    });

    it('normalizes empty name and non-Error values', () => {
        const anonymous = new Error('匿名');
        anonymous.name = '';
        expect(serializeModelCallError(anonymous)).toEqual({kind: 'error', name: 'Error', message: '匿名'});
        expect(serializeModelCallError('字符串错误')).toEqual({kind: 'error', name: 'Error', message: '字符串错误'});
    });

    it('captures APICallError discriminant fields duck-typed from the error', () => {
        const apiCallError = Object.assign(new Error('rate limited'), {
            name: 'AI_APICallError',
            url: 'https://api.example.com/v1/chat/completions',
            statusCode: 429,
            responseBody: '{"error":{"message":"Too Many Requests"}}',
        });
        expect(serializeModelCallError(apiCallError)).toEqual({
            kind: 'error',
            name: 'AI_APICallError',
            message: 'rate limited',
            url: 'https://api.example.com/v1/chat/completions',
            statusCode: 429,
            responseBodyText: '{"error":{"message":"Too Many Requests"}}',
        });
    });

    it('drops invalid optional fields instead of forwarding them', () => {
        const malformed = Object.assign(new Error('畸形字段'), {
            url: 123,
            statusCode: Number.NaN,
            responseBody: {not: 'a string'},
        });
        expect(serializeModelCallError(malformed)).toEqual({kind: 'error', name: 'Error', message: '畸形字段'});
    });
});

describe('restoreModelCallError', () => {
    it('rebuilds a plain error from name and message', () => {
        const restored = restoreModelCallError({kind: 'error', name: 'TypeError', message: 'boom'});
        expect(restored).toBeInstanceOf(Error);
        expect(restored.name).toBe('TypeError');
        expect(restored.message).toBe('boom');
        expect('url' in restored).toBe(false);
        expect('statusCode' in restored).toBe(false);
        expect('responseBody' in restored).toBe(false);
    });

    it('keeps the AbortError name so cancellation stays distinguishable', () => {
        const restored = restoreModelCallError({kind: 'error', name: 'AbortError', message: '翻译请求已取消'});
        expect(restored.name).toBe('AbortError');
        expect(restored.message).toBe('翻译请求已取消');
    });

    it('attaches APICallError discriminant fields for status-kind reconstruction', () => {
        const restored = restoreModelCallError({
            kind: 'error',
            name: 'AI_APICallError',
            message: 'rate limited',
            url: 'https://api.example.com',
            statusCode: 429,
            responseBodyText: 'Too Many Requests',
        });
        expect(restored.url).toBe('https://api.example.com');
        expect(restored.statusCode).toBe(429);
        expect(restored.responseBody).toBe('Too Many Requests');
    });

    it('falls back to the Error name when the field is empty', () => {
        const restored = restoreModelCallError({kind: 'error', name: '', message: 'missing name'});
        expect(restored.name).toBe('Error');
    });

    it('round-trips APICallError-like errors without losing fidelity', () => {
        const original = Object.assign(new Error('upstream failed'), {
            name: 'AI_APICallError',
            url: 'https://api.example.com/v1',
            statusCode: 503,
            responseBody: 'Service Unavailable',
        });
        const restored = restoreModelCallError(serializeModelCallError(original));
        expect(restored.name).toBe(original.name);
        expect(restored.message).toBe(original.message);
        expect(restored.url).toBe(original.url);
        expect(restored.statusCode).toBe(original.statusCode);
        expect(restored.responseBody).toBe(original.responseBody);
    });
});
