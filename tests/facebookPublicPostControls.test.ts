/**
 * @file tests/facebookPublicPostControls.test.ts
 * 文件职责：以实站失败保存的原生结构回归 Facebook 分享计数、全部回复入口与评论排序菜单。
 * 主要内容：验证三个完整 UI 源不进入候选/槽，保留十五段阅读 owner；计数、菜单语义、
 * comment-pane 关系及纯 span 组件必须同时成立，不能用全 rolebutton 或固定数字屏蔽正文。
 * 模块边界：只验证当前核心与忠实 DOM，不联网、不操作菜单或账号，不改实站完整性断言。
 */
import {parseHTML} from 'linkedom';
import {describe, expect, it, vi} from 'vitest';
import fixture from './fixtures/translation-pages/facebook-public-post-metadata.json';
import {builtinSiteRulePack} from '@/src/core/site-adaptation/catalog';
import {composeSiteAdapters} from '@/src/core/site-adaptation/compiler';
import {isFacebookPublicPostControl, withFacebookPublicPostControlsProtection} from '@/src/core/site-adaptation/facebookPublicPostControls';
import {TranslationCandidateCore} from '@/src/core/translation/engine';
import {createTranslationSourceSnapshot} from '@/src/core/translation/serialization';
import {extractTranslationTextFromNodes} from '@/src/core/translation/text';
import type {TranslationSiteAdapter} from '@/src/core/translation/types';

const url = new URL(fixture.url), context = {url};
const settings = {enabled: true, disabledRuleIds: [], custom: {version: 1 as const, rules: []}};
function nativeFixture() {
    const document = parseHTML(`<html><body>${fixture.html}</body></html>`).document as unknown as Document;
    document.getElementById('negative-corpus')!.remove();
    const share = document.getElementById(fixture.controlIds.share)!;
    const sort = document.getElementById(fixture.controlIds.sort)!;
    const expand = document.getElementById(fixture.controlIds.expandReplies)!;
    const span = sort.firstElementChild!, decoration = span.firstElementChild!;
    const [helper, caret] = [...decoration.children] as [Element, Element];
    const svg = caret.firstElementChild!;
    const parent = sort.parentElement!, header = parent.parentElement!, pane = header.parentElement!;
    const collection = pane.children[1]!;
    return {document, share, sort, expand, span, decoration, helper, caret, svg, parent, header, pane, collection};
}

describe('Facebook 三个已实证翻译的原生 UI 控件', () => {
    it('保护完整分享计数、评论排序和全部回复组件的四个边界', () => {
        const {share, sort, expand} = nativeFixture();
        const adapter = composeSiteAdapters(builtinSiteRulePack, settings).find(item => item.id === 'facebook-public-post')!;
        for (const button of [share, sort, expand]) {
            expect(adapter.decide(button, context).kind).toBe('prune-subtree');
            expect(adapter.shouldStayOriginal!(button, context)).toBe(true);
            expect(adapter.shouldOmitFromTranslation!(button, context)).toBe(true);
            expect(adapter.shouldIgnoreMutation!(button, context)).toBe(true);
        }
    });

    it('三个实际完整槽源被排除，十五个正文 owner 与原链接/文字完整保留', () => {
        const {document, share, sort, expand} = nativeFixture();
        const core = new TranslationCandidateCore({url, adapters: composeSiteAdapters(builtinSiteRulePack, settings)});
        for (const button of [share, sort, expand]) {
            expect(core.discover(button)).toEqual([]);
            expect(createTranslationSourceSnapshot(button as HTMLElement, core.shouldStayOriginal,
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
        expect(document.getElementById('caption-iss-link')!.textContent).toBe('International Space Station');
    });

    it('计数不依赖具体值，动态正文/菜单关系变动后立即撤销保护', () => {
        const {document, share, sort, expand, collection} = nativeFixture();
        share.querySelector('span > span')!.textContent = '12045次分享';
        expand.querySelector('span[dir="auto"]')!.textContent = '全部234条回复';
        share.className = 'new-random-class';
        expect(isFacebookPublicPostControl(share)).toBe(true);
        expect(isFacebookPublicPostControl(expand.firstElementChild!)).toBe(true);
        expect(isFacebookPublicPostControl(sort)).toBe(true);
        const replacement = collection.cloneNode(true); collection.replaceWith(replacement);
        expect(isFacebookPublicPostControl(sort)).toBe(true);
        replacement.parentNode!.removeChild(replacement); expect(isFacebookPublicPostControl(sort)).toBe(false);
        share.querySelector('span > span')!.textContent = '12045 shares';
        expect(isFacebookPublicPostControl(share)).toBe(false);
        expect(document.getElementById('native-post')).not.toBeNull();
    });

    it.each(['not-button', 'owned', 'inside-caption', 'inside-language-body', 'inside-comment-article',
        'descendant-caption', 'descendant-language-body', 'root-extra-text', 'missing-span', 'non-span-root', 'root-span-semantics',
        'ordinary-prose', 'missing-dialog', 'missing-heading', 'bad-idref', 'counter-menu', 'counter-expanded',
        'counter-reading-link', 'counter-hidden-span', 'missing-inner', 'extra-inner', 'share-wrong-dir',
        'expand-wrong-dir', 'expand-wrong-card'])(
        '计数组件拒绝 %s 的正文或近似结构', problem => {
            const {document, share, expand} = nativeFixture();
            let target = share;
            if (problem === 'not-button') target = document.getElementById('caption-0')!;
            if (problem === 'owned') share.setAttribute('data-fr-translation-owned', 'true');
            if (problem === 'inside-caption') document.getElementById('caption')!.appendChild(share);
            if (problem === 'inside-language-body') document.getElementById('comment-body-0')!.appendChild(share);
            if (problem === 'inside-comment-article') document.getElementById('comment-0')!.appendChild(share);
            if (problem === 'descendant-caption') share.firstElementChild!.setAttribute('data-ad-preview', 'message');
            if (problem === 'descendant-language-body') share.firstElementChild!.setAttribute('lang', 'en');
            if (problem === 'root-extra-text') share.prepend('Extra readable introduction.');
            if (problem === 'missing-span') share.replaceChildren();
            if (problem === 'non-span-root') {const p = document.createElement('p'); p.textContent = share.textContent; share.replaceChildren(p);}
            if (problem === 'root-span-semantics') share.firstElementChild!.setAttribute('role', 'button');
            if (problem === 'ordinary-prose') share.querySelector('span > span')!.textContent = 'NASA readers discuss 658 shares in this ordinary story.';
            if (problem === 'missing-dialog') document.body.appendChild(share);
            if (problem === 'missing-heading') document.getElementById('post-ui-heading')!.remove();
            if (problem === 'bad-idref') share.closest('[role="dialog"]')!.setAttribute('aria-labelledby', 'missing');
            if (problem === 'counter-menu') share.setAttribute('aria-haspopup', 'menu');
            if (problem === 'counter-expanded') share.setAttribute('aria-expanded', 'false');
            if (problem === 'counter-reading-link') share.querySelector('span > span')!.innerHTML = '<a href="/reading">658次分享</a>';
            if (problem === 'counter-hidden-span') share.querySelector('span > span')!.setAttribute('aria-hidden', 'true');
            if (problem === 'missing-inner') share.firstElementChild!.replaceChildren('658次分享');
            if (problem === 'extra-inner') share.firstElementChild!.appendChild(document.createElement('span'));
            if (problem === 'share-wrong-dir') share.firstElementChild!.setAttribute('dir', 'ltr');
            if (problem === 'expand-wrong-dir') {target = expand; expand.querySelector('span[dir="auto"]')!.setAttribute('dir', 'ltr');}
            if (problem === 'expand-wrong-card') {target = expand; document.getElementById('native-post')!.appendChild(expand);}
            expect(isFacebookPublicPostControl(target), problem).toBe(false);
        });

    it.each(['href', 'contenteditable', 'aria-label', 'aria-labelledby'])(
        '根控件增加 %s 语义时不套用无标签计数例外', attribute => {
            const {share} = nativeFixture(); share.setAttribute(attribute, 'other-native-semantics');
            expect(isFacebookPublicPostControl(share)).toBe(false);
        });

    it.each(['12 shares', '十二次分享', '12次分享 More reading', '-12次分享', '1,234次分享',
        '全部三条回复', '全部3条回复 More reading', 'All3replies', '658条评论', 'NASA 的分享'])(
        '不把其它 locale、评论计数或自然语言 %s 归入这三个例外', value => {
            const {share} = nativeFixture(); share.querySelector('span > span')!.textContent = value;
            expect(isFacebookPublicPostControl(share)).toBe(false);
        });

    it.each(['no-menu', 'open-menu', 'wrong-direction', 'extra-label-prose', 'no-decoration', 'decoration-semantics',
        'wrong-decoration-count', 'helper-element', 'helper-semantics', 'helper-child', 'caret-element', 'caret-semantics',
        'missing-svg', 'visible-svg', 'extra-svg-child', 'wrong-svg-shape', 'header-semantics', 'header-extra-text',
        'extra-parent-child', 'extra-header-child', 'wrong-pane-order', 'extra-pane-child', 'collection-semantics',
        'missing-comments', 'missing-comment-body', 'second-comment-body'])(
        '排序组件拒绝 %s 的错误菜单、装饰或 comment-pane 关系', problem => {
            const {document, sort, span, decoration, helper, caret, svg, parent, header, pane, collection} = nativeFixture();
            if (problem === 'no-menu') sort.setAttribute('aria-haspopup', 'dialog');
            if (problem === 'open-menu') sort.setAttribute('aria-expanded', 'true');
            if (problem === 'wrong-direction') span.setAttribute('dir', 'ltr');
            if (problem === 'extra-label-prose') decoration.append('Extra readable prose cannot be hidden.');
            if (problem === 'no-decoration') decoration.remove();
            if (problem === 'decoration-semantics') decoration.setAttribute('role', 'group');
            if (problem === 'wrong-decoration-count') decoration.appendChild(document.createElement('span'));
            if (problem === 'helper-element') {const div = document.createElement('div'); helper.replaceWith(div);}
            if (problem === 'helper-semantics') helper.setAttribute('role', 'note');
            if (problem === 'helper-child') helper.appendChild(document.createElement('span'));
            if (problem === 'caret-element') {const section = document.createElement('section'); section.appendChild(svg); caret.replaceWith(section);}
            if (problem === 'caret-semantics') caret.setAttribute('tabindex', '0');
            if (problem === 'missing-svg') svg.remove();
            if (problem === 'visible-svg') svg.setAttribute('aria-hidden', 'false');
            if (problem === 'extra-svg-child') svg.appendChild(document.createElement('path'));
            if (problem === 'wrong-svg-shape') {svg.replaceChildren(document.createElement('circle'));}
            if (problem === 'header-semantics') header.setAttribute('role', 'region');
            if (problem === 'header-extra-text') header.prepend('Extra story introduction.');
            if (problem === 'extra-parent-child') parent.appendChild(document.createElement('div'));
            if (problem === 'extra-header-child') header.appendChild(document.createElement('div'));
            if (problem === 'wrong-pane-order') pane.prepend(collection);
            if (problem === 'extra-pane-child') pane.appendChild(document.createElement('div'));
            if (problem === 'collection-semantics') collection.setAttribute('role', 'region');
            if (problem === 'missing-comments') collection.replaceChildren();
            if (problem === 'missing-comment-body') collection.querySelector('span[lang]')!.removeAttribute('lang');
            if (problem === 'second-comment-body') collection.querySelector('[role="article"]')!.appendChild(collection.querySelector('span[lang]')!.cloneNode(true));
            expect(isFacebookPublicPostControl(sort), problem).toBe(false);
        });

    it('缺少 HTML 外壳的短父链不会抛异常，普通按钮也不能冒充排序 pane', () => {
        const {document, sort} = nativeFixture();
        const dialog = sort.closest('[role="dialog"]')!;
        document.getElementById('native-post')!.appendChild(sort);
        const short = parseHTML(dialog.outerHTML).document as unknown as Document;
        expect(isFacebookPublicPostControl(short.getElementById(sort.id)!)).toBe(false);
    });

    it('自有副本不改变原生判断，也不能提供缺少的 span、caret 或评论结构', () => {
        const {document, share, sort, span, caret, svg, collection} = nativeFixture();
        const own = document.createElement('span'); own.setAttribute('data-fr-translation-owned', 'true');
        own.innerHTML = '<a href="/copy">译文副本</a><span dir="auto" lang="en">owned body</span>';
        share.appendChild(own); span.appendChild(own.cloneNode(true));
        span.appendChild(document.createComment('native empty comment'));
        const before = document.documentElement.outerHTML;
        expect(isFacebookPublicPostControl(share)).toBe(true);
        expect(isFacebookPublicPostControl(sort)).toBe(true);
        expect(isFacebookPublicPostControl(own)).toBe(false);
        expect(document.documentElement.outerHTML).toBe(before);
        svg.setAttribute('data-fr-translation-owned', 'true');
        expect(isFacebookPublicPostControl(sort)).toBe(false);
        svg.removeAttribute('data-fr-translation-owned');
        const copy = caret.cloneNode(true) as Element; copy.setAttribute('data-fr-translation-owned', 'true'); caret.after(copy);
        caret.remove(); expect(isFacebookPublicPostControl(sort)).toBe(false);
        copy.removeAttribute('data-fr-translation-owned');
        collection.setAttribute('data-fr-translation-owned', 'true');
        expect(isFacebookPublicPostControl(sort)).toBe(false);
    });

    it.each([
        'https://example.test/NASA/posts/example/1/', 'https://www.facebook.com.evil.test/NASA/posts/example/1/',
        'https://m.facebook.com/NASA/posts/example/1/', 'https://www.facebook.com/NASA/', 'https://www.facebook.com/login/',
    ])('精确 host/path 之外不授予新控件能力：%s', raw => {
        const {share} = nativeFixture();
        const base: TranslationSiteAdapter = {id: 'broad-base', matches: () => true, decide: () => ({kind: 'pass'})};
        const adapter = withFacebookPublicPostControlsProtection(base), outside = {url: new URL(raw)};
        expect(adapter.decide(share, outside)).toEqual({kind: 'pass'});
        expect(adapter.shouldStayOriginal!(share, outside)).toBe(false);
        expect(adapter.shouldOmitFromTranslation!(share, outside)).toBe(false);
        expect(adapter.shouldIgnoreMutation!(share, outside)).toBe(false);
    });

    it('共享包装器保留原决定、callback、getter 及完整属性观察依赖', () => {
        const {share} = nativeFixture();
        const decide = vi.fn(() => ({kind: 'skip-self' as const, reason: 'base'}));
        const base: TranslationSiteAdapter = {id: 'native-base', matches: () => false, decide};
        const adapter = withFacebookPublicPostControlsProtection(base);
        expect(adapter.decide(share, context)).toEqual({kind: 'skip-self', reason: 'base'});
        for (const key of ['shouldStayOriginal', 'shouldOmitFromTranslation', 'shouldIgnoreMutation'] as const) {
            expect(adapter[key]!(share, context)).toBe(false); base[key] = () => true;
            expect(adapter[key]!(share, context)).toBe(true); base[key] = () => false;
            expect(adapter[key]!(share, context)).toBe(false);
        }
        expect(adapter.observedAttributes).toEqual(expect.arrayContaining([
            'id', 'role', 'dir', 'lang', 'aria-hidden', 'aria-haspopup', 'aria-expanded',
            'aria-labelledby', 'aria-modal', 'aria-posinset', 'data-ad-preview', 'data-ad-comet-preview', 'data-fr-translation-owned',
        ]));
        base.observedAttributes = ['base']; expect(adapter.observedAttributes).toContain('base');
        base.observedAttributes = null; expect(adapter.observedAttributes).toBeNull();
        expect(decide).toHaveBeenCalledOnce();
    });

    it('用户替换与停用撤销四边界，不把内置语义能力附加给 custom JSON', () => {
        const {share, sort, expand} = nativeFixture();
        expect(composeSiteAdapters(builtinSiteRulePack, {...settings, disabledRuleIds: ['facebook-public-post']})
            .some(item => item.id === 'facebook-public-post')).toBe(false);
        const adapter = composeSiteAdapters(builtinSiteRulePack, {...settings, custom: {version: 1, rules: [{
            id: 'facebook-public-post', name: 'User replacement', match: {hosts: ['www.facebook.com']}, mode: 'augment',
        }]}}).find(item => item.id === 'facebook-public-post')!;
        for (const button of [share, sort, expand]) {
            expect(adapter.decide(button, context)).toEqual({kind: 'pass'});
            expect(adapter.shouldStayOriginal!(button, context)).toBe(false);
            expect(adapter.shouldOmitFromTranslation!(button, context)).toBe(false);
            expect(adapter.shouldIgnoreMutation!(button, context)).toBe(false);
        }
    });
});
