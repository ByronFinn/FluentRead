import {describe, expect, it} from 'vitest';
import {
    DEFAULT_COMMENT_PREFERENCES, normalizeCommentPreferences, resolveCommentModel,
    isCommentServiceUsable, COMMENT_COUNT_MAX, COMMENT_COUNT_MIN,
} from '@/src/core/config/comment';
import {customModelString, services} from '@/src/core/config/catalog';
import {COMMENT_PROMPT_MAX_LENGTH} from '@/src/core/comment/prompts';

describe('comment preferences', () => {
    it('falls back to defaults for non-object input', () => {
        expect(normalizeCommentPreferences(undefined)).toEqual(DEFAULT_COMMENT_PREFERENCES);
        expect(normalizeCommentPreferences([1, 2])).toEqual(DEFAULT_COMMENT_PREFERENCES);
        expect(normalizeCommentPreferences('nope')).toEqual(DEFAULT_COMMENT_PREFERENCES);
    });

    it('gates service by the harness allowlist and trims model overrides', () => {
        expect(normalizeCommentPreferences({enabled: true, service: ' deepseek '}).service).toBe('deepseek');
        expect(normalizeCommentPreferences({service: services.huanYuanTranslation}).service).toBe('');
        expect(normalizeCommentPreferences({service: 'custom-missing'}).service).toBe('');
        expect(normalizeCommentPreferences({model: customModelString}).model).toBe('');
        expect(normalizeCommentPreferences({model: '  glm-4  '}).model).toBe('glm-4');
        expect(normalizeCommentPreferences({model: 42}).model).toBe('');
        expect(normalizeCommentPreferences({enabled: 'yes'}).enabled).toBe(false);
    });

    it('clamps count and bounds prompt length', () => {
        expect(normalizeCommentPreferences({count: 0}).count).toBe(COMMENT_COUNT_MIN);
        expect(normalizeCommentPreferences({count: '9'}).count).toBe(COMMENT_COUNT_MAX);
        expect(normalizeCommentPreferences({count: 2.6}).count).toBe(3);
        expect(normalizeCommentPreferences({count: NaN}).count).toBe(DEFAULT_COMMENT_PREFERENCES.count);
        expect(normalizeCommentPreferences({count: 'abc'}).count).toBe(DEFAULT_COMMENT_PREFERENCES.count);
        expect(normalizeCommentPreferences({prompt: 'x'.repeat(COMMENT_PROMPT_MAX_LENGTH + 50)}).prompt).toHaveLength(COMMENT_PROMPT_MAX_LENGTH);
        expect(normalizeCommentPreferences({prompt: 7}).prompt).toBe('');
    });

    it('resolves effective service and model with comment-level overrides first', () => {
        const base = {service: 'openai', model: {openai: 'gpt-4o'}, customModel: {openai: ''}};
        expect(resolveCommentModel({...base, comment: {service: '', model: ''}})).toEqual({service: 'openai', model: 'gpt-4o'});
        expect(resolveCommentModel({...base, comment: {service: 'deepseek', model: 'deep-v'}})).toEqual({service: 'deepseek', model: 'deep-v'});
        expect(resolveCommentModel({...base, comment: {service: '', model: ''}, model: {openai: customModelString}, customModel: {openai: 'mine'}}))
            .toEqual({service: 'openai', model: 'mine'});
    });

    it('reports usable services including empty-string rejection', () => {
        expect(isCommentServiceUsable('deepseek')).toBe(true);
        expect(isCommentServiceUsable('')).toBe(false);
        expect(isCommentServiceUsable(9)).toBe(false);
        expect(isCommentServiceUsable(services.huanYuanTranslation)).toBe(false);
    });
});
