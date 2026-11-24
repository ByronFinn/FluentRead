import {parseHTML} from 'linkedom';
import {describe, expect, it, vi} from 'vitest';
import {isBbcCreditOnlyCaption, withBbcCreditCaptionProtection} from '@/src/core/site-adaptation/bbcCreditCaption';
import {builtinSiteRulePack} from '@/src/core/site-adaptation/catalog';
import {compileSiteRulePack, composeSiteAdapters, getSiteAdapterAttributeFilter} from '@/src/core/site-adaptation/compiler';
import {TranslationCandidateCore} from '@/src/core/translation/engine';
import {createTranslationSourceSnapshot} from '@/src/core/translation/serialization';
import type {TranslationSiteAdapter} from '@/src/core/translation/types';

const url = new URL('https://www.bbc.com/future/article/20261001-five-exercises-to-help-reduce-neck-pain');
const context = {url};
const settings = {enabled: true, disabledRuleIds: [], custom: {version: 1 as const, rules: []}};
const creditText = 'BBC/ Serenity Strull';
function fixture() {
    const {document} = parseHTML(`<html><body><main><article>
      <h1>How to future-proof your neck</h1><p>Regular movement can help protect the human neck.</p>
      <div data-component="image-block"><figure id="hero">
        <div><div data-testid="hero-image"><img alt="An illustration of the structure of the neck"><span id="credit">${creditText}</span></div></div>
        <div><figcaption id="caption">(Credit: ${creditText})</figcaption></div>
      </figure></div>
      <figure id="descriptive"><div data-testid="image"><img alt="Modern life is hard on the human neck"><span>Getty Images</span></div>
        <figcaption>Modern life is hard on the human neck. But it hasn't always been this way (Credit: Getty Images)</figcaption>
      </figure></article></main></body></html>`);
    const get = (selector: string) => document.querySelector(selector)! as HTMLElement;
    const caption = get('#caption'), credit = get('#credit'), figure = get('#hero');
    return {document, get, caption, credit, figure};
}

describe('BBC native credit-only captions', () => {
    it('recognizes the exact observed hero structure and whitespace while leaving descriptive captions readable', () => {
        const {caption, credit, get} = fixture();
        expect(isBbcCreditOnlyCaption(caption)).toBe(true);
        caption.textContent = ' \n(Credit: BBC/\u00a0 Serenity \n Strull)\t';
        credit.textContent = '\nBBC/  Serenity\tStrull ';
        expect(isBbcCreditOnlyCaption(caption)).toBe(true);
        expect(isBbcCreditOnlyCaption(get('#descriptive figcaption'))).toBe(false);
        expect(isBbcCreditOnlyCaption(get('h1'))).toBe(false);
    });

    it('accepts the observed direct inline-image/figcaption layout without relying on generated CSS classes', () => {
        const {caption, credit, figure} = fixture();
        figure.replaceChildren(credit.parentElement!, caption);
        credit.parentElement!.setAttribute('data-testid', 'image');
        caption.className = 'shared-caption-style'; credit.className = 'arbitrary-new-style';
        expect(isBbcCreditOnlyCaption(caption)).toBe(true);
    });

    it.each([
        '(Credit: Another Photographer)', 'Description (Credit: BBC/ Serenity Strull)',
        '(Credit: BBC/ Serenity Strull) More reading', '(Credit:BBC/ Serenity Strull)',
        '(credit: BBC/ Serenity Strull)', 'Credit: BBC/ Serenity Strull', '(Credit: )',
    ])('does not prune near or mismatched caption %s', text => {
        const {caption} = fixture(); caption.textContent = text;
        expect(isBbcCreditOnlyCaption(caption)).toBe(false);
    });

    it.each(['a', 'em', 'button', 'span', 'code', 'br'])('refuses native %s markup even when textContent is equal', tag => {
        const {caption, document} = fixture();
        const semantic = document.createElement(tag);
        if (tag === 'br') caption.appendChild(semantic);
        else {semantic.textContent = caption.textContent; caption.replaceChildren(semantic);}
        expect(isBbcCreditOnlyCaption(caption)).toBe(false);
        expect(isBbcCreditOnlyCaption(semantic)).toBe(false);
    });

    it.each(['role', 'tabindex', 'contenteditable', 'href', 'aria-label', 'aria-labelledby'])(
        'refuses %s reading/interaction semantics on the caption or native credit', attribute => {
            const {caption, credit} = fixture(); caption.setAttribute(attribute, 'native-semantics');
            expect(isBbcCreditOnlyCaption(caption)).toBe(false);
            caption.removeAttribute(attribute); credit.setAttribute(attribute, 'native-semantics');
            expect(isBbcCreditOnlyCaption(caption)).toBe(false);
        });

    it('refuses a credit span that contains native inline reading markup', () => {
        const {caption, credit} = fixture(); credit.innerHTML = `<a href="/photographer">${creditText}</a>`;
        expect(isBbcCreditOnlyCaption(caption)).toBe(false);
    });

    it.each(['missing-credit', 'two-credits', 'two-captions', 'missing-image', 'two-images',
        'wrong-image-testid', 'empty-credit', 'deep-caption', 'non-div-caption', 'deep-image', 'non-div-image', 'orphan-caption'])(
        'fails open to ordinary translation for %s relationships', problem => {
            const {caption, credit, figure, document} = fixture();
            const wrap = (element: Element, tag: string) => {const wrapper = document.createElement(tag); element.replaceWith(wrapper); wrapper.appendChild(element);};
            if (problem === 'missing-credit') credit.remove();
            if (problem === 'two-credits') credit.after(credit.cloneNode(true));
            if (problem === 'two-captions') figure.appendChild(caption.cloneNode(true));
            if (problem === 'missing-image') figure.querySelector('img')!.remove();
            if (problem === 'two-images') credit.before(document.createElement('img'));
            if (problem === 'wrong-image-testid') credit.parentElement!.setAttribute('data-testid', 'image-near-match');
            if (problem === 'empty-credit') {credit.textContent = '  '; caption.textContent = '(Credit: )';}
            if (problem === 'deep-caption') wrap(caption.parentElement!, 'div');
            if (problem === 'non-div-caption') {
                const section = document.createElement('section'); caption.parentElement!.replaceWith(section); section.appendChild(caption);
            }
            if (problem === 'deep-image') wrap(credit.parentElement!.parentElement!, 'div');
            if (problem === 'non-div-image') {
                const image = credit.parentElement!, section = document.createElement('section');
                image.parentElement!.replaceWith(section); section.appendChild(image);
            }
            if (problem === 'orphan-caption') document.body.appendChild(caption);
            expect(isBbcCreditOnlyCaption(caption)).toBe(false);
        });

    it('does not borrow a credit or caption from another nearest figure', () => {
        const {figure, caption, credit, document} = fixture();
        const nested = document.createElement('figure'); figure.appendChild(nested);
        nested.appendChild(credit.parentElement!);
        expect(isBbcCreditOnlyCaption(caption)).toBe(false);
        nested.appendChild(caption);
        expect(isBbcCreditOnlyCaption(caption)).toBe(true);
        figure.prepend(document.createElement('figcaption'));
        expect(isBbcCreditOnlyCaption(caption)).toBe(true);
    });

    it('does not grant semantic protection to a matching-looking figure outside an article', () => {
        const {figure, caption, credit, document} = fixture(); document.body.appendChild(figure);
        const adapter = composeSiteAdapters(builtinSiteRulePack, settings).find(value => value.id === 'bbc-news')!;
        expect(isBbcCreditOnlyCaption(caption)).toBe(false);
        expect(adapter.decide(caption, context).kind).not.toBe('prune-subtree');
        expect(adapter.shouldStayOriginal!(caption, context)).toBe(false);
        expect(adapter.shouldOmitFromTranslation!(caption, context)).toBe(false);
        expect(adapter.shouldIgnoreMutation!(caption, context)).toBe(false);
        expect(adapter.shouldIgnoreMutation!(credit, context)).toBe(false);
    });

    it('ignores owned copies only during judgement and cannot use a copy to supply missing native metadata', () => {
        const {caption, credit, figure, document} = fixture();
        const originalCaption = caption.firstChild!, originalCredit = credit.firstChild!;
        const copy = document.createElement('span'); copy.setAttribute('data-fr-translation-owned', 'true');
        copy.innerHTML = '<a href="/owned">译文副本</a><figure><figcaption>owned caption</figcaption><div data-testid="image"><img><span>owned credit</span></div></figure>';
        caption.appendChild(copy); credit.appendChild(copy.cloneNode(true));
        figure.appendChild(copy.cloneNode(true));
        caption.appendChild(document.createComment('native comment is not visible reading'));
        const before = figure.outerHTML;
        expect(isBbcCreditOnlyCaption(caption)).toBe(true);
        expect(isBbcCreditOnlyCaption(copy)).toBe(false);
        expect(figure.outerHTML).toBe(before);
        expect(caption.firstChild).toBe(originalCaption); expect(credit.firstChild).toBe(originalCredit);
        credit.setAttribute('data-fr-translation-owned', 'true');
        expect(isBbcCreditOnlyCaption(caption)).toBe(false);
        credit.removeAttribute('data-fr-translation-owned');
        figure.setAttribute('data-fr-translation-owned', 'true');
        expect(isBbcCreditOnlyCaption(caption)).toBe(false);
    });

    it('rereads native text/structure after edits, remounts and complete-figure rediscovery without a stale cache', () => {
        const {caption, credit, figure} = fixture();
        const adapters = composeSiteAdapters(builtinSiteRulePack, settings);
        const core = new TranslationCandidateCore({url, adapters});
        const containsCaption = () => core.discover(figure).some(candidate => candidate.element === caption);
        expect(containsCaption()).toBe(false);
        caption.textContent = `An illustration of the human neck (Credit: ${creditText})`;
        expect(core.shouldIgnoreMutation(caption)).toBe(false); expect(containsCaption()).toBe(true);
        caption.textContent = `(Credit: ${creditText})`;
        expect(core.shouldIgnoreMutation(caption)).toBe(true); expect(containsCaption()).toBe(false);
        credit.textContent = 'New Photographer';
        expect(core.shouldIgnoreMutation(credit)).toBe(false); expect(containsCaption()).toBe(true);
        caption.textContent = '(Credit: New Photographer)';
        expect(containsCaption()).toBe(false);
        const parent = caption.parentElement!; caption.remove(); parent.appendChild(caption);
        expect(containsCaption()).toBe(false);
        credit.parentElement!.removeAttribute('data-testid');
        expect(containsCaption()).toBe(true);
    });
});

describe('BBC builtin credit-caption capability ownership', () => {
    it('protects all four boundaries only through builtin composition and omits no descriptive source', () => {
        const {document, caption, credit, figure, get} = fixture();
        const compiled = compileSiteRulePack(builtinSiteRulePack).find(adapter => adapter.id === 'bbc-news')!;
        expect(compiled.decide(caption, context).kind).not.toBe('prune-subtree');
        const adapters = composeSiteAdapters(builtinSiteRulePack, settings);
        const adapter = adapters.find(value => value.id === 'bbc-news')!;
        const core = new TranslationCandidateCore({url, adapters});
        expect(adapter.decide(caption, context)).toEqual({kind: 'prune-subtree', reason: 'bbc-news:credit-only-caption'});
        expect(core.shouldStayOriginal(caption)).toBe(true);
        expect(core.shouldOmitFromTranslation(caption)).toBe(true);
        expect(core.shouldIgnoreMutation(caption)).toBe(true);
        expect(core.resolve(caption.firstChild)).toBeNull();
        const descriptive = get('#descriptive figcaption');
        expect(core.resolve(descriptive.firstChild)?.element).toBe(descriptive);
        const html = document.body.innerHTML, firstCaptionText = caption.firstChild, firstCreditText = credit.firstChild;
        const snapshot = createTranslationSourceSnapshot(get('article'), core.shouldStayOriginal, undefined, undefined, core.shouldOmitFromTranslation);
        expect(snapshot.clone.querySelector('#caption')).toBeNull();
        expect(snapshot.clone.querySelector('#descriptive figcaption')?.textContent).toBe(descriptive.textContent);
        expect(snapshot.slots.map(slot => slot.source).join(' ')).not.toContain(`(Credit: ${creditText})`);
        expect(snapshot.slots.map(slot => slot.source).join(' ')).toContain('Modern life is hard on the human neck');
        expect(document.body.innerHTML).toBe(html); expect(caption.firstChild).toBe(firstCaptionText); expect(credit.firstChild).toBe(firstCreditText);
        expect(core.discover(figure)).toEqual([]);
    });

    it('revokes the capability for custom same-ID replacement, disabled rule, disabled settings and a missing builtin', () => {
        const {caption} = fixture();
        for (const current of [
            {...settings, enabled: false}, {...settings, disabledRuleIds: ['bbc-news']},
            {...settings, custom: {version: 1 as const, rules: [{id: 'bbc-news', name: 'Custom', match: {hosts: ['www.bbc.com']}}]}},
        ]) {
            const adapters = composeSiteAdapters(builtinSiteRulePack, current);
            const core = new TranslationCandidateCore({url, adapters});
            expect(core.shouldStayOriginal(caption)).toBe(false);
            expect(core.shouldOmitFromTranslation(caption)).toBe(false);
            expect(core.shouldIgnoreMutation(caption)).toBe(false);
            expect(core.resolve(caption.firstChild)).not.toBeNull();
        }
        expect(composeSiteAdapters({version: 1, rules: []}, settings)).toEqual([]);
    });

    it.each(['https://example.test/future/article/example', 'https://www.bbc.com/sport/article/example',
        'https://bbc.com/future/article/example', 'file:///future/article/example'])(
        'rechecks builtin URL matching even for a direct callback on %s', href => {
            const {caption} = fixture();
            const adapter = composeSiteAdapters(builtinSiteRulePack, settings).find(value => value.id === 'bbc-news')!;
            const outside = {url: new URL(href)};
            expect(adapter.decide(caption, outside).kind).not.toBe('prune-subtree');
            expect(adapter.shouldStayOriginal!(caption, outside)).toBe(false);
            expect(adapter.shouldOmitFromTranslation!(caption, outside)).toBe(false);
            expect(adapter.shouldIgnoreMutation!(caption, outside)).toBe(false);
        });

    it('preserves optional/base policies and merges only actual attribute dependencies without eagerly reading the base getter', () => {
        const {caption, credit, get, document} = fixture();
        const observed = vi.fn(() => ['class', 'role']);
        const minimal: TranslationSiteAdapter = {id: 'bbc-news', matches: () => true, decide: () => ({kind: 'pass'}),
            get observedAttributes() {return observed();}};
        const wrapped = withBbcCreditCaptionProtection(minimal);
        expect(observed).not.toHaveBeenCalled();
        expect(wrapped.observedAttributes).toEqual(['class', 'role', 'data-testid', 'data-fr-translation-owned',
            'tabindex', 'contenteditable', 'href', 'aria-label', 'aria-labelledby']);
        expect(wrapped.decide(get('p'), context)).toEqual({kind: 'pass'});
        for (const method of ['shouldStayOriginal', 'shouldOmitFromTranslation', 'shouldIgnoreMutation'] as const) {
            expect(wrapped[method]!(get('p'), context)).toBe(false);
        }
        minimal.shouldStayOriginal = () => true; minimal.shouldOmitFromTranslation = () => true; minimal.shouldIgnoreMutation = () => true;
        expect(wrapped.shouldStayOriginal!(get('p'), context)).toBe(true);
        expect(wrapped.shouldOmitFromTranslation!(get('p'), context)).toBe(true);
        expect(wrapped.shouldIgnoreMutation!(get('p'), context)).toBe(true);
        expect(wrapped.shouldIgnoreMutation!(credit, context)).toBe(false);
        credit.setAttribute('data-fr-translation-owned', 'true');
        expect(wrapped.shouldIgnoreMutation!(credit, context)).toBe(true);
        credit.removeAttribute('data-fr-translation-owned');
        document.body.appendChild(credit.parentElement!);
        expect(wrapped.shouldIgnoreMutation!(credit, context)).toBe(true);
        expect(wrapped.shouldIgnoreMutation!(caption, context)).toBe(true);
        const none = withBbcCreditCaptionProtection({...minimal, observedAttributes: undefined});
        expect(none.observedAttributes).toContain('data-testid');
        const broad = withBbcCreditCaptionProtection({...minimal, observedAttributes: null});
        expect(getSiteAdapterAttributeFilter([broad], ['style'])).toBeNull();
    });
});
