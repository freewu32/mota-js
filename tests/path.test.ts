import { describe, expect, test } from 'bun:test';
import { findDirectPath, findPath } from '../src/engine/modules/path';
import { extractBlocks, type Block } from '../src/engine/modules/maps';
import type { FloorData, Maps } from '../src/shared/data/schema';

/** 0 空地 / 1 墙 / 2 门 / 3 怪物 / 4 物品 / 5 传送点 */
const maps: Maps = {
    '1': { cls: 'animates', id: 'wall' },
    '2': { cls: 'animates', id: 'door', doorInfo: { keys: {} } },
    '3': { cls: 'enemys', id: 'slime' },
    '4': { cls: 'items', id: 'redPotion' },
    '5': { cls: 'terrains', id: 'upFloor', canPass: true },
    '6': { cls: 'animates', id: 'net', canPass: true },
};

function floorOf(rows: number[][]): FloorData {
    return { floorId: 'f1', title: 't', name: 'n', map: rows };
}

function blocksOf(floor: FloorData): Block[] {
    return extractBlocks(floor, maps);
}

describe('findPath（旧 maps.automaticRoute）', () => {
    test('直线路径逐步包含方向', () => {
        const floor = floorOf([
            [0, 0, 0],
            [0, 0, 0],
        ]);
        const path = findPath(floor, blocksOf(floor), { x: 0, y: 0 }, { x: 2, y: 0 });
        expect(path).toEqual([
            { x: 1, y: 0, direction: 'right' },
            { x: 2, y: 0, direction: 'right' },
        ]);
    });

    test('绕开墙体', () => {
        const rows = [
            [0, 0, 0],
            [1, 1, 0],
            [0, 0, 0],
        ];
        const floor = floorOf(rows);
        const path = findPath(floor, blocksOf(floor), { x: 0, y: 0 }, { x: 0, y: 2 });
        // 必须从右边绕，不能穿过墙 (0,1) / (1,1)
        expect(path.some((one) => one.y === 1 && one.x <= 1)).toBe(false);
        const last = path[path.length - 1]!;
        expect([last.x, last.y]).toEqual([0, 2]);
    });

    test('中途不穿过怪物 / 门，但终点可以是它们', () => {
        const rows = [
            [0, 3, 0],
            [0, 0, 0],
        ];
        const floor = floorOf(rows);
        const blocks = blocksOf(floor);
        // 终点是怪物：允许寻路到它身上
        const toEnemy = findPath(floor, blocks, { x: 0, y: 0 }, { x: 1, y: 0 });
        expect(toEnemy).toEqual([{ x: 1, y: 0, direction: 'right' }]);
        // 想走到怪物后面：绕路（从下面走）
        const behind = findPath(floor, blocks, { x: 0, y: 0 }, { x: 2, y: 0 });
        expect(behind.map((one) => [one.x, one.y])).toEqual([
            [0, 1],
            [1, 1],
            [2, 1],
            [2, 0],
        ]);
    });

    test('同格返回空数组；被墙隔开的目标走不到', () => {
        const floor = floorOf([
            [0, 1, 0],
            [0, 1, 0],
        ]);
        const blocks = blocksOf(floor);
        expect(findPath(floor, blocks, { x: 0, y: 0 }, { x: 0, y: 0 })).toEqual([]);
        // (1,0) 虽是墙，但作为「终点」允许寻路过去（撞击 / 开门）
        expect(findPath(floor, blocks, { x: 0, y: 0 }, { x: 1, y: 0 })).toHaveLength(1);
        // (2,0) 被整列墙隔开，走不到
        expect(findPath(floor, blocks, { x: 0, y: 0 }, { x: 2, y: 0 })).toEqual([]);
    });

    test('cost 回调影响路径选择（旧绕血瓶 / 亮灯）', () => {
        const floor = floorOf([
            [0, 0, 0],
            [0, 0, 0],
        ]);
        // 两条路都只有 2 步，给下面那一行加价后应当走上面
        const path = findPath(
            floor,
            blocksOf(floor),
            { x: 0, y: 0 },
            { x: 2, y: 1 },
            {
                cost: (_x, y) => (y === 1 ? 100 : 0),
            },
        );
        expect(path.map((one) => [one.x, one.y])).toEqual([
            [1, 0],
            [2, 0],
            [2, 1],
        ]);
    });

    test('cannotMove 限制会被尊重', () => {
        const floor = floorOf([
            [0, 0],
            [0, 0],
        ]);
        floor.cannotMove = { '0,0': ['right'] };
        const path = findPath(floor, blocksOf(floor), { x: 0, y: 0 }, { x: 1, y: 0 });
        expect(path).toEqual([
            { x: 0, y: 1, direction: 'down' },
            { x: 1, y: 1, direction: 'right' },
            { x: 1, y: 0, direction: 'up' },
        ]);
    });
});

describe('findDirectPath（旧 canMoveDirectlyArray）', () => {
    test('只走完全空白的格子，可以拐弯', () => {
        const floor = floorOf([
            [0, 0],
            [0, 0],
        ]);
        const path = findDirectPath(floor, blocksOf(floor), { x: 0, y: 0 }, { x: 1, y: 1 });
        expect(path).toHaveLength(2);
        expect(path[path.length - 1]).toEqual({ x: 1, y: 1, direction: 'right' });
    });

    test('不能穿过物品 / 怪物 / 门', () => {
        const floor = floorOf([
            [0, 4, 0],
            [0, 0, 0],
        ]);
        const blocks = blocksOf(floor);
        // 不能穿过物品，但可以从下面绕过去（旧版也是绕行而不是放弃）
        const around = findDirectPath(floor, blocks, { x: 0, y: 0 }, { x: 2, y: 0 });
        expect(around.some((one) => one.x === 1 && one.y === 0)).toBe(false);
        expect([around[around.length - 1]!.x, around[around.length - 1]!.y]).toEqual([2, 0]);
        // 也可以以物品所在格为目标（站在原地购买 / 拾取）
        expect(findDirectPath(floor, blocks, { x: 0, y: 0 }, { x: 1, y: 0 })).toEqual([
            { x: 1, y: 0, direction: 'right' },
        ]);
        // 整行都是墙时无法瞬移过去
        const walled = floorOf([
            [0, 1, 0],
            [1, 1, 1],
        ]);
        expect(findDirectPath(walled, blocksOf(walled), { x: 0, y: 0 }, { x: 2, y: 0 })).toEqual(
            [],
        );
    });

    test('可通行的地形（canPass）可以穿过', () => {
        const floor = floorOf([
            [0, 6, 0],
            [0, 0, 0],
        ]);
        const path = findDirectPath(floor, blocksOf(floor), { x: 0, y: 0 }, { x: 2, y: 0 });
        expect(path).toEqual([
            { x: 1, y: 0, direction: 'right' },
            { x: 2, y: 0, direction: 'right' },
        ]);
    });

    test('越界与同格', () => {
        const floor = floorOf([
            [0, 0],
            [0, 0],
        ]);
        const blocks = blocksOf(floor);
        expect(findDirectPath(floor, blocks, { x: 0, y: 0 }, { x: 0, y: 0 })).toEqual([]);
        expect(findDirectPath(floor, blocks, { x: 0, y: 0 }, { x: 9, y: 9 })).toEqual([]);
    });
});
