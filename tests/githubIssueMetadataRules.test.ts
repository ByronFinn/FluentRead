/**
 * GitHub 当前 issue 原生身份组件的原创结构回归：验证候选、快照和动态重建边界。
 * 夹具不联网，也不把纯核心测试视为线上扩展、网络归属或服务质量验收。
 */
import {parseHTML} from 'linkedom';
import {describe, expect, it} from 'vitest';
import fixture from '@/scripts/site-translation/github-issue-metadata-fixture.json';
import {builtinSiteRulePack} from '@/src/core/site-adaptation/catalog';
import {compileSiteRulePack} from '@/src/core/site-adaptation/compiler';
import {TranslationCandidateCore} from '@/src/core/translation/engine';
import {applyTranslationsToSnapshot, createTranslationSourceSnapshot} from '@/src/core/translation/serialization';
import {extractTranslationTextFromNodes} from '@/src/core/translation/text';

const documentFor = (html = fixture.html): Document =>
    parseHTML(`<html><head></head><body>${html}</body></html>`).document as unknown as Document;

function node(document: Document, id: string): HTMLElement {
    const result = document.getElementById(id);
    if (!result) throw new Error(`Missing authored GitHub fixture node: ${id}`);
    return result;
}

const createCore = (url = fixture.url, generic = false) => new TranslationCandidateCore({
    url: new URL(url), adapters: generic ? [] : compileSiteRulePack(builtinSiteRulePack),
});

function sources(core: TranslationCandidateCore, root: Node): string {
    return core.discover(root).map(candidate => extractTranslationTextFromNodes(
        candidate.nodes ?? [candidate.element], core.shouldStayOriginal)).join('\n');
}

describe('GitHub 当前 issue 作者组件的精确保护', () => {
    it('重现通用候选中的作者泄漏，同时保护当前组件和旧版 header', () => {
        const document = documentFor();
        const generic = createCore(fixture.url, true);
        const core = createCore();
        const genericSource = sources(generic, document);
        const source = sources(core, document);
        for (const id of ['issue-author', 'comment-author', 'event-name', 'bot-name']) {
            expect(genericSource, id).toContain(node(document, id).textContent);
        }
        for (const id of fixture.protectedIds) {
            const author = node(document, id);
            expect(core.shouldStayOriginal(author), id).toBe(true);
            expect(core.shouldIgnoreMutation(author), id).toBe(true);
            expect(core.discover(author), id).toEqual([]);
            const resolved = core.resolve(author.firstChild);
            if (resolved) {
                // 图片等无文本后代可定位相邻事件正文，但不能把作者文字带入源文。
                expect(extractTranslationTextFromNodes(resolved.nodes ?? [resolved.element],
                    core.shouldStayOriginal), id).not.toContain(author.textContent);
            }
        }
        for (const id of ['comment-author', 'event-name', 'bot-name', 'legacy-author']) {
            expect(source, id).not.toContain(node(document, id).textContent);
        }
        // 同名正文提及仍可译，不能用全局字符串黑名单“解决”作者泄漏。
        expect(source).toContain('Fixture Issue Author');
    });

    it('保留所有正文拥有者、列表、引用以及兄弟评论正文', () => {
        const document = documentFor();
        const core = createCore();
        const candidates = core.discover(document);
        for (const id of fixture.bodyIds) {
            const body = node(document, id);
            expect(core.shouldStayOriginal(body), id).toBe(false);
            expect(core.shouldIgnoreMutation(body), id).toBe(false);
            expect(candidates.some(candidate => candidate.element === body), id).toBe(true);
            expect(core.resolve(body.firstChild)?.element, id).toBe(body);
        }
        expect(core.shouldIgnoreMutation(node(document, 'comment-item'))).toBe(false);
        expect(sources(core, document)).toContain(node(document, 'event-prose').textContent);
    });

    it('不保护 Markdown 内的同名 testid、根自身、普通作者提及和近似 class', () => {
        const document = documentFor();
        const core = createCore();
        const source = sources(core, document);
        for (const id of fixture.nearMissIds) {
            const readable = node(document, id);
            expect(core.shouldStayOriginal(readable), id).toBe(false);
            expect(core.shouldIgnoreMutation(readable), id).toBe(false);
            expect(source, id).toContain(readable.textContent);
        }
        expect(core.shouldStayOriginal(node(document, 'contaminated-header'))).toBe(false);
    });

    it.each([
        'https://example.test/example/project/issues/123',
        'https://github.com.evil.test/example/project/issues/123',
        'https://gitlab.com/example/project/-/issues/123',
    ])('同结构在其它 host 不启用 GitHub 保护：%s', (url) => {
        const document = documentFor();
        const core = createCore(url);
        for (const id of ['issue-author', 'comment-author', 'event-name', 'bot-name']) {
            const author = node(document, id);
            expect(core.shouldStayOriginal(author), id).toBe(false);
            expect(core.shouldIgnoreMutation(author), id).toBe(false);
            expect(sources(core, document), id).toContain(author.textContent);
        }
    });

    it('真实快照不给身份组件分配翻译槽，正文同名提及和完整链接仍送译', () => {
        const document = documentFor();
        const core = createCore();
        const root = node(document, 'issue-page');
        const original = root.outerHTML;
        const author = node(document, 'issue-author');
        const link = node(document, 'body-link');
        const code = node(document, 'body-code');
        for (const id of ['issue-author', 'comment-header', 'event-actor', 'bot-actor']) {
            const snapshot = createTranslationSourceSnapshot(node(document, id), core.shouldStayOriginal,
                undefined, undefined, core.shouldOmitFromTranslation);
            expect(snapshot.slots, id).toEqual([]);
        }
        const snapshot = createTranslationSourceSnapshot(root, core.shouldStayOriginal,
            undefined, undefined, core.shouldOmitFromTranslation);
        const requested = snapshot.slots.map(slot => slot.source).join('\n');
        for (const id of ['comment-author', 'event-name', 'bot-name', 'legacy-author']) {
            expect(requested, id).not.toContain(node(document, id).textContent);
        }
        expect(requested).toContain('Fixture Issue Author');
        expect(requested).toContain('This separate comment explains the expected behavior');
        expect(requested).toContain('an ordinary reading link');
        expect(requested).not.toContain(code.textContent);
        const translated = documentFor(applyTranslationsToSnapshot(snapshot,
            snapshot.slots.map((_slot, index) => `正文译文片段 ${index}`)));
        for (const id of ['issue-author', 'comment-author', 'event-name', 'bot-name', 'legacy-author']) {
            expect(node(translated, id).textContent, id).toBe(node(document, id).textContent);
        }
        expect(node(translated, 'body-link').getAttribute('href')).toBe(link.getAttribute('href'));
        expect(node(translated, 'body-mention').getAttribute('href')).toBe('/FixtureIssueAuthor');
        expect(node(translated, 'body-mention').textContent).not.toBe('Fixture Issue Author');
        expect(node(translated, 'body-code').textContent).toBe(code.textContent);
        expect(root.outerHTML).toBe(original);
        expect(node(document, 'issue-author')).toBe(author);
        expect(node(document, 'body-link')).toBe(link);
    });

    it('metadata 更新不入候选，动态新评论正文仍激活', () => {
        const document = documentFor();
        const core = createCore();
        const author = node(document, 'comment-author');
        author.textContent = 'A changed public comment author';
        expect(core.shouldStayOriginal(author)).toBe(true);
        expect(core.shouldIgnoreMutation(author)).toBe(true);
        expect(sources(core, document)).not.toContain(author.textContent);
        const added = documentFor(fixture.dynamicHtml).body.firstElementChild!;
        node(document, 'issue-timeline').appendChild(added);
        const dynamicAuthor = node(document, 'dynamic-author');
        const dynamicBody = node(document, 'dynamic-body');
        expect(core.shouldStayOriginal(dynamicAuthor)).toBe(true);
        expect(core.shouldIgnoreMutation(dynamicAuthor)).toBe(true);
        expect(core.discover(dynamicAuthor)).toEqual([]);
        expect(core.shouldIgnoreMutation(dynamicBody)).toBe(false);
        expect(core.discover(dynamicBody).map(candidate => candidate.element.id)).toEqual(['dynamic-body']);
        expect(sources(core, document)).toContain(dynamicBody.textContent);
        expect(sources(core, document)).not.toContain(dynamicAuthor.textContent);
    });

    it('同节点移入正文或失去语义标记后立即取消保护，重建后重新识别', () => {
        const document = documentFor();
        const core = createCore();
        const issueAuthor = node(document, 'issue-author');
        expect(core.shouldStayOriginal(issueAuthor)).toBe(true);
        issueAuthor.removeAttribute('data-testid');
        expect(core.shouldStayOriginal(issueAuthor)).toBe(false);
        expect(core.shouldIgnoreMutation(issueAuthor)).toBe(false);
        const commentHeader = node(document, 'comment-header');
        const commentAuthor = node(document, 'comment-author');
        expect(core.shouldStayOriginal(commentAuthor)).toBe(true);
        node(document, 'comment-body').appendChild(commentHeader);
        expect(core.shouldStayOriginal(commentHeader)).toBe(false);
        expect(core.shouldStayOriginal(commentAuthor)).toBe(false);
        expect(core.shouldIgnoreMutation(commentAuthor)).toBe(false);
        expect(sources(core, document)).toContain(commentAuthor.textContent);
        document.body.innerHTML = fixture.html;
        expect(node(document, 'issue-author')).not.toBe(issueAuthor);
        expect(core.shouldStayOriginal(node(document, 'issue-author'))).toBe(true);
        expect(core.shouldStayOriginal(node(document, 'comment-author'))).toBe(true);
        expect(core.resolve(node(document, 'comment-paragraph').firstChild)?.element)
            .toBe(node(document, 'comment-paragraph'));
    });

    it('header 一旦包含正文便失去整块保护，不缓存旧结构判断', () => {
        const document = documentFor();
        const core = createCore();
        const header = node(document, 'comment-header');
        const author = node(document, 'comment-author');
        expect(core.shouldStayOriginal(author)).toBe(true);
        const body = document.createElement('div');
        body.className = 'markdown-body';
        body.innerHTML = '<p id="new-inside-body">Newly inserted body prose cannot be swallowed by metadata protection.</p>';
        header.appendChild(body);
        expect(core.shouldStayOriginal(author)).toBe(false);
        expect(core.shouldIgnoreMutation(author)).toBe(false);
        expect(core.shouldStayOriginal(node(document, 'new-inside-body'))).toBe(false);
        expect(core.discover(body).map(candidate => candidate.element.id)).toEqual(['new-inside-body']);
        body.remove();
        expect(core.shouldStayOriginal(author)).toBe(true);
        expect(core.shouldIgnoreMutation(author)).toBe(true);
    });
});
