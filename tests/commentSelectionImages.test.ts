import {describe, expect, it, vi} from 'vitest';
import {captureCommentImages, collectSelectionImageSources, COMMENT_IMAGE_DEFAULTS} from '@/src/features/comment-assistant/selectionImages';
import type {SelectionImageDeps, SelectionImageLike} from '@/src/features/comment-assistant/selectionImages';

/** 项目测试基座为纯 node 环境（无 jsdom），这里用最小结构桩替代 img/fragment。 */
interface ImgStub { currentSrc: string; src: string; className: string; width: number; height: number; getAttribute(name: string): string | null; }
const img = (src: string, extra: {width?: number; height?: number; class?: string; alt?: string} = {}): ImgStub => ({
    currentSrc: src, src, className: extra.class ?? '', width: extra.width ?? 0, height: extra.height ?? 0,
    getAttribute: (name: string) => name === 'width' ? String(extra.width ?? '') : name === 'height' ? String(extra.height ?? '') : name === 'alt' ? extra.alt ?? '' : name === 'src' ? src : null,
});
const frag = (imgs: ImgStub[]) => ({querySelectorAll: (selector: string) => selector === 'img' ? imgs : []}) as unknown as DocumentFragment;
const rangeOf = (imgs: ImgStub[]) => ({cloneContents: () => frag(imgs)}) as unknown as Range;
const imageLike = (width: number, height: number): SelectionImageLike => ({width, height, drawTo: vi.fn()});

describe('selection image collection', () => {
    it('keeps content images, dedupes and applies the cap', () => {
        const imgs = [img('https://a/1.png'), img('https://a/1.png'), img('https://a/2.jpg'), img(''), img('https://a/3.jpg', {width: 300, height: 200})];
        expect(collectSelectionImageSources(frag(imgs), 2)).toEqual(['https://a/1.png', 'https://a/2.jpg']);
        expect(collectSelectionImageSources(frag(imgs), 9)).toEqual(['https://a/1.png', 'https://a/2.jpg', 'https://a/3.jpg']);
    });

    it('filters decorative emoji by size, class and alt', () => {
        expect(collectSelectionImageSources(frag([img('https://a/x.png', {width: 48, height: 48})]), 4)).toEqual([]);
        expect(collectSelectionImageSources(frag([img('https://a/x.png', {class: 'twemoji'})]), 4)).toEqual([]);
        expect(collectSelectionImageSources(frag([img('https://a/emoji-one.png')]), 4)).toEqual([]);
        expect(collectSelectionImageSources(frag([img('https://a/x.png', {alt: '🎉 庆祝'})]), 4)).toEqual([]);
        expect(collectSelectionImageSources(frag([img('https://a/x.png', {width: 0, height: 0})]), 4)).toEqual(['https://a/x.png']);
    });

    it('falls back to the src attribute when currentSrc and metadata are absent', () => {
        const bare = {currentSrc: '', src: 'https://a/bare.png', className: '', width: 0, height: 0, getAttribute: () => null} as unknown as ImgStub;
        expect(collectSelectionImageSources(frag([bare]), 4)).toEqual(['https://a/bare.png']);
    });
});

describe('selection image capture', () => {
    it('returns empty list without touching deps when the selection has no images', async () => {
        const deps: SelectionImageDeps = {loadImage: vi.fn(), encode: vi.fn()};
        expect(await captureCommentImages(rangeOf([]), deps)).toEqual([]);
        expect(deps.loadImage).not.toHaveBeenCalled();
    });

    it('downscales large images and skips zero-size or failed encodes', async () => {
        const encode = vi.fn()
            .mockReturnValueOnce('data:image/jpeg;base64,BIG')
            .mockReturnValueOnce(null);
        const deps: SelectionImageDeps = {
            loadImage: vi.fn()
                .mockResolvedValueOnce(imageLike(2048, 1024))
                .mockResolvedValueOnce(imageLike(0, 500))
                .mockResolvedValueOnce(imageLike(100, 100)),
            encode,
        };
        const images = await captureCommentImages(rangeOf([img('https://a/1.png'), img('https://a/2.png'), img('https://a/3.png')]), deps);
        expect(images).toEqual(['data:image/jpeg;base64,BIG']);
        expect(encode).toHaveBeenNthCalledWith(1, expect.anything(), 1024, 512);
        expect(encode).toHaveBeenCalledTimes(2);
    });

    it('continues past load failures but stops when cancelled', async () => {
        const deps: SelectionImageDeps = {
            loadImage: vi.fn()
                .mockRejectedValueOnce(new Error('broken'))
                .mockResolvedValueOnce(imageLike(10, 10)),
            encode: vi.fn().mockReturnValue('data:image/jpeg;base64,OK'),
        };
        const images = await captureCommentImages(rangeOf([img('https://a/1.png'), img('https://a/2.png')]), deps);
        expect(images).toEqual(['data:image/jpeg;base64,OK']);

        const aborted = new AbortController();
        aborted.abort();
        expect(await captureCommentImages(rangeOf([img('https://a/1.png')]), deps, {}, aborted.signal)).toEqual([]);
    });

    it('times out slow loads and breaks on abort during catch', async () => {
        vi.useFakeTimers();
        try {
            const deps: SelectionImageDeps = {loadImage: () => new Promise(() => { /* 永不 resolve */ }), encode: vi.fn()};
            const pending = captureCommentImages(rangeOf([img('https://a/1.png')]), deps, {timeoutMs: 100});
            await vi.advanceTimersByTimeAsync(120);
            expect(await pending).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
        const controller = new AbortController();
        const deps: SelectionImageDeps = {
            loadImage: () => { controller.abort(); return Promise.reject(new Error('cancelled by abort')); },
            encode: vi.fn(),
        };
        expect(await captureCommentImages(rangeOf([img('https://a/1.png')]), deps, {}, controller.signal)).toEqual([]);
    });

    it('exposes default limits', () => {
        expect(COMMENT_IMAGE_DEFAULTS).toEqual({maxImages: 4, maxSize: 1024, timeoutMs: 2500});
    });

    it('stops waiting when the caller aborts while a load is in flight', async () => {
        const controller = new AbortController();
        const deps: SelectionImageDeps = {loadImage: () => new Promise(() => { /* 永不 resolve */ }), encode: vi.fn()};
        const pending = captureCommentImages(rangeOf([img('https://a/1.png')]), deps, {timeoutMs: 10_000}, controller.signal);
        await Promise.resolve();
        controller.abort();
        expect(await pending).toEqual([]);
    });

    it('hands the loader a signal that the timeout aborts', async () => {
        vi.useFakeTimers();
        try {
            let seen: AbortSignal | undefined;
            const deps: SelectionImageDeps = {
                loadImage: (_src, signal) => { seen = signal; return new Promise(() => { /* 永不 resolve */ }); },
                encode: vi.fn(),
            };
            const pending = captureCommentImages(rangeOf([img('https://a/1.png')]), deps, {timeoutMs: 40});
            await vi.advanceTimersByTimeAsync(60);
            expect(await pending).toEqual([]);
            expect(seen?.aborted).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});
