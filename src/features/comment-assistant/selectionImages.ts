/**
 * @file src/features/comment-assistant/selectionImages.ts
 * 文件职责：从已捕获的选区中收集可评论的图片源，并按注入的加载与编码依赖降采样为 data URL 列表。
 * 主要内容：克隆片段遍历、表情与图标过滤、去重限数、超时与取消控制、按比例缩放和编码失败跳过。
 * 模块边界：不直接创建 Image/Canvas（由 content/imageDeps 注入），不发网络请求、不调用模型、不读取配置。
 */
import {COMMENT_MAX_IMAGES} from '@/src/core/config/comment';

export interface SelectionImageLike {
    width: number;
    height: number;
    drawTo: (context: CanvasRenderingContext2D, width: number, height: number) => void;
}
export interface SelectionImageDeps {
    loadImage(src: string, signal: AbortSignal): Promise<SelectionImageLike>;
    encode: (image: SelectionImageLike, width: number, height: number) => string | null;
}

export interface CommentImageLimits {
    maxImages: number;
    maxSize: number;
    timeoutMs: number;
}
export const COMMENT_IMAGE_DEFAULTS: CommentImageLimits = {maxImages: COMMENT_MAX_IMAGES, maxSize: 1024, timeoutMs: 2500};

const EMOJI_SOURCE = /(?:emoji|twemoji|emojione)/iu;
const EMOJI_ALT = /\p{Emoji_Presentation}/u;
const EMOJI_MAX_PX = 72;

function isDecorativeEmoji(img: HTMLImageElement): boolean {
    const width = Number(img.getAttribute('width')) || img.width;
    const height = Number(img.getAttribute('height')) || img.height;
    if (width > 0 && height > 0 && width <= EMOJI_MAX_PX && height <= EMOJI_MAX_PX) return true;
    if (EMOJI_SOURCE.test(img.className) || EMOJI_SOURCE.test(img.getAttribute('src') || '')) return true;
    return EMOJI_ALT.test(img.getAttribute('alt') || '');
}

/** 只收集当前选区内的图片源，去重并按上限截断；表情图标不进入评论素材。 */
export function collectSelectionImageSources(fragment: DocumentFragment, maxImages: number): string[] {
    const sources: string[] = [];
    const seen = new Set<string>();
    for (const img of Array.from(fragment.querySelectorAll('img'))) {
        const src = img.currentSrc || img.src;
        if (!src || seen.has(src) || isDecorativeEmoji(img)) continue;
        seen.add(src);
        sources.push(src);
        if (sources.length >= maxImages) break;
    }
    return sources;
}

function withTimeout<T>(start: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, {once: true});
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const guarded = new Promise<T>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('图片加载超时')), {once: true});
    });
    // 内层信号同时承载外部取消与超时，让仍在下载的图片真正被中止。
    return Promise.race([start(controller.signal), guarded]).finally(() => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
    });
}

/** 选区 → data URL 列表；单图失败只跳过，取消时停止收集并返回已完成部分。 */
export async function captureCommentImages(
    range: Range, deps: SelectionImageDeps, limits: Partial<CommentImageLimits> = {}, signal: AbortSignal = new AbortController().signal,
): Promise<string[]> {
    const {maxImages, maxSize, timeoutMs} = {...COMMENT_IMAGE_DEFAULTS, ...limits};
    const sources = collectSelectionImageSources(range.cloneContents(), maxImages);
    const images: string[] = [];
    for (const src of sources) {
        if (signal.aborted) break;
        try {
            const image = await withTimeout(inner => deps.loadImage(src, inner), signal, timeoutMs);
            if (!image.width || !image.height) continue;
            const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
            const dataUrl = deps.encode(image, Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
            if (dataUrl) images.push(dataUrl);
        } catch {
            if (signal.aborted) break;
        }
    }
    return images;
}
