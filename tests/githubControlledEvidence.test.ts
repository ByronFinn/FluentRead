/** GitHub 已保护身份的证据投影回归：真实核心和快照生成译文，保持正文完整及原生链接骨架。 */
import {createRequire} from 'node:module';
import {parseHTML} from 'linkedom';
import {afterEach, describe, expect, it, vi} from 'vitest';
import establishedRules from '@/src/core/site-adaptation/catalog/established.json';
import {createTranslationSourceSnapshot, applyTranslationsToSnapshot} from '@/src/core/translation/serialization';
import {appendBilingualTranslation} from '@/src/features/full-page-translation/content/renderer';
import {createTranslationCore} from './helpers/translationCore';

vi.mock('@/src/services/config/store', () => ({config: {style: 1, to: 'zh-Hans'}}));
vi.mock('@/src/core/config/catalog', () => ({options: {styles: []}}));
vi.mock('@/src/features/full-page-translation/content/layout', () => ({ensureTranslationTruncationLayout: vi.fn()}));

const require = createRequire(import.meta.url);
const {encodeControlledTranslation, readControlledPageEvidenceInPage, assertControlledPageEvidence} =
    require('../scripts/site-translation/controlled-provider.cjs');
const url = 'https://github.com/example/project/issues/123';
const metadataSelectors = [
    'main a[data-testid="issue-body-header-author"][data-hovercard-type="user"][href]:not(.markdown-body):not(.markdown-body *)',
    'main [data-testid="comment-header"]:not(.markdown-body):not(.markdown-body *):not(:has(.markdown-body))',
    'main #issue-timeline a[data-testid="actor-link"][href]:not(.markdown-body):not(.markdown-body *)',
];

function renderedFixture() {
    const {document, window} = parseHTML(`<html><body><main>
      <div id="issue-owner">Opened by <a data-testid="issue-body-header-author" data-hovercard-type="user" href="/FixtureAuthor">Fixture Author</a> with an explanation.</div>
      <section id="comment-section"><div data-testid="comment-header"><a href="/FixtureCommenter">Fixture Commenter</a><span>Member</span></div><p id="comment-owner">The comment independently explains a useful behavior.</p></section>
      <ol id="issue-timeline"><li><div id="event-owner"><div><a data-testid="actor-link" href="/FixtureActor"><img alt=""><span>Fixture Actor</span></a></div>closed this as <a href="/example/project/issues?state=closed">completed</a><a href="#event-1"><relative-time>on Oct 25, 2026</relative-time></a></div></li>
      <li><div id="bot-owner"><div><a data-testid="actor-link" href="/apps/fixture-bot"><span>Fixture Automation Bot</span></a></div>locked and limited this discussion.</div></li></ol>
      <div class="markdown-body"><p id="body-owner">A body reference to <a data-testid="actor-link" href="/FixtureActor">Fixture Actor</a> remains ordinary readable prose.</p></div>
      </main></body></html>`);
    Object.defineProperty(document, 'baseURI', {value: url});
    vi.stubGlobal('document', document);vi.stubGlobal('Node', window.Node);vi.stubGlobal('location', new URL(url));
    const core = createTranslationCore({url: new URL(url)});
    const rendered = ['issue', 'comment', 'event', 'bot', 'body'].map(name => {
        const owner = document.querySelector<HTMLElement>(`#${name}-owner`)!;
        const snapshot = createTranslationSourceSnapshot(owner, core.shouldStayOriginal,
            undefined, undefined, core.shouldOmitFromTranslation);
        const output = appendBilingualTranslation(owner, applyTranslationsToSnapshot(snapshot,
            snapshot.slots.map(slot => encodeControlledTranslation(slot.source))), {sourceSkeleton: snapshot.clone});
        return {name, owner, snapshot, output};
    });
    return {document, core, rendered};
}

afterEach(() => vi.unstubAllGlobals());

describe('GitHub 原生身份 literal skeleton 与完整正文归属', () => {
    it('与三条实际生产声明一致，保留合法身份及链接，全部正文槽完整匹配', () => {
        const {core, rendered} = renderedFixture();
        const rule = establishedRules.find(item => item.id === 'github')!;
        metadataSelectors.forEach(selector => {
            expect(rule.protect).toContain(selector);
            expect(rule.watchIgnore).toContain(selector);
        });
        for (const entry of rendered.slice(0, 4).filter(entry => entry.name !== 'comment')) {
            const literal = entry.owner.querySelector('a')!;
            expect(core.shouldStayOriginal(literal), entry.name).toBe(true);
            expect(entry.snapshot.slots.map(slot => slot.source).join(' '), entry.name).not.toContain(literal.textContent);
        }
        // 原生评论 header 与正文是兄弟节点；核心仅将 P 作为正文拥有者。
        const header = rendered[1]!.owner.previousElementSibling! as HTMLElement;
        expect(core.shouldStayOriginal(header)).toBe(true);
        expect(core.discover(header)).toEqual([]);
        expect(createTranslationSourceSnapshot(header, core.shouldStayOriginal).slots).toEqual([]);
        const body = rendered[4]!;
        expect(core.shouldStayOriginal(body.owner.querySelector('a')!)).toBe(false);
        expect(body.snapshot.slots.map(slot => slot.source).join(' ')).toContain('Fixture Actor');
        const evidence = readControlledPageEvidenceInPage();
        expect(evidence.flatMap((row: any) => row.omittedParts)).toEqual([]);
        expect(evidence.flatMap((row: any) => row.protectedMatches).filter((part: any) => part.text.includes('Fixture')))
            .toEqual(expect.arrayContaining([
                expect.objectContaining({tag: 'a', text: 'Fixture Author', href: '/FixtureAuthor', matched: true}),
                expect.objectContaining({tag: 'a', text: 'Fixture Actor', href: '/FixtureActor', matched: true}),
                expect.objectContaining({tag: 'a', text: 'Fixture Automation Bot', href: '/apps/fixture-bot', matched: true}),
            ]));
        expect(assertControlledPageEvidence(evidence, 'github-literals')).toMatchObject({owners: 5, completeSourceMatched: true});
    });

    it.each(['other-host', 'lookalike-host', 'markdown-descendant', 'markdown-root', 'near-class', 'outside-timeline',
        'changed-text', 'missing-author', 'changed-href', 'missing-href', 'changed-tag', 'duplicate-literal',
        'extra-encoded', 'extra-literal', 'missing-event-prose'])(
        '拒绝身份或归属边界变化：%s', variant => {
            const {document, rendered} = renderedFixture();
            const event = rendered[2]!;
            const original = event.owner.querySelector<HTMLAnchorElement>('a[data-testid="actor-link"]')!;
            const output = event.output.querySelector<HTMLAnchorElement>('a')!;
            if (variant === 'other-host') vi.stubGlobal('location', new URL('https://ordinary.example/example/project/issues/123'));
            if (variant === 'lookalike-host') vi.stubGlobal('location', new URL('https://github.com.evil.example/example/project/issues/123'));
            if (variant === 'markdown-descendant') event.owner.classList.add('markdown-body');
            if (variant === 'markdown-root') original.classList.add('markdown-body');
            if (variant === 'near-class') {original.removeAttribute('data-testid');original.className = 'eventActorLink__jICdM_';}
            if (variant === 'outside-timeline') document.querySelector('#issue-timeline')!.removeAttribute('id');
            if (variant === 'changed-text') output.querySelector('span')!.textContent = 'A Different Actor';
            if (variant === 'missing-author') output.remove();
            if (variant === 'changed-href') output.setAttribute('href', '/WrongActor');
            if (variant === 'missing-href') output.removeAttribute('href');
            if (variant === 'changed-tag') {const span = document.createElement('span');span.textContent = output.textContent;output.replaceWith(span);}
            if (variant === 'duplicate-literal') event.output.append(output.cloneNode(true));
            if (variant === 'extra-encoded') event.output.append(document.createTextNode(encodeControlledTranslation('Additional unrelated prose.')));
            if (variant === 'extra-literal') event.output.append(document.createTextNode('Additional unencoded prose.'));
            if (variant === 'missing-event-prose') event.output.innerHTML = output.outerHTML;
            expect(() => assertControlledPageEvidence(readControlledPageEvidenceInPage(), variant)).toThrow('complete source');
        });

    it('相同姓名在正文中必须编码，不能复用 metadata literal 豁免', () => {
        const {rendered} = renderedFixture();
        const body = rendered[4]!;
        body.output.querySelector('a')!.textContent = 'Fixture Actor';
        expect(() => assertControlledPageEvidence(readControlledPageEvidenceInPage(), 'body-same-name'))
            .toThrow('complete source');
    });

    it('同名 comment-header 一旦含 Markdown 正文就不能继续作为保护骨架', () => {
        const {document, rendered} = renderedFixture();
        const header = rendered[1]!.owner.previousElementSibling! as HTMLElement;
        const body = document.createElement('div');body.className = 'markdown-body';
        body.textContent = 'New complete prose inside the header must be translated.';header.append(body);
        expect(createTranslationCore({url: new URL(url)}).shouldStayOriginal(header)).toBe(false);
        const snapshot = createTranslationSourceSnapshot(header,
            createTranslationCore({url: new URL(url)}).shouldStayOriginal);
        expect(snapshot.slots.map(slot => slot.source).join(' ')).toContain(body.textContent);
    });
});
