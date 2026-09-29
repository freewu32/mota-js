/** 素材加载的小工具（浏览器专用） */

/** 加载一张图片；失败时返回 null（引擎有回退绘制，不阻断游戏） */
export function loadImage(src: string): Promise<HTMLImageElement | null> {
    // 无 DOM 环境（`bun test`）直接放弃，调用方都有回退绘制
    if (typeof Image === 'undefined') return Promise.resolve(null);
    return new Promise((resolve) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => resolve(null);
        image.src = src;
    });
}
