/** GitLab scoped labels are immutable skeleton, never an exemption for ordinary prose. */
import {createRequire} from 'node:module';
import {parseHTML} from 'linkedom';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createTranslationSourceSnapshot, applyTranslationsToSnapshot} from '@/src/core/translation/serialization';
import {appendBilingualTranslation} from '@/src/features/full-page-translation/content/renderer';
import {createTranslationCore} from './helpers/translationCore';
import {compileSiteRulePack} from '@/src/core/site-adaptation/compiler';
import {builtinSiteRulePack} from '@/src/core/site-adaptation/catalog';

vi.mock('@/src/services/config/store', () => ({config: {style: 1, to: 'zh-Hans'}}));
vi.mock('@/src/core/config/catalog', () => ({options: {styles: []}}));
vi.mock('@/src/features/full-page-translation/content/layout', () => ({ensureTranslationTruncationLayout: vi.fn()}));
const require = createRequire(import.meta.url);
const {encodeControlledTranslation, readControlledPageEvidenceInPage, assertControlledPageEvidence,
    captureSourcePartitions, assertSourcePartitions} = require('../scripts/site-translation/controlled-provider.cjs');
const url = 'https://gitlab.com/gitlab-org/gitlab/-/work_items/18924';
function setup() {
    const {document, window} = parseHTML(`<html><body><main><div class="md"><p id="body">A public paragraph contains <a href="/labels/feature"><span class="gl-label-text">feature</span><span class="gl-label-text-scoped">enhancement</span></a> and <span class="gl-label-text-scoped-example">ordinary readable words</span> for readers.</p></div></main></body></html>`);
    Object.defineProperty(document, 'baseURI', {value: url});
    vi.stubGlobal('document', document);vi.stubGlobal('Node', window.Node);vi.stubGlobal('location', new URL(url));
    const core = createTranslationCore({url: new URL(url)});
    const owner = document.querySelector<HTMLElement>('#body')!;
    const snapshot = createTranslationSourceSnapshot(owner, core.shouldStayOriginal, undefined, undefined, core.shouldOmitFromTranslation);
    return {document, owner, snapshot};
}
function render(state: ReturnType<typeof setup>) {
    return appendBilingualTranslation(state.owner, applyTranslationsToSnapshot(state.snapshot,
        state.snapshot.slots.map(slot => encodeControlledTranslation(slot.source))), {sourceSkeleton: state.snapshot.clone});
}
afterEach(() => vi.unstubAllGlobals());
describe('GitLab scoped label controlled evidence', () => {
    it.each([
        'https://example.com/article',
        'https://gitlab.com/gitlab-org/gitlab/-/work_items/18924',
        'https://gitlab.com/gitlab-org/gitlab/-/snippets/1',
    ])('keeps marker-shaped native text in the evidence when no label marker was inserted: %s', pageUrl => {
        const {document, window} = parseHTML('<html><body><main><p id="body">Leading words <span id="literal"></span> final words.<span class="fluent-read-bilingual-content" data-fr-translation-owned="true"></span></p></main></body></html>');
        vi.stubGlobal('document', document);vi.stubGlobal('Node', window.Node);vi.stubGlobal('location', new URL(pageUrl));
        const literal = '\uFFF2123\uFFF3', source = `Leading words ${literal} final words.`;
        document.querySelector('#literal')!.textContent = literal;
        const output = document.querySelector('.fluent-read-bilingual-content')!;
        output.textContent = encodeControlledTranslation(source);
        const valid = readControlledPageEvidenceInPage();
        expect(valid[0].source).toContain(literal);
        expect(assertControlledPageEvidence(valid, 'literal-marker')).toMatchObject({owners: 1});

        output.textContent = encodeControlledTranslation('Leading words  final words.');
        expect(() => assertControlledPageEvidence(readControlledPageEvidenceInPage(), 'missing-literal')).toThrow('complete source');
        output.textContent = encodeControlledTranslation(source);
        output.append(document.createTextNode(literal));
        expect(() => assertControlledPageEvidence(readControlledPageEvidenceInPage(), 'extra-literal')).toThrow('complete source');
    });
    it('does not filter a marker generated for another GitLab owner', () => {
        const {document, window} = parseHTML('<html><body><main><span class="gl-label-text">other label</span><p id="body">Leading words <span id="literal"></span> final words.<span class="fluent-read-bilingual-content" data-fr-translation-owned="true"></span></p></main></body></html>');
        vi.stubGlobal('document', document);vi.stubGlobal('Node', window.Node);vi.stubGlobal('location', new URL(url));
        const literal = '\uFFF20\uFFF3';
        document.querySelector('#literal')!.textContent = literal;
        document.querySelector('.fluent-read-bilingual-content')!.textContent = encodeControlledTranslation('Leading words  final words.');
        const rows = readControlledPageEvidenceInPage();
        expect(rows[0].source).toContain(literal);
        expect(() => assertControlledPageEvidence(rows, 'other-owner-marker')).toThrow('complete source');
    });

    it('matches both label siblings and their exact href without dropping surrounding prose from a source partition', async () => {
        const state = setup();
        const page = {evaluate: async (fn: Function, input: unknown) => fn(input)};
        const ledger = await captureSourcePartitions(page, [{name: 'body', selector: '#body', sourcePartition: {excludeSelectors: []}}]);
        const output = render(state);
        const rows = readControlledPageEvidenceInPage();
        expect(rows[0].protectedMatches).toEqual(expect.arrayContaining([
            expect.objectContaining({tag: 'span', text: 'feature', linkHref: '/labels/feature', matched: true}),
            expect.objectContaining({tag: 'span', text: 'enhancement', linkHref: '/labels/feature', matched: true}),
        ]));
        expect(rows[0].source).toContain('ordinary readable words');
        expect(assertControlledPageEvidence(rows, 'gitlab')).toMatchObject({owners: 1, completeSourceMatched: true});
        await expect(assertSourcePartitions(page, ledger, 'full')).resolves.toEqual([expect.objectContaining({completeSourceMatched: true})]);
        output.remove();
        await expect(assertSourcePartitions(page, ledger, 'restore', {restored: true})).resolves.toEqual([expect.objectContaining({restored: true})]);
    });
    it.each([
        'https://gitlab.com/group/project/-/issues/1',
        'https://GITLAB.com./group/project/-/issues/1',
        'https://gitlab.com/group/project/-/work_items/1?view=full#details',
        'https://gitlab.com/group/project/-/merge_requests/1',
        'https://gitlab.com/group/project/-/blob/main/README.md',
        'https://gitlab.com/group/project/-/wikis/guide',
        'https://gitlab.com/group/project/-/releases/v1',
        'http://gitlab.com/group/project/-/work_items/1',
    ])('accepts the original label skeleton only on a declared GitLab profile path: %s', path => {
        const state = setup();render(state);vi.stubGlobal('location', new URL(path));
        expect(assertControlledPageEvidence(readControlledPageEvidenceInPage(), 'matching-profile')).toMatchObject({owners: 1});
    });
    it.each([
        'https://gitlab.com/group/project/-/issues/1',
        'https://GITLAB.com./group/project/-/work_items/1?view=full#details',
        'https://gitlab.com/parent/nested/project/-/work_items/1',
        'https://gitlab.com//-/work_items/1',
        'https://gitlab.com/-/work_items/1',
        'https://gitlab.com/group/project/-/releases/v1',
        'https://gitlab.com/group/project/-/merge_requests/1',
        'https://gitlab.com/group/project/-/blob/main/README.md',
        'https://gitlab.com/group/project/-/wikis/guide',
        'https://gitlab.com/login/group/project/-/work_items/1',
        'https://gitlab.com/group/project/-/snippets/1',
        'https://gitlab.com.evil.invalid/group/project/-/work_items/1',
        'ftp://gitlab.com/group/project/-/work_items/1',
    ])('keeps controlled GitLab context in parity with the production adapter: %s', path => {
        const state = setup();render(state);vi.stubGlobal('location', new URL(path));
        const gitlab = compileSiteRulePack(builtinSiteRulePack).find(adapter => adapter.id === 'gitlab')!;
        const protectedValues = readControlledPageEvidenceInPage()[0].protectedMatches.filter(
            (part: {requireElement?: boolean}) => part.requireElement === true);
        expect(protectedValues.length === 2).toBe(gitlab.matches(new URL(path)));
    });
    it('pairs identical repeated scoped labels one-to-one in the original order', () => {
        const state = setup(), clone = state.owner.querySelector('a')!.cloneNode(true);
        state.owner.append(' and ', clone);
        const core = createTranslationCore({url: new URL(url)});
        state.snapshot = createTranslationSourceSnapshot(state.owner, core.shouldStayOriginal, undefined, undefined, core.shouldOmitFromTranslation);
        const output = render(state), rows = readControlledPageEvidenceInPage();
        expect(rows[0].protectedMatches.filter((part: {requireElement?: boolean}) => part.requireElement)).toHaveLength(4);
        expect(assertControlledPageEvidence(rows, 'repeated-labels')).toMatchObject({owners: 1});
        output.querySelectorAll('a')[1]!.remove();
        expect(() => assertControlledPageEvidence(readControlledPageEvidenceInPage(), 'missing-duplicate')).toThrow('complete source');
    });
    it.each(['source', 'output'])('rejects GitLab marker collisions in %s text', side => {
        const state = setup(), output = render(state);
        (side === 'source' ? state.owner : output).append(document.createTextNode('\uFFF2collision'));
        expect(() => readControlledPageEvidenceInPage()).toThrow('GitLab label marker collision');
    });
    it.each(['wrong-host', 'lookalike-host', 'other-path', 'excluded-path', 'ftp', 'changed-text', 'changed-link', 'removed-label', 'unwrapped-label', 'cross-link', 'reordered-label', 'moved-label-link', 'duplicate-label', 'ordinary-echo'])(
        'rejects missing context or changed skeleton and never exempts ordinary prose: %s', variant => {
            const state = setup(), output = render(state);
            if (variant === 'wrong-host') vi.stubGlobal('location', new URL('https://example.com/group/project/-/work_items/1'));
            if (variant === 'lookalike-host') vi.stubGlobal('location', new URL('https://gitlab.com.evil.invalid/group/project/-/work_items/1'));
            if (variant === 'other-path') vi.stubGlobal('location', new URL('https://gitlab.com/group/project/-/snippets/1'));
            if (variant === 'excluded-path') vi.stubGlobal('location', new URL('https://gitlab.com/login/group/project/-/work_items/1'));
            if (variant === 'ftp') vi.stubGlobal('location', new URL('ftp://gitlab.com/group/project/-/work_items/1'));
            if (variant === 'changed-text') output.querySelectorAll('span')[1]!.textContent = 'changed';
            if (variant === 'changed-link') output.querySelector('a')!.setAttribute('href', '/different');
            if (variant === 'removed-label') output.querySelectorAll('span')[1]!.remove();
            if (variant === 'unwrapped-label') {
                const value = output.querySelectorAll('span')[1]!;
                value.replaceWith(...Array.from(value.childNodes));
            }
            if (variant === 'cross-link') {
                const value = output.querySelectorAll('span')[1]!, link = document.createElement('a');
                link.setAttribute('href', '/different');link.append(value);output.append(link);
            }
            if (variant === 'moved-label-link') output.append(output.querySelector('a')!);
            if (variant === 'reordered-label') {
                const link = output.querySelector('a')!, labels = link.querySelectorAll('span');
                link.insertBefore(labels[1]!, labels[0]!);
            }
            if (variant === 'duplicate-label') {
                const link = output.querySelector('a')!, value = output.querySelectorAll('span')[1]!;
                link.append(value.cloneNode(true));
            }
            if (variant === 'ordinary-echo') output.append(document.createTextNode(' ordinary readable words'));
            expect(() => assertControlledPageEvidence(readControlledPageEvidenceInPage(), variant)).toThrow('complete source');
        });
});
