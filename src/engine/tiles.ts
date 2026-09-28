import type { Icons, MapElement } from '../shared/data/schema';

/** 单元格像素尺寸 */
export const TILE = 32;

/** tileset 编号起点：每个 tileset 占用连续的 10000 个编号，对齐旧 icons.tilesetStartOffset */
export const TILESET_START_OFFSET = 10000;

/** 各类图块的动画帧数，对齐旧 icons._getAnimateFrames */
const ANIMATE_FRAMES: Record<string, number> = {
    enemys: 2,
    npcs: 2,
    animates: 4,
    enemy48: 4,
    npc48: 4,
};

export function animateFrames(cls: string): number {
    return ANIMATE_FRAMES[cls] ?? 1;
}

/** 48 高度图块：贴图底边与格子底边对齐（向上超出 16 像素） */
export function tileHeight(cls: string): number {
    return cls === 'enemy48' || cls === 'npc48' ? 48 : 32;
}

/** 图块行号：icons[cls][id] 即图集中的行 */
export function rowIndex(icons: Icons, cls: string, id: string): number | null {
    const record = (icons as Record<string, unknown>)[cls];
    if (!record || typeof record !== 'object') return null;
    const index = (record as Record<string, unknown>)[id];
    return typeof index === 'number' ? index : null;
}

/** icons.autotile 中登记的全部 autotile id */
export function autotileIds(icons: Icons): string[] {
    const record = (icons as Record<string, unknown>)['autotile'];
    if (!record || typeof record !== 'object') return [];
    return Object.keys(record as Record<string, unknown>);
}

/** 图块帧数：地图项显式 animate 优先，animate === false 表示静态 */
export function frameCount(element: MapElement, cls: string): number {
    const animate = element.animate;
    if (animate === false) return 1;
    if (typeof animate === 'number' && animate > 0) return animate;
    return animateFrames(cls);
}

/** 帧序号：animate 为全局动画计数，返回 0..frameCount-1 */
export function frameIndex(element: MapElement, cls: string, animate: number): number {
    const count = frameCount(element, cls);
    return ((animate % count) + count) % count;
}

/** 绘制指令：源矩形 + 相对目标格左上角的目标矩形 */
export interface TileCommand {
    sx: number;
    sy: number;
    sw: number;
    sh: number;
    ox: number;
    oy: number;
    ow: number;
    oh: number;
}

/**
 * 普通图块（terrains/animates/enemys/items/npcs/*48）的绘制指令。
 * 图集每行一个 id、每列一帧；48 高图块的 oy 为负值。
 */
export function atlasTileCommand(
    element: MapElement,
    icons: Icons,
    animate = 0,
): TileCommand | null {
    const cls = element.cls;
    const row = rowIndex(icons, cls, element.id);
    if (row === null) return null;
    const height = tileHeight(cls);
    return {
        sx: frameIndex(element, cls, animate) * TILE,
        sy: row * height,
        sw: TILE,
        sh: height,
        ox: 0,
        oy: TILE - height,
        ow: TILE,
        oh: height,
    };
}

export interface TilesetSize {
    name: string;
    width: number;
    height: number;
}

export interface TilesetOffset {
    name: string;
    x: number;
    y: number;
}

/** 由 "X10000" 或 10000 形式的编号解析出所在 tileset 与格坐标 */
export function getTilesetOffset(
    id: string | number,
    sizes: readonly TilesetSize[],
): TilesetOffset | null {
    let value: number;
    if (typeof id === 'number') {
        value = id;
    } else {
        const match = /^X(\d+)$/.exec(id);
        if (!match) return null;
        value = Number(match[1]);
    }

    let start = TILESET_START_OFFSET;
    for (const size of sizes) {
        const cols = Math.max(1, Math.floor(size.width / TILE));
        const rows = Math.max(1, Math.floor(size.height / TILE));
        if (value >= start && value < start + cols * rows) {
            const offset = value - start;
            return {
                name: size.name,
                x: offset % cols,
                y: Math.floor(offset / cols),
            };
        }
        start += TILESET_START_OFFSET;
    }
    return null;
}
