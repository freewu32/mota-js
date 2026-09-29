import { describe, expect, test } from 'bun:test';
import {
    MovingBlocks,
    parseMoveSteps,
    type MovingBlockHost,
} from '../src/engine/modules/move-block';
import { TILE } from '../src/engine/tiles';

interface Harness {
    moving: MovingBlocks;
    /** 记录落地（`keep`）与移除 */
    placed: string[];
    removed: string[];
    /** 起点图块；置为 null 表示该格没有图块 */
    taken: { element: { cls: string; id: string }; number: number } | null;
    doneCount: number;
    run(ms: number, step?: number): void;
}

function harness(
    taken: Harness['taken'] = { element: { cls: 'npcs', id: 'thief' }, number: 123 },
): Harness {
    const state: Harness = {
        moving: null as unknown as MovingBlocks,
        placed: [],
        removed: [],
        taken,
        doneCount: 0,
        run(ms: number, step = 16) {
            let left = ms;
            while (left > 0) {
                state.moving.update(Math.min(step, left));
                left -= step;
            }
        },
    };
    const host: MovingBlockHost = {
        takeBlock: () => state.taken,
        removeBlock: (x, y) => void state.removed.push(`${x},${y}`),
        placeBlock: (number, x, y) => void state.placed.push(`${number}@${x},${y}`),
    };
    state.moving = new MovingBlocks(host);
    return state;
}

describe('parseMoveSteps', () => {
    test('解析方向与格数，缺省格数为 1', () => {
        expect(parseMoveSteps(['right:2', 'down'])).toEqual([
            { kind: 'move', direction: 'right', count: 2 },
            { kind: 'move', direction: 'down', count: 1 },
        ]);
    });

    test('未知方向与 forward/backward 忽略，speed 只在 >= 16 时保留', () => {
        expect(
            parseMoveSteps(['forward:2', 'backward', 'nowhere:3', 'speed:8', 'speed:32']),
        ).toEqual([{ kind: 'speed', count: 32 }]);
    });

    test('非数组 / 空返回空', () => {
        expect(parseMoveSteps(undefined)).toEqual([]);
        expect(parseMoveSteps('right:2')).toEqual([]);
    });
});

describe('MovingBlocks', () => {
    test('起点图块立刻消失，走完后 keep 落地', () => {
        const h = harness();
        expect(h.moving.start(2, 11, ['right:2', 'down:1'], 750, true, 'sample1')).toBe(true);
        expect(h.removed).toEqual(['2,11']);
        expect(h.moving.size).toBe(1);

        // 每格 750ms：走完 3 格需要 2250ms
        h.run(750 * 3 + 100);
        expect(h.placed).toEqual(['123@4,12']);
        expect(h.moving.size).toBe(0);
    });

    test('动画途中按 16 小步 / 格推进像素位置', () => {
        const h = harness();
        h.moving.start(0, 0, ['right:2'], 160, false, 'sample1');
        h.run(80); // 半格
        expect(h.moving.list[0]?.px).toBe(TILE / 2);
        h.run(80);
        expect(h.moving.list[0]?.px).toBe(TILE);
    });

    test('不 keep 时淡出并消失，位置停在终点', () => {
        const h = harness();
        h.moving.start(2, 11, ['down:1'], 160, false, 'sample1');
        // 走完一格要 160ms（16 小步 * 10ms）
        h.run(160);
        expect(h.moving.size).toBe(1);
        expect(h.moving.list[0]?.py).toBe(12 * TILE);
        // 随后每个小步 -0.06，17 个小步（170ms）后消失
        h.run(170);
        expect(h.moving.size).toBe(0);
        expect(h.placed).toEqual([]);
    });

    test('起点没有图块时不启动动画，直接回调', () => {
        const h = harness(null);
        let done = 0;
        expect(
            h.moving.start(0, 0, ['right:1'], 100, false, 'sample1', () => {
                done += 1;
            }),
        ).toBe(false);
        expect(done).toBe(1);
        expect(h.moving.size).toBe(0);
    });

    test('speed 令牌改变每格用时', () => {
        const h = harness();
        h.moving.start(0, 0, ['speed:32', 'right:1'], 320, true, 'sample1');
        // 第一个小步消费 speed 令牌：每格从 320ms 变成 32ms
        h.run(20);
        expect(h.moving.list[0]?.perStep).toBe(2);
        h.run(32);
        expect(h.moving.list[0]?.px).toBe(TILE);
    });

    test('完成后调用 done（事件流据此继续）', () => {
        const h = harness();
        let done = 0;
        h.moving.start(0, 0, ['right:1'], 160, false, 'sample1', () => {
            done += 1;
        });
        expect(done).toBe(0);
        h.run(1000);
        expect(done).toBe(1);
    });

    test('clear 丢掉进行中的动画，可选择是否让事件流继续', () => {
        const h = harness();
        let done = 0;
        const doneFn = (): void => void (done += 1);
        h.moving.start(0, 0, ['right:4'], 160, false, 'sample1', doneFn);
        h.moving.clear();
        expect(h.moving.size).toBe(0);
        expect(done).toBe(1);

        h.moving.start(0, 0, ['right:4'], 160, false, 'sample1', doneFn);
        h.moving.clear(false);
        expect(h.moving.size).toBe(0);
        expect(done).toBe(1);
    });

    test('步数为 0 / 只转向的令牌不移动', () => {
        const h = harness();
        h.moving.start(3, 3, ['left:0', 'right:1'], 160, true, 'sample1');
        h.run(1000);
        expect(h.placed).toEqual(['123@4,3']);
    });
});
