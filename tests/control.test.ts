import { describe, expect, test } from 'bun:test';
import {
    MotaControl,
    addItem,
    itemCount,
    removeItem,
    type ControlContext,
} from '../src/engine/modules/control';
import type { EnemyData } from '../src/engine/modules/enemys';
import { extractBlocks } from '../src/engine/modules/maps';
import type { FloorData, Maps } from '../src/shared/data/schema';
import type { HeroState } from '../src/engine/types';

const maps: Maps = {
    '1': { cls: 'terrains', id: 'ground' },
    '2': { cls: 'animates', id: 'wall' },
    '3': { cls: 'terrains', id: 'upFloor', canPass: true },
    '10': { cls: 'items', id: 'redPotion' },
    '11': { cls: 'items', id: 'yellowKey' },
    '12': {
        cls: 'animates',
        id: 'yellowDoor',
        doorInfo: { keys: { yellowKey: 1 } },
    },
    '20': { cls: 'enemys', id: 'slime' },
};

const floors: Record<string, FloorData> = {
    f1: {
        floorId: 'f1',
        title: '一层',
        name: '1',
        map: [
            [11, 10, 0],
            [0, 12, 3],
            [0, 20, 2],
        ],
        changeFloor: { '2,1': { floorId: 'f2', loc: [1, 1] } },
    },
    f2: {
        floorId: 'f2',
        title: '二层',
        name: '2',
        map: [
            [0, 0, 0],
            [0, 0, 0],
            [0, 0, 0],
        ],
    },
};

function newHero(overrides: Partial<HeroState> = {}): HeroState {
    return {
        x: 0,
        y: 0,
        direction: 'up',
        hp: 100,
        atk: 50,
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

function makeControl(
    options: {
        hero?: HeroState;
        enemys?: Record<string, EnemyData>;
        flags?: Record<string, unknown>;
    } = {},
): MotaControl {
    const hero = options.hero ?? newHero();
    const flags = options.flags ?? {};
    const cache: Record<string, ReturnType<typeof extractBlocks>> = {};
    const ctx: ControlContext = {
        maps,
        values: { weakValue: 5, hatred: 2 },
        flags,
        enemys: options.enemys ?? {
            slime: { name: '史莱姆', hp: 30, atk: 5, def: 0, money: 5, exp: 3, special: 0 },
        },
        items: {
            redPotion: { cls: 'items', name: '红血瓶' },
            yellowKey: { cls: 'tools', name: '黄钥匙' },
        },
        hero,
        floorId: 'f1',
        getFloor: (id) => floors[id],
        getBlocks: (id) => {
            cache[id] ??= extractBlocks(floors[id], maps, {
                isDisabled: (x, y) => (flags[`__block_${id}_${x}_${y}__`] ? true : undefined),
            });
            return cache[id];
        },
    };
    return new MotaControl(ctx);
}

describe('control 背包', () => {
    test('addItem / itemCount / removeItem 跨背包类别', () => {
        const hero = newHero();
        addItem(hero, 'yellowKey', 2, 'tools');
        addItem(hero, 'redPotion', 1, 'items');
        expect(itemCount(hero, 'yellowKey')).toBe(2);
        expect(itemCount(hero, 'redPotion')).toBe(1);
        expect(removeItem(hero, 'yellowKey', 3)).toBe(false);
        expect(removeItem(hero, 'yellowKey', 1)).toBe(true);
        expect(itemCount(hero, 'yellowKey')).toBe(1);
    });
});

describe('control 交互', () => {
    test('开门：无钥匙失败，有钥匙消耗并移除', () => {
        const h = newHero();
        const control = makeControl({ hero: h });
        const door = control.blockAt(1, 1)!;
        expect(control.openDoor(door)).toBe(false);

        addItem(h, 'yellowKey', 1, 'tools');
        expect(control.openDoor(door)).toBe(true);
        expect(itemCount(h, 'yellowKey')).toBe(0);
        expect(control.blockAt(1, 1)!.disable).toBe(true);
    });

    test('拾取物品按 cls 入包并移除图块', () => {
        const control = makeControl();
        const item = control.blockAt(0, 0)!;
        control.pickUp(item);
        expect(itemCount(control.ctx.hero, 'yellowKey')).toBe(1);
        expect(control.blockAt(0, 0)!.disable).toBe(true);
    });

    test('战斗获胜：扣血、奖励、移除怪物', () => {
        const control = makeControl();
        const damage = control.battle(control.blockAt(1, 2)!);
        expect(damage).toBe(0);
        expect(control.ctx.hero.money).toBe(5);
        expect(control.ctx.hero.exp).toBe(3);
        expect(control.blockAt(1, 2)!.disable).toBe(true);
    });

    test('打不过：返回 null 且状态不变', () => {
        const control = makeControl({
            enemys: {
                slime: { name: '强敌', hp: 10000, atk: 999, def: 0, money: 5, exp: 3, special: 0 },
            },
        });
        const before = control.ctx.hero.hp;
        expect(control.battle(control.blockAt(1, 2)!)).toBeNull();
        expect(control.ctx.hero.hp).toBe(before);
        expect(control.blockAt(1, 2)!.disable).toBeUndefined();
    });

    test('战后中毒 / 自爆 / 退化', () => {
        const control = makeControl({
            enemys: {
                slime: {
                    name: '诅咒怪',
                    hp: 30,
                    atk: 5,
                    def: 0,
                    money: 5,
                    exp: 3,
                    special: [12, 14, 19, 21],
                    atkValue: 2,
                    defValue: 3,
                },
            },
        });
        control.battle(control.blockAt(1, 2)!);
        expect(control.ctx.flags.poison).toBe(true);
        expect(control.ctx.flags.curse).toBe(true);
        expect(control.ctx.hero.hp).toBe(1); // 自爆
        expect(control.ctx.hero.atk).toBe(48); // 退化
        expect(control.ctx.hero.def).toBe(7);
        expect(control.ctx.hero.money).toBe(5); // 奖励在诅咒生效前结算
        expect(control.ctx.hero.exp).toBe(3);
    });

    test('楼梯切换楼层', () => {
        const control = makeControl();
        const stairs = control.blockAt(2, 1)!;
        control.changeFloor(stairs);
        expect(control.ctx.floorId).toBe('f2');
        expect(control.ctx.hero.x).toBe(1);
        expect(control.ctx.hero.y).toBe(1);
    });

    test('move：撞墙不动，撞怪战斗，踩物品拾取', () => {
        const control = makeControl();
        // 从 (0,0) 向右 → (1,0) 红血瓶
        const picked = control.move(1, 0);
        expect(picked.action).toBe('item');
        expect(control.ctx.hero.x).toBe(1);
        expect(control.ctx.hero.y).toBe(0);

        // 向下 → (1,1) 门（无钥匙）；再向左 -> (0,1)
        control.move(-1, 0);
        expect(control.ctx.hero.x).toBe(0);

        // 向下两次 → (0,2)，再向右 → (1,2) 怪物
        control.move(0, 1); // (0,1)
        control.move(0, 1); // (0,2)
        const battleResult = control.move(1, 0);
        expect(battleResult.action).toBe('battle');
    });

    test('move：踩到墙不动', () => {
        const control = makeControl({ hero: newHero({ x: 1, y: 2 }) });
        const result = control.move(1, 0); // (2,2) 墙
        expect(result.moved).toBe(false);
        expect(control.ctx.hero.x).toBe(1);
    });
});
