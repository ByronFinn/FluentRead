import {parseHTML} from 'linkedom';
import {installFilteredTreeWalker} from './helpers/filteredTreeWalker';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {getPageTranslationContext, resetPageTranslationContextCache} from '@/userscript/pageContext';

const filterConstants = {SHOW_ELEMENT: 1, SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2};

function usePage(html: string, url: string): Document {
    const {document, window} = parseHTML(html);
    installFilteredTreeWalker(document as unknown as Document);
    vi.stubGlobal('document', document);
    vi.stubGlobal('Node', window.Node);
    vi.stubGlobal('NodeFilter', filterConstants);
    vi.stubGlobal('location', {href: url});
    return document as unknown as Document;
}

describe('userscript bounded page context', () => {
    afterEach(() => {
        resetPageTranslationContextCache();
        vi.unstubAllGlobals();
    });

    it('skips hidden roots, forms, editors, navigation, and owned translation nodes', async () => {
        usePage(`<html><head><title>Article title</title><meta name="description" content="Safe description"></head>
            <body><main hidden><p>HIDDEN_SECRET</p></main><main>
                <nav>NAV_SECRET</nav><form><input value="INPUT_SECRET">FORM_SECRET</form>
                <div contenteditable="true">EDITOR_SECRET</div>
                <p>Readable article text</p>
                <span data-fr-translation-owned="true">TRANSLATION_SECRET</span>
            </main></body></html>`, 'https://example.test/article');

        const context = await getPageTranslationContext();
        expect(context).toContain('Page title: Article title');
        expect(context).toContain('Page description: Safe description');
        expect(context).toContain('Readable article text');
        expect(context).not.toMatch(/HIDDEN_SECRET|NAV_SECRET|INPUT_SECRET|FORM_SECRET|EDITOR_SECRET|TRANSLATION_SECRET/u);
    });

    it('refreshes bounded text when the SPA route changes', async () => {
        const document = usePage('<html><body><main><p>First article</p></main></body></html>', 'https://example.test/first');
        expect(await getPageTranslationContext()).toContain('First article');
        document.querySelector('p')!.textContent = 'Second article';
        expect(await getPageTranslationContext()).toContain('First article');
        globalThis.location.href = 'https://example.test/second';
        expect(await getPageTranslationContext()).toContain('Second article');
    });

    it.each(['whitespace', 'visible'] as const)('clips raw %s text before trimming within the capture budget', async kind => {
        const source = kind === 'whitespace' ? ' '.repeat(200_000) : 'Readable '.repeat(30_000);
        usePage(`<html><body><main><p>${source}</p><p>LATER_TEXT</p></main></body></html>`, 'https://example.test/raw-budget');
        const trim = String.prototype.trim;
        let largestInput = 0;
        const spy = vi.spyOn(String.prototype, 'trim').mockImplementation(function (this: string) {
            largestInput = Math.max(largestInput, this.length); return trim.call(this);
        });
        let context;
        try {context = await getPageTranslationContext();} finally {spy.mockRestore();}
        expect(largestInput).toBeLessThanOrEqual(6000);
        expect(context).not.toContain('LATER_TEXT');
        if (kind === 'whitespace') expect(context).toBe('');
        else expect(context).toContain('Readable');
    });

    it('charges whitespace across text nodes while leaving excluded large subtrees outside the raw budget', async () => {
        usePage(`<html><body><main><span>${' '.repeat(3500)}</span><span>${' '.repeat(3500)}</span><p>LATER_TEXT</p></main></body></html>`, 'https://example.test/whitespace-budget');
        expect(await getPageTranslationContext()).toBe('');
        resetPageTranslationContextCache();
        usePage(`<html><body><main><span hidden>${'x'.repeat(200_000)}</span><p>Safe article</p></main></body></html>`, 'https://example.test/excluded-budget');
        expect(await getPageTranslationContext()).toContain('Safe article');
    });

    it('uses body/html fallbacks without a prose root and handles excluded or missing document roots', async () => {
        const body = usePage('<html><body><p>Fallback body</p></body></html>', 'https://example.test/body');
        body.querySelector('p')!.appendChild(body.createTextNode(''));
        expect(await getPageTranslationContext()).toContain('Fallback body');
        resetPageTranslationContextCache();
        const html = usePage('<html><body><p>Fallback html</p></body></html>', 'https://example.test/html');
        Object.defineProperty(html, 'body', {value: null});
        expect(await getPageTranslationContext()).toContain('Fallback html');
        resetPageTranslationContextCache();
        usePage('<html><body hidden><p>PRIVATE</p></body></html>', 'https://example.test/hidden-body');
        expect(await getPageTranslationContext()).toBe('');
        resetPageTranslationContextCache();
        vi.stubGlobal('document', {title: '', querySelector: () => null, querySelectorAll: () => [], body: null, documentElement: null});
        expect(await getPageTranslationContext()).toBe('');
        vi.stubGlobal('document', undefined);
        expect(await getPageTranslationContext()).toBe('');
    });
});
