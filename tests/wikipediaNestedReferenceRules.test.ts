/**
 * Wikipedia 嵌套脚注的原创结构回归：显式非原子引用容器补齐引导 run，子列表保留独立归属。
 * 只验证真实核心、来源快照、物化与状态恢复；不代表线上浏览器或翻译服务验收。
 */
import {parseHTML} from 'linkedom';
import {describe, expect, it, vi} from 'vitest';

vi.mock('@/src/services/config/store', () => ({config: {style: 1, to: 'zh-Hans'}}));
vi.mock('@/src/core/config/catalog', () => ({options: {styles: []}}));
vi.mock('@/src/features/full-page-translation/content/layout', () => ({ensureTranslationTruncationLayout: vi.fn()}));

import fixture from './fixtures/translation-pages/wikipedia-nested-reference.json';
import {builtinSiteRulePack} from '@/src/core/site-adaptation/catalog';
import {compileSiteRulePack} from '@/src/core/site-adaptation/compiler';
import {TranslationCandidateCore} from '@/src/core/translation/engine';
import type {TranslationCandidate} from '@/src/core/translation/types';
import {extractTranslationTextFromNodes} from '@/src/core/translation/text';
import {applyTranslationsToSnapshot, createTranslationSourceSnapshot} from '@/src/core/translation/serialization';
import {materializeCandidate} from '@/src/features/full-page-translation/content/renderer';
import {beginTranslation, markTranslationComplete, restoreTranslation, setBilingualContent} from '@/src/features/full-page-translation/content/state';

const selector = '.mw-parser-output ol.references > li > span.mw-reference-text:has(> ul)';
const node = (document: Document, id: string) => document.getElementById(id)!;
function setup(html = fixture.html, url = fixture.url, previousRules = false) {
    const document = parseHTML(`<html><head></head><body>${html}</body></html>`).document as unknown as Document;
    const pack = structuredClone(builtinSiteRulePack);
    if (previousRules) {
        const rule = pack.rules.find(rule => rule.id === 'wikipedia')!;
        rule.content = rule.content!.filter(content => !content.css.includes(selector));
    }
    const core = new TranslationCandidateCore({url: new URL(url), adapters: compileSiteRulePack(pack)});
    return {document, core};
}
const source = (core: TranslationCandidateCore, candidate: TranslationCandidate) =>
    extractTranslationTextFromNodes(candidate.nodes ?? [candidate.element], core.shouldStayOriginal);
const own = (core: TranslationCandidateCore, document: Document, id: string) =>
    core.discover(document).filter(candidate => candidate.element === node(document, id));

describe('Wikipedia 直接嵌套列表引用的非原子正文', () => {
    it('复现原规则只发现三个子项，引导 Text 的 discover 与 hover 均缺失', () => {
        const {document, core} = setup(fixture.html, fixture.url, true);
        const prefix = node(document, 'prefix');
        expect(core.shouldStayOriginal(prefix)).toBe(false);
        expect(core.shouldOmitFromTranslation(prefix)).toBe(false);
        expect(own(core, document, 'prefix')).toEqual([]);
        expect(core.resolve(prefix.firstChild)).toBeNull();
        for (const id of fixture.ownerIds.slice(1)) expect(own(core, document, id), id).toHaveLength(1);
        expect(own(core, document, 'note')).toEqual([]);
    });

    it('补齐一个引导 owner 并保留三个正序子 owner，完整来源不重复也不跨 UL', () => {
        const {document, core} = setup();
        const candidates = core.discover(document).filter(candidate => fixture.ownerIds.includes(candidate.element.id));
        expect(candidates).toHaveLength(4);
        expect(candidates.map(candidate => candidate.element.id)).toEqual(['child-a', 'child-b', 'child-c', 'prefix']);
        expect(own(core, document, 'note')).toEqual([]);
        const prefix = own(core, document, 'prefix')[0]!;
        expect(source(core, prefix)).toBe(fixture.intro);
        expect(prefix.nodes).toEqual([node(document, 'prefix').firstChild]);
        expect(prefix.nodes).not.toContain(node(document, 'nested'));
        expect(core.resolve(node(document, 'prefix').firstChild)?.nodes).toEqual(prefix.nodes);
        const assigned = new Set<Node>();
        for (const candidate of candidates) {
            expect(source(core, candidate)).toBe(candidate.element.id === 'prefix'
                ? fixture.intro : candidate.element.textContent);
            for (const root of candidate.nodes ?? [candidate.element]) {
                const pending = [root];
                while (pending.length) {
                    const current = pending.pop()!;
                    if (current.nodeType === 3) {
                        expect(assigned.has(current)).toBe(false);
                        assigned.add(current);
                    } else {
                        pending.push(...Array.from(current.childNodes));
                    }
                }
            }
        }
        expect(core.shouldStayOriginal(node(document, 'backlink'))).toBe(true);
        expect(core.resolve(node(document, 'backlink').firstChild)).toBeNull();
    });

    it('真实物化、来源快照及状态恢复重复两轮后保留原节点、链接与监听器', () => {
        const html = fixture.html.replace(fixture.intro,
            'An introductory note follows <a id="inline-link" href="https://example.test/source">the independent source</a>, keeps <code id="literal">KEEP_LITERAL</code> and <span class="mwe-math-element"><math><mi>x</mi></math></span> unchanged:');
        const {document, core} = setup(html);
        const note = node(document, 'note');
        const before = note.outerHTML;
        const allNodes = () => {
            const result: Node[] = [], pending: Node[] = [note];
            while (pending.length) {
                const current = pending.pop()!;
                result.push(current);
                pending.push(...Array.from(current.childNodes).reverse());
            }
            return result;
        };
        const originals = allNodes();
        const link = node(document, 'inline-link');
        const clicked = vi.fn(); link.addEventListener('click', clicked);
        for (let cycle = 0; cycle < 2; cycle += 1) {
            const active: HTMLElement[] = [];
            try {
                const candidates = core.discover(document).filter(candidate => fixture.ownerIds.includes(candidate.element.id));
                expect(candidates).toHaveLength(4);
                for (const candidate of candidates) {
                    const materialized = materializeCandidate(candidate, false)!;
                    expect(materialized).not.toBeNull();
                    const snapshot = createTranslationSourceSnapshot(materialized.node, core.shouldStayOriginal,
                        undefined, undefined, core.shouldOmitFromTranslation);
                    const inputs = snapshot.slots.map(slot => slot.source);
                    expect(inputs.join(' ')).not.toContain('KEEP_LITERAL');
                    if (candidate.element.id === 'prefix') {
                        expect(inputs.join(' ')).toContain('the independent source');
                        expect(inputs.join(' ')).not.toContain('first independent source');
                        expect(inputs).not.toContain('x');
                    }
                    const output = applyTranslationsToSnapshot(snapshot, inputs.map(() => '独立译文'));
                    if (candidate.element.id === 'prefix') {
                        expect(output).toContain('KEEP_LITERAL');
                        expect(output).toContain('https://example.test/source');
                    }
                    const attempt = beginTranslation(materialized.node, 'bilingual', 'content', materialized.synthetic)!;
                    active.push(materialized.node);
                    expect(markTranslationComplete(materialized.node, attempt.state, attempt.generation, false)).toBe(true);
                    const wrapper = document.createElement('span');
                    wrapper.className = 'fluent-read-bilingual-content';
                    wrapper.setAttribute('data-fr-translation-owned', 'true');
                    wrapper.innerHTML = output;
                    materialized.node.appendChild(wrapper);
                    setBilingualContent(materialized.node, wrapper);
                }
                expect(note.querySelectorAll('.fluent-read-bilingual-content')).toHaveLength(4);
            } finally {
                for (const owner of active.reverse()) expect(restoreTranslation(owner)).toBe(true);
            }
            expect(note.outerHTML).toBe(before);
            const restored = allNodes();
            expect(restored).toHaveLength(originals.length);
            restored.forEach((current, index) => expect(current).toBe(originals[index]));
            expect(node(document, 'inline-link')).toBe(link);
            expect(link.getAttribute('href')).toBe('https://example.test/source');
            link.dispatchEvent(new document.defaultView!.Event('click'));
        }
        expect(clicked).toHaveBeenCalledTimes(2);
    });

    it('新增、同节点重挂与引导文本更新后重新发现完整独立来源', () => {
        const {document, core} = setup();
        const list = document.querySelector('ol.references')!;
        const added = node(document, 'note').cloneNode(true) as HTMLElement;
        for (const element of [added, ...Array.from(added.querySelectorAll('[id]'))]) element.id += '-new';
        list.appendChild(added);
        for (const id of fixture.ownerIds) expect(own(core, document, `${id}-new`), id).toHaveLength(1);
        added.remove(); list.appendChild(added);
        const prefix = node(document, 'prefix-new');
        prefix.firstChild!.nodeValue = 'An updated independent introduction describes the later chronology:';
        const candidates = own(core, document, 'prefix-new');
        expect(candidates).toHaveLength(1);
        expect(source(core, candidates[0]!)).toBe(prefix.firstChild!.nodeValue);
        for (const id of fixture.ownerIds.slice(1)) expect(own(core, document, `${id}-new`), id).toHaveLength(1);
    });

    it('普通 div、引用与 inline 容器仍沿用原有候选边界', () => {
        const html = fixture.html.replace('</main>', '<p id="inline-parent"><span id="ordinary-inline">Ordinary inline prose remains part of its paragraph.</span></p></main>');
        const current = setup(html), previous = setup(html, fixture.url, true);
        for (const id of ['ordinary-div', 'ordinary-child', 'quote', 'inline-parent', 'ordinary-inline']) {
            expect(own(current.core, current.document, id).map(candidate => source(current.core, candidate)), id)
                .toEqual(own(previous.core, previous.document, id).map(candidate => source(previous.core, candidate)));
        }
        expect(own(current.core, current.document, 'ordinary-inline')).toEqual([]);
    });

    it.each([
        ['near class', fixture.html.replace('mw-reference-text reference-text', 'mw-reference-text-near reference-text')],
        ['wrong reference list', fixture.html.replace('mw-references references', 'mw-references references-near')],
        ['indirect nested list', fixture.html.replace('<ul id="nested">', '<div><ul id="nested">').replace('</ul></span>', '</ul></div></span>')],
    ])('近似结构不获得专站强制声明：%s', (_name, html) => {
        const {document, core} = setup(html);
        expect(node(document, 'prefix').matches(selector)).toBe(false);
        expect(own(core, document, 'prefix')).toEqual([]);
    });

    it.each(['https://example.test/wiki/Authored_reference_example', 'https://en.wikipedia.org/w/index.php'])
    ('主机或路径不匹配时不强制 inline 容器：%s', url => {
        const {document, core} = setup(fixture.html, url);
        expect(own(core, document, 'prefix')).toEqual([]);
        expect(core.discover(document).some(candidate => candidate.adapterId === 'wikipedia')).toBe(false);
    });

    it.each(['role="navigation"', 'translate="no"', 'contenteditable="true"'])
    ('祖先硬保护仍优先于显式引用声明：%s', attributes => {
        const {document, core} = setup(fixture.html.replace('<ol class=', `<ol ${attributes} class=`));
        expect(own(core, document, 'prefix')).toEqual([]);
        expect(core.resolve(node(document, 'prefix').firstChild)).toBeNull();
        for (const id of fixture.ownerIds.slice(1)) expect(own(core, document, id), id).toEqual([]);
    });

    it('所有子列表受保护时允许原有非分段分支，但来源仅含合法引导且不包含保护子项', () => {
        const {document, core} = setup(fixture.html.replace('<ul id="nested">', '<ul id="nested" translate="no">'));
        const candidates = own(core, document, 'prefix');
        expect(candidates).toHaveLength(1);
        expect(source(core, candidates[0]!)).toBe(fixture.intro);
        for (const id of fixture.ownerIds.slice(1)) expect(own(core, document, id), id).toEqual([]);
    });
});
