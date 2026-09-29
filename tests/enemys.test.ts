import { describe, expect, test } from 'bun:test';
import {
    canBattle,
    getDamageInfo,
    getDamageString,
    getDefDamage,
    getEnemyInfo,
    getSpecialColor,
    getSpecialText,
    hasSpecial,
    nextCriticals,
    type BattleContext,
    type EnemyData,
} from '../src/engine/modules/enemys';
import type { Block } from '../src/engine/modules/maps';
import type { HeroStats } from '../src/engine/types';

function hero(overrides: Partial<HeroStats> = {}): HeroStats {
    return {
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

function ctx(
    options: {
        hero?: HeroStats;
        flags?: Record<string, unknown>;
        values?: Record<string, unknown>;
        enemys?: Record<string, EnemyData>;
        blocks?: Block[];
        hasItem?: (id: string) => boolean;
    } = {},
): BattleContext {
    const enemys = options.enemys ?? {};
    return {
        hero: options.hero ?? hero(),
        flags: options.flags ?? {},
        values: options.values ?? {},
        blocks: options.blocks,
        enemyOf: (id) => enemys[id],
        hasItem: options.hasItem,
    } as BattleContext;
}

function enemy(data: Record<string, unknown> = {}): EnemyData {
    return { name: '测试怪', hp: 100, atk: 20, def: 0, money: 1, exp: 1, special: 0, ...data };
}

function block(x: number, y: number, id: string): Block {
    return { x, y, id: 0, event: { cls: 'enemys', id } };
}

describe('enemys.hasSpecial', () => {
    test('数组 / 数字 / 怪物 id / 嵌套', () => {
        expect(hasSpecial([1, 4], 4)).toBe(true);
        expect(hasSpecial(4, 4)).toBe(true);
        expect(hasSpecial([1], 4)).toBe(false);
        expect(hasSpecial(null, 4)).toBe(false);

        const enemys: Record<string, EnemyData> = { base: { special: [7, 8] } };
        const lookup = (id: string) => enemys[id];
        expect(hasSpecial('base', 7, lookup)).toBe(true);
        expect(hasSpecial({ special: [9] }, 9, lookup)).toBe(true);
    });

    test('特殊属性文字与颜色', () => {
        const e = enemy({ special: [1, 10] });
        expect(getSpecialText(e)).toEqual(['先攻', '模仿']);
        expect(getSpecialColor(e)).toHaveLength(2);
    });
});

describe('enemys.getEnemyInfo', () => {
    test('模仿：攻防等于勇士', () => {
        const info = getEnemyInfo(enemy({ special: 10 }), null, null, null, ctx());
        expect(info.atk).toBe(50);
        expect(info.def).toBe(10);
    });

    test('坚固：防御不小于攻击-1', () => {
        const info = getEnemyInfo(enemy({ def: 0, special: 3 }), null, null, null, ctx());
        expect(info.def).toBe(49);
    });

    test('光环：同层怪物生命提升', () => {
        const enemys: Record<string, EnemyData> = {
            target: enemy({ hp: 100 }),
            halo: enemy({ special: 25, hpBuff: 100 }),
        };
        const blocks = [block(0, 0, 'halo'), block(1, 0, 'target')];
        const info = getEnemyInfo(enemys.target, null, 1, 0, ctx({ enemys, blocks }));
        expect(info.hp).toBe(200);
    });

    test('支援：九宫格内怪物进入 guards', () => {
        const enemys: Record<string, EnemyData> = {
            target: enemy(),
            helper: enemy({ special: 26 }),
        };
        const blocks = [block(0, 0, 'helper'), block(1, 0, 'target')];
        const info = getEnemyInfo(enemys.target, null, 1, 0, ctx({ enemys, blocks }));
        expect(info.guards).toEqual([[0, 0, 'helper']]);
    });
});

describe('enemys.getDamageInfo', () => {
    test('基础：回合数与伤害', () => {
        const info = getDamageInfo(enemy(), null, null, null, ctx())!;
        expect(info.mon_hp).toBe(100);
        expect(info.per_damage).toBe(10); // 20 - 10
        expect(info.hero_per_damage).toBe(50);
        expect(info.turn).toBe(2);
        expect(info.damage).toBe(10); // (2-1)*10
    });

    test('2连击 / 魔攻', () => {
        expect(getDamageInfo(enemy({ special: 4 }), null, null, null, ctx())!.per_damage).toBe(20);
        const magic = getDamageInfo(enemy({ special: 2 }), null, null, null, ctx())!;
        expect(magic.per_damage).toBe(20); // 无视防御
        expect(magic.damage).toBe(20);
    });

    test('先攻 / 破甲 / 反击 / 净化', () => {
        expect(getDamageInfo(enemy({ special: 1 }), null, null, null, ctx())!.damage).toBe(20);

        const armor = getDamageInfo(
            enemy({ special: 7, breakArmor: 0.5 }),
            null,
            null,
            null,
            ctx(),
        )!;
        expect(armor.init_damage).toBe(5); // floor(0.5 * def10)

        const counter = getDamageInfo(
            enemy({ special: 8, counterAttack: 0.2 }),
            null,
            null,
            null,
            ctx(),
        )!;
        expect(counter.damage).toBe(30); // (2-1)*10 + 2*10
    });

    test('净化按护盾计算', () => {
        const info = getDamageInfo(
            enemy({ special: 9, purify: 2 }),
            null,
            null,
            null,
            ctx({ hero: hero({ mdef: 5 }) }),
        )!;
        expect(info.init_damage).toBe(10);
    });

    test('吸血可加到自身生命', () => {
        const info = getDamageInfo(
            enemy({ special: 11, vampire: 0.5, add: true }),
            null,
            null,
            null,
            ctx(),
        )!;
        expect(info.init_damage).toBe(50);
        expect(info.mon_hp).toBe(150);
    });

    test('无敌：需要十字架', () => {
        expect(getDamageInfo(enemy({ special: 20 }), null, null, null, ctx())).toBeNull();
        const withCross = getDamageInfo(
            enemy({ special: 20 }),
            null,
            null,
            null,
            ctx({ hasItem: (id) => id === 'cross' }),
        );
        expect(withCross).not.toBeNull();
    });

    test('未破防返回 null', () => {
        expect(
            getDamageInfo(enemy({ def: 60 }), null, null, null, ctx({ hero: hero({ atk: 10 }) })),
        ).toBeNull();
    });

    test('护盾减伤与负伤开关', () => {
        const shielded = getDamageInfo(
            enemy(),
            null,
            null,
            null,
            ctx({ hero: hero({ mdef: 5 }) }),
        )!;
        expect(shielded.damage).toBe(5);

        const clamped = getDamageInfo(
            enemy(),
            null,
            null,
            null,
            ctx({ hero: hero({ mdef: 100 }) }),
        )!;
        expect(clamped.damage).toBe(0); // 默认不允许负伤

        const negative = getDamageInfo(
            enemy(),
            null,
            null,
            null,
            ctx({ hero: hero({ mdef: 100 }), flags: { enableNegativeDamage: true } }),
        )!;
        expect(negative.damage).toBe(-90);
    });

    test('二倍斩技能', () => {
        const info = getDamageInfo(
            enemy({ hp: 200 }),
            null,
            null,
            null,
            ctx({ flags: { skill: 1 } }),
        )!;
        expect(info.hero_per_damage).toBe(100);
        expect(info.turn).toBe(2);
    });

    test('支援怪加入伤害且任一不可战则 null', () => {
        const enemys: Record<string, EnemyData> = {
            target: enemy(),
            helper: enemy({ special: 26, hp: 100, atk: 50 }),
        };
        const blocks = [block(0, 0, 'helper'), block(1, 0, 'target')];
        const info = getDamageInfo(enemys.target, null, 1, 0, ctx({ enemys, blocks }))!;
        expect(info.damage).toBe(50); // 本体 10 + 支援怪 40

        const unbeatable: Record<string, EnemyData> = {
            target: enemy(),
            helper: enemy({ special: 26, def: 999 }),
        };
        expect(
            getDamageInfo(unbeatable.target, null, 1, 0, ctx({ enemys: unbeatable, blocks })),
        ).toBeNull();
    });
});

describe('enemys 辅助函数', () => {
    test('canBattle 与 getDamageString', () => {
        const c = ctx();
        expect(canBattle(enemy(), null, null, c)).toBe(true);
        expect(getDamageString(enemy(), null, null, c)).toEqual({ damage: '10', color: '#FFFFFF' });
        expect(
            getDamageString(enemy({ def: 60 }), null, null, ctx({ hero: hero({ atk: 10 }) })),
        ).toEqual({ damage: '???', color: '#FF2222' });
    });

    test('getDefDamage', () => {
        expect(getDefDamage(enemy(), 5, null, null, ctx())).toBe(5); // 10 -> 5
    });

    test('nextCriticals 回合制', () => {
        const list = nextCriticals(enemy(), 1, null, null, ctx());
        expect(list[0]).toEqual([50, 10]);
    });

    test('nextCriticals 模仿 / 坚固返回空', () => {
        expect(nextCriticals(enemy({ special: 10 }), 1, null, null, ctx())).toEqual([]);
        expect(nextCriticals(enemy({ special: 3 }), 1, null, null, ctx())).toEqual([]);
    });

    test('nextCriticals 未破防先求破防攻击', () => {
        const list = nextCriticals(
            enemy({ hp: 100, def: 20 }),
            1,
            null,
            null,
            ctx({ hero: hero({ atk: 10 }) }),
        );
        expect(list[0][0]).toBe(11); // 10 -> 21 才能破防
    });
});
