import {DOMParser, parseHTML} from 'linkedom';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {cloneTranslationElementInert} from '@/src/core/translation/inertClone';
import {applyTranslationsToSnapshot, createTranslationSourceSnapshot} from '@/src/core/translation/serialization';

function page(markup: string, base = 'https://example.org/article/') {
    return parseHTML(`<html><head><base href="${base}"></head><body>${markup}</body></html>`).document;
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('inert translation element snapshots', () => {
    it('keeps the source skeleton outside the live document while preserving ordered text slots', () => {
        const {document} = parseHTML('<html><head><base href="https://example.org/article/"></head><body><p>Read <a href="reference"><img src="https://example.org/icon.png" alt="">the reference</a><br>and its proof.</p></body></html>');
        const source = document.querySelector('p')!;
        const original = source.outerHTML;
        const originalChildren = [...source.childNodes];
        const snapshot = createTranslationSourceSnapshot(source);

        expect(snapshot.clone.ownerDocument).not.toBe(document);
        expect(snapshot.clone.isConnected).toBe(false);
        expect(snapshot.clone.outerHTML).toBe(original);
        expect(snapshot.slots.map(slot => slot.source)).toEqual(['Read', 'the reference', 'and its proof.']);
        expect(source.outerHTML).toBe(original);
        expect([...source.childNodes]).toEqual(originalChildren);
    });

    it('shallow-copies only the owner document and delegates the deep copy to importNode', () => {
        const document = page('<p>Read <img src="/icon.png">the reference.</p>');
        const source = document.querySelector('p')!;
        const shallowDocument = document.cloneNode(false) as Document;
        const shallow = vi.spyOn(document, 'cloneNode').mockReturnValue(shallowDocument);
        const imported = vi.spyOn(shallowDocument, 'importNode');

        const copy = cloneTranslationElementInert(source);

        expect(shallow.mock.calls).toEqual([[false]]);
        expect(imported.mock.calls).toEqual([[source, true]]);
        expect(copy.ownerDocument).toBe(shallowDocument);
        expect(copy.parentNode).toBeNull();
        expect(copy.isConnected).toBe(false);
        expect(shallowDocument.childNodes).toHaveLength(0);
        expect(shallowDocument.querySelector('img')).toBeNull();
        expect(copy.querySelector('base')).toBeNull();
    });

    it('reuses one inert document per owner but always imports a fresh current subtree', () => {
        const document = page('<p>First <a href="reference">reference</a></p>');
        const source = document.querySelector('p')!;
        const shallow = vi.spyOn(document, 'cloneNode');
        const first = cloneTranslationElementInert(source);
        source.firstChild!.nodeValue = 'Updated ';
        const second = cloneTranslationElementInert(source);

        expect(shallow.mock.calls).toEqual([[false]]);
        expect(second.ownerDocument).toBe(first.ownerDocument);
        expect(second).not.toBe(first);
        expect(second.textContent).toBe('Updated reference');
        expect(first.textContent).toBe('First reference');
        second.querySelector('a')!.textContent = 'translated';
        expect(source.textContent).toBe('Updated reference');
        expect(first.textContent).toBe('First reference');
    });

    it('can import only a shallow container without copying children or changing the source', () => {
        const document = page('<p class="source" data-key="a">Read <a href="reference"><img src="icon.png">reference</a></p>');
        const source = document.querySelector('p')!;
        const original = source.outerHTML;
        const children = [...source.childNodes];

        const copy = cloneTranslationElementInert(source, false);

        expect(copy.ownerDocument).not.toBe(document);
        expect(copy.outerHTML).toBe('<p class="source" data-key="a"></p>');
        expect(copy.childNodes).toHaveLength(0);
        expect(source.outerHTML).toBe(original);
        expect([...source.childNodes]).toEqual(children);
    });

    it('reuses the same inert owner document when an already copied element is copied again', () => {
        const document = page('<p>Read <a href="reference">reference</a></p>');
        const source = document.querySelector('p')!;
        const first = cloneTranslationElementInert(source);
        const inert = first.ownerDocument;
        const shallow = vi.spyOn(inert, 'cloneNode');

        const second = cloneTranslationElementInert(first);
        const third = cloneTranslationElementInert(second, false);

        expect(second.ownerDocument).toBe(inert);
        expect(third.ownerDocument).toBe(inert);
        expect(shallow).not.toHaveBeenCalled();
        expect(second).not.toBe(first);
        expect(second.outerHTML).toBe(source.outerHTML);
        expect(third.childNodes).toHaveLength(0);
        expect(source.outerHTML).toBe(first.outerHTML);
    });

    it('isolates different owner documents and ignores the global page document', () => {
        const firstDocument = page('<p>First source.</p>', 'https://first.example/');
        const secondDocument = page('<p>Second source.</p>', 'https://second.example/');
        const globalClone = vi.spyOn(firstDocument, 'cloneNode');
        vi.stubGlobal('document', firstDocument);

        const second = cloneTranslationElementInert(secondDocument.querySelector('p')!);
        expect(globalClone).not.toHaveBeenCalled();
        const first = cloneTranslationElementInert(firstDocument.querySelector('p')!);

        expect(first.ownerDocument).not.toBe(second.ownerDocument);
        expect(first.ownerDocument).not.toBe(firstDocument);
        expect(second.ownerDocument).not.toBe(secondDocument);
    });

    it('retains raw relative resource and link attributes across changes to the live page base', () => {
        const document = page('<p><a href="../reference?q=1#part">Read</a><img src="icons/icon.png" srcset="small.png 1x, large.png 2x"></p>');
        const source = document.querySelector('p')!;
        const before = source.outerHTML;
        const first = cloneTranslationElementInert(source);
        document.querySelector('base')!.setAttribute('href', 'https://example.org/changed/');
        const second = cloneTranslationElementInert(source);

        expect(second.ownerDocument).toBe(first.ownerDocument);
        expect(first.outerHTML).toBe(before);
        expect(second.querySelector('a')!.getAttribute('href')).toBe('../reference?q=1#part');
        expect(second.querySelector('img')!.getAttribute('src')).toBe('icons/icon.png');
        expect(second.querySelector('img')!.getAttribute('srcset')).toBe('small.png 1x, large.png 2x');
        expect(source.outerHTML).toBe(before);
        expect(second.ownerDocument.childNodes).toHaveLength(0);
        expect(second.querySelector('base')).toBeNull();
    });

    it('copies a detached source without reading its unavailable window-backed baseURI', () => {
        const document = page('<p>Read <a href="reference"><img src="icon.png">the reference.</a></p>');
        const source = document.querySelector('p')!;
        const original = source.outerHTML, children = [...source.childNodes];
        Object.defineProperty(document, 'defaultView', {configurable: true, value: null});
        const unavailableBase = vi.fn(() => {throw new Error('Source window is unavailable');});
        Object.defineProperty(source, 'baseURI', {configurable: true, get: unavailableBase});

        const first = cloneTranslationElementInert(source);
        document.querySelector('base')!.setAttribute('href', '../changed-base/');
        const second = cloneTranslationElementInert(source);

        expect(unavailableBase).not.toHaveBeenCalled();
        expect(first.ownerDocument).not.toBe(document);
        expect(first.ownerDocument).toBe(second.ownerDocument);
        expect(second.ownerDocument.childNodes).toHaveLength(0);
        expect(second.outerHTML).toBe(original);
        expect(second.querySelector('a')!.getAttribute('href')).toBe('reference');
        expect(second.querySelector('img')!.getAttribute('src')).toBe('icon.png');
        expect(source.outerHTML).toBe(original); expect([...source.childNodes]).toEqual(children);
    });

    it('does not inspect window or base information or create a base in a read-only snapshot document', () => {
        const document = page('<p><a href="reference">Read the reference.</a></p>');
        const source = document.querySelector('p')!;
        const unavailableMetadata = vi.fn(() => {throw new Error('Window and address metadata are unavailable');});
        Object.defineProperty(document, 'defaultView', {configurable: true, get: unavailableMetadata});
        Object.defineProperty(document, 'baseURI', {configurable: true, get: unavailableMetadata});
        Object.defineProperty(source, 'baseURI', {configurable: true, get: unavailableMetadata});
        const inert = document.cloneNode(false) as Document;
        vi.spyOn(document, 'cloneNode').mockReturnValue(inert);
        const createElement = vi.spyOn(inert, 'createElement');
        const first = cloneTranslationElementInert(source);
        document.querySelector('base')!.remove();

        const second = cloneTranslationElementInert(source);

        expect(second.ownerDocument).toBe(first.ownerDocument);
        expect(second.ownerDocument.childNodes).toHaveLength(0);
        expect(unavailableMetadata).not.toHaveBeenCalled();
        expect(createElement).not.toHaveBeenCalled();
        expect(second.outerHTML).toBe(source.outerHTML);
        expect(second.querySelector('a')!.getAttribute('href')).toBe('reference');
        expect(source.querySelector('a')!.getAttribute('href')).toBe('reference');
    });

    it('keeps HTML and SVG namespaces, qualified attributes and Text/BR ordering', () => {
        const document = page('<p>Before <br>after <svg xmlns="http://www.w3.org/2000/svg"><g><text>diagram label</text><use xlink:href="#symbol" xmlns:xlink="http://www.w3.org/1999/xlink"></use></g></svg> end.</p>');
        const source = document.querySelector('p')!;
        const copy = cloneTranslationElementInert(source);

        expect(copy.outerHTML).toBe(source.outerHTML);
        expect([...copy.childNodes].map(node => [node.nodeType, node.nodeName, node.textContent]))
            .toEqual([...source.childNodes].map(node => [node.nodeType, node.nodeName, node.textContent]));
        for (const element of [copy, ...copy.querySelectorAll('*')]) {
            expect(element.ownerDocument).toBe(copy.ownerDocument);
        }
        expect(copy.querySelector('svg')!.namespaceURI).toBe('http://www.w3.org/2000/svg');
        expect(copy.querySelector('g')!.namespaceURI).toBe('http://www.w3.org/2000/svg');
        expect(copy.querySelector('use')!.getAttribute('xlink:href')).toBe('#symbol');
        const sourceSvg = source.querySelector('svg')!;
        const copiedSvg: SVGElement = cloneTranslationElementInert(sourceSvg);
        expect(copiedSvg.namespaceURI).toBe(sourceSvg.namespaceURI);
        expect(copiedSvg.outerHTML).toBe(sourceSvg.outerHTML);
    });

    it('imports an XML source without HTML scaffolding, attribute rewrites or rejection', () => {
        const document = new DOMParser().parseFromString('<article xml:base="https://xml.example/base/"><p href="relative">XML source</p></article>', 'text/xml');
        const source = document.documentElement as unknown as Element;
        const inert = document.cloneNode(false) as Document;
        const shallow = vi.spyOn(document, 'cloneNode').mockReturnValue(inert);
        const created = vi.spyOn(inert, 'createElement');
        const original = source.outerHTML;

        const copy = cloneTranslationElementInert(source);
        const second = cloneTranslationElementInert(source);

        expect(copy.ownerDocument).toBe(inert);
        expect(second.ownerDocument).toBe(inert);
        expect(copy.ownerDocument).not.toBe(document);
        expect(copy.outerHTML).toBe(original);
        expect(copy.getAttribute('xml:base')).toBe('https://xml.example/base/');
        expect(copy.querySelector('p')!.getAttribute('href')).toBe('relative');
        expect(copy.textContent).toBe('XML source');
        expect(inert.childNodes).toHaveLength(0);
        expect(shallow.mock.calls).toEqual([[false]]);
        expect(created).not.toHaveBeenCalled();
        expect(source.outerHTML).toBe(original);
    });

    it('preserves a document-copy exception and retries preparation on the next call', () => {
        const document = page('<p>Retry source.</p>');
        const source = document.querySelector('p')!;
        const failure = new Error('Document copy rejected');
        const shallow = vi.spyOn(document, 'cloneNode').mockImplementationOnce(() => {throw failure;});

        expect(() => cloneTranslationElementInert(source)).toThrow(failure);
        expect(cloneTranslationElementInert(source).textContent).toBe('Retry source.');
        expect(shallow).toHaveBeenCalledTimes(2);
        expect(shallow.mock.calls).toEqual([[false], [false]]);
    });

    it('preserves import failure without falling back to a live-document element copy', () => {
        const document = page('<p>Import source.</p>');
        const source = document.querySelector('p')!;
        const inert = document.cloneNode(false) as Document;
        const shallow = vi.spyOn(document, 'cloneNode').mockReturnValue(inert);
        const failure = new Error('Import rejected');
        const imported = vi.spyOn(inert, 'importNode').mockImplementationOnce(() => {throw failure;});

        expect(() => cloneTranslationElementInert(source)).toThrow(failure);
        expect(source.textContent).toBe('Import source.');
        const copy = cloneTranslationElementInert(source);
        expect(copy.ownerDocument).toBe(inert);
        expect(imported).toHaveBeenCalledTimes(2);
        expect(shallow.mock.calls).toEqual([[false]]);
    });

    it('translates successive current snapshots while retaining original nodes and raw links', () => {
        const document = page('<p>Read <a href="reference"><img src="icon.png">the reference</a><br>and its proof.</p>');
        const source = document.querySelector('p')!;
        const original = source.outerHTML;
        const children = [...source.childNodes];

        for (let cycle = 0; cycle < 2; cycle += 1) {
            const snapshot = createTranslationSourceSnapshot(source);
            const html = applyTranslationsToSnapshot(snapshot, snapshot.slots.map(slot => `译:${slot.source}`));
            expect(html).toContain('译:Read');
            expect(html).toContain('href="reference"');
            expect(snapshot.clone.ownerDocument).not.toBe(document);
            expect(source.outerHTML).toBe(original);
            expect([...source.childNodes]).toEqual(children);
        }
    });
});
