/**
 * @file tests/facebookPublicPostDialogLabel.test.ts
 * 文件职责：验证 Facebook 公开帖子 dialog 的原生 IDREF 标签保护，避免翻译 UI 中复制的作者名。
 * 主要内容：复用已保存原生文章及其 heading/span 关系，逐项反证正文 heading、重复标识、
 * 多 message/article、交互阅读结构和扩展副本冒充；自定义规则与停用须撤销内置能力。
 * 模块边界：纯 DOM 与 adapter 回归，不联网或操作账号，不把 fixture 渲染当作线上通过。
 */
import {parseHTML} from 'linkedom';
import {describe, expect, it, vi} from 'vitest';
import fixture from './fixtures/translation-pages/facebook-public-post-metadata.json';
import {builtinSiteRulePack} from '@/src/core/site-adaptation/catalog';
import {composeSiteAdapters} from '@/src/core/site-adaptation/compiler';
import {TranslationCandidateCore} from '@/src/core/translation/engine';
import {createTranslationSourceSnapshot} from '@/src/core/translation/serialization';
import {
    isFacebookPublicPostDialogLabel, withFacebookPublicPostDialogLabelProtection,
} from '@/src/core/site-adaptation/facebookPublicPostDialogLabel';
import type {TranslationSiteAdapter} from '@/src/core/translation/types';

const url = new URL(fixture.url);
const context = {url};
const settings = {enabled: true, disabledRuleIds: [], custom: {version: 1 as const, rules: []}};
const adapterFor = () => composeSiteAdapters(builtinSiteRulePack, settings)
    .find(adapter => adapter.id === 'facebook-public-post')!;

function nativeFixture() {
    // 负例语料包含第二个模拟 message，移除它后只核对真实原站 post dialog。
    const document = parseHTML(`<html><body>${fixture.html}</body></html>`).document as unknown as Document;
    document.getElementById('negative-corpus')!.remove();
    const heading = document.getElementById('post-ui-heading')!;
    const label = heading.querySelector('span[id]')!;
    const dialog = heading.closest('[role="dialog"]')!;
    const article = document.getElementById('native-post')!;
    const message = document.getElementById('caption')!;
    return {document, heading, label, dialog, article, message};
}

describe('Facebook 原生 post dialog label 的内置能力', () => {
    it('通过唯一原生 IDREF 保护整个 UI heading/span，但保留全部正文 owner', () => {
        const {document, heading, label} = nativeFixture();
        const adapter = adapterFor();
        for (const element of [heading, label]) {
            expect(adapter.decide(element, context).kind).toBe('prune-subtree');
            expect(adapter.shouldStayOriginal!(element, context)).toBe(true);
            expect(adapter.shouldOmitFromTranslation!(element, context)).toBe(true);
            expect(adapter.shouldIgnoreMutation!(element, context)).toBe(true);
        }
        const core = new TranslationCandidateCore({url, adapters: composeSiteAdapters(builtinSiteRulePack, settings)});
        expect(core.discover(heading)).toEqual([]);
        expect(createTranslationSourceSnapshot(heading as HTMLElement, core.shouldStayOriginal,
            undefined, undefined, core.shouldOmitFromTranslation).slots).toEqual([]);
        const candidates = core.discover(document);
        for (const id of fixture.bodyIds) {
            expect(candidates.filter(candidate => candidate.element.id === id), id).toHaveLength(1);
        }
    });

    it('允许任意作者名字、普通多层 span、注释与完整 ID token，不按姓名或样式判断', () => {
        const {document, heading, label, dialog} = nativeFixture();
        label.id = 'native:label[7]';
        dialog.setAttribute('aria-labelledby', '  native:label[7]\t');
        label.innerHTML = '<span><span>A Completely Changed Public Author 的帖子</span></span><!-- native comment -->';
        document.getElementById('main-author')!.textContent = 'A Completely Changed Public Author';
        heading.className = 'changed-native-class';
        const before = document.documentElement.outerHTML;
        expect(isFacebookPublicPostDialogLabel(label.firstElementChild!)).toBe(true);
        expect(document.documentElement.outerHTML).toBe(before);
        label.removeAttribute('id'); heading.id = 'label-on-heading';
        dialog.setAttribute('aria-labelledby', 'label-on-heading');
        expect(isFacebookPublicPostDialogLabel(heading)).toBe(true);
    });

    it('复合 IDREF 只保护其中唯一 heading 标签，不保护另外的说明来源', () => {
        const {document, heading, dialog} = nativeFixture();
        const note = document.createElement('p'); note.id = 'dialog-note'; note.textContent = 'Additional native dialog context';
        dialog.appendChild(note);
        dialog.setAttribute('aria-labelledby', `${dialog.getAttribute('aria-labelledby')} dialog-note`);
        expect(isFacebookPublicPostDialogLabel(heading)).toBe(true);
        expect(isFacebookPublicPostDialogLabel(note)).toBe(false);
    });

    it.each(['missing-idref', 'empty-idref', 'near-id', 'missing-id', 'duplicate-id', 'duplicate-token',
        'two-heading-targets', 'non-heading-idref', 'outside-span-idref', 'external-idref',
        'missing-article', 'two-articles', 'missing-message', 'two-messages', 'message-outside-main',
        'body-heading', 'two-ui-headings', 'no-dialog', 'second-dialog', 'detached-dialog', 'detached-other-dialog',
        'heading-is-dialog', 'heading-is-dialog-with-peer', 'empty-label'])(
        '拒绝关系不成立的 %s，而不是放宽 ID、数量或正文边界', problem => {
            const {document, heading, label, dialog, article, message} = nativeFixture();
            if (problem === 'missing-idref') dialog.removeAttribute('aria-labelledby');
            if (problem === 'empty-idref') dialog.setAttribute('aria-labelledby', ' \t ');
            if (problem === 'near-id') dialog.setAttribute('aria-labelledby', `${label.id}-near`);
            if (problem === 'missing-id') label.removeAttribute('id');
            if (problem === 'duplicate-id') dialog.appendChild(label.cloneNode(true));
            if (problem === 'duplicate-token') dialog.setAttribute('aria-labelledby', `${label.id} ${label.id}`);
            if (problem === 'two-heading-targets') {heading.id = 'heading-id'; dialog.setAttribute('aria-labelledby', `${label.id} heading-id`);}
            if (problem === 'non-heading-idref') dialog.setAttribute('aria-labelledby', 'native-post');
            if (problem === 'outside-span-idref') {const span = document.createElement('span'); span.id = 'outside-span'; dialog.appendChild(span); dialog.setAttribute('aria-labelledby', span.id);}
            if (problem === 'external-idref') {const span = document.createElement('span'); span.id = 'external'; document.body.appendChild(span); dialog.setAttribute('aria-labelledby', `${label.id} external`);}
            if (problem === 'missing-article') article.removeAttribute('aria-posinset');
            if (problem === 'two-articles') {const other = document.createElement('div'); other.setAttribute('role', 'article'); other.setAttribute('aria-posinset', '1'); dialog.appendChild(other);}
            if (problem === 'missing-message') message.removeAttribute('data-ad-comet-preview');
            if (problem === 'two-messages') article.appendChild(message.cloneNode(true));
            if (problem === 'message-outside-main') dialog.appendChild(message);
            if (problem === 'body-heading') article.appendChild(heading);
            if (problem === 'two-ui-headings') dialog.appendChild(heading.cloneNode(true));
            if (problem === 'no-dialog') document.body.appendChild(heading);
            if (problem === 'second-dialog' || problem === 'detached-other-dialog') {const other = document.createElement('div'); other.setAttribute('role', 'dialog'); other.setAttribute('aria-modal', 'true'); document.body.appendChild(other);}
            if (problem === 'detached-dialog' || problem === 'detached-other-dialog') dialog.remove();
            if (problem === 'heading-is-dialog' || problem === 'heading-is-dialog-with-peer') {
                dialog.replaceWith(heading); heading.setAttribute('role', 'dialog'); heading.setAttribute('aria-modal', 'true');
                heading.setAttribute('aria-labelledby', label.id); heading.appendChild(article);
                if (problem === 'heading-is-dialog-with-peer') {const peer = document.createElement('h2'); peer.setAttribute('dir', 'auto'); heading.appendChild(peer);}
            }
            if (problem === 'empty-label') label.replaceChildren(document.createComment('not native readable text'));
            expect(isFacebookPublicPostDialogLabel(heading), problem).toBe(false);
            const adapter = adapterFor();
            expect(adapter.decide(heading, context).kind, problem).not.toBe('prune-subtree');
            expect(adapter.shouldStayOriginal!(heading, context), problem).toBe(false);
            expect(adapter.shouldOmitFromTranslation!(heading, context), problem).toBe(false);
            expect(adapter.shouldIgnoreMutation!(heading, context), problem).toBe(false);
        });

    it.each(['a', 'p', 'br', 'blockquote', 'code', 'em', 'button'])(
        '拒绝标签中的原生 %s 阅读/互动结构，即使文字未改变', tag => {
            const {document, heading, label} = nativeFixture();
            const semantic = document.createElement(tag); semantic.textContent = label.textContent;
            label.replaceChildren(semantic);
            expect(isFacebookPublicPostDialogLabel(heading)).toBe(false);
        });

    it.each(['role', 'tabindex', 'contenteditable', 'href'])(
        '拒绝 heading/span 上的 %s 互动语义', attribute => {
            const {heading, label} = nativeFixture();
            heading.setAttribute(attribute, 'reading-or-control');
            expect(isFacebookPublicPostDialogLabel(heading)).toBe(false);
            heading.removeAttribute(attribute); label.setAttribute(attribute, 'reading-or-control');
            expect(isFacebookPublicPostDialogLabel(heading)).toBe(false);
        });

    it('own 副本可忽略，但不得补足 ID、message、article 或 label 原生关系', () => {
        const {document, heading, label, dialog, article, message} = nativeFixture();
        const copy = document.createElement('span'); copy.setAttribute('data-fr-translation-owned', 'true');
        copy.innerHTML = `<a href="/owned">译文</a>${label.outerHTML}<div role="dialog" aria-modal="true"></div>${message.outerHTML}<div role="article" aria-posinset="1"></div>`;
        heading.appendChild(copy);
        expect(isFacebookPublicPostDialogLabel(heading)).toBe(true);
        expect(isFacebookPublicPostDialogLabel(copy)).toBe(false);
        expect(isFacebookPublicPostDialogLabel(copy.querySelector('a')!)).toBe(false);
        expect(copy.parentElement).toBe(heading);
        label.removeAttribute('id'); expect(isFacebookPublicPostDialogLabel(heading)).toBe(false);
        label.id = dialog.getAttribute('aria-labelledby')!;
        message.removeAttribute('data-ad-preview'); expect(isFacebookPublicPostDialogLabel(heading)).toBe(false);
        message.setAttribute('data-ad-preview', 'message');
        article.removeAttribute('aria-posinset'); expect(isFacebookPublicPostDialogLabel(heading)).toBe(false);
        article.setAttribute('aria-posinset', '1');
        label.textContent = ''; expect(isFacebookPublicPostDialogLabel(heading)).toBe(false);
    });

    it('重挂或属性变动后读取当前关系，不缓存旧的标题保护', () => {
        const {document, heading, label, dialog, article} = nativeFixture();
        expect(isFacebookPublicPostDialogLabel(label)).toBe(true);
        dialog.setAttribute('aria-labelledby', 'unrelated');
        expect(isFacebookPublicPostDialogLabel(label)).toBe(false);
        dialog.setAttribute('aria-labelledby', label.id);
        expect(isFacebookPublicPostDialogLabel(label)).toBe(true);
        article.appendChild(heading);
        expect(isFacebookPublicPostDialogLabel(label)).toBe(false);
        dialog.prepend(heading);
        expect(isFacebookPublicPostDialogLabel(label)).toBe(true);
        const replacement = heading.cloneNode(true) as Element;
        heading.replaceWith(replacement);
        expect(isFacebookPublicPostDialogLabel(heading)).toBe(false);
        expect(isFacebookPublicPostDialogLabel(replacement)).toBe(true);
        expect(document.getElementById('post-ui-heading')).toBe(replacement);
    });

    it.each([
        'https://example.test/NASA/posts/example/1/', 'https://www.facebook.com.evil.test/NASA/posts/example/1/',
        'https://m.facebook.com/NASA/posts/example/1/', 'https://www.facebook.com/NASA/',
        'https://www.facebook.com/login/', 'https://www.facebook.com/NASA/posts/',
        'https://www.facebook.com/NASA/posts//',
    ])('装饰器再次核对精确 host/path：%s', raw => {
        const {heading} = nativeFixture();
        // 即使传入的底层 adapter 过宽，也不把内置能力泄漏到其它页面。
        const base: TranslationSiteAdapter = {id: 'broad-base', matches: () => true, decide: () => ({kind: 'pass'})};
        const adapter = withFacebookPublicPostDialogLabelProtection(base);
        const outside = {url: new URL(raw)};
        expect(adapter.decide(heading, outside)).toEqual({kind: 'pass'});
        expect(adapter.shouldStayOriginal!(heading, outside)).toBe(false);
        expect(adapter.shouldOmitFromTranslation!(heading, outside)).toBe(false);
        expect(adapter.shouldIgnoreMutation!(heading, outside)).toBe(false);
    });

    it('保留底层决定、可选 callback、属性 getter 与能力描述符', () => {
        const {heading, message} = nativeFixture();
        const decide = vi.fn(() => ({kind: 'skip-self' as const, reason: 'base'}));
        const base: TranslationSiteAdapter = {id: 'native-base', matches: () => false, decide};
        const wrapped = withFacebookPublicPostDialogLabelProtection(base);
        expect(wrapped.decide(heading, context)).toEqual({kind: 'skip-self', reason: 'base'});
        for (const callback of ['shouldStayOriginal', 'shouldOmitFromTranslation', 'shouldIgnoreMutation'] as const) {
            expect(wrapped[callback]!(heading, context)).toBe(false);
            base[callback] = () => true;
            expect(wrapped[callback]!(message, context)).toBe(true);
            base[callback] = () => false;
            expect(wrapped[callback]!(message, context)).toBe(false);
        }
        expect(wrapped.id).toBe(base.id);
        expect(wrapped.observedAttributes).toEqual(expect.arrayContaining([
            'id', 'dir', 'role', 'aria-modal', 'aria-labelledby', 'aria-posinset',
            'data-ad-preview', 'data-ad-comet-preview', 'data-fr-translation-owned', 'tabindex', 'contenteditable', 'href',
        ]));
        base.observedAttributes = ['base-attribute'];
        expect(wrapped.observedAttributes).toContain('base-attribute');
        base.observedAttributes = null;
        expect(wrapped.observedAttributes).toBeNull();
        expect(decide).toHaveBeenCalledOnce();
    });

    it('停用、自定义同 ID 替换以及全局关闭撤销语义保护', () => {
        const {heading} = nativeFixture();
        const disabled = composeSiteAdapters(builtinSiteRulePack, {...settings, disabledRuleIds: ['facebook-public-post']});
        expect(disabled.some(adapter => adapter.id === 'facebook-public-post')).toBe(false);
        expect(composeSiteAdapters(builtinSiteRulePack, {...settings, enabled: false})).toEqual([]);
        const replaced = composeSiteAdapters(builtinSiteRulePack, {...settings, custom: {version: 1, rules: [{
            id: 'facebook-public-post', name: 'User replacement', match: {hosts: ['www.facebook.com']}, mode: 'augment',
        }]}}).find(adapter => adapter.id === 'facebook-public-post')!;
        expect(replaced.decide(heading, context)).toEqual({kind: 'pass'});
        expect(replaced.shouldStayOriginal!(heading, context)).toBe(false);
        expect(replaced.shouldOmitFromTranslation!(heading, context)).toBe(false);
        expect(replaced.shouldIgnoreMutation!(heading, context)).toBe(false);
    });
});
