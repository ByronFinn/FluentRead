import {describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {createTranslationSourceSnapshot} from '@/src/core/translation/serialization';
import {createInlineCodePacket, getInlineCodeClass, inlineCodeNodesAreAllowed} from '@/src/core/translation/inlineCodeProtocol';

function fixture(html = '<p>Use <code>fetch()</code> before <code>parse()</code> now.</p>') {
    const {document} = parseHTML(`<html><body>${html}</body></html>`);
    const style = {display: 'inline', visibility: 'visible', contentVisibility: 'visible', opacity: '1', whiteSpace: 'normal',
        fontFamily: 'Arial', position: 'static', overflow: 'visible', width: '20px', height: '20px', clip: 'auto', clipPath: 'none'};
    Object.defineProperty(document.defaultView, 'getComputedStyle', {configurable: true, value: () => style});
    const owner = document.querySelector('p') as unknown as HTMLElement;
    const snapshot = createTranslationSourceSnapshot(owner);
    return {document, owner, snapshot, style, packet: createInlineCodePacket(owner, snapshot, () => false)};
}

describe('inline code packet', () => {
    it('never includes the code, preserves whitespace and outputs text slots in skeleton order', () => {
        const {packet} = fixture();
        expect(packet).not.toBeNull();
        expect(packet!.source).not.toContain('fetch()');
        expect(packet!.source).not.toContain('parse()');
        const tokens = packet!.source.match(/__FRCODE_[a-f0-9]+_\d+__/gu)!;
        expect(tokens).toHaveLength(2);
        expect(packet!.decode(`使用 ${tokens[0]} 之前 ${tokens[1]} 现在。`)).toEqual(['使用', '之前', '现在。']);
        expect(packet!.decode(`使用 ${tokens[0]} <script>alert(1)</script> ${tokens[1]} 现在。`))
            .toEqual(['使用', '<script>alert(1)</script>', '现在。']);
    });

    it('rejects missing, reordered, duplicate, unknown, damaged markers and changed boundary whitespace', () => {
        const {packet} = fixture();
        const [a, b] = packet!.source.match(/__FRCODE_[a-f0-9]+_\d+__/gu)!;
        for (const result of [`使用 ${a} 现在。`, `使用 ${b} 之前 ${a} 现在。`,
            `使用 ${a} 之前 ${a} ${b} 现在。`, `使用 ${a} __FRCODE_unknown__ ${b} 现在。`,
            `使用 ${a}  ${b} 现在。`,
            `使用 ${a.replace('FRCODE', 'FRCOdE')} 之前 ${b} 现在。`, `使用${a}之前${b}现在。`]) {
            expect(packet!.decode(result), result).toBeNull();
        }
        expect(packet!.decode(null)).toBeNull();
    });

    it('rechecks production text protection after ancestor or presentation changes', () => {
        for (const change of [
            (f: ReturnType<typeof fixture>) => f.owner.classList.add('sr-only'),
            (f: ReturnType<typeof fixture>) => f.document.body.classList.add('visually-hidden'),
            (f: ReturnType<typeof fixture>) => { f.style.fontFamily = 'Material Icons'; },
            (f: ReturnType<typeof fixture>) => f.document.body.setAttribute('data-fr-translation-owned', 'true'),
            (f: ReturnType<typeof fixture>) => f.document.body.classList.add('immersive-translate-target-wrapper'),
            (f: ReturnType<typeof fixture>) => { f.style.position = 'absolute'; f.style.overflow = 'hidden';
                f.style.width = '1px'; f.style.height = '1px'; f.style.clipPath = 'inset(50%)'; },
        ]) {
            const f = fixture();
            expect(f.packet).not.toBeNull();
            change(f);
            expect(f.packet!.decode(f.packet!.source)).toBeNull();
        }
        const f = fixture();
        let protect = false;
        const packet = createInlineCodePacket(f.owner, f.snapshot, () => protect);
        expect(packet).not.toBeNull();
        protect = true;
        expect(packet!.decode(packet!.source)).toBeNull();
    });

    it('fails closed for stale source or snapshot identities, attributes, protection and visibility', () => {
        for (const change of [
            (f: ReturnType<typeof fixture>) => { f.owner.querySelector('code')!.textContent = 'different()'; },
            (f: ReturnType<typeof fixture>) => { const code = f.owner.querySelector('code')!; code.replaceWith(code.cloneNode(true)); },
            (f: ReturnType<typeof fixture>) => { f.owner.querySelector('code')!.setAttribute('class', 'changed'); },
            (f: ReturnType<typeof fixture>) => { f.style.display = 'none'; },
            (f: ReturnType<typeof fixture>) => { f.snapshot.clone.querySelector('code')!.firstChild!.replaceWith(f.document.createTextNode('fetch()')); },
        ]) {
            const f = fixture();
            expect(f.packet).not.toBeNull();
            change(f);
            expect(f.packet!.decode(f.packet!.source)).toBeNull();
        }
        const f = fixture();
        expect(createInlineCodePacket(f.owner, f.snapshot, () => true)).toBeNull();
    });

    it('rejects arbitrary structures, attributes and literal reserved markers', () => {
        for (const html of ['<p>Use <code class="x">fetch()</code> now.</p>',
            '<p>Use <code><b>fetch()</b></code> now.</p>', '<p>Use <code>a</code><code>b</code> now.</p>',
            '<p>Use <a href="/x">link</a> <code>a</code> now.</p>', '<p>Use __FRCODE_ literal <code>a</code> now.</p>',
            '<p>Use <code>a</code></p>', '<p>Use <code>a</code>   </p>']) {
            expect(fixture(html).packet, html).toBeNull();
        }
    });
});

describe('inline code packet whitespace and trusted loading node', () => {
    it.each(['zh-Hans', 'zh-Hant'])('allows omitted ASCII boundary spaces only for %s and keeps original slot boundaries', targetLanguage => {
        const f = fixture('<p>The variable <code>früh</code> is different from <code>Früh</code> because the language is case-sensitive.</p>');
        const packet = createInlineCodePacket(f.owner, f.snapshot, () => false, {targetLanguage})!;
        const [a, b] = packet.source.match(/__FRCODE_[a-f0-9]+_\d+__/gu)!;
        const changed = packet.decode(`变量${a}与${b}不同，因为语言区分大小写。`);
        expect(changed).toEqual(['变量', '与', '不同，因为语言区分大小写。']);
        // The existing serializer restores each source slot's original spaces.
        for (const [index, text] of changed!.entries()) f.snapshot.slots[index]!.node.nodeValue =
            `${f.snapshot.slots[index]!.prefix}${text}${f.snapshot.slots[index]!.suffix}`;
        expect(f.snapshot.clone.textContent).toBe('变量 früh 与 Früh 不同，因为语言区分大小写。');
    });

    it('allows original boundary spaces and punctuation with no changed positions', () => {
        const f = fixture('<p>Call <code>x()</code>, then <code>y()</code>!</p>');
        const packet = createInlineCodePacket(f.owner, f.snapshot, () => false, {targetLanguage: 'zh-Hans'})!;
        const [a, b] = packet.source.match(/__FRCODE_[a-f0-9]+_\d+__/gu)!;
        expect(packet.decode(`调用 ${a}，然后 ${b}！`)).toEqual(['调用', '，然后', '！']);
        // An added space where the original had no space would be lost on rendering.
        expect(packet.decode(`调用 ${a} ，然后 ${b}！`)).toBeNull();
        expect(packet.decode(`调用 ${a}，然后 ${b} ！`)).toBeNull();
    });

    it('fails closed for non-Chinese, source or result complex whitespace, and non-normal white-space', () => {
        const f = fixture();
        const english = createInlineCodePacket(f.owner, f.snapshot, () => false, {targetLanguage: 'en'})!;
        const zh = createInlineCodePacket(f.owner, f.snapshot, () => false, {targetLanguage: 'zh-Hans'})!;
        const [a, b] = zh.source.match(/__FRCODE_[a-f0-9]+_\d+__/gu)!;
        expect(english.decode(`使用${a}之前${b}现在。`)).toBeNull();
        expect(zh.decode(`使用${a}  之前${b}现在。`)).toBeNull();
        expect(zh.decode(`使用${a}之前  ${b}现在。`)).toBeNull();
        for (const v of [`使用\n${a}之前${b}现在。`, `使用\u00a0${a}之前${b}现在。`, `使用\u200b${a}之前${b}现在。`]) expect(zh.decode(v)).toBeNull();
        f.style.whiteSpace = 'pre-wrap';
        expect(zh.decode(`使用 ${a} 之前 ${b} 现在。`)).toBeNull();
        expect(createInlineCodePacket(f.owner, f.snapshot, () => false, {targetLanguage: 'zh-Hans'})).toBeNull();
        for (const text of ['Use\n', 'Use\u00a0', 'Use\u200b']) {
            const altered = fixture(`<p>${text}<code>a</code> now.</p>`);
            expect(createInlineCodePacket(altered.owner, altered.snapshot, () => false, {targetLanguage: 'zh-Hans'})).toBeNull();
        }
    });

    it('ignores only the exact loading node owned by the caller, including removal and replacement', () => {
        const f = fixture();
        let spinner: Element | undefined;
        const packet = createInlineCodePacket(f.owner, f.snapshot, () => false, {getIgnoredArtifact: () => spinner})!;
        const response = packet.source;
        spinner = f.document.createElement('span');
        spinner.setAttribute('data-fr-translation-owned', 'true');
        f.owner.append(spinner);
        expect(packet.decode(response)).not.toBeNull();
        const fake = f.document.createElement('span');
        fake.setAttribute('data-fr-translation-owned', 'true');
        f.owner.append(fake);
        expect(packet.decode(response)).toBeNull();
        fake.remove();
        spinner.remove();
        expect(packet.decode(response)).not.toBeNull();
        f.owner.append(spinner);
        const replacement = spinner.cloneNode(true) as Element;
        spinner.replaceWith(replacement);
        expect(packet.decode(response)).toBeNull();
        spinner = replacement;
        expect(packet.decode(response)).not.toBeNull();
        spinner = f.owner.querySelector('code')!;
        expect(packet.decode(response)).toBeNull();
    });
});

describe('real MDN adaptation policy', () => {
    it('accepts the observed MDN paragraph when its code is protected by the site rules', async () => {
        const {createTranslationCore} = await import('./helpers/translationCore');
        const f = fixture('<main role="main"><p>But, the variable <code>früh</code> is not the same as <code>Früh</code> because JavaScript is case sensitive.</p></main>');
        const core = createTranslationCore({url: new URL('https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Grammar_and_types')});
        const code = f.owner.querySelector('code')!;
        expect(core.shouldStayOriginal(code)).toBe(true);
        expect(core.shouldStayOriginal(f.owner)).toBe(false);
        const snapshot = createTranslationSourceSnapshot(f.owner, core.shouldStayOriginal, undefined, undefined, core.shouldOmitFromTranslation);
        const packet = createInlineCodePacket(f.owner, snapshot, core.shouldStayOriginal, {targetLanguage: 'zh-Hans'});
        expect(packet).not.toBeNull();
        expect(packet!.source).not.toContain('früh');
        expect(packet!.source).not.toContain('Früh');
        expect(packet!.codeTexts).toEqual(['früh', 'Früh']);
        const [a, b] = packet!.markers;
        expect(packet!.decode(`但是变量${a}与${b}不同，因为 JavaScript 区分大小写。`))
            .toEqual(['但是变量', '与', '不同，因为 JavaScript 区分大小写。']);
    });
});

describe('GitHub comments with protected inline code', () => {
    it('accepts the observed text/code structure inside noninteractive list semantics and preserves only local code', async () => {
        const {createTranslationCore} = await import('./helpers/translationCore');
        const f = fixture('<main><ol role="list"><li role="listitem"><div class="markdown-body"><p dir="auto">The <code class="notranslate">gen(val)</code> will only execute when you iterate.</p></div></li></ol></main>');
        const core = createTranslationCore({url: new URL('https://github.com/vuejs/core/issues/1000')});
        const code = f.owner.querySelector('code')!;
        const snapshot = createTranslationSourceSnapshot(f.owner, core.shouldStayOriginal, undefined, undefined, core.shouldOmitFromTranslation);
        const packet = createInlineCodePacket(f.owner, snapshot, core.shouldStayOriginal, {targetLanguage: 'zh-Hans'});
        expect(packet).not.toBeNull();
        expect(packet!.codeClasses).toEqual(['notranslate']);
        expect(packet!.source).not.toContain('gen(val)');
        expect(packet!.decode(`该 ${packet!.markers[0]} 仅在迭代时执行。`)).toEqual(['该', '仅在迭代时执行。']);
        expect(code.outerHTML).toBe('<code class="notranslate">gen(val)</code>');
        expect(snapshot.clone.querySelector('code')?.outerHTML).toBe(code.outerHTML);
    });

    it('freezes the exact allowed class state on live code and clone', () => {
        const f = fixture('<p>Use <code class="notranslate">fetch()</code> before <code>parse()</code> now.</p>');
        expect(f.packet?.codeClasses).toEqual(['notranslate', null]);
        expect(Object.isFrozen(f.packet!.codeClasses)).toBe(true);
        const first = f.owner.querySelector('code')!;
        first.removeAttribute('class');
        expect(f.packet!.isCurrent()).toBe(false);
        first.setAttribute('class', 'notranslate');
        expect(f.packet!.isCurrent()).toBe(true);
        first.setAttribute('title', 'changed');
        expect(f.packet!.isCurrent()).toBe(false);
        first.removeAttribute('title');
        f.snapshot.clone.querySelector('code')!.removeAttribute('class');
        expect(f.packet!.isCurrent()).toBe(false);
        expect(f.packet!.source).not.toContain('fetch()');
    });

    it('rejects additional, alternate and malformed attributes and interactive list ancestors', () => {
        for (const html of [
            '<p>Use <code class="notranslate extra">fetch()</code> now.</p>',
            '<p>Use <code class="NOTRANSLATE">fetch()</code> now.</p>',
            '<p>Use <code class="notranslate" onclick="danger()">fetch()</code> now.</p>',
            '<p>Use <code translate="no">fetch()</code> now.</p>',
            '<ol role="list" tabindex="0"><li><p>Use <code class="notranslate">fetch()</code> now.</p></li></ol>',
            '<ol role="listbox"><li><p>Use <code class="notranslate">fetch()</code> now.</p></li></ol>',
            '<ol role="list"><li contenteditable="true"><p>Use <code class="notranslate">fetch()</code> now.</p></li></ol>',
        ]) expect(fixture(html).packet, html).toBeNull();
        const f = fixture();
        expect(getInlineCodeClass(f.owner)).toBeUndefined();
        // linkedom normalizes class whitespace; inspect a native-shaped attribute directly.
        expect(getInlineCodeClass({localName: 'code', attributes: [{name: 'class', namespaceURI: null, value: ' notranslate'}]} as unknown as Element)).toBeUndefined();
        expect(getInlineCodeClass(f.owner.querySelector('code')!)).toBeNull();
        const code = f.owner.querySelector('code')!;
        code.setAttribute('class', 'notranslate');
        expect(getInlineCodeClass(code)).toBe('notranslate');
        code.setAttribute('style', 'display:none');
        expect(getInlineCodeClass(code)).toBeUndefined();
    });
});

describe('inline code packet defensive boundaries', () => {
    it('共享解析器拒绝来源时不创建整句试探包', async () => {
        const f = fixture();
        vi.resetModules();
        vi.doMock('@/src/core/translation/inlineCodeMarkers', async importOriginal => ({
            ...await importOriginal<typeof import('@/src/core/translation/inlineCodeMarkers')>(),
            parseInlineCodeSource: () => null,
        }));
        try {
            const {createInlineCodePacket: create} = await import('@/src/core/translation/inlineCodeProtocol');
            expect(create(f.owner, f.snapshot, () => false)).toBeNull();
        } finally {
            vi.doUnmock('@/src/core/translation/inlineCodeMarkers');
            vi.resetModules();
        }
    });
    it('fails closed when the live view is absent, computed style is unavailable or throws', () => {
        const disconnected = fixture();
        disconnected.owner.remove();
        expect(createInlineCodePacket(disconnected.owner, disconnected.snapshot, () => false)).toBeNull();
        const missing = fixture();
        Object.defineProperty(missing.document.defaultView, 'getComputedStyle', {configurable: true, value: undefined});
        expect(createInlineCodePacket(missing.owner, missing.snapshot, () => false)).toBeNull();
        const thrown = fixture();
        Object.defineProperty(thrown.document.defaultView, 'getComputedStyle', {configurable: true, value: () => { throw new Error('unavailable'); }});
        expect(createInlineCodePacket(thrown.owner, thrown.snapshot, () => false)).toBeNull();
    });

    it('rejects code visibility changes and a code node becoming a foreign translation boundary', () => {
        const f = fixture();
        const code = f.owner.querySelector('code')!;
        code.classList.add('immersive-translate-target-wrapper');
        expect(f.packet!.isCurrent()).toBe(false);
        expect(inlineCodeNodesAreAllowed(f.owner, [], [code], () => false, {})).toBe(false);
        const hidden = fixture();
        const code2 = hidden.owner.querySelector('code')!;
        Object.defineProperty(hidden.document.defaultView, 'getComputedStyle', {configurable: true, value: (el: Element) =>
            el === code2 ? {...hidden.style, contentVisibility: 'hidden'} : hidden.style});
        expect(hidden.packet!.isCurrent()).toBe(false);
    });

    it('checks noninteractive ancestors, opacity, and explicit input option boundaries', async () => {
        const {inlineCodeNodesAreAllowed} = await import('@/src/core/translation/inlineCodeProtocol');
        for (const attr of ['contenteditable', 'tabindex', 'role', 'translate']) {
            const f = fixture();
            f.owner.setAttribute(attr, attr === 'role' ? 'button' : attr === 'translate' ? 'no' : '');
            expect(inlineCodeNodesAreAllowed(f.owner, [], [], () => false, {}), attr).toBe(false);
        }
        const f = fixture();
        f.style.opacity = '0';
        expect(inlineCodeNodesAreAllowed(f.owner, [], [], () => false, {})).toBe(false);
        expect(createInlineCodePacket(f.owner, f.snapshot, () => false, {protectionOptions: {includeInlineCodeForLanguage: true}})).toBeNull();
        expect(createInlineCodePacket(f.owner, f.snapshot, null as never)).toBeNull();
        expect(createInlineCodePacket(null as never, f.snapshot, () => false)).toBeNull();
        expect(createInlineCodePacket(f.owner, null as never, () => false)).toBeNull();
    });

    it('rejects corrupted snapshot slots, structural changes, untrusted artifact callbacks and unknown tail markers', () => {
        const altered = fixture();
        altered.snapshot.slots[0]!.source = 'different';
        expect(createInlineCodePacket(altered.owner, altered.snapshot, () => false)).toBeNull();
        const changedType = fixture();
        changedType.owner.querySelector('code')!.replaceWith(changedType.document.createTextNode('code'));
        expect(createInlineCodePacket(changedType.owner, changedType.snapshot, () => false)).toBeNull();
        const failing = fixture();
        const packet = createInlineCodePacket(failing.owner, failing.snapshot, () => false, {getIgnoredArtifact: () => { throw new Error('unavailable'); }})!;
        expect(packet.isCurrent()).toBe(false);
        const f = fixture();
        expect(f.packet!.decode(`${f.packet!.source}__FRCODE_rogue__`)).toBeNull();
    });
});
