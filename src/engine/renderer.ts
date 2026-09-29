import type { FloorData, MapElement, Maps } from '../shared/data/schema';
import { TILE, TILESET_START_OFFSET } from './tiles';

export { TILE };

function colorOf(key: string): string {
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
        hash = (hash * 31 + key.charCodeAt(i)) | 0;
    }
    return `hsl(${Math.abs(hash) % 360} 55% 52%)`;
}

export interface HeroPos {
    x: number;
    y: number;
}

/** `icons.hero` 的形态：朝向 → 帧序号，外加精灵尺寸 */
export interface HeroIcons {
    width?: number;
    height?: number;
    [direction: string]: unknown;
}

interface HeroDirectionMeta {
    loc?: number;
    stop?: number;
    leftFoot?: number;
    rightFoot?: number;
}

/** 渲染器依赖的图块绘制能力（由 MaterialStore 实现，测试可传入桩） */
export interface TilePainter {
    drawElement(
        ctx: CanvasRenderingContext2D,
        element: MapElement,
        x: number,
        y: number,
        animate: number,
    ): boolean;
    drawAutotile(
        ctx: CanvasRenderingContext2D,
        element: MapElement,
        x: number,
        y: number,
        map: readonly (readonly number[])[],
        animate: number,
    ): boolean;
}

/** 数字 -> 图块；10000 以上的编号按旧约定自动视为 tileset（X+编号） */
export function resolveElement(maps: Maps, tileId: number): MapElement | undefined {
    const element = maps[String(tileId)];
    if (element) return element;
    if (tileId >= TILESET_START_OFFSET) return { cls: 'tileset', id: `X${tileId}` };
    return undefined;
}

/** 绘制一层地图与英雄；有素材时使用真实图块，否则回退为色块 */
export function drawScene(
    ctx: CanvasRenderingContext2D,
    floor: FloorData,
    maps: Maps,
    hero: HeroPos,
    materials?: TilePainter,
    animate = 0,
    /** 是否画勇士（有精灵图时由调用方关掉内置圆点） */
    drawHero = true,
): void {
    const rows = floor.map;

    for (let y = 0; y < rows.length; y++) {
        const row = rows[y];
        if (!row) continue;
        for (let x = 0; x < row.length; x++) {
            const tileId = row[x] ?? 0;
            const element = resolveElement(maps, tileId);

            let drawn = false;
            if (element && materials) {
                drawn =
                    element.cls === 'autotile'
                        ? materials.drawAutotile(ctx, element, x, y, rows, animate)
                        : materials.drawElement(ctx, element, x, y, animate);
            }

            if (!drawn) {
                ctx.fillStyle =
                    tileId === 0
                        ? '#1a1a1a'
                        : element
                          ? colorOf(`${element.cls}/${element.id}`)
                          : colorOf(String(tileId));
                ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
            }

            ctx.strokeStyle = 'rgba(0, 0, 0, 0.15)';
            ctx.strokeRect(x * TILE, y * TILE, TILE, TILE);
        }
    }

    if (!drawHero) return;
    ctx.fillStyle = '#ffd700';
    ctx.beginPath();
    ctx.arc(hero.x * TILE + TILE / 2, hero.y * TILE + TILE / 2, TILE * 0.35, 0, Math.PI * 2);
    ctx.fill();
}

/**
 * 绘制勇士精灵（`project/images/<firstData.hero.image>`）。
 *
 * 图集布局同旧引擎（`control._drawHero_draw`）：列 = 帧序号，行 = 朝向的 `loc`，
 * 帧序号由 `icons.hero[朝向]` 给出（`stop` / `leftFoot` / `rightFoot`）。
 * 没有图标表时退回 `stop` 帧。
 */
export function drawHeroSprite(
    ctx: CanvasRenderingContext2D,
    image: CanvasImageSource,
    icons: HeroIcons | undefined,
    hero: HeroPos & { direction?: string },
    frame = 0,
    /** 是否在走路（走路时循环左右脚，否则用 stop 帧） */
    walking = false,
): boolean {
    if (!icons) return false;
    const meta = icons[hero.direction ?? 'down'] as HeroDirectionMeta | undefined;
    if (!meta) return false;
    const width = icons.width ?? TILE;
    const height = icons.height ?? TILE;
    const stop = meta.stop ?? 0;
    const cycle = [stop, meta.leftFoot ?? stop, stop, meta.rightFoot ?? stop];
    const column = walking ? cycle[Math.abs(Math.floor(frame)) % cycle.length]! : stop;
    ctx.drawImage(
        image,
        column * width,
        (meta.loc ?? 0) * height,
        width,
        height,
        hero.x * TILE + (TILE - width) / 2,
        hero.y * TILE + TILE - height,
        width,
        height,
    );
    return true;
}

/** 跟随者绘制所需的一帧状态（图片名 + 位置 + 朝向 + 是否在走） */
export interface FollowerSprite extends HeroPos {
    name?: string;
    direction?: string;
    stop?: boolean;
}

/**
 * 绘制跟随者（旧 `_drawHero_getDrawObjs` 里把 `hero.followers` 一起排序绘制的部分）。
 *
 * 复用勇士的帧表（`icons.hero`），图片按名字从 `images` 里取；缺图的跟随者跳过。
 */
export function drawFollowers(
    ctx: CanvasRenderingContext2D,
    images: Record<string, CanvasImageSource | undefined>,
    icons: HeroIcons | undefined,
    followers: readonly FollowerSprite[],
    frame = 0,
): void {
    for (const follower of followers) {
        const image = images[follower.name ?? ''];
        if (!image) continue;
        drawHeroSprite(ctx, image, icons, follower, frame, follower.stop !== true);
    }
}
