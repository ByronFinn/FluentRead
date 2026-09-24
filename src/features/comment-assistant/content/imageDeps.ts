/**
 * @file src/features/comment-assistant/content/imageDeps.ts
 * 文件职责：提供选区图片捕获所需的真实浏览器依赖，把 Image 加载与 Canvas 编码绑定到页面运行时。
 * 主要内容：跨域匿名加载图片、按目标尺寸绘制到离屏画布并导出 JPEG data URL；跨域污染时返回 null 交由上层跳过。
 * 模块边界：只有浏览器对象装配，无业务规则；收集、过滤、超时与取消逻辑在 selectionImages.ts 并由其测试覆盖。
 */
import type {SelectionImageDeps} from '../selectionImages';

export const browserSelectionImageDeps: SelectionImageDeps = {
    loadImage: (src, signal) => new Promise((resolve, reject) => {
        const image = new Image();
        image.crossOrigin = 'anonymous';
        const abort = () => {
            image.onload = null;
            image.onerror = null;
            // 只 reject 不会中断下载；清空来源才不会让已隐藏的图片继续在页面上占带宽。
            image.src = '';
            reject(new Error('图片加载已取消'));
        };
        signal.addEventListener('abort', abort, {once: true});
        image.onload = () => {
            signal.removeEventListener('abort', abort);
            resolve({
                width: image.naturalWidth || image.width,
                height: image.naturalHeight || image.height,
                drawTo: (context, width, height) => context.drawImage(image, 0, 0, width, height),
            });
        };
        image.onerror = () => { signal.removeEventListener('abort', abort); reject(new Error('图片加载失败')); };
        image.src = src;
    }),
    encode: (image, width, height) => {
        try {
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext('2d');
            if (!context) return null;
            // JPEG 没有 alpha 通道，透明像素会变成黑色，所以先铺白底再绘制。
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, width, height);
            image.drawTo(context, width, height);
            return canvas.toDataURL('image/jpeg', 0.82);
        } catch {
            // 跨域画布被污染时 toDataURL 抛 SecurityError，跳过该图而不是中断整体。
            return null;
        }
    },
};
