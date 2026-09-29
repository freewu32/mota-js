import { describe, expect, test } from 'bun:test';
import { drawHeroSprite, drawScene, resolveElement, type TilePainter } from '../src/engine/renderer';
import type { FloorData } from '../src/shared/data/schema';

/** 记录被调用的 canvas 方法名的假上下文 */
function recordingCtx(): { ctx: CanvasRenderingContext2D; calls: string[] } {
    const calls: string[] = [];
    const ctx = new Proxy(
        {},
        {
            get: (_target, prop) => {
                if (typeof prop === 'string') {
                    return (..._args: unknown[]) => {
                        calls.push(prop);
                    };
                }
                return undefined;
            },
            set: () => true,
        },
    ) as unknown as CanvasRenderingContext2D;
    return { ctx, calls };
}

const floor: FloorData = {
    floorId: 'f',
    title: 't',
    name: 'n',
    map: [
        [1, 1, 1],
        [1, 0, 1],
        [1, 1, 1],
    ],
};

const maps = { '1': { cls: 'terrains', id: 'ground' } };

describe('drawScene', () => {
    test('无素材时每格绘制色块，并绘制英雄', () => {
        const { ctx, calls } = recordingCtx();
        drawScene(ctx, floor, maps, { x: 1, y: 1 });

        expect(calls.filter((c) => c === 'fillRect').length).toBe(9);
        expect(calls).toContain('strokeRect');
        expect(calls).toContain('arc');
        expect(calls).toContain('fill');
    });

    test('有素材时交给 painter，仅未命中素材的格子回退色块', () => {
        const drawn: Array<[string, string, number, number]> = [];
        const painter: TilePainter = {
            drawElement: (_ctx, element, x, y) => {
                drawn.push([element.cls, element.id, x, y]);
                return true;
            },
            drawAutotile: () => true,
        };

        const { ctx, calls } = recordingCtx();
        drawScene(ctx, floor, maps, { x: 1, y: 1 }, painter);

        expect(drawn).toHaveLength(8);
        expect(drawn[0]).toEqual(['terrains', 'ground', 0, 0]);
        expect(calls.filter((c) => c === 'fillRect').length).toBe(1); // 只有 tileId 为 0 的格子
    });

    test('autotile 图块走 drawAutotile 分支', () => {
        const map = [
            [20, 20],
            [20, 20],
        ];
        const floorWithAutotile: FloorData = { floorId: 'a', title: 't', name: 'n', map };
        const autotiles: number[] = [];
        const painter: TilePainter = {
            drawElement: () => false,
            drawAutotile: (_ctx, element, x, y, mapArr) => {
                autotiles.push(mapArr[y]?.[x] ?? 0);
                return element.id === 'autotile';
            },
        };

        const { ctx } = recordingCtx();
        drawScene(
            ctx,
            floorWithAutotile,
            { '20': { cls: 'autotile', id: 'autotile' } },
            { x: 0, y: 0 },
            painter,
        );
        expect(autotiles).toEqual([20, 20, 20, 20]);
    });

    test('resolveElement 将 10000+ 编号视为 tileset', () => {
        expect(resolveElement({}, 10000)).toEqual({ cls: 'tileset', id: 'X10000' });
        expect(resolveElement({ '5': { cls: 'items', id: 'redPotion' } }, 5)).toEqual({
            cls: 'items',
            id: 'redPotion',
        });
        expect(resolveElement({}, 0)).toBeUndefined();
    });
});

describe('drawHeroSprite', () => {
    test('按朝向取行、走路时按帧循环取列', () => {
        const calls: unknown[][] = [];
        const ctx = {
            drawImage: (...args: unknown[]) => void calls.push(args),
        } as unknown as CanvasRenderingContext2D;
        const icons = {
            width: 32,
            height: 48,
            down: { loc: 0, stop: 0, leftFoot: 1, rightFoot: 3 },
            left: { loc: 1, stop: 0, leftFoot: 1, rightFoot: 3 },
        };
        expect(drawHeroSprite(ctx, {} as CanvasImageSource, icons, { x: 0, y: 0, direction: 'down' })).toBe(true);
        expect(calls[0]).toEqual([{}, 0, 0, 32, 48, 0, -16, 32, 48]);

        // 走路：帧 1 → leftFoot 列
        calls.length = 0;
        drawHeroSprite(ctx, {} as CanvasImageSource, icons, { x: 1, y: 2, direction: 'left' }, 1, true);
        expect(calls[0]).toEqual([{}, 1 * 32, 1 * 48, 32, 48, 1 * 32, 2 * 32 + 32 - 48, 32, 48]);

        // 没有该朝向 → 不绘制
        expect(drawHeroSprite(ctx, {} as CanvasImageSource, icons, { x: 0, y: 0, direction: 'up' })).toBe(false);
        expect(drawHeroSprite(ctx, {} as CanvasImageSource, undefined, { x: 0, y: 0 })).toBe(false);
    });
});
