/**
 * @file tests/facebookPublicPostRules.test.ts
 * 文件职责：以已保存的 Facebook 公开帖子原生结构验证作者身份与完整阅读正文的边界。
 * 主要内容：覆盖主作者、十个评论作者、两段带链接的 caption、十三段评论、动态评论、
 * 同名正文和近似组件；通过真实核心快照及状态入口验证双语产物恢复和再次翻译。
 * 模块边界：只操作 Linkedom 夹具，不联网、不调用供应商；候选回归不代表实机翻译或全站验收。
 */
import {parseHTML} from 'linkedom';
import {describe, expect, it} from 'vitest';
import fixture from './fixtures/translation-pages/facebook-public-post-metadata.json';
import {builtinSiteRulePack} from '@/src/core/site-adaptation/catalog';
import {compileSiteRulePack, composeSiteAdapters} from '@/src/core/site-adaptation/compiler';
import {isLiteralLabel} from '@/src/core/site-adaptation/literalLabel';
import {TranslationCandidateCore} from '@/src/core/translation/engine';
import {applyTranslationsToSnapshot, createTranslationSourceSnapshot} from '@/src/core/translation/serialization';
import {extractTranslationTextFromNodes} from '@/src/core/translation/text';
import {
    beginTranslation, markTranslationComplete, restoreTranslation, setBilingualContent,
} from '@/src/features/full-page-translation/content/state';
import type {TranslationCandidate} from '@/src/core/translation/types';
import type {SiteAdaptationSettings} from '@/src/core/site-adaptation/types';

const ruleId = 'facebook-public-post';
const documentFor = (html = fixture.html): Document =>
    parseHTML(`<html><head></head><body>${html}</body></html>`).document as unknown as Document;

function node(document: Document, id: string): HTMLElement {
    const result = document.getElementById(id);
    if (!result) throw new Error(`Missing Facebook fixture node: ${id}`);
    return result;
}

const createCore = (url = fixture.url, generic = false) => new TranslationCandidateCore({
    url: new URL(url), adapters: generic ? [] : compileSiteRulePack(builtinSiteRulePack),
});
const source = (core: TranslationCandidateCore, candidate: TranslationCandidate) =>
    extractTranslationTextFromNodes(candidate.nodes ?? [candidate.element], core.shouldStayOriginal);
const sources = (core: TranslationCandidateCore, root: Node) => core.discover(root).map(candidate => source(core, candidate));

describe('Facebook 公开帖子的窄作者边界', () => {
    it('忠实夹具保留两段 caption、十个评论和十三段原生评论正文', () => {
        const document = documentFor();
        expect(document.querySelectorAll('#caption div[dir="auto"]')).toHaveLength(2);
        expect(document.querySelectorAll('#native-post [role="article"][aria-label]')).toHaveLength(10);
        expect(document.querySelectorAll('#native-post span[dir="auto"][lang] > div > div[dir="auto"]')).toHaveLength(13);
        for (const body of fixture.bodySources) expect(node(document, body.id).textContent, body.id).toBe(body.text);
    });

    it.each(fixture.authorIds)('%s 的完整名字在通用路径暴露，站点规则保护且不分配槽', (id) => {
        const document = documentFor();
        const author = node(document, id);
        const generic = createCore(fixture.url, true);
        const core = createCore();
        expect(sources(generic, document), id).toContain(author.textContent!.trim());
        expect(core.shouldStayOriginal(author), id).toBe(true);
        expect(core.shouldIgnoreMutation(author), id).toBe(true);
        expect(core.discover(author), id).toEqual([]);
        expect(sources(core, document), id).not.toContain(author.textContent!.trim());
        expect(createTranslationSourceSnapshot(author, core.shouldStayOriginal,
            undefined, undefined, core.shouldOmitFromTranslation).slots, id).toEqual([]);
    });

    it('全部十五个原生正文段仍为独立通用 owner，逐段保留完整 source', () => {
        const document = documentFor();
        const core = createCore();
        const candidates = core.discover(document);
        for (const id of fixture.bodyIds) {
            const body = node(document, id);
            expect(core.shouldStayOriginal(body), id).toBe(false);
            expect(core.shouldIgnoreMutation(body), id).toBe(false);
            const matches = candidates.filter(candidate => candidate.element === body);
            expect(matches, id).toHaveLength(1);
            expect(core.resolve(body.firstChild)?.element, id).toBe(body);
            expect(source(core, matches[0]!), id).toBe(extractTranslationTextFromNodes([body]));
            const snapshot = createTranslationSourceSnapshot(body, core.shouldStayOriginal,
                undefined, undefined, core.shouldOmitFromTranslation);
            expect(snapshot.clone.textContent, id).toBe(body.textContent);
        }
        const caption = node(document, 'caption-0');
        expect(sources(core, caption)).toEqual(['Look up this week — you might spot the International Space Station !']);
        const snapshot = createTranslationSourceSnapshot(caption, core.shouldStayOriginal);
        expect(snapshot.slots.map(slot => slot.source)).toEqual([
            'Look up this week — you might spot the', 'International Space Station', '!',
        ]);
        expect(node(document, 'caption-iss-link').getAttribute('href')).toBe('https://www.facebook.com/ISS');
    });

    it.each(fixture.negativeIds)('%s 的姓名提及、可读链接和近似结构不会成为身份保护', (id) => {
        const document = documentFor();
        const core = createCore();
        const readable = node(document, id);
        expect(core.shouldStayOriginal(readable), id).toBe(false);
        expect(core.shouldIgnoreMutation(readable), id).toBe(false);
        // 部分混合 inline/block 负例本来没有独立 generic owner；完整原文仍不可被保护裁去。
        expect(extractTranslationTextFromNodes([readable], core.shouldStayOriginal), id)
            .toBe(extractTranslationTextFromNodes([readable]));
    });

    it('普通 caption/profile 链接和 interactive card 中的阅读段仍进入正文源', () => {
        const document = documentFor();
        const core = createCore();
        expect(sources(core, node(document, 'body-anchor'))).toEqual([
            'Read about International Space Station and NASA research in this ordinary prose.',
        ]);
        expect(sources(core, node(document, 'body-name'))).toEqual([
            'NASA and Mary Pat Berry explain why readers can observe the station.',
        ]);
        const paragraph = node(document, 'reading-control-body');
        const candidate = core.resolve(paragraph.firstChild);
        expect(candidate).not.toBeNull();
        // 通用引擎可把互动卡片定位为 control owner；本规则只保证完整阅读源不被作者裁剪。
        expect(source(core, candidate!)).toBe(paragraph.textContent);
    });

    it.each([
        'https://www.facebook.com.evil.test/NASA/posts/example/1/',
        'https://example.test/NASA/posts/example/1/',
        'https://www.facebook.com/NASA/',
        'https://www.facebook.com/login/',
        'https://www.facebook.com/NASA/post/example/',
        'https://m.facebook.com/NASA/posts/example/1/',
    ])('其它 host/path 不授予作者保护：%s', (url) => {
        const document = documentFor();
        const core = createCore(url);
        for (const id of fixture.authorIds) {
            expect(core.shouldStayOriginal(node(document, id)), id).toBe(false);
            expect(core.shouldIgnoreMutation(node(document, id)), id).toBe(false);
        }
    });

    it('动态新评论沿原生结构保护作者，已有姓名变动不会污染或冻结正文', () => {
        const document = documentFor();
        const core = createCore();
        const author = node(document, 'comment-author-0');
        author.textContent = 'A Changed Public Display Name';
        author.className = 'randomized-class-changed';
        expect(core.shouldStayOriginal(author)).toBe(true);
        expect(core.shouldIgnoreMutation(author.firstElementChild ?? author)).toBe(true);
        node(document, 'native-post').insertAdjacentHTML('beforeend', fixture.dynamicHtml);
        expect(core.shouldStayOriginal(node(document, 'dynamic-author'))).toBe(true);
        expect(core.shouldIgnoreMutation(node(document, 'dynamic-author'))).toBe(true);
        const paragraph = node(document, 'dynamic-paragraph');
        expect(core.shouldIgnoreMutation(paragraph)).toBe(false);
        expect(core.discover(paragraph).map(candidate => source(core, candidate)))
            .toEqual([paragraph.textContent]);
        expect(sources(core, document)).not.toContain(author.textContent);
        expect(sources(core, document)).not.toContain(node(document, 'dynamic-author').textContent);
    });

    it('移入正文、失去作者标记或评论 article 关系时立即撤销对应保护', () => {
        const document = documentFor();
        const core = createCore();
        const main = node(document, 'main-author');
        expect(core.shouldStayOriginal(main)).toBe(true);
        main.removeAttribute('data-ad-rendering-role');
        expect(core.shouldStayOriginal(main)).toBe(false);
        expect(core.shouldIgnoreMutation(main)).toBe(false);
        const author = node(document, 'comment-author-0');
        expect(core.shouldStayOriginal(author)).toBe(true);
        node(document, 'comment-body-0').appendChild(author);
        expect(core.shouldStayOriginal(author)).toBe(false);
        expect(core.shouldIgnoreMutation(author)).toBe(false);
        node(document, 'comment-1').removeAttribute('aria-label');
        expect(core.shouldStayOriginal(node(document, 'comment-author-1'))).toBe(false);
        expect(core.shouldIgnoreMutation(node(document, 'comment-author-1'))).toBe(false);
    });

    it('正文双语两轮翻译和恢复保留原 Text/链接身份、作者及其它原生 metadata', () => {
        const document = documentFor();
        const core = createCore();
        const root = node(document, 'native-post');
        const before = root.outerHTML;
        const author = node(document, 'main-author');
        const link = node(document, 'caption-iss-link');
        const originalText = node(document, 'caption-0').firstChild;
        const metadata = fixture.metadataIds.map(id => [id, node(document, id).outerHTML] as const);
        for (let round = 0; round < 2; round += 1) {
            const translated: HTMLElement[] = [];
            try {
                for (const id of fixture.bodyIds) {
                    const body = node(document, id);
                    const snapshot = createTranslationSourceSnapshot(body, core.shouldStayOriginal,
                        undefined, undefined, core.shouldOmitFromTranslation);
                    const attempt = beginTranslation(body, 'bilingual', 'content', false,
                        body.textContent ?? '', snapshot.slots.map(slot => slot.node))!;
                    expect(markTranslationComplete(body, attempt.state, attempt.generation, false), id).toBe(true);
                    const wrapper = document.createElement('span');
                    wrapper.className = 'fluent-read-bilingual-content';
                    wrapper.setAttribute('data-fr-translation-owned', 'true');
                    wrapper.innerHTML = applyTranslationsToSnapshot(snapshot,
                        snapshot.slots.map((_slot, index) => `正文译文 ${round}-${index}`));
                    body.appendChild(wrapper);
                    setBilingualContent(body, wrapper);
                    translated.push(body);
                }
                expect(root.querySelectorAll('.fluent-read-bilingual-content')).toHaveLength(15);
                expect(node(document, 'main-author')).toBe(author);
                expect(node(document, 'caption-iss-link')).toBe(link);
                for (const [id, html] of metadata) expect(node(document, id).outerHTML, id).toBe(html);
                expect(sources(core, document).every(value => !value.includes('正文译文'))).toBe(true);
            } finally {
                for (const body of translated) expect(restoreTranslation(body)).toBe(true);
            }
            expect(root.outerHTML).toBe(before);
            expect(node(document, 'caption-0').firstChild).toBe(originalText);
            expect(node(document, 'caption-iss-link')).toBe(link);
        }
    });

    it('不借 literalLabel 命令语法误判 post heading 或 reply 控件，保留待核实边界', () => {
        const document = documentFor();
        const core = createCore();
        const heading = node(document, 'post-ui-heading');
        const dialog = heading.closest('[role="dialog"]')!;
        expect(dialog.getAttribute('aria-labelledby')).toBe(heading.querySelector('span[id]')!.id);
        expect(heading.closest('[role="article"]')).toBeNull();
        expect(isLiteralLabel(heading, ['h2[dir="auto"]'])).toBe(false);
        expect(core.shouldStayOriginal(heading)).toBe(false);
        const replies = [...document.querySelectorAll('#native-post [role="button"]')]
            .filter(element => element.textContent?.includes('NASA - National Aeronautics and Space Administration回复了'));
        expect(replies).toHaveLength(2);
        for (const reply of replies) {
            expect(reply.hasAttribute('aria-label')).toBe(false);
            expect(isLiteralLabel(reply, ['[role="button"]'])).toBe(false);
            expect(core.shouldStayOriginal(reply)).toBe(false);
        }
    });

    it('用户停用或同 ID 替换会撤销内置作者保护', () => {
        const document = documentFor();
        const settingsCases: SiteAdaptationSettings[] = [
            {enabled: true, disabledRuleIds: [ruleId], custom: {version: 1, rules: []}},
            {enabled: true, disabledRuleIds: [], custom: {version: 1, rules: [{
                id: ruleId, name: 'Explicit user replacement', match: {hosts: ['www.facebook.com']}, mode: 'augment' as const,
            }]}},
        ];
        for (const settings of settingsCases) {
            const core = new TranslationCandidateCore({url: new URL(fixture.url),
                adapters: composeSiteAdapters(builtinSiteRulePack, settings)});
            for (const id of fixture.authorIds) expect(core.shouldStayOriginal(node(document, id)), id).toBe(false);
        }
    });
});
