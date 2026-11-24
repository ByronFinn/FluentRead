import { describe, expect, it } from 'vitest';

import {
    createApiKeyRequirementKey,
    getApiKeyRequirementKey,
    getMissingCredentialMessage,
    isApiKeyRequired,
    parseApiKeyRequirementKey,
} from '@/src/core/config/validation';
import {customModelString, services} from '@/src/core/config/catalog';

describe('翻译服务凭据校验', () => {
    it.each(['v2:null', 'v2:{}', 'v2:["service",42]', 'v2:["service","model","extra"]', 'v2:[null,"model"]', 'v2:["service",null]'])(
        '拒绝破损凭据键 %s，避免绑定到另一个模型', key => {
            expect(parseApiKeyRequirementKey(key)).toBeNull();
        },
    );

    it('提示需要 API Key 的服务填写访问令牌', () => {
        expect(getMissingCredentialMessage(services.openai, { token: {} })).toContain('API Key');
        expect(getMissingCredentialMessage(services.openai, { token: { [services.openai]: '  ' } })).toContain('API Key');
        expect(getMissingCredentialMessage(services.openai, { token: { [services.openai]: 'configured' } })).toBeNull();
    });

    it('明确指出 DeepSeek 缺少 API Key', () => {
        expect(getMissingCredentialMessage(services.deepseek, { token: {} })).toBe(
            'DeepSeek 需要 API Key（访问令牌），当前尚未配置；请先在设置中填写，再开始翻译。',
        );
        expect(getMissingCredentialMessage(services.deepseek, { token: { [services.deepseek]: 'configured' } })).toBeNull();
    });

    it('允许按当前模型关闭 API Key 校验', () => {
        const config = {
            model: { [services.deepseek]: 'deepseek-v4-flash' },
            requireApiKey: { [`${services.deepseek}:deepseek-v4-flash`]: false },
            token: {},
        };
        expect(getApiKeyRequirementKey(services.deepseek, config)).toBe(
            createApiKeyRequirementKey(services.deepseek, 'deepseek-v4-flash'),
        );
        expect(getMissingCredentialMessage(services.deepseek, config)).toBeNull();
    });

    it('ChatGPT 套餐始终免除 API Key，自定义接口未配置时仍要求密钥', () => {
        expect(isApiKeyRequired(services.chatgptPlan, {})).toBe(false);
        expect(isApiKeyRequired('custom:team', {})).toBe(true);
        expect(isApiKeyRequired('custom', {
            requireApiKey: {'custom:team-model': false},
            model: {custom: 'team-model'},
        })).toBe(false);
    });

    it('切换模型后不会复用另一个模型的免 Key设置', () => {
        const config = {
            model: { [services.deepseek]: 'deepseek-v4-pro' },
            requireApiKey: { [`${services.deepseek}:deepseek-v4-flash`]: false },
            token: {},
        };
        expect(getMissingCredentialMessage(services.deepseek, config)).toContain('API Key');
    });

    it('独立功能模型只覆盖本次校验身份，保留默认模型、动态服务名与自定义模型解析', () => {
        const service = 'custom:team';
        const config = {model: {[service]: 'main'}, customModel: {[service]: 'private'}, token: {},
            customOpenAIProviders: [{id: service, name: '团队网关', endpoint: 'https://gateway.example/v1', models: ['private']}],
            requireApiKey: {[createApiKeyRequirementKey(service, 'private')]: false, [createApiKeyRequirementKey(service, '')]: false}};
        expect(getMissingCredentialMessage(service, config, customModelString)).toBeNull();
        expect(getMissingCredentialMessage(service, config, '')).toBeNull();
        expect(getMissingCredentialMessage(service, config, 'other')).toContain('团队网关 需要 API Key');
        expect(getMissingCredentialMessage(service, config)).toContain('API Key');
        expect(config.model[service]).toBe('main');
        expect(config.customModel[service]).toBe('private');
    });

    it('保留 DeepLX 可选令牌的行为', () => {
        expect(getMissingCredentialMessage(services.deeplx, { token: {} })).toBeNull();
    });

    it('用动态服务名称提示缺失凭据并兼容旧自定义模型键', () => {
        const config = {
            token: {},
            model: {'custom:team': customModelString},
            customModel: {'custom:team': 'team-private-model'},
            customOpenAIProviders: [{
                id: 'custom:team',
                name: '团队模型网关',
                endpoint: 'https://gateway.example/v1',
                models: ['team-private-model'],
            }],
        };

        expect(getApiKeyRequirementKey('custom:team', config)).toBe(
            createApiKeyRequirementKey('custom:team', 'team-private-model'),
        );
        expect(getMissingCredentialMessage('custom:team', config)).toBe(
            '团队模型网关 需要 API Key（访问令牌），当前尚未配置；请先在设置中填写，再开始翻译。',
        );
    });

    it('含冒号的 legacy 模型不会与动态服务的免 Key 开关碰撞', () => {
        const collidingLegacyKey = 'custom:1:latest';
        const legacyConfig = {
            model: {custom: '1:latest'},
            requireApiKey: {[collidingLegacyKey]: false},
            token: {},
        };
        const dynamicConfig = {
            model: {'custom:1': 'latest'},
            requireApiKey: {[collidingLegacyKey]: false},
            customOpenAIProviders: [{
                id: 'custom:1',
                name: '动态服务',
                endpoint: 'https://dynamic.example/v1',
                models: ['latest'],
            }],
            token: {},
        };

        expect(getMissingCredentialMessage('custom', legacyConfig)).toBeNull();
        expect(getMissingCredentialMessage('custom:1', dynamicConfig)).toContain('API Key');
        const dynamicKey = getApiKeyRequirementKey('custom:1', dynamicConfig);
        expect(dynamicKey).not.toBe(collidingLegacyKey);
        expect(getMissingCredentialMessage('custom:1', {
            ...dynamicConfig,
            requireApiKey: {[dynamicKey]: false},
        })).toBeNull();
    });

    it('覆盖有道的专用凭据', () => {
        expect(getMissingCredentialMessage(services.youdao, { token: {}, youdaoAppKey: 'key' })).toContain('App Secret');
    });

    it.each([services.tencent, services.huanYuanTranslation])(
        '%s 对共享腾讯 SecretId/SecretKey 使用同一缺失校验',
        (service) => {
            expect(getMissingCredentialMessage(service, {token: {}, tencentSecretId: 'id'}))
                .toContain('SecretKey');
            expect(getMissingCredentialMessage(service, {
                token: {},
                tencentSecretId: 'id',
                tencentSecretKey: 'secret',
            })).toBeNull();
        },
    );
});
