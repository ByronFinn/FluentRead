/**
 * @file tests/aiMultiSegmentConfig.test.ts
 * 文件职责：验证 AI 全文多段预算的纯规范化与配置迁移、导入导出和普通云同步契约。
 * 主要内容：覆盖默认值、两端范围、有限数字字符串、小数取整和非法类型；确认开关关闭保留预算，旧备份补默认，新预算以可读名称预览并跨设备恢复。
 * 模块边界：执行真实配置领域模块，不读写浏览器存储、不调用翻译供应商或 UI。
 */
import {describe, expect, it} from 'vitest';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {
    DEFAULT_AI_MULTI_SEGMENT_MAX_SEGMENTS, MIN_AI_MULTI_SEGMENT_MAX_SEGMENTS, MAX_AI_MULTI_SEGMENT_MAX_SEGMENTS,
    DEFAULT_AI_MULTI_SEGMENT_MAX_CHARACTERS, MIN_AI_MULTI_SEGMENT_MAX_CHARACTERS, MAX_AI_MULTI_SEGMENT_MAX_CHARACTERS,
    normalizeAiMultiSegmentMaxSegments, normalizeAiMultiSegmentMaxCharacters,
} from '@/src/core/config/aiMultiSegment';
import {buildConfigDiff, configDiffFieldLabel} from '@/src/core/config/diff';
import {prepareConfigForExport, prepareConfigForImport} from '@/src/core/config/transfer';
import {buildDriveSyncDiff, projectDriveSyncConfig, restoreDriveSyncSettings} from '@/src/core/config/driveSync';

describe('AI 全文多段预算', () => {
    it.each([
        [normalizeAiMultiSegmentMaxSegments, DEFAULT_AI_MULTI_SEGMENT_MAX_SEGMENTS, MIN_AI_MULTI_SEGMENT_MAX_SEGMENTS, MAX_AI_MULTI_SEGMENT_MAX_SEGMENTS],
        [normalizeAiMultiSegmentMaxCharacters, DEFAULT_AI_MULTI_SEGMENT_MAX_CHARACTERS, MIN_AI_MULTI_SEGMENT_MAX_CHARACTERS, MAX_AI_MULTI_SEGMENT_MAX_CHARACTERS],
    ] as const)('有限数字与字符串取整并限制范围，非法预算回默认值', (normalize, fallback, min, max) => {
        for (const value of [undefined, null, '', '  ', 'broken', Number.NaN, Infinity, -Infinity, true, false, {}, [], Symbol('budget')]) {
            expect(normalize(value), String(value)).toBe(fallback);
        }
        for (const [input, expected] of [[min, min], [max, max], [min - 1, min], [max + 1, max],
            [min + 0.9, min], [String(max), max], [` ${min + 1}.9 `, min + 1], ['1e100', max], [-Infinity, fallback]] as const) {
            expect(normalize(input), String(input)).toBe(expected);
            expect(normalize(normalize(input))).toBe(expected);
        }
    });

    it('新旧配置默认 8 个片段及 2000 字符，关闭保留合法自定义预算', () => {
        for (const config of [new Config(), normalizeConfig({}), normalizeConfig(null)]) {
            expect(config).toMatchObject({enableAIMultiSegment: false, aiMultiSegmentMaxSegments: 8, aiMultiSegmentMaxCharacters: 2000});
        }
        const source = {enableAIMultiSegment: false, aiMultiSegmentMaxSegments: '32.9', aiMultiSegmentMaxCharacters: '9000.8'};
        const normalized = normalizeConfig(source);
        expect(normalized).toMatchObject({enableAIMultiSegment: false, aiMultiSegmentMaxSegments: 32, aiMultiSegmentMaxCharacters: 9000});
        expect(source.aiMultiSegmentMaxSegments).toBe('32.9');
        expect(normalizeConfig({...normalized, enableAIMultiSegment: true})).toMatchObject({aiMultiSegmentMaxSegments: 32, aiMultiSegmentMaxCharacters: 9000});
    });

    it('完整导入导出保留预算，旧备份缺项与非法值补默认', () => {
        const custom = normalizeConfig({...new Config(), enableAIMultiSegment: true, aiMultiSegmentMaxSegments: 12, aiMultiSegmentMaxCharacters: 8000});
        const exported = prepareConfigForExport(custom);
        expect(prepareConfigForImport(exported, new Config())).toMatchObject({enableAIMultiSegment: true, aiMultiSegmentMaxSegments: 12, aiMultiSegmentMaxCharacters: 8000});
        const {aiMultiSegmentMaxSegments: _segments, aiMultiSegmentMaxCharacters: _characters, ...legacy} = exported;
        for (const input of [legacy, {...legacy, aiMultiSegmentMaxSegments: 'broken', aiMultiSegmentMaxCharacters: {}}]) {
            expect(prepareConfigForImport(input, custom)).toMatchObject({aiMultiSegmentMaxSegments: 8, aiMultiSegmentMaxCharacters: 2000});
        }
    });

    it('配置与云差异使用可读名称，普通备份恢复预算并保留本机凭据', () => {
        const local = normalizeConfig(new Config());
        const remote = normalizeConfig({...local, aiMultiSegmentMaxSegments: 24, aiMultiSegmentMaxCharacters: 12000});
        expect(configDiffFieldLabel('aiMultiSegmentMaxSegments')).toBe('AI 多段每批最多片段数');
        expect(configDiffFieldLabel('aiMultiSegmentMaxCharacters')).toBe('AI 多段每批最多字符数');
        const diff = buildConfigDiff(local, remote);
        expect(diff.changeCount).toBe(2);
        expect(diff.groups.find(group => group.id === 'translation')?.changes.map(change => change.key)).toEqual([
            'aiMultiSegmentMaxSegments', 'aiMultiSegmentMaxCharacters',
        ]);
        const projected = projectDriveSyncConfig(remote as unknown as Record<string, unknown>);
        expect(projected).toMatchObject({aiMultiSegmentMaxSegments: 24, aiMultiSegmentMaxCharacters: 12000});
        const cloudDiff = buildDriveSyncDiff(null, local as unknown as Record<string, unknown>, remote as unknown as Record<string, unknown>);
        expect(cloudDiff.changes.filter(change => change.label.startsWith('AI 多段每批')).map(change => change.sensitive)).toEqual([false, false]);
        expect(restoreDriveSyncSettings(local as unknown as Record<string, unknown>, projected)).toMatchObject({
            aiMultiSegmentMaxSegments: 24, aiMultiSegmentMaxCharacters: 12000, token: local.token,
        });
    });
});
