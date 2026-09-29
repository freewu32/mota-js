import { describe, expect, test } from 'bun:test';
import {
    blockAt,
    canMoveInDirection,
    extractBlocks,
    isDoor,
    isEnemy,
    isItem,
    isPassable,
    removeBlock,
    resolveEvent,
    type Block,
} from '../src/engine/modules/maps';
import type { FloorData, Maps } from '../src/shared/data/schema';

const maps: Maps = {
    '1': { cls: 'terrains', id: 'ground' },
    '2': { cls: 'animates', id: 'wall' },
    '3': { cls: 'terrains', id: 'upFloor', canPass: true },
    '10': { cls: 'items', id: 'redPotion' },
    '12': {
        cls: 'animates',
        id: 'yellowDoor',
        doorInfo: { keys: { yellowKey: 1 } },
    },
    '20': { cls: 'enemys', id: 'slime' },
};

const floor: FloorData = {
    floorId: 'f1',
    title: '一层',
    name: '1',
    map: [
        [0, 2, 10],
        [20, 12, 3],
        [1, 0, 0],
    ],
    events: {
        '0,0': ['hello'],
        '1,1': { trigger: null, enable: false, noPass: null, data: ['hi'] },
    },
    changeFloor: { '1,2': { floorId: 'f2', loc: [0, 0] } },
};

describe('maps.resolveEvent', () => {
    test('空地 / 已知 / tileset / 未知', () => {
        expect(resolveEvent(maps, 0)).toBeNull();
        expect(resolveEvent(maps, 2)?.id).toBe('wall');
        expect(resolveEvent(maps, 10017)?.cls).toBe('tileset');
        expect(resolveEvent(maps, 999)?.id).toBe('none');
        expect(resolveEvent(maps, 999)?.noPass).toBe(false);
    });
});

describe('maps.isPassable', () => {
    test('items 与显式 canPass 可通行，其余默认阻挡', () => {
        expect(isPassable({ cls: 'items', id: 'x' })).toBe(true);
        expect(isPassable({ cls: 'terrains', id: 'none', noPass: false })).toBe(true);
        expect(isPassable({ cls: 'terrains', id: 'ground' })).toBe(false);
        expect(isPassable({ cls: 'animates', id: 'wall', noPass: true })).toBe(false);
        expect(isPassable({ cls: 'terrains', id: 'upFloor', canPass: true })).toBe(true);
    });
});

describe('maps.extractBlocks', () => {
    const blocks = extractBlocks(floor, maps);

    test('空地挂了剧本事件也会生成 block 并标记 action', () => {
        const b = blockAt(blocks, 0, 0);
        expect(b).toBeDefined();
        expect(b!.event.trigger).toBe('action');
        expect(isPassable(b!.event)).toBe(true);
    });

    test('墙 / 物品 / 怪物 / 楼梯分类', () => {
        const wall = blockAt(blocks, 1, 0)!;
        expect(isPassable(wall.event)).toBe(false);

        const item = blockAt(blocks, 2, 0)!;
        expect(isItem(item.event)).toBe(true);
        expect(isPassable(item.event)).toBe(true);

        const monster = blockAt(blocks, 0, 1)!;
        expect(isEnemy(monster.event)).toBe(true);

        const door = blockAt(blocks, 1, 1)!;
        expect(isDoor(door.event)).toBe(true);

        const stair = blockAt(blocks, 2, 1)!;
        expect(stair.event.id).toBe('upFloor');
    });

    test('changeFloor 追加 trigger 与 data', () => {
        const b = blockAt(blocks, 1, 2)!;
        expect(b.event.trigger).toBe('changeFloor');
        expect(b.event.data).toEqual({ floorId: 'f2', loc: [0, 0] });
    });

    test('enable:false 覆盖为禁用', () => {
        const door = blockAt(blocks, 1, 1)!;
        expect(door.disable).toBe(true);
    });

    test('isDisabled 回调可禁用已打开的门', () => {
        const withDisabled = extractBlocks(floor, maps, {
            isDisabled: (x, y) => x === 1 && y === 1,
        });
        expect(blockAt(withDisabled, 1, 1)!.disable).toBe(true);
    });

    test('removeBlock 标记禁用', () => {
        const copy: Block[] = extractBlocks(floor, maps);
        expect(removeBlock(copy, 2, 0)!.disable).toBe(true);
        expect(blockAt(copy, 2, 0)!.disable).toBe(true);
    });
});

describe('maps.canMoveInDirection', () => {
    const base: FloorData = {
        floorId: 'f',
        title: 't',
        name: 'n',
        map: [
            [0, 0],
            [0, 0],
        ],
    };
    const none = () => undefined;

    test('cannotMove 限制出发方向', () => {
        const f = { ...base, cannotMove: { '0,0': ['right'] } } as FloorData;
        expect(canMoveInDirection(f, 0, 0, 1, 0, none)).toBe(false);
        expect(canMoveInDirection(f, 0, 0, 0, 1, none)).toBe(true);
    });

    test('cannotMoveIn 限制进入方向', () => {
        const f = { ...base, cannotMoveIn: { '1,0': ['left'] } } as FloorData;
        expect(canMoveInDirection(f, 0, 0, 1, 0, none)).toBe(false);
        expect(canMoveInDirection(f, 0, 0, 0, 1, none)).toBe(true);
    });

    test('素材 cannotIn / cannotOut', () => {
        const arrowIn = (x: number, y: number) =>
            x === 1 && y === 0 ? { cls: 'terrains', id: 'arrow', cannotIn: ['left'] } : undefined;
        expect(canMoveInDirection(base, 0, 0, 1, 0, arrowIn)).toBe(false);

        const arrowOut = (x: number, y: number) =>
            x === 0 && y === 0 ? { cls: 'terrains', id: 'arrow', cannotOut: ['right'] } : undefined;
        expect(canMoveInDirection(base, 0, 0, 1, 0, arrowOut)).toBe(false);

        expect(canMoveInDirection(base, 0, 0, 1, 0, none)).toBe(true);
    });
});
