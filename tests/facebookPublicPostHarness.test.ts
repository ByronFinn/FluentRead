/** 原生帖子测试边界：成功准备只授权本页原 Node，不使其它 dialog 或保护区失效。 */
import {createRequire} from 'node:module';
import {parseHTML} from 'linkedom';
import {afterEach, describe, expect, it, vi} from 'vitest';
import cases from './browser-translation-cases.json';

const require = createRequire(import.meta.url);
const {prepareFacebookPublicPost} = require('../scripts/site-translation/facebook-public-post-preparation.cjs');
const {normalizeCaseConfig, collectBaseCaseConfigErrors} = require('../scripts/site-translation/case-config.cjs');
const {authorizeFacebookReadingDialog, releaseFacebookReadingDialog, coverageEligibilityContext,
    waitForCoverageReady, resolveHoverTarget, installCoverageTracker, readCoverageReport, COVERAGE_TRACKER_KEY} =
    require('../scripts/run-site-translation-test.cjs');
const url = 'https://www.facebook.com/FixturePublisher/posts/native-public-story/123/';
const rules = [{name: 'body', selector: '#caption', kind: 'content', minInitial: 1, minSeen: 1,
    sourceIncludes: [], minTextLength: 0, trackDynamic: true}];

type FixtureWindow = Record<string, unknown> & {
    HTMLElement: {prototype: object};
    HTMLAnchorElement: unknown;
    Node: unknown;
};

function fixture() {
    const parsed = parseHTML(`<html><head><link rel="canonical" href="${url}"></head><body>
      <div id="post" role="dialog" aria-modal="true"><div role="article" aria-posinset="1">
        <a role="link" tabindex="0" aria-label="Published yesterday" href="https://www.facebook.com/FixturePublisher/posts/pfbidFixture">Yesterday</a>
        <div data-ad-preview="message" data-ad-comet-preview="message"><p id="caption">Complete public source remains readable.</p></div>
      </div></div></body></html>`);
    const document = parsed.document as unknown as Document;
    const window = parsed.window as unknown as FixtureWindow;
    Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', {configurable: true,
        value() {return {x: 10, y: 20, width: 400, height: 40};}});
    Object.defineProperty(document, 'createRange', {configurable: true, value: () => ({selectNodeContents() {},
        getClientRects: () => [{x: 20, y: 100, width: 200, height: 20}]})});
    Object.defineProperty(document, 'elementFromPoint', {configurable: true,
        value: () => document.querySelector('[data-ad-preview="message"]')});
    let observerCallback: ((records: unknown[]) => void) | undefined;
    class Observer {
        constructor(callback: (records: unknown[]) => void) {observerCallback = callback;}
        observe() {}
        disconnect() {}
    }
    const globals: Record<string, unknown> = {document, window, HTMLElement: window.HTMLElement,
        HTMLAnchorElement: window.HTMLAnchorElement, Node: window.Node,
        MutationObserver: Observer, NodeFilter: {SHOW_TEXT: 4}, location: new URL(url), innerWidth: 1280, innerHeight: 900,
        getComputedStyle: () => ({display: 'block', visibility: 'visible', opacity: '1'})};
    for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
    const handles: Array<{value: unknown; asElement: () => unknown; dispose: ReturnType<typeof vi.fn>}> = [];
    const unwrap = (value: any): any => {
        if (handles.includes(value)) return value.value;
        if (Array.isArray(value)) return value.map(unwrap);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, unwrap(child)]));
        return value;
    };
    const execute = (fn: Function, arg: unknown) => Function('return (' + fn.toString() + ');')()(unwrap(arg));
    const page = {
        url: () => url,
        evaluate: vi.fn(async (fn: Function, arg: unknown) => execute(fn, arg)),
        evaluateHandle: vi.fn(async (fn: Function, arg: unknown) => {
            const value = execute(fn, arg), handle = {value, asElement: () => value, dispose: vi.fn(async () => {})};
            handles.push(handle);return handle;
        }),
        waitForFunction: vi.fn(async (fn: Function, arg: unknown) => {
            if (!execute(fn, arg)) throw new Error('predicate remained false');
            return {dispose: async () => {}};
        }),
    };
    return {document, window, page, handles, mutate: (records: unknown[]) => observerCallback?.(records)};
}
afterEach(() => {vi.unstubAllGlobals();vi.restoreAllMocks();});

describe('Facebook case configuration', () => {
    const base = {url, requiredSelectors: ['#caption'], forbiddenSelectors: ['input'], interactionSelectors: ['a'],
        coverageRules: rules, modes: ['hover', 'full']};
    it('allows clean native comment additions only in the three observed metadata groups', () => {
        const configured = cases['facebook-nasa-public-post'];
        expect(configured.dynamicForbiddenSelectors).toEqual([
            '[role="article"][aria-posinset="1"] [role="article"][aria-label] span:has(+ div > span[dir="auto"][lang]):not(span[dir="auto"][lang] *)',
            '[role="article"][aria-posinset="1"] [role="article"][aria-label] ul[aria-hidden="false"] a[role="link"]',
            '[role="article"][aria-posinset="1"] [role="button"]',
        ]);
        for (const selector of configured.dynamicForbiddenSelectors) {
            expect(configured.forbiddenSelectors).toContain(selector);
            expect(configured.forbiddenMustExistSelectors).toContain(selector);
            expect(configured.optionalForbiddenSelectors).not.toContain(selector);
        }
        expect(configured).not.toHaveProperty('mutableForbiddenSelectors');
        expect(configured.coverageRules.map(rule => [rule.minInitial, rule.minSeen])).toEqual([[2, 2], [13, 13]]);
        expect(configured.hoverTargets).toHaveLength(15);
        expect(collectBaseCaseConfigErrors('facebook-nasa-public-post', configured)).toEqual([]);
    });
    it('only enables the reviewed preparation explicitly', () => {
        expect(normalizeCaseConfig('facebook', base)).not.toHaveProperty('prepareFacebookPublicPost');
        expect(normalizeCaseConfig('facebook', {...base, prepareFacebookPublicPost: true}).prepareFacebookPublicPost).toBe(true);
        expect(collectBaseCaseConfigErrors('facebook', {...base, prepareFacebookPublicPost: true})).toEqual([]);
    });
    it.each([false, null, 1, 'true', {}, []])('rejects an ambiguous opt-in: %j', value => {
        expect(() => normalizeCaseConfig('facebook', {...base, prepareFacebookPublicPost: value})).toThrow('prepareFacebookPublicPost');
    });
    it.each(['https://facebook.com/FixturePublisher/posts/123/', 'https://www.facebook.com/FixturePublisher/',
        'https://www.facebook.com.evil.test/FixturePublisher/posts/123/'])('rejects an unsupported configured URL: %s', value => {
        expect(collectBaseCaseConfigErrors('facebook', {...base, url: value, prepareFacebookPublicPost: true}))
            .toContain('facebook 的 prepareFacebookPublicPost 仅支持 https://www.facebook.com 的公开 posts URL');
    });
    it.each([{prepareClickText: 'Dismiss'}, {prepareDismissiblePromotion: {
        dialogSelector: '#promo', buttonSelector: 'button', contentSelector: '#caption'}}])('rejects a second native action: %j', value => {
        expect(collectBaseCaseConfigErrors('facebook', {...base, ...value, prepareFacebookPublicPost: true}))
            .toContain('facebook 的 prepareFacebookPublicPost 不得与其他推广关闭动作同时使用');
    });
});

describe('Facebook reading dialog identity', () => {
    it('keeps all dialog content excluded until native preparation succeeds, then covers and hovers the original post', async () => {
        const state = fixture();
        await expect(waitForCoverageReady(state.page, rules, 100)).rejects.toThrow('predicate remained false');
        const preparation = await prepareFacebookPublicPost(state.page, url, 1000);
        await authorizeFacebookReadingDialog(state.page, preparation);
        await waitForCoverageReady(state.page, rules, 100);
        await expect(resolveHoverTarget(state.page, {selector: '#caption', index: 0, sourceIncludes: []}, 100))
            .resolves.toMatchObject({rawIndex: 0, sourceText: 'Complete public source remains readable.'});
        expect(coverageEligibilityContext({}).readingPostDialog).toBeUndefined();
        await releaseFacebookReadingDialog(state.page);
        expect(state.handles[0].dispose).toHaveBeenCalledOnce();
        await expect(waitForCoverageReady(state.page, rules, 100)).rejects.toThrow();
    });

    it('rejects invented or cloned preparation receipts and duplicate scope binding', async () => {
        const state = fixture(), preparation = await prepareFacebookPublicPost(state.page, url, 1000);
        for (const forged of [{}, {...preparation}, JSON.parse(JSON.stringify(preparation))]) {
            await expect(authorizeFacebookReadingDialog(state.page, forged)).rejects.toThrow('successful native preparation');
        }
        expect(state.page.evaluateHandle).not.toHaveBeenCalled();
        await expect(authorizeFacebookReadingDialog({...state.page}, preparation)).rejects.toThrow('successful native preparation');
        await authorizeFacebookReadingDialog(state.page, preparation);
        await expect(authorizeFacebookReadingDialog(state.page, preparation)).rejects.toThrow('already bound');
        await releaseFacebookReadingDialog(state.page);
    });

    it('rejects a changed canonical before pinning the native identity', async () => {
        const state = fixture(), preparation = await prepareFacebookPublicPost(state.page, url, 1000);
        state.document.querySelector('link')!.setAttribute('href', 'https://www.facebook.com/other/posts/999/');
        await expect(authorizeFacebookReadingDialog(state.page, preparation)).rejects.toThrow('changed after native preparation');
        expect(coverageEligibilityContext(state.page).readingPostDialog).toBeUndefined();
    });

    it.each(['hidden', 'inert', 'aria-hidden'])('retains the %s guard on the original dialog itself', async attribute => {
        const state = fixture(), preparation = await prepareFacebookPublicPost(state.page, url, 1000);
        await authorizeFacebookReadingDialog(state.page, preparation);
        state.document.getElementById('post')!.setAttribute(attribute, attribute === 'aria-hidden' ? 'true' : '');
        await expect(waitForCoverageReady(state.page, rules, 100)).rejects.toThrow();
        await expect(resolveHoverTarget(state.page, {selector: '#caption', index: 0}, 100)).rejects.toThrow();
        await releaseFacebookReadingDialog(state.page);
    });

    it.each(['nested', 'replaced', 'outer', 'outside', 'replaced-plain', 'role-changed', 'modal-changed'])
    ('does not grant the original scope after %s', async variant => {
        const state = fixture(), preparation = await prepareFacebookPublicPost(state.page, url, 1000);
        await authorizeFacebookReadingDialog(state.page, preparation);
        const post = state.document.getElementById('post')!, caption = state.document.getElementById('caption')!;
        if (variant === 'replaced') post.replaceWith(post.cloneNode(true));
        else if (variant === 'replaced-plain') {
            const replacement = state.document.createElement('div');replacement.innerHTML = post.innerHTML;post.replaceWith(replacement);
        }
        else if (variant === 'outside') state.document.body.append(caption);
        else if (variant === 'role-changed') post.setAttribute('role', 'region');
        else if (variant === 'modal-changed') post.removeAttribute('aria-modal');
        else {
            const dialog = state.document.createElement('div');dialog.setAttribute('role', 'dialog');
            if (variant === 'outer') {post.replaceWith(dialog);dialog.append(post);}
            else {caption.replaceWith(dialog);dialog.append(caption);}
        }
        await expect(waitForCoverageReady(state.page, rules, 100)).rejects.toThrow();
        await expect(resolveHoverTarget(state.page, {selector: '#caption', index: 0}, 100)).rejects.toThrow();
        await releaseFacebookReadingDialog(state.page);
    });

    it('tracks native host mutations within the original dialog and still ignores protected descendants', async () => {
        const state = fixture(), preparation = await prepareFacebookPublicPost(state.page, url, 1000);
        await authorizeFacebookReadingDialog(state.page, preparation);
        await installCoverageTracker(state.page, rules);
        const baseline = await readCoverageReport(state.page);
        expect(baseline[0].seenCount).toBe(1);
        const tracker = (state.window as any)[COVERAGE_TRACKER_KEY];
        const initialMetrics = tracker.metrics();
        const caption = state.document.getElementById('caption')!;
        caption.firstChild!.textContent = 'A changed complete public source remains readable.';
        state.mutate([{type: 'characterData', target: caption.firstChild, addedNodes: [], removedNodes: []}]);
        await readCoverageReport(state.page);
        expect(tracker.metrics().hostMutationCount).toBe(initialMetrics.hostMutationCount + 1);
        const updatedMetrics = tracker.metrics();
        const code = state.document.createElement('code');caption.append(code);
        state.mutate([{type: 'characterData', target: code, addedNodes: [], removedNodes: []}]);
        await readCoverageReport(state.page);
        expect(tracker.metrics().hostMutationCount).toBe(updatedMetrics.hostMutationCount);
        expect(tracker.metrics().ignoredProtectedMutationCount).toBe(updatedMetrics.ignoredProtectedMutationCount + 1);
        tracker.stop();
        await releaseFacebookReadingDialog(state.page);
    });
});
