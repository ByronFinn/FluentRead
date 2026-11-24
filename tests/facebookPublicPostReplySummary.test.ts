/**
 * @file tests/facebookPublicPostReplySummary.test.ts
 * 文件职责：回归 Facebook 已实测中文公开帖的回复摘要组件，避免把作者副本与计数当正文。
 * 主要内容：忠实四槽组件、评论卡片兄弟关系、当前动态主作者与完整字面格式，以及异名、
 * 额外正文、普通互动卡片、其它 locale、own 副本和关系重挂的负例。
 * 模块边界：仅纯 DOM/core/adapter 回归，不点击控件、不调用供应商，不代替实站翻译验收。
 */
import {parseHTML} from 'linkedom';
import {describe, expect, it, vi} from 'vitest';
import fixture from './fixtures/translation-pages/facebook-public-post-metadata.json';
import {builtinSiteRulePack} from '@/src/core/site-adaptation/catalog';
import {composeSiteAdapters} from '@/src/core/site-adaptation/compiler';
import {isFacebookPublicPostReplySummary, withFacebookPublicPostReplySummaryProtection} from '@/src/core/site-adaptation/facebookPublicPostReplySummary';
import {getFacebookPublicPostContext} from '@/src/core/site-adaptation/facebookPublicPostDialogLabel';
import {TranslationCandidateCore} from '@/src/core/translation/engine';
import {createTranslationSourceSnapshot} from '@/src/core/translation/serialization';
import {extractTranslationTextFromNodes} from '@/src/core/translation/text';
import type {TranslationSiteAdapter} from '@/src/core/translation/types';

const url = new URL(fixture.url);
const context = {url};
const settings = {enabled: true, disabledRuleIds: [], custom: {version: 1 as const, rules: []}};
function nativeFixture() {
    const document = parseHTML(`<html><body>${fixture.html}</body></html>`).document as unknown as Document;
    document.getElementById('negative-corpus')!.remove();
    const button = document.getElementById(fixture.replyIds[0]!)!;
    const row = button.firstElementChild!.firstElementChild!.firstElementChild!;
    const [avatar, author, separator, count] = [...row.children] as [Element, Element, Element, Element];
    const leaf = button.parentElement!, branch = leaf.parentElement!, replies = branch.parentElement!, card = replies.parentElement!;
    const comment = card.firstElementChild!;
    const profile = document.getElementById('main-author')!;
    const link = profile.querySelector('h3 a[role="link"]')!;
    const heading = document.getElementById('post-ui-heading')!;
    return {document, button, row, avatar, author, separator, count, leaf, branch, replies, card, comment, profile, link, heading};
}

describe('Facebook 原生中文 reply summary', () => {
    it('四个原生槽与评论卡片关系满足时保护完整控件', () => {
        const {document} = nativeFixture();
        const adapter = composeSiteAdapters(builtinSiteRulePack, settings).find(item => item.id === 'facebook-public-post')!;
        for (const id of fixture.replyIds) {
            const button = document.getElementById(id)!;
            expect(button.closest('[role="article"][aria-label]')).toBeNull();
            expect(button.closest('[role="article"]')?.id).toBe('native-post');
            for (const element of [button, button.querySelector('span[dir="auto"]')!]) {
                expect(adapter.decide(element, context).kind).toBe('prune-subtree');
                expect(adapter.shouldStayOriginal!(element, context)).toBe(true);
                expect(adapter.shouldOmitFromTranslation!(element, context)).toBe(true);
                expect(adapter.shouldIgnoreMutation!(element, context)).toBe(true);
            }
        }
    });

    it('只移除摘要源，所有 caption/comment owner 和可读链接仍完整', () => {
        const {document} = nativeFixture();
        const core = new TranslationCandidateCore({url, adapters: composeSiteAdapters(builtinSiteRulePack, settings)});
        for (const id of fixture.replyIds) {
            const button = document.getElementById(id)! as HTMLElement;
            expect(core.discover(button)).toEqual([]);
            expect(createTranslationSourceSnapshot(button, core.shouldStayOriginal,
                undefined, undefined, core.shouldOmitFromTranslation).slots).toEqual([]);
        }
        const candidates = core.discover(document);
        for (const id of fixture.bodyIds) {
            const body = document.getElementById(id)!;
            const matches = candidates.filter(candidate => candidate.element === body);
            expect(matches, id).toHaveLength(1);
            expect(extractTranslationTextFromNodes(matches[0]!.nodes ?? [matches[0]!.element], core.shouldStayOriginal), id)
                .toBe(extractTranslationTextFromNodes([body]));
        }
    });

    it('动态作者链接与摘要同步变化、计数和随机样式变更仍按当前值复验', () => {
        const {document, button, author, count, link} = nativeFixture();
        expect(isFacebookPublicPostReplySummary(button)).toBe(true);
        link.textContent = 'Another Public Display Name';
        expect(isFacebookPublicPostReplySummary(button)).toBe(false);
        author.textContent = 'Another Public Display Name回复了';
        count.textContent = '120条回复';
        button.className = 'random-new-class';
        button.appendChild(document.createComment('native comment'));
        const before = document.documentElement.outerHTML;
        expect(isFacebookPublicPostReplySummary(author)).toBe(true);
        expect(document.documentElement.outerHTML).toBe(before);
        count.textContent = '120 replies';
        expect(isFacebookPublicPostReplySummary(button)).toBe(false);
        count.textContent = '120条回复';
        expect(isFacebookPublicPostReplySummary(button)).toBe(true);
    });

    it.each(['no-button', 'owned', 'inside-caption', 'inside-language-body', 'no-dialog', 'missing-heading',
        'invalid-idref', 'inside-comment-article', 'parent-structure', 'parent-semantics', 'parent-extra-text',
        'missing-comment', 'extra-card-child', 'wrong-card-order', 'wrong-comment-role', 'wrong-comment-tabindex',
        'missing-comment-body', 'extra-comment-body', 'extra-replies-child', 'extra-branch-child',
        'extra-leaf-child', 'wrong-leaf-order', 'leaf-decoration-semantics', 'leaf-decoration-child',
        'button-extra-text', 'no-outer', 'extra-outer', 'no-inner', 'no-row', 'outer-extra-text', 'inner-extra-text',
        'wrong-direction', 'row-extra-text', 'three-slots', 'five-slots', 'non-div-slot',
        'missing-avatar-container', 'avatar-extra-text', 'avatar-container-extra-text', 'missing-svg', 'visible-svg',
        'wrong-svg-role', 'avatar-readable-text', 'avatar-reading-element', 'missing-mask', 'extra-mask',
        'missing-image', 'extra-image', 'author-link', 'author-interactive', 'hidden-author', 'count-reading',
        'separator-reading', 'no-hidden-separator', 'two-hidden-separators', 'hidden-nonspan',
        'hidden-false', 'wrong-dot', 'extra-separator-prose', 'missing-profile', 'two-profiles',
        'profile-inside-comment', 'profile-inside-caption', 'missing-profile-link', 'two-profile-links',
        'profile-reading-element', 'profile-interactive-element', 'empty-name', 'different-name', 'wrong-author-suffix'])(
        '拒绝 %s 的额外阅读或错误原生关系', problem => {
            const f = nativeFixture();
            const {document, button, row, avatar, author, separator, count, leaf, branch, replies, card, comment, profile, link, heading} = f;
            let target = button;
            if (problem === 'no-button') target = document.getElementById('caption')!;
            if (problem === 'owned') button.setAttribute('data-fr-translation-owned', 'true');
            if (problem === 'inside-caption') document.getElementById('caption')!.appendChild(button);
            if (problem === 'inside-language-body') comment.querySelector('[lang]')!.appendChild(button);
            if (problem === 'no-dialog') document.body.appendChild(button);
            if (problem === 'missing-heading') heading.remove();
            if (problem === 'invalid-idref') heading.closest('[role="dialog"]')!.setAttribute('aria-labelledby', 'missing');
            if (problem === 'inside-comment-article') comment.appendChild(button);
            if (problem === 'parent-structure') {const section = document.createElement('section'); branch.replaceWith(section); section.appendChild(leaf);}
            if (problem === 'parent-semantics') branch.setAttribute('role', 'region');
            if (problem === 'parent-extra-text') branch.prepend('Extra body text cannot be swallowed.');
            if (problem === 'missing-comment') comment.remove();
            if (problem === 'extra-card-child') card.appendChild(document.createElement('div'));
            if (problem === 'wrong-card-order') card.prepend(replies);
            if (problem === 'wrong-comment-role') comment.setAttribute('role', 'region');
            if (problem === 'wrong-comment-tabindex') comment.setAttribute('tabindex', '0');
            if (problem === 'missing-comment-body') comment.querySelector('[lang]')!.removeAttribute('lang');
            if (problem === 'extra-comment-body') comment.appendChild(comment.querySelector('[lang]')!.cloneNode(true));
            if (problem === 'extra-replies-child') replies.appendChild(document.createElement('div'));
            if (problem === 'extra-branch-child') branch.appendChild(document.createElement('div'));
            if (problem === 'extra-leaf-child') leaf.appendChild(document.createElement('div'));
            if (problem === 'wrong-leaf-order') leaf.prepend(button);
            if (problem === 'leaf-decoration-semantics') leaf.firstElementChild!.setAttribute('role', 'region');
            if (problem === 'leaf-decoration-child') leaf.firstElementChild!.appendChild(document.createElement('span'));
            if (problem === 'button-extra-text') button.prepend('Extra reading prose.');
            if (problem === 'no-outer') button.replaceChildren();
            if (problem === 'extra-outer') button.appendChild(document.createElement('span'));
            if (problem === 'no-inner') button.firstElementChild!.replaceChildren();
            if (problem === 'no-row') button.firstElementChild!.firstElementChild!.replaceChildren();
            if (problem === 'outer-extra-text') button.firstElementChild!.prepend('Extra reading prose.');
            if (problem === 'inner-extra-text') button.firstElementChild!.firstElementChild!.prepend('Extra reading prose.');
            if (problem === 'wrong-direction') button.firstElementChild!.firstElementChild!.setAttribute('dir', 'ltr');
            if (problem === 'row-extra-text') row.prepend('Extra reading prose.');
            if (problem === 'three-slots') count.remove();
            if (problem === 'five-slots') row.appendChild(document.createElement('div'));
            if (problem === 'non-div-slot') {const span = document.createElement('span'); span.textContent = count.textContent; count.replaceWith(span);}
            if (problem === 'missing-avatar-container') avatar.replaceChildren();
            if (problem === 'avatar-extra-text') avatar.prepend('A readable portrait caption');
            if (problem === 'avatar-container-extra-text') avatar.firstElementChild!.prepend('A readable portrait caption');
            if (problem === 'missing-svg') avatar.querySelector('svg')!.remove();
            if (problem === 'visible-svg') avatar.querySelector('svg')!.setAttribute('aria-hidden', 'false');
            if (problem === 'wrong-svg-role') avatar.querySelector('svg')!.setAttribute('role', 'img');
            if (problem === 'avatar-readable-text') avatar.querySelector('svg')!.append('Actual readable words');
            if (problem === 'avatar-reading-element') avatar.querySelector('svg')!.appendChild(document.createElement('foreignObject'));
            if (problem === 'missing-mask') avatar.querySelector('mask')!.remove();
            if (problem === 'extra-mask') avatar.querySelector('svg')!.appendChild(avatar.querySelector('mask')!.cloneNode(true));
            if (problem === 'missing-image') avatar.querySelector('image')!.remove();
            if (problem === 'extra-image') avatar.querySelector('svg')!.appendChild(avatar.querySelector('image')!.cloneNode(true));
            if (problem === 'author-link') author.innerHTML = `<a href="/ordinary-reading">${author.textContent}</a>`;
            if (problem === 'author-interactive') author.querySelector('span')!.setAttribute('role', 'button');
            if (problem === 'hidden-author') author.setAttribute('aria-hidden', 'true');
            if (problem === 'count-reading') count.innerHTML = `<em>${count.textContent}</em>`;
            if (problem === 'separator-reading') separator.innerHTML = '<a href="/ordinary-reading">·</a>';
            if (problem === 'no-hidden-separator') separator.querySelector('[aria-hidden]')!.removeAttribute('aria-hidden');
            if (problem === 'two-hidden-separators') separator.appendChild(separator.querySelector('[aria-hidden]')!.cloneNode(true));
            if (problem === 'hidden-nonspan') {const div = document.createElement('div'); div.setAttribute('aria-hidden', 'true'); div.textContent = '·'; separator.querySelector('[aria-hidden]')!.replaceWith(div);}
            if (problem === 'hidden-false') separator.querySelector('[aria-hidden]')!.setAttribute('aria-hidden', 'false');
            if (problem === 'wrong-dot') separator.querySelector('[aria-hidden]')!.textContent = '|';
            if (problem === 'extra-separator-prose') separator.append('Extra readable prose.');
            if (problem === 'missing-profile') profile.removeAttribute('data-ad-rendering-role');
            if (problem === 'two-profiles') profile.after(profile.cloneNode(true));
            if (problem === 'profile-inside-comment') comment.appendChild(profile);
            if (problem === 'profile-inside-caption') document.getElementById('caption')!.appendChild(profile);
            if (problem === 'missing-profile-link') link.removeAttribute('role');
            if (problem === 'two-profile-links') link.after(link.cloneNode(true));
            if (problem === 'profile-reading-element') link.innerHTML = `<em>${link.textContent}</em>`;
            if (problem === 'profile-interactive-element') link.querySelector('span')!.setAttribute('tabindex', '0');
            if (problem === 'empty-name') link.replaceChildren();
            if (problem === 'different-name') author.textContent = 'A Different Public Author回复了';
            if (problem === 'wrong-author-suffix') author.textContent = `${link.textContent} replied`;
            expect(isFacebookPublicPostReplySummary(target), problem).toBe(false);
        });

    it.each(['contenteditable', 'href', 'aria-label', 'aria-labelledby'])(
        '摘要根存在 %s 语义时不套用无标签组件例外', attribute => {
            const {button} = nativeFixture(); button.setAttribute(attribute, 'other-native-semantics');
            expect(isFacebookPublicPostReplySummary(button)).toBe(false);
        });

    it.each(['language-body', 'caption'])('后代出现真实 %s 标记时撤销整块摘要保护', marker => {
        const {button, author} = nativeFixture();
        const span = author.querySelector('span')!;
        if (marker === 'language-body') {span.setAttribute('dir', 'auto'); span.setAttribute('lang', 'en');}
        else span.setAttribute('data-ad-preview', 'message');
        expect(isFacebookPublicPostReplySummary(button)).toBe(false);
    });

    it.each(['9 replies', '九条回复', '-1条回复', '1.5条回复', '1,000条回复', '9条回复 More reading', '回复 9', ''])('不猜其它 locale/近似计数 %s', value => {
        const {button, count} = nativeFixture(); count.textContent = value;
        expect(isFacebookPublicPostReplySummary(button)).toBe(false);
    });

    it('own 副本忽略而不写 DOM，不能用它补原生作者/四槽/avatar/评论正文', () => {
        const {document, button, row, author, count, avatar, comment, profile} = nativeFixture();
        const owned = document.createElement('span'); owned.setAttribute('data-fr-translation-owned', 'true');
        owned.innerHTML = '<a href="/copy">译文链接</a>'; button.appendChild(owned);
        author.appendChild(owned.cloneNode(true)); row.appendChild(owned.cloneNode(true));
        count.appendChild(document.createComment('native non-text note'));
        const before = document.documentElement.outerHTML;
        expect(isFacebookPublicPostReplySummary(button)).toBe(true);
        expect(isFacebookPublicPostReplySummary(owned)).toBe(false);
        expect(document.documentElement.outerHTML).toBe(before);
        const profileCopy = profile.cloneNode(true) as Element; profileCopy.setAttribute('data-fr-translation-owned', 'true'); profile.after(profileCopy);
        profile.removeAttribute('data-ad-rendering-role'); expect(isFacebookPublicPostReplySummary(button)).toBe(false);
        profile.setAttribute('data-ad-rendering-role', 'profile_name');
        const svgCopy = avatar.firstElementChild!.cloneNode(true) as Element; svgCopy.setAttribute('data-fr-translation-owned', 'true'); avatar.appendChild(svgCopy);
        avatar.firstElementChild!.remove(); expect(isFacebookPublicPostReplySummary(button)).toBe(false);
        svgCopy.removeAttribute('data-fr-translation-owned');
        const body = comment.querySelector('[lang]')!; body.setAttribute('data-fr-translation-owned', 'true');
        expect(isFacebookPublicPostReplySummary(button)).toBe(false);
    });

    it('普通有头像的互动卡片、真实正文和异名讨论不会因 rolebutton 或相似 slot 被保护', () => {
        const {document, button, card, author} = nativeFixture();
        const copy = card.cloneNode(true) as Element;
        document.getElementById('native-post')!.appendChild(copy);
        const copyButton = copy.querySelector('[role="button"][tabindex="0"]')!;
        // 首个评论 reaction 也有 rolebutton；任意普通控件都不能从相邻摘要继承例外。
        expect(isFacebookPublicPostReplySummary(copyButton)).toBe(false);
        card.firstElementChild!.removeAttribute('role');
        expect(isFacebookPublicPostReplySummary(button)).toBe(false);
        card.firstElementChild!.setAttribute('role', 'article');
        author.append(' This is ordinary quoted reading prose.');
        expect(isFacebookPublicPostReplySummary(button)).toBe(false);
        expect(isFacebookPublicPostReplySummary(document.getElementById('caption-0')!)).toBe(false);
    });

    it('共享关系函数必须得到真实 heading，而不是保护标记或 own 冒充', () => {
        const {heading, button} = nativeFixture();
        expect(getFacebookPublicPostContext(button)).toBeNull();
        heading.setAttribute('data-fr-translation-owned', 'true');
        expect(getFacebookPublicPostContext(heading)).toBeNull();
        expect(isFacebookPublicPostReplySummary(button)).toBe(false);
    });

    it('缺少 HTML 外壳的短祖先链也安全失败，不抛异常', () => {
        const {document, button, heading} = nativeFixture();
        const dialog = heading.closest('[role="dialog"]')!;
        const main = document.getElementById('native-post')!;
        main.appendChild(button);
        const short = parseHTML(dialog.outerHTML).document as unknown as Document;
        expect(isFacebookPublicPostReplySummary(short.getElementById(button.id)!)).toBe(false);
    });

    it.each([
        'https://example.test/NASA/posts/example/1/', 'https://www.facebook.com.evil.test/NASA/posts/example/1/',
        'https://m.facebook.com/NASA/posts/example/1/', 'https://www.facebook.com/NASA/',
        'https://www.facebook.com/login/', 'https://www.facebook.com/NASA/posts/',
    ])('wrapper 不把能力泄漏到其它 host/path：%s', raw => {
        const {button} = nativeFixture();
        const base: TranslationSiteAdapter = {id: 'broad-base', matches: () => true, decide: () => ({kind: 'pass'})};
        const adapter = withFacebookPublicPostReplySummaryProtection(base), outside = {url: new URL(raw)};
        expect(adapter.decide(button, outside)).toEqual({kind: 'pass'});
        expect(adapter.shouldStayOriginal!(button, outside)).toBe(false);
        expect(adapter.shouldOmitFromTranslation!(button, outside)).toBe(false);
        expect(adapter.shouldIgnoreMutation!(button, outside)).toBe(false);
    });

    it('保留底层 callback、getter 与未命中决定', () => {
        const {button, heading} = nativeFixture();
        const decide = vi.fn(() => ({kind: 'skip-self' as const, reason: 'base'}));
        const base: TranslationSiteAdapter = {id: 'native-base', matches: () => false, decide};
        const wrapped = withFacebookPublicPostReplySummaryProtection(base);
        expect(wrapped.decide(button, context)).toEqual({kind: 'skip-self', reason: 'base'});
        for (const key of ['shouldStayOriginal', 'shouldOmitFromTranslation', 'shouldIgnoreMutation'] as const) {
            expect(wrapped[key]!(button, context)).toBe(false); base[key] = () => true;
            expect(wrapped[key]!(heading, context)).toBe(true); base[key] = () => false;
            expect(wrapped[key]!(heading, context)).toBe(false);
        }
        expect(wrapped.observedAttributes).toEqual(expect.arrayContaining(['aria-hidden', 'role', 'tabindex', 'data-ad-rendering-role']));
        base.observedAttributes = ['base']; expect(wrapped.observedAttributes).toContain('base');
        base.observedAttributes = null; expect(wrapped.observedAttributes).toBeNull();
        expect(decide).toHaveBeenCalledOnce();
    });

    it('内置能力停用与用户同 ID 替换撤销四个边界', () => {
        const {button} = nativeFixture();
        expect(composeSiteAdapters(builtinSiteRulePack, {...settings, disabledRuleIds: ['facebook-public-post']})
            .some(item => item.id === 'facebook-public-post')).toBe(false);
        const adapter = composeSiteAdapters(builtinSiteRulePack, {...settings, custom: {version: 1, rules: [{
            id: 'facebook-public-post', name: 'User replacement', match: {hosts: ['www.facebook.com']}, mode: 'augment',
        }]}}).find(item => item.id === 'facebook-public-post')!;
        expect(adapter.decide(button, context)).toEqual({kind: 'pass'});
        expect(adapter.shouldStayOriginal!(button, context)).toBe(false);
        expect(adapter.shouldOmitFromTranslation!(button, context)).toBe(false);
        expect(adapter.shouldIgnoreMutation!(button, context)).toBe(false);
    });
});
