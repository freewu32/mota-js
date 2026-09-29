/**
 * 窗口皮肤 → CSS 九宫格。
 *
 * 旧引擎的 `ui.drawWindowSkin` 用的不是标准九宫格：`winskin.png`（192x128）里
 * 背景贴在 `(0,0,128,128)`，四条边分别在 `x=144` / `y=48` 的 32px 条带上循环，
 * 四角在 `x=128/176` 与 `y=0/48`。直接丢给 CSS `border-image-slice` 会切错位置。
 *
 * 所以这里在加载时把 RM 布局**重切成标准九宫格**（48x48，slice 16），
 * 之后面板 / 对话框就能用纯 CSS `border-image` 还原旧外观，
 * 不需要给每个面板写 canvas 绘制代码（对应方案文档「窗口皮肤的逃生通道」）。
 */
import { loadImage } from './assets';

/** 单格边长（= `border-image-slice` 的值） */
export const SKIN_GRID = 16;

/** 标准九宫格边长 */
export const SKIN_SIZE = SKIN_GRID * 3;

export interface SkinPatch {
    /** 目标位置（九宫格内，单位：格） */
    dst: [number, number];
    /** 源位置（`winskin.png` 内，像素） */
    src: [number, number];
}

/**
 * RM 窗口皮肤 → 标准九宫格的 9 个切片（顺序：左上、上、右上、左、中、右、左下、下、右下）。
 * 中部填 `(0,0)` 的背景贴图。
 */
export const WINDOW_SKIN_PATCHES: readonly SkinPatch[] = [
    { dst: [0, 0], src: [128, 0] },
    { dst: [1, 0], src: [144, 0] },
    { dst: [2, 0], src: [176, 0] },
    { dst: [0, 1], src: [128, 16] },
    { dst: [1, 1], src: [0, 0] },
    { dst: [2, 1], src: [176, 16] },
    { dst: [0, 2], src: [128, 48] },
    { dst: [1, 2], src: [144, 48] },
    { dst: [2, 2], src: [176, 48] },
];

/** 是否 RM 布局的窗口皮肤（需要重切） */
export function isWindowSkin(src: string): boolean {
    return /(^|\/)winskin\.png$/i.test(src);
}

/** 把 RM 窗口皮肤重切成标准九宫格图，返回 data URL；失败返回 null */
export async function buildWindowSkinDataUrl(src: string): Promise<string | null> {
    const image = await loadImage(src);
    if (!image || typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = SKIN_SIZE;
    canvas.height = SKIN_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = false;
    for (const patch of WINDOW_SKIN_PATCHES) {
        ctx.drawImage(
            image,
            patch.src[0],
            patch.src[1],
            SKIN_GRID,
            SKIN_GRID,
            patch.dst[0] * SKIN_GRID,
            patch.dst[1] * SKIN_GRID,
            SKIN_GRID,
            SKIN_GRID,
        );
    }
    return canvas.toDataURL('image/png');
}

/** 主题里的皮肤若是 RM 布局，先重切；其它皮肤按标准九宫格直接用 */
export async function resolveThemeSkin<T extends { skin?: string; skinSlice?: number }>(
    theme: T,
): Promise<T> {
    if (!theme.skin || !isWindowSkin(theme.skin)) return theme;
    const url = await buildWindowSkinDataUrl(theme.skin);
    if (!url) return { ...theme, skin: undefined };
    return { ...theme, skin: url, skinSlice: SKIN_GRID };
}
