import { describe, expect, test } from 'bun:test';
import { createBuiltins, resolveFloorId, DIRECTION_DELTA } from '../src/engine/modules/builtins';
import { extractBlocks, type Block } from '../src/engine/modules/maps';
import { evaluateValue, type ValueScope } from '../src/engine/modules/values';
import type { FloorData, Maps } from '../src/shared/data/schema';
import type { HeroState } from '../src/engine/types';

const maps: Maps = {
    '0': { cls: 'terrains', id: 'ground' },
    '1': { cls: 'animates', id: 'wall' },
    '2': { cls: 'terrains', id: 'lava', canBreak: true },
    '3': { cls: 'terrains', id: 'upFloor', canPass: true },
    '4': { cls: 'animates', id: 'yellowDoor', doorInfo: { keys: { yellowKey: 1 } } },
};

function newFloor(id: string, map: number[][], extra: Partial<FloorData> = {}): FloorData {
    return {
        floorId: id,
        title: id,
        name: id,
        map,
        width: map[0]?.length ?? 0,
        height: map.length,
        ...extra,
    } as FloorData;
}

/** 3 层：f1 有楼梯/门/岩浆，f2 空，f3 用于相对楼层越界 */
const floors: Record<string, FloorData> = {
    f1: newFloor('f1', [
        [3, 2, 1],
        [1, 0, 4],
        [1, 1, 1],
    ]),
    f2: newFloor('f2', [
        [0, 0],
        [0, 1],
    ]),
};

function newHero(overrides: Partial<HeroState> = {}): HeroState {
    return {
        x: 1,
        y: 1,
        direction: 'up',
        hp: 100,
        atk: 10,
        def: 10,
        mdef: 0,
        money: 0,
        exp: 0,
        lv: 1,
        steps: 0,
        items: { constants: {}, tools: {}, equips: {} },
        equipment: [],
        ...overrides,
    };
}

function makeBuiltins(options: { hero?: HeroState; floorId?: string; disabled?: string[] } = {}) {
    const hero = options.hero ?? newHero();
    const disabled = new Set(options.disabled ?? []);
    const cache: Record<string, Block[]> = {};
    const getBlocks = (floorId: string): Block[] => {
        cache[floorId] ??= extractBlocks(floors[floorId] as FloorData, maps, {
            isDisabled: (x, y) => (disabled.has(`${x},${y}`) ? true : undefined),
        });
        return cache[floorId];
    };
    const host = {
        hero,
        floorId: options.floorId ?? 'f1',
        floorIds: ['f1', 'f2'],
        getFloor: (id: string) => floors[id],
        getBlocks,
        enemys: { slime: { name: '史莱姆', hp: 100, notBomb: true }, bat: { name: '蝙蝠' } },
    };
    const functions = createBuiltins(host);
    const scope: ValueScope = {
        flags: {},
        values: {},
        hero,
        functions,
        getBlock: (x, y) => getBlocks(host.floorId).find((b) => b.x === x && b.y === y),
    };
    const call = (name: string, ...args: unknown[]): unknown => functions[name]!(...args);
    return { hero, functions, scope, call, getBlocks };
}

describe('builtins 方位与坐标', () => {
    test('nextX / nextY 按朝向与步数计算', () => {
        const { call } = makeBuiltins();
        // 朝上：(1,1) 前方一格是 (1,0)
        expect(call('nextX')).toBe(1);
        expect(call('nextY')).toBe(0);
        expect(call('nextY', 2)).toBe(-1);

        const right = makeBuiltins({ hero: newHero({ direction: 'right' }) });
        expect(right.call('nextX')).toBe(2);
        expect(right.call('nextY')).toBe(1);
        expect(right.call('nextX', 3)).toBe(4);
    });

    test('方向位移表与旧 core.utils.scan 一致', () => {
        expect(DIRECTION_DELTA.up).toEqual({ x: 0, y: -1 });
        expect(DIRECTION_DELTA.down).toEqual({ x: 0, y: 1 });
        expect(DIRECTION_DELTA.left).toEqual({ x: -1, y: 0 });
        expect(DIRECTION_DELTA.right).toEqual({ x: 1, y: 0 });
    });

    test('mapWidth / mapHeight 支持指定楼层', () => {
        const { call } = makeBuiltins();
        expect(call('mapWidth')).toBe(3);
        expect(call('mapHeight')).toBe(3);
        expect(call('mapWidth', 'f2')).toBe(2);
        expect(call('mapHeight', 'f2')).toBe(2);
        expect(call('mapWidth', '不存在')).toBe(0);
    });
});

describe('builtins 图块查询', () => {
    test('blockId / blockNumber / blockCls 读指定点', () => {
        const { call } = makeBuiltins();
        expect(call('blockId', 0, 0)).toBe('upFloor');
        expect(call('blockNumber', 0, 0)).toBe(3);
        expect(call('blockCls', 2, 0)).toBe('animates');
        // 空点返回 null（旧 core.getBlockId）
        expect(call('blockId', 1, 1)).toBeNull();
        expect(call('blockCls', 1, 1)).toBeNull();
    });

    test('blockId 可指定其他楼层', () => {
        const { call } = makeBuiltins();
        expect(call('blockId', 1, 1, 'f2')).toBe('wall');
        expect(call('blockId', 0, 0, 'f2')).toBeNull();
    });

    test('已禁用的图块视为不存在（旧 getBlock 语义）', () => {
        const { call } = makeBuiltins({ disabled: ['0,0'] });
        expect(call('blockId', 0, 0)).toBeNull();
    });

    test('blockCount 按 id 或 cls 统计当前层', () => {
        const { call } = makeBuiltins();
        expect(call('blockCount', 'wall')).toBe(5);
        expect(call('blockCount', 'yellowDoor')).toBe(1);
        // 编号 0 的空地块不产生图块，故 terrains 只有 upFloor 与 lava 两个
        expect(call('blockCount', 'terrains')).toBe(2);
        expect(call('blockCount', '不存在')).toBe(0);
    });

    test('nearStair 判断勇士与楼梯是否相邻', () => {
        // (0,1) 与 upFloor(0,0) 相邻（只算上下左右，不含斜角）
        expect(makeBuiltins({ hero: newHero({ x: 0, y: 1 }) }).call('nearStair')).toBe(true);
        // (1,1) 的四邻都是墙/岩浆/门，不算楼梯边
        expect(makeBuiltins().call('nearStair')).toBe(false);
        expect(makeBuiltins({ hero: newHero({ x: 1, y: 0 }) }).call('nearStair')).toBe(true);
        expect(makeBuiltins().call('nearStair', 'f2')).toBe(false);
    });
});

describe('builtins 楼层顺序', () => {
    test('floorId / floorIndex / floorCount', () => {
        const { call } = makeBuiltins({ floorId: 'f2' });
        expect(call('floorId')).toBe('f2');
        expect(call('floorIndex')).toBe(1);
        expect(call('floorIndex', 'f1')).toBe(0);
        expect(call('floorCount')).toBe(2);
    });

    test('floorIdOffset 取相对楼层，越界为 null', () => {
        const { call } = makeBuiltins();
        expect(call('floorIdOffset', 1)).toBe('f2');
        expect(call('floorIdOffset', -1)).toBeNull();
        expect(call('floorIdOffset', 2)).toBeNull();
        // 显式传 null（越界楼层）不退回当前层，避免读到本层的图块
        expect(call('blockId', 0, 0, null)).toBeNull();
        expect(call('blockId', 0, 0)).toBe('upFloor');
    });

    test('blockAttr 读图块属性（破墙镐条件）', () => {
        const { call } = makeBuiltins();
        expect(call('blockAttr', 1, 0, 'canBreak')).toBe(true);
        expect(call('blockAttr', 0, 0, 'canBreak')).toBeNull();
        expect(call('blockAttr', 9, 9, 'canBreak')).toBeNull();
        expect(call('blockAttr', 0, 1, 'canBreak', 'f2')).toBeNull();
    });

    test('blockCount 支持按属性名统计（地震卷轴条件）', () => {
        const { call } = makeBuiltins();
        expect(call('blockCount', 'canBreak')).toBe(1);
        expect(call('blockCount', 'yellowDoor')).toBe(1);
        expect(call('blockCount', 'nothing')).toBe(0);
        // 被禁用的图块不计入
        expect(makeBuiltins({ disabled: ['1,0'] }).call('blockCount', 'canBreak')).toBe(0);
    });

    test('isEnemy / enemyAttr 读怪物数据（炸弹条件）', () => {
        const { call } = makeBuiltins();
        expect(call('isEnemy', 'slime')).toBe(true);
        expect(call('isEnemy', 'wall')).toBe(false);
        expect(call('enemyAttr', 'slime', 'notBomb')).toBe(true);
        expect(call('enemyAttr', 'bat', 'notBomb')).toBeNull();
        expect(call('enemyAttr', 'wall', 'name')).toBeNull();
    });

    test('resolveFloorId 解析 :now / :before / :after，越界停在当前层', () => {
        const ids = ['f1', 'f2', 'f3'];
        expect(resolveFloorId(ids, 'f2')).toBe('f2');
        expect(resolveFloorId(ids, 'f2', ':now')).toBe('f2');
        expect(resolveFloorId(ids, 'f2', ':before')).toBe('f1');
        expect(resolveFloorId(ids, 'f2', ':after')).toBe('f3');
        // 旧写法 `:next` 等同 `:after`
        expect(resolveFloorId(ids, 'f2', ':next')).toBe('f3');
        // 越界时旧实现回退到当前层（而不是报错或空值）
        expect(resolveFloorId(ids, 'f1', ':before')).toBe('f1');
        expect(resolveFloorId(ids, 'f3', ':after')).toBe('f3');
        expect(resolveFloorId(ids, 'f1', 'f9')).toBe('f9');
    });
});

describe('builtins 与表达式求值集成', () => {
    test('用表达式判断前方图块（破冰镐条件）', () => {
        const { scope } = makeBuiltins();
        // 前方是岩浆：blockId 比 id，blockCls 比类别
        expect(evaluateValue("blockId(nextX(), nextY()) == 'lava'", scope)).toBe(true);
        expect(evaluateValue("blockCls(nextX(), nextY()) == 'terrains'", scope)).toBe(true);
        expect(evaluateValue("blockId(nextX(), nextY()) == 'wall'", scope)).toBe(false);
    });

    test('用表达式判断目标楼层是否可传送（上楼器条件）', () => {
        const { scope } = makeBuiltins();
        // f2 的 (1,1) 是墙 → 不可上楼
        expect(
            evaluateValue(
                'floorIndex() < floorCount() - 1 && blockId(status:x, status:y, floorIdOffset(1)) == null',
                scope,
            ),
        ).toBe(false);
        // (0,0) 在 f2 是空的 → 可上楼
        const hero = newHero({ x: 0, y: 0 });
        const atCorner = makeBuiltins({ hero });
        expect(
            evaluateValue(
                'floorIndex() < floorCount() - 1 && blockId(status:x, status:y, floorIdOffset(1)) == null',
                atCorner.scope,
            ),
        ).toBe(true);
    });

    test('用表达式统计图块（大黄门钥匙条件）', () => {
        const { scope } = makeBuiltins();
        expect(evaluateValue("blockCount('yellowDoor') > 0", scope)).toBe(true);
        expect(evaluateValue("blockCount('redDoor') > 0", scope)).toBe(false);
    });

    test('用表达式判断是否在楼梯边（楼层传送器条件）', () => {
        const atStair = makeBuiltins({ hero: newHero({ x: 0, y: 1 }) });
        expect(evaluateValue('nearStair()', atStair.scope)).toBe(true);
        expect(evaluateValue('nearStair()', makeBuiltins().scope)).toBe(false);
        const { scope } = makeBuiltins();
        expect(evaluateValue('mapWidth() - 1 - status:x', scope)).toBe(1);
    });
});
