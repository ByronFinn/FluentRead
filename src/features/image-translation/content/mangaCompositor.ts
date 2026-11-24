/**
 * @file src/features/image-translation/content/mangaCompositor.ts
 * 文件职责：将漫画的局部无损图块直接合成到原始图片或已捕获的可读画布，省去整页 PNG 编码与再解码。
 * 主要内容：整页绘制与解码共用十五秒预算，逐块解码、核对尺寸，以完整最终图块替换对应原像素，避免透明图块叠加旧字形或重复累积 alpha，及时关闭位图；取消、超时或解码失败释放画布，迟到的位图仍关闭；完成前保留宿主原图可读。
 * 模块边界：只操作调用方图片和压缩结果，不访问模型、翻译服务、缓存或宿主样式。
 */
import type {MangaCompressedPage} from '../mangaPatchResult';
export async function composeMangaPage(source: HTMLImageElement | HTMLCanvasElement, page: MangaCompressedPage, signal: AbortSignal): Promise<HTMLCanvasElement> {
    const deadline = performance.now() + 15_000;
    const canvas = document.createElement('canvas');
    const check = () => {
        if (signal.aborted) throw new DOMException('图片翻译已取消', 'AbortError');
        if (performance.now() >= deadline) throw new Error('译图加载超时');
    };
    try {
        check(); canvas.width = page.width; canvas.height = page.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('浏览器不支持图片处理');
        context.drawImage(source, 0, 0, page.width, page.height);
        for (const patch of page.patches) {
            check();
            const bitmap = await new Promise<ImageBitmap>((resolve, reject) => {
                let settled = false;
                const finish = (error?: Error, value?: ImageBitmap) => {
                    if (settled) {value?.close(); return;}
                    settled = true; clearTimeout(timeout); signal.removeEventListener('abort', abort);
                    if (error) reject(error); else resolve(value!);
                };
                const abort = () => finish(new DOMException('图片翻译已取消', 'AbortError'));
                const timeout = setTimeout(() => finish(new Error('译图加载超时')), Math.max(0, deadline - performance.now()));
                signal.addEventListener('abort', abort, {once: true});
                try {
                    void createImageBitmap(new Blob([patch.bytes as BlobPart], {type: 'image/png'}))
                        .then(value => finish(undefined, value), error => finish(error));
                } catch (error) {finish(error as Error);}
            });
            try {
                check();
                if (bitmap.width !== patch.width || bitmap.height !== patch.height) throw new Error('漫画译图数据无效');
                context.clearRect(patch.x, patch.y, patch.width, patch.height);
                context.drawImage(bitmap, patch.x, patch.y);
            } finally {bitmap.close();}
        }
        check(); return canvas;
    } catch (error) {canvas.width = 0; canvas.height = 0; throw error;}
}
