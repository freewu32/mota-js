import { describe, expect, test } from 'bun:test';
import type { ItemData } from '../src/engine/modules/control';
import { MotaItems, type ItemsHost } from '../src/engine/modules/items';
import { evaluateCondition, type ValueScope } from '../src/engine/modules/values';
import type { HeroState } from '../src/engine/types';

function hero(
    items: Partial<Record<'constants' | 'tools' | 'equips', Record<string, number>>> = {},
): HeroState {
    return {
        x: 0,
        y: 0,
        direction: 'up',
        hp: 100,
        atk: 10,
        def: 10,
        mdef: 10,
        money: 0,
        exp: 0,
        lv: 1,
        steps: 0,
        items: { constants: {}, tools: {}, equips: {}, ...items },
        equipment: [],
    };
}

const ITEMS: Record<string, ItemData> = {
    redPotion: {
        cls: 'items',
        name: '红血瓶',
        itemEffect: [{ type: 'setValue', name: 'status:hp', operator: '+=' }],
        itemEffectTip: '，生命+100',
        useItemEffect: [{ type: 'setValue', name: 'status:hp', operator: '+=' }],
        canUseItemEffect: 'true',
    },
    bigKey: {
        cls: 'items',
        name: '大钥匙',
        itemEffect: [{ type: 'addItem', id: 'yellowKey', count: 1 }],
    },
    yellowKey: { cls: 'tools', name: '黄钥匙' },
    superPotion: {
        cls: 'tools',
        name: '超级血瓶',
        useItemEffect: [{ type: 'setValue' }],
        canUseItemEffect: 'status:hp < 500',
    },
    lockedTool: { cls: 'tools', name: '未迁移道具' },
    sword1: { cls: 'equips', name: '铁剑', equip: { type: 0, value: { atk: 10 } } },
    shield1: { cls: 'equips', name: '铁盾', equip: { type: 1, value: { def: 5, mdef: 2 } } },
    percentSword: {
        cls: 'equips',
        name: '百分比剑',
        equip: { type: 0, value: { atk: 1 }, percentage: { atk: 10 } },
    },
    book: { cls: 'constants', name: '怪物手册' },
};

interface Harness {
    items: MotaItems;
    hero: HeroState;
    flags: Record<string, unknown>;
    scripts: unknown[];
    tips: string[];
    sounds: string[];
    routes: string[];
    values: Record<string, unknown>;
}

function harness(options: { hero?: HeroState; items?: Record<string, ItemData> } = {}): Harness {
    const heroState = options.hero ?? hero();
    const flags: Record<string, unknown> = {};
    const values: Record<string, unknown> = { redPotion: 100 };
    const scripts: unknown[] = [];
    const tips: string[] = [];
    const sounds: string[] = [];
    const routes: string[] = [];

    const scope = (): ValueScope => ({ flags, values, hero: heroState, globals: {} });
    const host: ItemsHost = {
        hero: heroState,
        items: structuredClone(options.items ?? ITEMS),
        flags,
        values,
        equipName: ['武器', '防具'],
        runScript: (actions) => void scripts.push(actions),
        scope,
        record: (token) => void routes.push(token),
        tip: (text) => void tips.push(text),
        playSound: (name) => void sounds.push(name),
    };

    return {
        items: new MotaItems(host),
        hero: heroState,
        flags,
        scripts,
        tips,
        sounds,
        routes,
        values,
    };
}

describe('背包', () => {
    test('add / count / has / remove 按类别归位', () => {
        const h = harness();
        h.items.add('yellowKey', 3);
        expect(h.hero.items.tools.yellowKey).toBe(3);
        expect(h.items.count('yellowKey')).toBe(3);
        expect(h.items.has('yellowKey')).toBe(true);

        h.items.remove('yellowKey', 2);
        expect(h.items.count('yellowKey')).toBe(1);
        h.items.remove('yellowKey', 1);
        expect(h.hero.items.tools.yellowKey).toBeUndefined();
        expect(h.items.has('yellowKey')).toBe(false);
    });

    test('即捡即用类道具不进背包', () => {
        const h = harness();
        h.items.add('redPotion', 1);
        expect(h.items.count('redPotion')).toBe(0);
    });

    test('永久道具只能有一个', () => {
        const h = harness();
        h.items.add('book', 5);
        expect(h.hero.items.constants.book).toBe(1);
    });

    test('set 直接覆盖数量，0 表示删除', () => {
        const h = harness();
        h.items.set('yellowKey', 2);
        expect(h.items.count('yellowKey')).toBe(2);
        h.items.set('yellowKey', 0);
        expect(h.hero.items.tools.yellowKey).toBeUndefined();
    });

    test('list 合并 flag:equipInfo 上的装备改动', () => {
        const h = harness({ hero: hero({ equips: { sword1: 1 } }) });
        h.flags.equipInfo = { sword1: { type: 0, value: { atk: 20 } } };
        const list = h.items.list();
        expect((list.sword1?.equip as { value: { atk: number } }).value.atk).toBe(20);
        expect(list.sword1?.id).toBe('sword1');
        // 原始数据不被修改
        expect((ITEMS.sword1?.equip as { value: { atk: number } }).value.atk).toBe(10);
    });
});

describe('拾取效果', () => {
    test('即捡即用：执行效果脚本并累计回血统计', () => {
        const h = harness();
        h.hero.hp = 100;
        const consumed = h.items.runPickUpEffect('redPotion', 1);
        expect(consumed).toBe(true);
        expect(h.scripts.length).toBe(1);
    });

    test('按数量执行多次（旧行为：loop itemNum 次）', () => {
        const h = harness();
        h.items.runPickUpEffect('redPotion', 3);
        expect(h.scripts.length).toBe(3);
    });

    test('非即捡即用类不处理', () => {
        const h = harness();
        expect(h.items.runPickUpEffect('yellowKey', 1)).toBe(false);
        expect(h.scripts.length).toBe(0);
    });

    test('提示文本走值块插值', () => {
        const h = harness({
            items: {
                redPotion: { ...ITEMS.redPotion, itemEffectTip: '，生命+${value:redPotion}' },
            },
        });
        expect(h.items.effectTip('redPotion')).toBe('，生命+100');
        expect(h.items.effectTip('yellowKey')).toBe('');
    });
});

describe('使用道具', () => {
    test('canUseItemEffect 通过时执行效果并扣减数量', () => {
        const h = harness({ hero: hero({ tools: { superPotion: 2 } }) });
        expect(h.items.use('superPotion')).toBe(true);
        expect(h.scripts.length).toBe(1);
        expect(h.items.count('superPotion')).toBe(1);
        expect(h.routes).toEqual(['item:superPotion']);
    });

    test('条件不通过时不消耗道具', () => {
        const h = harness({ hero: hero({ tools: { superPotion: 1 } }) });
        h.hero.hp = 900;
        expect(h.items.use('superPotion')).toBe(false);
        expect(h.items.count('superPotion')).toBe(1);
        expect(h.scripts.length).toBe(0);
    });

    test('没有 canUseItemEffect 时不可用（与旧实现一致）', () => {
        const h = harness({ hero: hero({ tools: { lockedTool: 1 } }) });
        expect(h.items.canUse('lockedTool')).toBe(false);
        expect(h.items.use('lockedTool')).toBe(false);
    });

    test('没有该道具时不可用', () => {
        const h = harness();
        expect(h.items.canUse('superPotion')).toBe(false);
    });

    test('noRoute 时不记录像', () => {
        const h = harness({ hero: hero({ tools: { superPotion: 1 } }) });
        h.items.use('superPotion', true);
        expect(h.routes).toEqual([]);
    });

    test('条件表达式解析失败时视为不可用', () => {
        const h = harness({
            hero: hero({ tools: { superPotion: 1 } }),
            items: { superPotion: { ...ITEMS.superPotion, canUseItemEffect: 'core.foo()' } },
        });
        expect(evaluateCondition('core.foo()', h.items['host'].scope())).toBe(false);
        expect(h.items.canUse('superPotion')).toBe(false);
    });
});

describe('装备', () => {
    test('换装：属性差、背包增减与槽位更新', () => {
        const h = harness({ hero: hero({ equips: { sword1: 1 } }) });
        expect(h.items.equip('sword1')).toBe(true);
        expect(h.hero.atk).toBe(20);
        expect(h.hero.equipment[0]).toBe('sword1');
        // 穿上的装备从背包里移除（数量归 0 即删除）
        expect(h.hero.items.equips.sword1).toBeUndefined();
        expect(h.tips.at(-1)).toBe('已装备上铁剑');
        expect(h.sounds).toContain('穿脱装备');
    });

    test('换装替换原有装备，属性差按新旧比较', () => {
        const h = harness({ hero: hero({ equips: { sword1: 1 } }) });
        h.items.equip('sword1');
        h.hero.items.equips.percentSword = 1;
        expect(h.items.equip('percentSword')).toBe(true);
        // 数值差：atk 1-10 = -9；百分比差：atk +0.1
        expect(h.hero.atk).toBe(11);
        expect(h.flags.__atk_buff__).toBe(1.1);
        expect(h.hero.items.equips.sword1).toBe(1);
    });

    test('卸下装备恢复属性并退回背包', () => {
        const h = harness({ hero: hero({ equips: { shield1: 1 } }) });
        h.items.equip('shield1');
        expect(h.hero.def).toBe(15);
        expect(h.items.unequip(1)).toBe(true);
        expect(h.hero.def).toBe(10);
        expect(h.hero.mdef).toBe(10);
        expect(h.hero.equipment[1]).toBeNull();
        expect(h.hero.items.equips.shield1).toBe(1);
    });

    test('没有该装备时不能换上', () => {
        const h = harness();
        expect(h.items.canEquip('sword1', true)).toBe(false);
        expect(h.tips.at(-1)).toBe('你当前没有铁剑，无法换装');
        expect(h.sounds).toContain('操作失败');
    });

    test('不是装备的道具不能换上', () => {
        const h = harness({ hero: hero({ tools: { yellowKey: 1 } }) });
        expect(h.items.canEquip('yellowKey', true)).toBe(false);
        expect(h.tips.at(-1)).toBe('不合法的装备！');
    });

    test('槽位不足时不换装', () => {
        const h = harness({ hero: hero({ equips: { shield1: 1 } }) });
        expect(h.items.equip('shield1')).toBe(true);
        const atkBefore = h.hero.atk;
        h.hero.items.equips.yellowKey = 1;
        expect(h.items.canEquip('yellowKey')).toBe(false);
        expect(h.hero.atk).toBe(atkBefore);
    });

    test('canUseItemEffect 不通过时不能换装', () => {
        const h = harness({
            hero: hero({ equips: { sword1: 1 } }),
            items: { sword1: { ...ITEMS.sword1, canUseItemEffect: 'status:atk > 100' } },
        });
        expect(h.items.canEquip('sword1', true)).toBe(false);
        expect(h.tips.at(-1)).toBe('当前不可换上铁剑');
    });

    test('compareEquip 只比较勇士上存在的数值属性', () => {
        const h = harness();
        expect(h.items.compareEquip('sword1', 'shield1')).toEqual({
            value: { atk: 10, def: -5, mdef: -2 },
            percentage: {},
        });
        expect(h.items.compareEquip('sword1', null)).toEqual({
            value: { atk: 10 },
            percentage: {},
        });
    });

    test('hasEquip / currentEquip / equipTypeById', () => {
        const h = harness({ hero: hero({ equips: { sword1: 1 } }) });
        expect(h.items.hasEquip('sword1')).toBe(false);
        h.items.equip('sword1');
        expect(h.items.hasEquip('sword1')).toBe(true);
        expect(h.items.currentEquip(0)).toBe('sword1');
        expect(h.items.equipTypeById('sword1')).toBe(0);
        expect(h.items.equipTypeById('yellowKey')).toBe(-1);
    });

    test('按名字找槽位：优先空槽，歧义返回 -1', () => {
        const h = harness({ hero: hero({ equips: { sword1: 1 } }) });
        h.items.equip('sword1');
        expect(h.items.equipTypeByName('武器')).toBe(0);
        expect(h.items.equipTypeByName('防具')).toBe(1);
        // 未在 equipName 里登记的名字找不到槽位
        expect(h.items.equipTypeByName('饰品')).toBe(-1);
    });
});

describe('套装', () => {
    test('保存并读取套装，记入录像', () => {
        const h = harness({ hero: hero({ equips: { sword1: 1, shield1: 1 } }) });
        h.items.equip('sword1');
        h.items.equip('shield1');
        h.items.saveLoadout(0);
        expect(h.routes).toEqual(['saveEquip:0']);
        expect(h.tips.at(-1)).toBe('已保存0号套装');

        h.items.unequip(0);
        h.items.unequip(1);
        expect(h.hero.atk).toBe(10);
        expect(h.items.loadLoadout(0)).toBe(true);
        expect(h.routes).toEqual(['saveEquip:0', 'loadEquip:0']);
        expect(h.hero.atk).toBe(20);
        expect(h.hero.def).toBe(15);
        expect(h.hero.equipment[0]).toBe('sword1');
    });

    test('套装不存在时提示', () => {
        const h = harness();
        expect(h.items.loadLoadout(2)).toBe(false);
        expect(h.tips.at(-1)).toBe('2号套装不存在');
    });

    test('任一装备当前不可用时整体放弃', () => {
        const h = harness({ hero: hero({ equips: { sword1: 1 } }) });
        h.items.equip('sword1');
        h.items.saveLoadout(0);
        h.items.unequip(0);
        h.items.remove('sword1');
        expect(h.items.loadLoadout(0)).toBe(false);
        expect(h.routes).toEqual(['saveEquip:0']);
    });

    test('换装过程中不重复播放音效', () => {
        const h = harness({ hero: hero({ equips: { sword1: 1, shield1: 1 } }) });
        h.items.equip('sword1');
        h.items.equip('shield1');
        h.items.saveLoadout(0);
        h.items.unequip(0);
        h.items.unequip(1);
        h.sounds.length = 0;
        h.items.loadLoadout(0);
        expect(h.sounds.filter((one) => one === '穿脱装备').length).toBe(1);
    });
});

describe('setEquip', () => {
    test('修改装备属性并写入 flag:equipInfo', () => {
        const h = harness();
        h.items.setEquip('sword1', 'value', 'atk', '5', '+=');
        const equip = h.items.list().sword1?.equip as { value: { atk: number } };
        expect(equip.value.atk).toBe(15);
        expect(
            (h.flags.equipInfo as Record<string, { value: { atk: number } }>).sword1.value.atk,
        ).toBe(15);
    });

    test('穿戴中修改属性会同步修正当前数值', () => {
        const h = harness({ hero: hero({ equips: { sword1: 1 } }) });
        h.items.equip('sword1');
        expect(h.hero.atk).toBe(20);
        h.items.setEquip('sword1', 'value', 'atk', '5', '+=');
        expect(h.hero.atk).toBe(25);
        // 临时装备不会留在道具表里
        expect(h.items['host'].items['temp:sword1']).toBeUndefined();
    });

    test('非装备类道具不做处理', () => {
        const h = harness();
        h.items.setEquip('yellowKey', 'value', 'atk', '5');
        expect(h.flags.equipInfo).toBeUndefined();
    });
});
