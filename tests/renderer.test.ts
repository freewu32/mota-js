import { describe, expect, test } from 'bun:test';
import {
    drawFollowers,
    drawHeroSprite,
    drawScene,
    resolveElement,
    type TilePainter,
} from '../src/engine/renderer';
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

    test('运行时图块：已移除的不画，setBlock 过的按新图块画', () => {
        const drawn: string[] = [];
        const painter: TilePainter = {
            drawElement: (_ctx, element) => {
                drawn.push(element.id ?? '');
                return true;
            },
            drawAutotile: () => true,
        };
        // floor 里 9 格全是 ground；运行时只剩左上角一格，另外关掉了两格、多了一个宝箱
        const blocks = [
            { x: 0, y: 0, id: 1, event: { cls: 'terrains', id: 'ground' } },
            { x: 1, y: 0, id: 1, event: { cls: 'terrains', id: 'ground' }, disable: true },
            { x: 2, y: 0, id: 1, event: { cls: 'terrains', id: 'ground' }, disable: true },
            { x: 1, y: 1, id: 9, event: { cls: 'animates', id: 'box' } },
        ];
        const { ctx, calls } = recordingCtx();
        drawScene(ctx, floor, maps, { x: 1, y: 1 }, painter, 0, false, blocks);

        expect(drawn).toEqual(['ground', 'box']);
        // 其余 7 格退回空地色块
        expect(calls.filter((c) => c === 'fillRect').length).toBe(7);
    });

    test('移动中的图块按像素位置与透明度绘制', () => {
        const detached: Array<[string, number, number]> = [];
        const painter: TilePainter = {
            drawElement: () => true,
            drawAutotile: () => true,
            drawDetached: (_ctx, element, px, py) => {
                detached.push([element.id ?? '', px, py]);
                return true;
            },
        };
        const moving = [
            {
                element: { cls: 'npcs', id: 'thief' },
                px: 2 * 32 + 10,
                py: 11 * 32,
                opacity: 0.5,
            },
        ] as unknown as Parameters<typeof drawScene>[8];
        const { ctx, calls } = recordingCtx();
        drawScene(ctx, floor, maps, { x: 1, y: 1 }, painter, 0, false, [], moving);

        expect(detached).toEqual([['thief', 2 * 32 + 10, 11 * 32]]);
        // 半透明：整个场景绘制完会把 alpha 还原回去
        expect(calls.length).toBeGreaterThan(0);
    });

    test('运行时图块：autotile 的连通性用运行时地图', () => {
        const mapWithHole = [
            [20, 0],
            [20, 20],
        ];
        const floorWithHole: FloorData = { floorId: 'a', title: 't', name: 'n', map: mapWithHole };
        const seen: number[][] = [];
        const painter: TilePainter = {
            drawElement: () => false,
            drawAutotile: (_ctx, _element, x, y, mapArr) => {
                seen.push([x, y, mapArr[y]?.[x] ?? 0]);
                return true;
            },
        };
        const blocks = [
            { x: 0, y: 0, id: 20, event: { cls: 'autotile', id: 'autotile' } },
            { x: 0, y: 1, id: 20, event: { cls: 'autotile', id: 'autotile' } },
            { x: 1, y: 1, id: 20, event: { cls: 'autotile', id: 'autotile' } },
        ];
        const { ctx } = recordingCtx();
        drawScene(
            ctx,
            floorWithHole,
            { '20': { cls: 'autotile', id: 'autotile' } },
            { x: 0, y: 0 },
            painter,
            0,
            false,
            blocks,
        );
        // 只画运行时存在的三格，且传给 painter 的邻居表也是运行时的
        expect(seen).toEqual([
            [0, 0, 20],
            [0, 1, 20],
            [1, 1, 20],
        ]);
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
        expect(
            drawHeroSprite(ctx, {} as CanvasImageSource, icons, { x: 0, y: 0, direction: 'down' }),
        ).toBe(true);
        expect(calls[0]).toEqual([{}, 0, 0, 32, 48, 0, -16, 32, 48]);

        // 走路：帧 1 → leftFoot 列
        calls.length = 0;
        drawHeroSprite(
            ctx,
            {} as CanvasImageSource,
            icons,
            { x: 1, y: 2, direction: 'left' },
            1,
            true,
        );
        expect(calls[0]).toEqual([{}, 1 * 32, 1 * 48, 32, 48, 1 * 32, 2 * 32 + 32 - 48, 32, 48]);

        // 没有该朝向 → 不绘制
        expect(
            drawHeroSprite(ctx, {} as CanvasImageSource, icons, { x: 0, y: 0, direction: 'up' }),
        ).toBe(false);
        expect(drawHeroSprite(ctx, {} as CanvasImageSource, undefined, { x: 0, y: 0 })).toBe(false);
    });
});

describe('drawFollowers', () => {
    function fakeCtx() {
        const calls: unknown[][] = [];
        const ctx = {
            drawImage: (...args: unknown[]) => void calls.push(args),
            fillStyle: '',
            beginPath: () => {},
            arc: () => {},
            fill: () => {},
            strokeStyle: '',
            strokeRect: () => {},
            fillRect: () => {},
            calls,
        };
        return ctx as unknown as CanvasRenderingContext2D & { calls: unknown[][] };
    }

    const icons = {
        width: 32,
        height: 48,
        down: { loc: 0, stop: 0, leftFoot: 1, rightFoot: 3 },
        left: { loc: 1, stop: 0, leftFoot: 1, rightFoot: 3 },
        right: { loc: 2, stop: 0, leftFoot: 1, rightFoot: 3 },
        up: { loc: 3, stop: 0, leftFoot: 1, rightFoot: 3 },
    };

    test('按名字取图并复用勇士帧表绘制', () => {
        const ctx = fakeCtx();
        const image = {} as CanvasImageSource;
        drawFollowers(
            ctx,
            { 'bear.png': image },
            icons,
            [{ name: 'bear.png', x: 2, y: 3, direction: 'right', stop: false }],
            1,
        );
        expect(ctx.calls).toHaveLength(1);
        const args = ctx.calls[0] as unknown[];
        expect(args[0]).toBe(image);
        // 走路帧循环：frame=1 -> leftFoot(1)；行取 right 的 loc=2
        expect(args[1]).toBe(32);
        expect(args[2]).toBe(96);
        expect(args[5]).toBe(2 * 32);
        expect(args[6]).toBe(3 * 32 + 32 - 48);
    });

    test('缺图的跟随者跳过；没有图标表时全部跳过', () => {
        const ctx = fakeCtx();
        drawFollowers(ctx, {}, icons, [{ name: 'ghost.png', x: 0, y: 0 }]);
        expect(ctx.calls).toHaveLength(0);
        drawFollowers(ctx, { 'bear.png': {} as CanvasImageSource }, undefined, [
            { name: 'bear.png', x: 0, y: 0 },
        ]);
        expect(ctx.calls).toHaveLength(0);
    });
});
