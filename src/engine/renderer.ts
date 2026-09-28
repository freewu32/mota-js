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

    ctx.fillStyle = '#ffd700';
    ctx.beginPath();
    ctx.arc(hero.x * TILE + TILE / 2, hero.y * TILE + TILE / 2, TILE * 0.35, 0, Math.PI * 2);
    ctx.fill();
}
