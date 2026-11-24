/**
 * 常见站点规则的真实候选引擎回归：原创页面结构同时核对通用路径、正文拥有者、
 * 请求文本、原文保护和动态子树；不联网，不把合成 DOM 验证当作实站验收。
 */
import {parseHTML} from 'linkedom';
import {describe, expect, it} from 'vitest';
import {builtinSiteRulePack} from '@/src/core/site-adaptation/catalog';
import catalogFixtures from '@/scripts/site-translation/site-adaptation-fixtures.json';
import establishedFixtures from '@/scripts/site-translation/site-adaptation-established-fixtures.json';
import xDeployedFixture from '@/scripts/site-translation/x-deployed-author-fixture.json';
import {compileSiteRulePack, composeSiteAdapters} from '@/src/core/site-adaptation/compiler';
import {createDeclarativeAdapter} from '@/src/core/translation/adapters/declarative';
import {TranslationCandidateCore} from '@/src/core/translation/engine';
import {extractTranslationTextFromNodes} from '@/src/core/translation/text';
import {applyTranslationsToSnapshot, createTranslationSourceSnapshot} from '@/src/core/translation/serialization';
import type {TranslationCandidate} from '@/src/core/translation/types';

interface SiteFixture {
    id: string;
    url: string;
    html: string;
    required: string[];
    guarded: string[];
    genericLeak: string;
    dirtyId: string;
    dirtyOwner: string;
    dynamicHtml: string;
    dynamicId: string;
    excludedUrls: string[];
}

const fixtures: SiteFixture[] = [
    {
        id: 'bing-search',
        url: 'https://www.bing.com/search?q=example',
        html: `<main><ol id="b_results"><li class="b_algo">
            <h2 id="title"><a href="https://example.test/docs">Readable documentation for building reliable applications</a></h2>
            <div class="b_attribution" id="attribution"><span>Example Developer Documentation</span><cite>https://example.test/docs</cite></div>
            <div class="b_caption"><p id="body">This result explains a <em id="dirty">useful translation boundary</em>
                with <a id="reading-link" href="https://example.test/guide">an ordinary documentation link</a>.
                <code id="code">ORIGINAL_CODE</code></p></div>
            <div class="b_tpcn" id="metadata">Published by Example Documentation in the Developer Tools category</div>
            </li></ol><form id="editor"><input value="Original search query"></form></main>`,
        required: ['title', 'body'],
        guarded: ['attribution', 'metadata', 'code', 'editor'],
        genericLeak: 'Published by Example Documentation in the Developer Tools category',
        dirtyId: 'dirty',
        dirtyOwner: 'body',
        dynamicHtml: '<li class="b_algo"><h2 id="new-body"><a href="https://example.test/next">A newly added result explains another useful example</a></h2><div class="b_attribution">Example Documentation Source</div></li>',
        dynamicId: 'new-body',
        excludedUrls: ['https://www.bing.com/images/search?q=example', 'https://www.bing.com/maps', 'https://bing.com.evil.test/search?q=example', 'https://www.bing.com/searching'],
    },
    {
        id: 'steam-community-discussions',
        url: 'https://steamcommunity.com/app/570/discussions/0/12345/',
        html: `<main id="AppHubContent"><div class="forum_op">
            <div class="forum_op_header commentthread_comment_author" id="author"><a class="forum_op_author">Example User With A Long Display Name</a>
                <span class="date commentthread_comment_timestamp" id="date">Edited after the author submitted the discussion</span></div>
            <div class="topic" id="title">A readable discussion about improving a useful tool</div>
            <div class="content" id="forum_op_content_opening">The opening explains why this feature helps readers.
                <p id="body">This separate paragraph has <em id="dirty">important practical context</em>,
                    <a class="bb_link" id="reading-link" href="https://example.test/guide">an ordinary reading link</a>
                    and <code id="code">ORIGINAL_CODE</code>.</p>
                <div class="bb_code" id="raw-code">if (original_code) { keep_this_local(); }</div></div></div>
            <div class="commentthread_comment"><div class="commentthread_comment_author" id="comment-author">Another User With A Long Display Name</div>
                <span class="commentthread_comment_timestamp" id="timestamp">Today at ten past eleven</span>
                <div class="commentthread_comment_text" id="comment">The comment independently explains how the tool can be used.</div></div>
            <textarea id="editor">A private reply draft must stay original</textarea></main>`,
        required: ['title', 'forum_op_content_opening', 'body', 'comment'],
        guarded: ['author', 'date', 'comment-author', 'timestamp', 'code', 'raw-code', 'editor'],
        genericLeak: 'Example User With A Long Display Name',
        dirtyId: 'dirty',
        dirtyOwner: 'body',
        dynamicHtml: '<div class="commentthread_comment"><div class="commentthread_comment_author">New User With A Long Display Name</div><div class="commentthread_comment_text" id="new-body">A newly added comment explains another useful example.</div></div>',
        dynamicId: 'new-body',
        excludedUrls: ['https://steamcommunity.com/id/example/', 'https://steamcommunity.com/app/570/', 'https://steamcommunity.com/app/570/guides/', 'https://store.steampowered.com/app/570/', 'https://steamcommunity.com.evil.test/app/570/discussions/'],
    },
];

function documentFor(html: string): Document {
    return parseHTML(`<html><head></head><body>${html}</body></html>`).document as unknown as Document;
}

function node(document: Document, id: string): HTMLElement {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Missing fixture element: ${id}`);
    return element;
}

function coreFor(fixture: SiteFixture, generic = false): TranslationCandidateCore {
    return new TranslationCandidateCore({url: new URL(fixture.url),
        adapters: generic ? [] : compileSiteRulePack(builtinSiteRulePack)});
}

function sourceOf(core: TranslationCandidateCore, candidate: TranslationCandidate): string {
    return extractTranslationTextFromNodes(candidate.nodes ?? [candidate.element], core.shouldStayOriginal);
}

function sources(core: TranslationCandidateCore, root: Node): string[] {
    return core.discover(root).map(candidate => sourceOf(core, candidate));
}

interface CatalogShape {
    id: string;
    name?: string;
    url: string;
    html: string;
    required: string[];
    forbidden: string[];
    sourceAssertions?: {required: string[]; forbidden: string[]};
    dynamic?: {
        appendHtml?: {selector: string; html: string; required: string[]; forbidden?: string[]}[];
        inlineText?: {selector: string; owner: string; from: string; to: string}[];
        noiseSelector?: string;
    };
    variants?: Omit<CatalogShape, 'id' | 'variants'>[];
}

const youtubeSearch = establishedFixtures.find(fixture => fixture.id === 'youtube')!.variants![0]!;

describe('X 公开帖作者与相邻 handle 组件的实站结构边界', () => {
    const url = new URL(xDeployedFixture.url);
    const createCore = (generic = false, currentUrl = url) => new TranslationCandidateCore({url: currentUrl,
        adapters: generic ? [] : compileSiteRulePack(builtinSiteRulePack)});

    it('通用正文已经完整可读；规则仅阻止实际作者显示名进入候选', () => {
        const document = documentFor(xDeployedFixture.html);
        const generic = createCore(true);
        const genericSource = sources(generic, document).join('\n');
        const core = createCore();
        const source = sources(core, document).join('\n');
        for (const id of xDeployedFixture.authorIds) {
            const author = node(document, id);
            expect(genericSource, id).toContain(author.textContent);
            expect(source, id).not.toContain(author.textContent);
            expect(core.shouldStayOriginal(author), id).toBe(true);
            expect(core.discover(author), id).toEqual([]);
            expect(core.resolve(author.firstChild), id).toBeNull();
        }
        for (const id of xDeployedFixture.bodyIds) {
            const body = node(document, id);
            const candidate = core.discover(document).find(item => item.element === body)!;
            expect(candidate, id).toBeDefined();
            expect(candidate.kind, id).toBe('content');
            expect(candidate.reason, id).toBe('generic-readable-block');
            expect(candidate.adapterId, id).toBeUndefined();
            expect(core.resolve(body.firstChild)?.element, id).toBe(body);
        }
    });

    it('正文近似组件、引用、外链、协议相对链接和缺少 handle 的样式仍可译', () => {
        const document = documentFor(xDeployedFixture.html);
        const core = createCore();
        const source = sources(core, document).join('\n');
        for (const id of xDeployedFixture.nearMissIds) {
            const text = node(document, id);
            expect(core.shouldStayOriginal(text), id).toBe(false);
            expect(core.shouldIgnoreMutation(text), id).toBe(false);
            expect(source, id).toContain(text.textContent);
        }
        for (const currentUrl of [new URL('https://example.test/ExampleAgency/status/12345'),
            new URL('https://x.com.evil.test/ExampleAgency/status/12345')]) {
            const external = createCore(false, currentUrl);
            for (const id of xDeployedFixture.authorIds) expect(external.shouldStayOriginal(node(document, id)), id).toBe(false);
            expect(sources(external, document).join('\n')).toContain(node(document, 'author-primary').textContent);
        }
        expect(createCore(false, new URL('https://twitter.com/ExampleAgency/status/12345'))
            .shouldStayOriginal(node(document, 'author-primary'))).toBe(true);
    });

    it('快照只翻译正文槽，保护作者并保留正文链接和源 DOM', () => {
        const document = documentFor(xDeployedFixture.html);
        const core = createCore();
        const post = node(document, 'post');
        const original = post.outerHTML;
        const author = node(document, 'author-primary');
        const link = node(document, 'hashtag');
        const snapshot = createTranslationSourceSnapshot(post, core.shouldStayOriginal,
            undefined, undefined, core.shouldOmitFromTranslation);
        const requested = snapshot.slots.map(slot => slot.source).join('\n');
        expect(requested).not.toContain(author.textContent);
        expect(requested).not.toContain(node(document, 'author-quote').textContent);
        expect(requested).toContain('Readers can follow the complete explanation');
        expect(requested).toContain('#ExampleTopic');
        const translated = documentFor(applyTranslationsToSnapshot(snapshot,
            snapshot.slots.map((_slot, index) => `翻译正文片段 ${index}`)));
        expect(node(translated, 'author-primary').textContent).toBe(author.textContent);
        expect(node(translated, 'hashtag').getAttribute('href')).toBe(link.getAttribute('href'));
        expect(post.outerHTML).toBe(original);
        expect(node(document, 'author-primary')).toBe(author);
        expect(node(document, 'hashtag')).toBe(link);
    });

    it('仅作者显示名忽略 mutation，动态正文、组件失配和宿主恢复均使用当前节点', () => {
        const document = documentFor(xDeployedFixture.html);
        const core = createCore();
        const adapter = compileSiteRulePack(builtinSiteRulePack).find(item => item.id === 'x')!;
        // 关联相邻 handle 的复杂 selector 不能安全穷举属性；null 要求观察全部属性。
        expect(adapter.observedAttributes).toBeNull();
        const author = node(document, 'author-primary');
        expect(core.shouldIgnoreMutation(author)).toBe(true);
        expect(core.shouldIgnoreMutation(author.parentElement!)).toBe(false);
        expect(core.shouldIgnoreMutation(node(document, 'body-primary').firstElementChild!)).toBe(false);
        author.textContent = 'A changed public display name stays original';
        expect(sources(core, document).join('\n')).not.toContain(author.textContent);
        const added = documentFor(xDeployedFixture.dynamicHtml).body.firstElementChild!;
        document.querySelector('main')!.appendChild(added);
        expect(core.discover(node(document, 'author-dynamic'))).toEqual([]);
        expect(core.shouldIgnoreMutation(node(document, 'author-dynamic'))).toBe(true);
        expect(core.discover(node(document, 'body-dynamic')).map(item => item.element.id)).toEqual(['body-dynamic']);
        // 当前链接不再是站内 profile 时，旧的同节点保护结果不得继续生效。
        author.parentElement!.setAttribute('href', 'https://example.test/ordinary-reading');
        expect(core.shouldStayOriginal(author)).toBe(false);
        expect(core.shouldIgnoreMutation(author)).toBe(false);
        expect(sources(core, author).join('\n')).toContain(author.textContent);
        document.body.innerHTML = xDeployedFixture.html;
        expect(node(document, 'author-primary')).not.toBe(author);
        expect(core.shouldStayOriginal(node(document, 'author-primary'))).toBe(true);
        expect(sources(core, document).join('\n')).not.toContain('A changed public display name stays original');
        expect(core.resolve(node(document, 'body-primary').firstChild)?.element).toBe(node(document, 'body-primary'));
    });
});

describe('YouTube 实站搜索结构的正文与元数据边界', () => {
    const url = new URL(youtubeSearch.url);
    const createCore = (generic = false) => new TranslationCandidateCore({url,
        adapters: generic ? [] : compileSiteRulePack(builtinSiteRulePack)});

    it('通用路径能翻译标题，但会把频道名与播放信息送译；站点规则只收紧已观察的元数据', () => {
        const document = documentFor(youtubeSearch.html);
        const baseline = sources(createCore(true), document).join('\n');
        for (const text of ['Example Machine Learning Channel', 'Two million views', 'Example University Course Author']) {
            expect(baseline).toContain(text);
        }
        const core = createCore();
        const source = sources(core, document).join('\n');
        for (const text of youtubeSearch.sourceAssertions.required) expect(source).toContain(text);
        for (const text of youtubeSearch.sourceAssertions.forbidden) expect(source).not.toContain(text);
        for (const selector of youtubeSearch.forbidden) {
            const owner = one(document, selector);
            expect(core.discover(owner), selector).toEqual([]);
            expect(core.resolve(owner.firstChild ?? owner), selector).toBeNull();
        }
        // 课程元数据容器还包含可读课时标题，不能整块裁剪。
        expect(core.shouldStayOriginal(one(document, '#lesson-title'))).toBe(false);
    });

    it('标题和简介在全文与悬浮中保持同一拥有者，动态内容与原文快照仍可重建', () => {
        const document = documentFor(youtubeSearch.html);
        const core = createCore();
        const original = document.body.outerHTML;
        const verify = () => {
            const candidates = core.discover(document);
            for (const selector of youtubeSearch.required) {
                const owner = one(document, selector);
                const owned = candidates.filter(candidate => candidate.element === owner);
                expect(owned, selector).toHaveLength(1);
                expect(core.resolve(readableText(document, owner, core))?.element, selector).toBe(owner);
                const snapshot = createTranslationSourceSnapshot(owner, core.shouldStayOriginal,
                    undefined, undefined, core.shouldOmitFromTranslation);
                expect(snapshot.slots.length, selector).toBeGreaterThan(0);
                expect(applyTranslationsToSnapshot(snapshot, snapshot.slots.map(() => '翻译后的正文'))).toContain('翻译后的正文');
            }
        };
        verify();
        expect(document.body.outerHTML).toBe(original);
        node(document, 'search-inline').textContent = 'how newly updated translation models work';
        expect(sources(core, node(document, 'search-inline')).join('\n')).toContain('newly updated translation models');
        const replacement = documentFor(youtubeSearch.html);
        const card = node(replacement, 'video-card');
        card.querySelector('#channel-link')!.textContent = 'A dynamically replaced channel display name';
        node(document, 'video-card').replaceWith(card);
        verify();
        expect(sources(core, document).join('\n')).not.toContain('A dynamically replaced channel display name');
        const adapter = compileSiteRulePack(builtinSiteRulePack).find(item => item.id === 'youtube')!;
        expect(adapter.shouldIgnoreMutation?.(one(document, '#metadata-line span:first-child'), {url})).toBe(true);
        expect(adapter.shouldIgnoreMutation?.(one(document, '#channel-link'), {url})).toBe(true);
        expect(adapter.shouldIgnoreMutation?.(one(document, '#lesson-title'), {url})).toBe(false);
        expect(adapter.matches(new URL('https://www.youtube.com.evil.test/results'))).toBe(false);
    });
});

const expansionIds = ['bing-search', 'steam-community-discussions', 'google-news-home-headlines', 'github-gist', 'firefox-addons'];
const expansionShapes = (catalogFixtures as CatalogShape[])
    .filter(fixture => expansionIds.includes(fixture.id))
    .flatMap(fixture => [
        {...fixture, name: `${fixture.id}:primary`},
        ...(fixture.variants ?? []).map(variant => ({...variant, id: fixture.id, name: `${fixture.id}:${variant.name}`})),
    ]);

function fixtureCore(shape: CatalogShape, generic = false): TranslationCandidateCore {
    return new TranslationCandidateCore({url: new URL(shape.url),
        adapters: generic ? [] : compileSiteRulePack(builtinSiteRulePack)});
}

function one(document: Document, selector: string): HTMLElement {
    const matches = document.querySelectorAll(selector);
    expect(matches.length, selector).toBe(1);
    return matches[0] as HTMLElement;
}

function readableText(document: Document, owner: HTMLElement, core: TranslationCandidateCore): Text {
    const walker = document.createTreeWalker(owner, 4);
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
        if (current.textContent?.trim() && current.parentElement && !core.shouldStayOriginal(current.parentElement)) return current as Text;
    }
    throw new Error(`No readable fixture text in ${owner.id}`);
}

function assertCatalogBoundaries(shape: CatalogShape, document: Document, core: TranslationCandidateCore): void {
    const candidates = core.discover(document);
    for (const selector of shape.required) {
        const owner = one(document, selector);
        const owned = candidates.filter(candidate => candidate.element === owner);
        expect(owned, `${shape.name}: ${selector}`).toHaveLength(1);
        if (owned[0]?.reason === 'generic-inline-run') {
            const adapter = compileSiteRulePack(builtinSiteRulePack).find(item => item.id === shape.id)!;
            expect(adapter.decide(owner, {url: new URL(shape.url)})).toMatchObject({kind: 'force-target', target: owner, atomic: false});
            expect(owned[0].nodes?.length).toBeGreaterThan(0);
        } else expect(owned[0]?.adapterId).toBe(shape.id);
        expect(core.resolve(readableText(document, owner, core))?.element, `${shape.name}: hover ${selector}`).toBe(owner);
    }
    for (const selector of shape.forbidden) {
        const guard = one(document, selector);
        expect(candidates.some(candidate => guard === candidate.element || guard.contains(candidate.element)),
            `${shape.name}: ${selector}`).toBe(false);
        const hover = core.resolve(guard.firstChild ?? guard);
        if (hover) {
            // 行内代码/mention 可命中外层段落，自己的文字仍必须受保护并被排除。
            expect(core.shouldStayOriginal(guard), `${shape.name}: protected literal ${selector}`).toBe(true);
            expect(hover.element === guard || guard.contains(hover.element)).toBe(false);
            expect(sourceOf(core, hover), `${shape.name}: protected hover source ${selector}`).not.toContain(guard.textContent!.trim());
        }
    }
    const source = candidates.map(candidate => sourceOf(core, candidate)).join('\n').replace(/\s+/gu, ' ');
    for (const text of shape.sourceAssertions?.required ?? []) expect(source, shape.name).toContain(text);
    for (const text of shape.sourceAssertions?.forbidden ?? []) expect(source, shape.name).not.toContain(text);
}

describe('BBC 实站文章的署名与正文边界', () => {
    const shape: CatalogShape = {...catalogFixtures.find(fixture => fixture.id === 'bbc-news')!, name: 'bbc-news:observed-article'};
    const url = new URL(shape.url);

    it('实际 byline 与图片直接署名不会进入请求，标题、段落和真正图注仍共享候选语义', () => {
        const document = documentFor(shape.html);
        const baseline = fixtureCore(shape, true);
        const oldSource = sources(baseline, document).join('\n');
        expect(oldSource).toContain('Example Reporter With A Long Display Name');
        expect(oldSource).toContain('Example Photo Agency Via Image Library');
        const core = fixtureCore(shape);
        assertCatalogBoundaries(shape, document, core);
        expect(core.discover(node(document, 'outside'))).toHaveLength(1);
        const articleSource = extractTranslationTextFromNodes([node(document, 'article')], core.shouldStayOriginal);
        expect(articleSource).not.toContain('Example Reporter With A Long Display Name');
        expect(articleSource).not.toContain('Example Photo Agency Via Image Library');
        expect(articleSource).toContain('This photograph shows the public event');
        const original = node(document, 'figure').outerHTML;
        const snapshot = createTranslationSourceSnapshot(node(document, 'figure'), core.shouldStayOriginal,
            undefined, undefined, core.shouldOmitFromTranslation);
        expect(snapshot.slots.map(slot => slot.source).join(' ')).toContain('This photograph shows');
        expect(snapshot.slots.map(slot => slot.source).join(' ')).not.toContain('Example Photo Agency');
        const translated = documentFor(applyTranslationsToSnapshot(snapshot, snapshot.slots.map(() => '报道图片说明')));
        expect(node(translated, 'credit').textContent).toBe('Example Photo Agency Via Image Library');
        expect(node(translated, 'caption').textContent).toBe('报道图片说明');
        expect(node(document, 'figure').outerHTML).toBe(original);
    });

    it('动态署名受保护、追加图注仍能发现，作者文字出现在正文时保持可译', () => {
        const document = documentFor(shape.html);
        const core = fixtureCore(shape);
        const adapter = compileSiteRulePack(builtinSiteRulePack).find(item => item.id === shape.id)!;
        node(document, 'author').textContent = 'A Newly Assigned Reporter Name';
        expect(core.discover(node(document, 'author'))).toEqual([]);
        expect(adapter.shouldIgnoreMutation?.(node(document, 'author'), {url})).toBe(true);
        expect(adapter.shouldIgnoreMutation?.(node(document, 'credit'), {url})).toBe(true);
        expect(adapter.shouldIgnoreMutation?.(node(document, 'caption'), {url})).toBe(false);
        const operation = shape.dynamic!.appendHtml![0]!;
        const appended = documentFor(operation.html);
        while (appended.body.firstChild) node(document, 'article').appendChild(appended.body.firstChild);
        for (const selector of operation.required) {
            const owner = one(document, selector);
            expect(core.discover(owner).filter(candidate => candidate.element === owner)).toHaveLength(1);
            expect(core.resolve(readableText(document, owner, core))?.element).toBe(owner);
        }
        expect(core.discover(node(document, 'new-credit'))).toEqual([]);
        node(document, 'body2').textContent = 'The article quotes Example Reporter With A Long Display Name in ordinary reporting.';
        expect(sources(core, node(document, 'body2')).join(' ')).toContain('Example Reporter With A Long Display Name');
        expect(core.shouldStayOriginal(node(document, 'body2'))).toBe(false);
        document.body.innerHTML = shape.html;
        assertCatalogBoundaries(shape, document, core);
        expect(adapter.matches(new URL('https://www.bbc.com.evil.test/news/articles/example'))).toBe(false);
    });
});

describe('常见站点正文规则', () => {
    it('五条新增规则各有主页面，Steam 讨论串和 AMO 评论保留同一规则下的独立结构夹具', () => {
        expect(new Set(expansionShapes.map(shape => shape.id))).toEqual(new Set(expansionIds));
        expect(expansionShapes.map(shape => shape.name)).toContain('steam-community-discussions:thread');
        expect(expansionShapes.map(shape => shape.name)).toContain('firefox-addons:reviews');
        expect(expansionShapes).toHaveLength(7);
    });

    it.each(expansionShapes)('$name 与通用路径比较，正文粒度或元数据边界有明确改善', shape => {
        const document = documentFor(shape.html);
        const generic = fixtureCore(shape, true);
        const baseline = generic.discover(document);
        const baselineSource = baseline.map(candidate => sourceOf(generic, candidate)).join('\n');
        const missingOwners = shape.required.filter(selector => !baseline.some(candidate => candidate.element === one(document, selector)));
        const metadataLeaks = (shape.sourceAssertions?.forbidden ?? []).filter(text => baselineSource.includes(text));
        // 通用识别本来能读部分正文；规则的收益必须是具体边界或明确的独立拥有者。
        expect(baselineSource.trim().length).toBeGreaterThan(0);
        expect(missingOwners.length + metadataLeaks.length, `${shape.name}: no demonstrated gain over generic`).toBeGreaterThan(0);
        assertCatalogBoundaries(shape, document, fixtureCore(shape));
    });

    it.each(expansionShapes)('$name 的实际候选节点保留直接首段，代码和邻接 UI 不进入正文请求', shape => {
        const document = documentFor(shape.html);
        const original = document.body.outerHTML;
        const core = fixtureCore(shape);
        assertCatalogBoundaries(shape, document, core);
        expect(document.body.outerHTML).toBe(original);
    });

    it.each(expansionShapes)('$name 的新增正文、inline 修改与同页宿主重建不会复用旧节点', shape => {
        const document = documentFor(shape.html);
        const core = fixtureCore(shape);
        for (const operation of shape.dynamic?.inlineText ?? []) {
            const target = one(document, operation.selector);
            const originalText = [...target.childNodes].find(child => child.nodeType === 3 && child.textContent === operation.from) as Text | undefined;
            expect(originalText, `${shape.name}: actual original Text slot`).toBeDefined();
            expect(core.discover(target).map(candidate => candidate.element), shape.name).toEqual([one(document, operation.owner)]);
            originalText!.data = operation.to;
            expect(target.childNodes).toContain(originalText);
            expect(sources(core, target).join('\n')).toContain(operation.to);
            expect(sources(core, target).join('\n')).not.toContain(operation.from);
        }
        for (const operation of shape.dynamic?.appendHtml ?? []) {
            const parent = one(document, operation.selector);
            const appended = documentFor(operation.html);
            while (appended.body.firstChild) parent.appendChild(appended.body.firstChild);
            for (const selector of operation.required) {
                const target = one(document, selector);
                const candidates = core.discover(target);
                expect(candidates.filter(candidate => candidate.element === target), `${shape.name}: dynamic ${selector}`).toHaveLength(1);
                expect(sourceOf(core, candidates[0]!).trim().length).toBeGreaterThan(0);
            }
            for (const selector of operation.forbidden ?? []) expect(core.discover(one(document, selector)), selector).toEqual([]);
        }
        if (shape.dynamic?.noiseSelector) {
            const adapter = compileSiteRulePack(builtinSiteRulePack).find(item => item.id === shape.id)!;
            expect(adapter.shouldIgnoreMutation?.(one(document, shape.dynamic.noiseSelector), {url: new URL(shape.url)})).toBe(true);
        }
        const prior = one(document, shape.required[0]!);
        document.body.innerHTML = shape.html;
        expect(one(document, shape.required[0]!)).not.toBe(prior);
        assertCatalogBoundaries(shape, document, core);
        for (const operation of shape.dynamic?.inlineText ?? []) expect(sources(core, document).join('\n')).not.toContain(operation.to);
    });

    it.each([
        ['bing-search', ['https://www.bing.com/images/search?q=example', 'https://www.bing.com/maps', 'https://www.bing.com/searching']],
        ['steam-community-discussions', ['https://steamcommunity.com/id/example/', 'https://steamcommunity.com/app/570/', 'https://store.steampowered.com/app/570/discussions/']],
        ['google-news-home-headlines', ['https://news.google.com/search?q=example', 'https://news.google.com/topics/example', 'https://news.google.com/read/example']],
        ['github-gist', ['https://gist.github.com/example', 'https://gist.github.com/example/12345/edit', 'https://gist.github.com/settings/profile', 'https://github.com/example/12345']],
        ['firefox-addons', ['https://addons.mozilla.org/en-US/firefox/', 'https://addons.mozilla.org/en-US/developers/addon/example/edit', 'https://addons.mozilla.org/en-US/firefox/user/12345/']],
    ] as const)('%s 限定域名与页面类型，同 ID 用户规则整体替换原内容和保护边界', (id, excludedUrls) => {
        const shape = expansionShapes.find(item => item.id === id)!;
        const adapter = compileSiteRulePack(builtinSiteRulePack).find(item => item.id === id)!;
        expect(adapter.matches(new URL(shape.url))).toBe(true);
        for (const url of excludedUrls) expect(adapter.matches(new URL(url)), url).toBe(false);
        const deceptive = new URL(shape.url); deceptive.hostname += '.evil.test';
        expect(adapter.matches(deceptive)).toBe(false);
        const document = documentFor(`${shape.html}<p id="user-body">The user explicitly chose this independent readable paragraph.</p>`);
        const adapters = composeSiteAdapters(builtinSiteRulePack, {enabled: true, disabledRuleIds: [], custom: {version: 1, rules: [{
            id, name: 'Explicit user replacement', match: {hosts: [new URL(shape.url).hostname]},
            mode: 'focus', content: [{css: ['#user-body'], atomic: true}],
        }]}});
        expect(adapters.filter(item => item.id === id)).toHaveLength(1);
        const replaced = new TranslationCandidateCore({url: new URL(shape.url), adapters});
        expect(replaced.discover(document).map(candidate => candidate.element.id)).toEqual(['user-body']);
        for (const selector of shape.required) expect(replaced.resolve(one(document, selector).firstChild)).toBeNull();
    });

    it('Bing 摘要快照省略摘要按钮与日期，保留普通参考链接和代码原值', () => {
        const shape = expansionShapes.find(item => item.id === 'bing-search')!;
        const document = documentFor(shape.html);
        const core = fixtureCore(shape);
        const owner = one(document, '#body1');
        const original = owner.outerHTML;
        const reference = one(document, '#body1 a:not(.b_algoReadMore)');
        const snapshot = createTranslationSourceSnapshot(owner, core.shouldStayOriginal,
            undefined, undefined, core.shouldOmitFromTranslation);
        const slotText = snapshot.slots.map(slot => slot.source).join(' ');
        expect(slotText).toContain('Read additional context');
        expect(slotText).not.toContain('Summary action remains original');
        expect(slotText).not.toContain('2026-10-11');
        expect(slotText).not.toContain('KEEP_ORIGINAL_TOKEN');
        const translated = documentFor(applyTranslationsToSnapshot(snapshot, snapshot.slots.map((_slot, index) => `本地译文片段 ${index}`)));
        expect(translated.querySelector('#read-more')).toBeNull();
        expect(translated.querySelector('#date1')).toBeNull();
        expect(translated.querySelector('#protected')?.textContent).toBe('KEEP_ORIGINAL_TOKEN');
        expect(translated.querySelector('a')?.getAttribute('href')).toBe(reference.getAttribute('href'));
        expect(owner.outerHTML).toBe(original);
        expect(one(document, '#body1 a:not(.b_algoReadMore)')).toBe(reference);
    });

    it.each(fixtures)('$id 的通用路径已能发现可读正文，但尚未保护该站点元数据', fixture => {
        const document = documentFor(fixture.html);
        const core = coreFor(fixture, true);
        const text = sources(core, document).join('\n');
        expect(text).toContain(fixture.genericLeak);
        expect(core.shouldStayOriginal(node(document, fixture.guarded[0]!))).toBe(false);
        expect(core.discover(document).some(candidate =>
            candidate.element === node(document, fixture.dirtyOwner))).toBe(true);
    });

    it.each(fixtures)('$id 只请求正文并保留链接、代码、作者、时间和输入区', fixture => {
        const document = documentFor(fixture.html);
        const original = document.body.outerHTML;
        const core = coreFor(fixture);
        const candidates = core.discover(document);
        for (const id of fixture.required) {
            expect(candidates.filter(candidate => candidate.element === node(document, id)), id).toHaveLength(1);
        }
        const text = candidates.map(candidate => sourceOf(core, candidate)).join('\n');
        expect(text).not.toContain(fixture.genericLeak);
        expect(text).not.toContain('ORIGINAL_CODE');
        for (const id of fixture.guarded) {
            const protectedNode = node(document, id);
            expect(core.shouldStayOriginal(protectedNode), id).toBe(true);
            if (id !== 'code') expect(core.resolve(protectedNode.firstChild ?? protectedNode), id).toBeNull();
        }
        const link = node(document, 'reading-link');
        expect(core.shouldStayOriginal(link)).toBe(false);
        expect(core.resolve(link.firstChild)?.element).toBe(node(document, fixture.dirtyOwner));
        expect(link.getAttribute('href')).toBe('https://example.test/guide');
        expect(document.body.outerHTML).toBe(original);
    });

    it.each(fixtures)('$id 的 inline 脏子树归属原正文，新节点和宿主重建使用新 DOM', fixture => {
        const document = documentFor(fixture.html);
        const core = coreFor(fixture);
        const dirty = node(document, fixture.dirtyId);
        expect(core.discover(dirty).map(candidate => candidate.element.id)).toEqual([fixture.dirtyOwner]);
        dirty.textContent = 'Changed inline context from the current host document';
        expect(sources(core, dirty)).toHaveLength(1);
        expect(sources(core, dirty)[0]).toContain('Changed inline context');
        const container = fixture.id === 'bing-search' ? document.querySelector('#b_results')! : document.querySelector('main')!;
        const dynamicDocument = documentFor(fixture.dynamicHtml);
        container.appendChild(dynamicDocument.body.firstElementChild!);
        const added = node(document, fixture.dynamicId);
        expect(core.discover(added).map(candidate => candidate.element.id)).toEqual([fixture.dynamicId]);
        const oldOwner = node(document, fixture.dirtyOwner);
        document.body.innerHTML = fixture.html;
        expect(node(document, fixture.dirtyOwner)).not.toBe(oldOwner);
        expect(sources(core, document).join('\n')).not.toContain('Changed inline context');
        for (const id of fixture.required) expect(core.discover(document).filter(candidate => candidate.element === node(document, id)), id).toHaveLength(1);
    });

    it.each(fixtures)('$id 的正文快照只允许修改文字槽，代码和链接地址保持原值', fixture => {
        const document = documentFor(fixture.html);
        const core = coreFor(fixture);
        const owner = node(document, fixture.dirtyOwner);
        const original = owner.outerHTML;
        const link = node(document, 'reading-link');
        const code = node(document, 'code');
        const snapshot = createTranslationSourceSnapshot(owner, core.shouldStayOriginal,
            undefined, undefined, core.shouldOmitFromTranslation);
        expect(snapshot.slots.map(slot => slot.source).join(' ')).not.toContain('ORIGINAL_CODE');
        expect(snapshot.slots.map(slot => slot.source).join(' ')).toContain(link.textContent);
        const translated = documentFor(applyTranslationsToSnapshot(snapshot,
            snapshot.slots.map((_slot, index) => `本地译文片段 ${index}`)));
        expect(translated.querySelector('code')?.textContent).toBe('ORIGINAL_CODE');
        expect(translated.querySelector('a')?.getAttribute('href')).toBe('https://example.test/guide');
        expect(owner.outerHTML).toBe(original);
        expect(node(document, 'reading-link')).toBe(link);
        expect(node(document, 'code')).toBe(code);
    });

    it.each(fixtures)('$id 限定页面范围并允许用户整条同名规则替换', fixture => {
        const adapter = compileSiteRulePack(builtinSiteRulePack).find(item => item.id === fixture.id);
        expect(adapter, 'The production catalog must own this rule').toBeDefined();
        expect(adapter!.matches(new URL(fixture.url))).toBe(true);
        for (const url of fixture.excludedUrls) expect(adapter!.matches(new URL(url)), url).toBe(false);
        const document = documentFor(`${fixture.html}<p id="override-body">The user explicitly selected this independent paragraph.</p>`);
        const adapters = composeSiteAdapters(builtinSiteRulePack, {enabled: true, disabledRuleIds: [], custom: {version: 1, rules: [{
            id: fixture.id, name: 'Explicit user replacement', match: {hosts: [new URL(fixture.url).hostname]},
            mode: 'focus', content: [{css: ['#override-body'], atomic: true}],
        }]}});
        expect(adapters.filter(item => item.id === fixture.id)).toHaveLength(1);
        const overridden = new TranslationCandidateCore({url: new URL(fixture.url), adapters});
        expect(overridden.discover(document).map(candidate => candidate.element.id)).toEqual(['override-body']);
        expect(overridden.shouldStayOriginal(node(document, fixture.guarded[0]!))).toBe(false);
    });

    it('Steam 的空覆盖链接允许坐标命中下层标题，但输入区仍是顶层命中屏障', () => {
        const fixture = fixtures.find(item => item.id === 'steam-community-discussions')!;
        const document = documentFor(`<main id="AppHubContent"><div class="forum_topics"><div class="forum_topic" role="button" id="card">
            <a class="forum_topic_overlay" id="overlay" href="https://steamcommunity.com/app/570/discussions/0/12345/"></a>
            <div class="forum_topic_name" id="card-title">A readable topic behind the transparent card link</div>
            <div class="forum_topic_op">Example User With A Long Display Name</div>
            </div></div><textarea id="editor">A private search draft must stay original</textarea></main>`);
        const core = coreFor(fixture);
        const overlay = node(document, 'overlay');
        const title = node(document, 'card-title');
        const card = node(document, 'card');
        Object.defineProperty(document, 'elementsFromPoint', {configurable: true,
            value: () => [overlay, title, card]});
        expect(core.resolveAtPoint(document, 20, 30)?.element).toBe(title);
        Object.defineProperty(document, 'elementsFromPoint', {configurable: true,
            value: () => [node(document, 'editor'), overlay, title, card]});
        expect(core.resolveAtPoint(document, 20, 30)).toBeNull();
    });
});

describe('非原子专站正文的局部扫描根', () => {
    const url = new URL('https://reader.example.test/article');
    const adapter = () => createDeclarativeAdapter({id: 'owned-prose', hosts: ['reader.example.test'],
        genericCandidatePolicy: 'targets-only',
        targets: [{selector: '.paragraph, .owner', match: 'self', atomic: false, reason: 'owned-prose'}],
        keepOriginal: [{selector: '.mention', reason: 'keep-identity'}],
        prune: [{selector: '.private, nav', reason: 'keep-controls'}],
    });
    const core = () => new TranslationCandidateCore({url, adapters: [adapter()]});

    it('只提升到最近非原子语义拥有者，完整扫描和脏 inline 扫描各只请求正文一次', () => {
        const document = documentFor('<article class="owner" id="outer">An independent opening remains readable.<p class="paragraph" id="paragraph">This paragraph has <span><em id="dirty">readable inline context</em></span> and separate details.</p></article>');
        const candidateCore = core();
        const paragraph = node(document, 'paragraph');
        const dirty = node(document, 'dirty');
        expect(candidateCore.discover(dirty).map(candidate => candidate.element)).toEqual([paragraph]);
        expect(sources(candidateCore, dirty)).toEqual(['This paragraph has readable inline context and separate details.']);
        const all = candidateCore.discover(document);
        expect(all.filter(candidate => candidate.element === paragraph)).toHaveLength(1);
        expect(all.filter(candidate => candidate.element === node(document, 'outer'))).toHaveLength(1);
        expect(all.find(candidate => candidate.element === node(document, 'outer'))?.nodes?.map(child => child.textContent).join(''))
            .toBe('An independent opening remains readable.');
    });

    it('密集普通 inline 成员不成为父段落的独立候选屏障，悬浮仍覆盖完整正文', () => {
        const links = Array.from({length: 40}, (_value, index) => `<a href="https://example.test/${index}">readable reference ${index}</a>`).join(' and ');
        const document = documentFor(`<p class="paragraph" id="paragraph">This paragraph explains ${links} with useful context.</p>`);
        const declared = adapter();
        let decisions = 0;
        const candidateCore = new TranslationCandidateCore({url, adapters: [{...declared,
            decide(element, context) { decisions += 1; return declared.decide(element, context); }}]});
        const paragraph = node(document, 'paragraph');
        const discovered = candidateCore.discover(document);
        expect(discovered).toHaveLength(1);
        decisions = 0;
        const hovered = candidateCore.resolve(paragraph.firstChild)!;
        expect(hovered?.element).toBe(paragraph);
        expect(sourceOf(candidateCore, hovered)).toBe(sourceOf(candidateCore, discovered[0]!));
        expect(decisions).toBeLessThanOrEqual(5 * 40 + 20);
    });

    it.each([
        '<span id="dirty" translate="no">Private host text</span>',
        '<span id="dirty" contenteditable="true">Private host text</span>',
        '<span id="dirty" hidden>Private host text</span>',
        '<input id="dirty" value="Private host text">',
        '<code id="dirty">ORIGINAL_CODE</code>',
        '<a class="mention" id="dirty">Original User Identity</a>',
        '<div class="private"><span id="dirty">Original control metadata</span></div>',
        '<nav><span id="dirty">Original navigation metadata</span></nav>',
    ])('受保护局部节点不提升到外层正文：%s', html => {
        const document = documentFor(`<article class="owner">Readable surrounding prose remains available.${html}</article>`);
        expect(core().discover(node(document, 'dirty'))).toEqual([]);
    });

    it('自有目标的同页 fresh 扫描不记住移除的 class，生成器后续子节点读取当前规则', () => {
        const document = documentFor('<article class="owner" id="outer">A direct opening is independently readable.<div id="paragraph"><em id="dirty">A new readable paragraph after the host update.</em></div></article>');
        const candidateCore = core();
        const scan = candidateCore.discoverSteps(node(document, 'dirty'));
        expect(scan.next().value?.element).toBe(node(document, 'outer'));
        node(document, 'paragraph').className = 'paragraph';
        const candidates = [...scan].flatMap(step => step.candidate ? [step.candidate] : []);
        expect(candidates.filter(candidate => candidate.element === node(document, 'paragraph'))).toHaveLength(1);
        expect(sources(candidateCore, node(document, 'dirty'))).toEqual(['A new readable paragraph after the host update.']);
        node(document, 'paragraph').className = '';
        node(document, 'outer').className = '';
        expect(candidateCore.discover(node(document, 'dirty'))).toEqual([]);
    });

    it('普通通用路径、未匹配规则和全部节点范围沿用原扫描根', () => {
        const document = documentFor('<article class="owner" id="outer"><em id="dirty">Readable inline source from an ordinary document.</em></article>');
        const dirty = node(document, 'dirty');
        for (const candidateCore of [
            new TranslationCandidateCore({url}),
            new TranslationCandidateCore({url: new URL('https://other.example.test'), adapters: [adapter()]}),
            new TranslationCandidateCore({url, scope: 'all', adapters: [{...adapter(), allScopes: true}]}),
        ]) expect(candidateCore.discoverSteps(dirty).next().value?.element).toBe(dirty);
    });

    it('已有控件拥有者优先，正文提升不把控件的内层标签提到 article', () => {
        const document = documentFor('<article class="owner" id="outer"><button id="control"><span id="dirty">Readable action control label</span></button></article>');
        const candidateCore = new TranslationCandidateCore({url, adapters: [{...adapter(), genericCandidatePolicy: 'allow'}]});
        expect(candidateCore.discoverSteps(node(document, 'dirty')).next().value?.element).toBe(node(document, 'control'));
        expect(candidateCore.discoverSteps(node(document, 'control')).next().value?.element).toBe(node(document, 'control'));
    });

    it('从自有非原子容器内的 shadow 脏节点扫描时不穿越 ShadowRoot', () => {
        const document = documentFor('<article class="owner" id="outer"><div id="host"></div></article>');
        const shadow = node(document, 'host').attachShadow({mode: 'open'});
        shadow.innerHTML = '<span id="dirty">Readable shadow text remains inside its own tree.</span>';
        expect(core().discoverSteps(shadow.querySelector('#dirty')!).next().value?.element).toBe(shadow.querySelector('#dirty'));
    });

    it.each(['atomic', 'implicit-atomic', 'skip', 'redirect'] as const)('最近明确 %s 决策阻止继续提升到更远的正文祖先', kind => {
        const document = documentFor('<article class="owner" id="outer"><div id="near"><em id="dirty">Readable local source remains bounded.</em></div></article><p id="external">An external adapter target is separate.</p>');
        const nearest = node(document, 'near');
        const candidateCore = new TranslationCandidateCore({url, adapters: [{
            id: 'nearest-boundary', genericCandidatePolicy: 'targets-only', matches: () => true,
            decide(element) {
                if (element === nearest) {
                    if (kind === 'skip') return {kind: 'skip-self', reason: 'near-boundary'};
                    return {kind: 'force-target', reason: 'near-boundary',
                        ...(kind === 'redirect' ? {atomic: false, target: node(document, 'external')}
                            : kind === 'atomic' ? {atomic: true} : {})};
                }
                return element.classList.contains('owner')
                    ? {kind: 'force-target', atomic: false, reason: 'outer-owner'} : {kind: 'pass'};
            },
        }]});
        expect(candidateCore.discoverSteps(node(document, 'dirty')).next().value?.element).toBe(node(document, 'dirty'));
        expect(candidateCore.discover(node(document, 'dirty'))).toEqual([]);
    });

    it('省略 target 的非原子自有决策可提升，根节点自己的 skip 决策仍不会被祖先覆盖', () => {
        const document = documentFor('<article id="owner"><em id="dirty">Readable inline context in an explicitly admitted owner.</em></article>');
        const owner = node(document, 'owner');
        const custom = new TranslationCandidateCore({url, adapters: [{id: 'implicit-owner', matches: () => true,
            genericCandidatePolicy: 'targets-only', decide: element => element === owner
                ? {kind: 'force-target', atomic: false, reason: 'implicit-owner'} : {kind: 'pass'}}]});
        expect(custom.discover(node(document, 'dirty')).map(candidate => candidate.element)).toEqual([owner]);
        const skipped = new TranslationCandidateCore({url, adapters: [{id: 'skip-dirty', matches: () => true,
            genericCandidatePolicy: 'targets-only', decide: element => element === node(document, 'dirty')
                ? {kind: 'skip-self', reason: 'skip-local'} : element === owner
                    ? {kind: 'force-target', atomic: false, reason: 'implicit-owner'} : {kind: 'pass'}}]});
        expect(skipped.discover(node(document, 'dirty'))).toEqual([]);
    });

    it('无拥有者的深链由原硬守卫预算拒绝，不进行无界站点祖先查询', () => {
        const document = documentFor('<main id="root"></main>');
        let deepest = node(document, 'root');
        for (let index = 0; index < 550; index += 1) {
            const next = document.createElement('div'); deepest.appendChild(next); deepest = next;
        }
        deepest.textContent = 'Readable text beneath an adversarially deep ancestor chain.';
        let decisions = 0;
        const candidateCore = new TranslationCandidateCore({url, adapters: [{id: 'bounded-empty', matches: () => true,
            decide() { decisions += 1; return {kind: 'pass'}; }}]});
        expect(candidateCore.discover(deepest)).toEqual([]);
        expect(decisions).toBe(1);
    });
});
