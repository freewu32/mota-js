import { describe, expect, test } from 'bun:test';
import { MotaRuntime } from '../src/engine/runtime';
import { ReplayController } from '../src/engine/modules/actions';
import type { RuntimeData } from '../src/engine/types';

/** 两层的塔：f1 可起飞，f2 可降落；含可用的消耗品与两件装备 */
const data: RuntimeData = {
    tower: {
        main: { floorIds: ['f1', 'f2'], equipName: ['武器', '防具'] },
        firstData: {
            title: 't',
            name: 'n',
            version: '1',
            floorId: 'f1',
            hero: {
                hp: 100,
                atk: 50,
                def: 10,
                mdef: 0,
                money: 0,
                exp: 0,
                lv: 1,
                items: { constants: {}, tools: {}, equips: {} },
                loc: { x: 0, y: 0, direction: 'down' },
            },
        },
        values: {},
        flags: {},
    },
    maps: { '1': { cls: 'terrains', id: 'ground' } },
    enemys: {},
    items: {
        superPotion: {
            cls: 'tools',
            name: '超级血瓶',
            canUseItemEffect: 'status:hp < 150',
            useItemEffect: [
                { type: 'setValue', name: 'status:hp', operator: '+=', value: '500' },
            ],
        },
        sword1: { cls: 'equips', name: '铁剑', equip: { type: 0, value: { atk: 10 } } },
        armor1: { cls: 'equips', name: '铁盾', equip: { type: 1, value: { def: 5 } } },
        hidden: { cls: 'tools', name: '隐藏道具', hideInToolbox: true },
    },
    floors: {
        f1: {
            floorId: 'f1',
            title: '一层',
            name: '1',
            map: [
                [0, 0],
                [0, 0],
            ],
            canFlyFrom: true,
        },
        f2: {
            floorId: 'f2',
            title: '二层',
            name: '2',
            map: [[0]],
            canFlyTo: true,
            flyPoint: [0, 0],
        },
    },
    icons: {},
};

describe('TurnDispatcher 内置 token', () => {
    test('方向 / 转向走统一入口并记录路线', () => {
        const rt = new MotaRuntime(data, null);
        expect(rt.turns.run('right')).toBe(true);
        expect(rt.state.hero.x).toBe(1);
        expect(rt.state.hero.direction).toBe('right');
        expect(rt.turns.run('turn')).toBe(true);
        // right 顺时针转 90 度 -> down
        expect(rt.state.hero.direction).toBe('down');
        expect(rt.turns.run('turn:left')).toBe(true);
        expect(rt.state.hero.direction).toBe('left');
        expect(rt.route.route).toEqual(['right', 'turn', 'turn:left']);
    });

    test('item: 先校验能否使用，成功才消费并记录像', () => {
        const rt = new MotaRuntime(data, null);
        // 没有道具时不可用
        expect(rt.turns.run('item:superPotion')).toBe(false);

        rt.items.add('superPotion', 1);
        const hpBefore = rt.state.hero.hp;
        expect(rt.turns.run('item:superPotion')).toBe(true);
        expect(rt.state.hero.hp).toBe(hpBefore + 500);
        expect(rt.route.route).toEqual(['item:superPotion']);

        // 血量条件不满足时 token 失败且不再消费
        rt.state.hero.hp = 999;
        rt.items.add('superPotion', 1);
        expect(rt.turns.run('item:superPotion')).toBe(false);
        expect(rt.items.count('superPotion')).toBe(1);
    });

    test('equip: / unEquip: 由分发器记录录像', () => {
        const rt = new MotaRuntime(data, null);
        rt.items.add('sword1', 1);
        const atkBefore = rt.state.hero.atk;

        expect(rt.turns.run('equip:sword1')).toBe(true);
        expect(rt.state.hero.atk).toBe(atkBefore + 10);
        expect(rt.state.hero.equipment[0]).toBe('sword1');
        expect(rt.route.route).toEqual(['equip:sword1']);

        expect(rt.turns.run('unEquip:0')).toBe(true);
        expect(rt.state.hero.equipment[0]).toBeNull();
        expect(rt.route.route).toEqual(['equip:sword1', 'unEquip:0']);
    });

    test('saveEquip: / loadEquip: 走套装接口', () => {
        const rt = new MotaRuntime(data, null);
        rt.items.add('sword1', 1);
        rt.items.add('armor1', 1);
        rt.turns.run('equip:sword1');
        rt.turns.run('equip:armor1');
        expect(rt.turns.run('saveEquip:0')).toBe(true);
        expect(rt.turns.run('unEquip:0')).toBe(true);
        expect(rt.turns.run('unEquip:1')).toBe(true);
        expect(rt.turns.run('loadEquip:0')).toBe(true);
        expect(rt.state.hero.equipment[0]).toBe('sword1');
        expect(rt.state.hero.equipment[1]).toBe('armor1');
        expect(rt.turns.run('loadEquip:2')).toBe(false); // 套装不存在
    });

    test('fly: 检查到达与可降落，并记录 fly 路线', () => {
        const tips: string[] = [];
        const rt = new MotaRuntime(data, null, { tip: (text) => void tips.push(text) });
        expect(rt.turns.run('fly:f2')).toBe(false); // 尚未到达
        expect(tips).toEqual(['无法飞往二层！']);

        rt.visitFloor('f2');
        expect(rt.turns.run('fly:f2')).toBe(true);
        expect(rt.state.floorId).toBe('f2');
        expect(rt.state.hero.x).toBe(0);
        expect(rt.route.route).toEqual(['fly:f2']);
    });

    test('非法 / 未知 token 返回 false', () => {
        const rt = new MotaRuntime(data, null);
        expect(rt.turns.run('nope')).toBe(false);
        expect(rt.turns.run('item:')).toBe(false);
        expect(rt.turns.run('equip:')).toBe(false);
        expect(rt.turns.run('unEquip:abc')).toBe(false);
        expect(rt.turns.run('turn:diagonal')).toBe(false);
        expect(rt.turns.run(42 as unknown)).toBe(false);
        expect(rt.turns.run('')).toBe(false);
    });
});

describe('TurnDispatcher 扩展点', () => {
    test('register 可覆盖内置处理器，unregister 还原', () => {
        const rt = new MotaRuntime(data, null);
        const calls: string[] = [];
        rt.turns.register('custom', (token) => {
            calls.push(token);
            return true;
        }, 10);
        expect(rt.turns.run('up')).toBe(true);
        expect(calls).toEqual(['up']);
        expect(rt.state.hero.y).toBe(0); // 内置移动被覆盖，勇士没动

        rt.turns.unregister('custom');
        expect(rt.turns.run('up')).toBe(true);
        expect(rt.state.hero.y).toBe(0); // 上边界，动不了
        expect(rt.turns.has('custom')).toBe(false);
    });

    test('同名注册覆盖旧项', () => {
        const rt = new MotaRuntime(data, null);
        const calls: number[] = [];
        rt.turns.register('dup', () => {
            calls.push(1);
            return true;
        });
        rt.turns.register('dup', () => {
            calls.push(2);
            return true;
        });
        expect(rt.turns.run('dup')).toBe(true);
        expect(calls).toEqual([2]);
    });

    test('处理器抛错时自动注销，不影响其它 token', () => {
        const rt = new MotaRuntime(data, null);
        const original = console.error;
        console.error = () => {};
        try {
            rt.turns.register('boom', () => {
                throw new Error('炸了');
            });
            expect(rt.turns.run('boom')).toBe(false);
            expect(rt.turns.has('boom')).toBe(false);
            expect(rt.turns.run('right')).toBe(true);
        } finally {
            console.error = original;
        }
    });
});

describe('ReplayController 与回合分发器共用录像 token', () => {
    test('按录像逐个执行 token，路线一致', () => {
        const rt = new MotaRuntime(data, null);
        rt.items.add('superPotion', 1);
        const replay = new ReplayController<never>();
        expect(replay.start(['right', 'turn', 'item:superPotion'])).toBe(true);

        for (;;) {
            const token = replay.next(true);
            if (token == null) break;
            expect(rt.turns.run(token)).toBe(true);
        }
        expect(rt.route.route).toEqual(['right', 'turn', 'item:superPotion']);
        expect(replay.state.failed).toBe(false);
    });
});

describe('运行时面板数据', () => {
    test('toolboxView 分栏、排序并过滤隐藏道具', () => {
        const rt = new MotaRuntime(data, null);
        rt.items.add('superPotion', 2);
        rt.items.add('hidden', 1);
        rt.items.add('sword1', 1);

        const view = rt.toolboxView();
        expect(view.tools.map((one) => one.id)).toEqual(['superPotion']);
        expect(view.equips.map((one) => one.id)).toEqual(['sword1']);
        expect(view.constants).toEqual([]);
        expect(view.tools[0]!.count).toBe(2);
        expect(view.tools[0]!.usable).toBe(true);
        expect(view.equips[0]!.equippable).toBe(true);
    });

    test('equipView 给出当前装备与属性差', () => {
        const rt = new MotaRuntime(data, null);
        rt.items.add('sword1', 1);
        rt.items.add('armor1', 1);

        const empty = rt.equipView();
        expect(empty.map((slot) => slot.label)).toEqual(['武器', '防具']);
        expect(empty[0]!.current).toBeNull();
        expect(empty[0]!.candidates.map((one) => one.id)).toEqual(['sword1']);
        expect(empty[0]!.candidates[0]!.value.atk).toBe(10);
        expect(empty[1]!.candidates.map((one) => one.id)).toEqual(['armor1']);
        expect(empty[1]!.candidates[0]!.value.def).toBe(5);

        rt.turns.run('equip:sword1');
        const equipped = rt.equipView();
        expect(equipped[0]!.current?.id).toBe('sword1');
        expect(equipped[0]!.candidates).toEqual([]);
    });

    test('floorView 标注当前层与可传送状态', () => {
        const rt = new MotaRuntime(data, null);
        let view = rt.floorView();
        expect(view.map((one) => one.floorId)).toEqual(['f1', 'f2']);
        expect(view[0]!.current).toBe(true);
        expect(view[0]!.selectable).toBe(false); // f1 未开启 canFlyTo
        expect(view[1]!.selectable).toBe(false); // f2 尚未到达

        rt.visitFloor('f2');
        view = rt.floorView();
        expect(view[1]!.selectable).toBe(true);
        expect(view[1]!.name).toBe('二层');
    });

    test('楼层传送后标记为已到达并写进存档', () => {
        const rt = new MotaRuntime(data, null);
        rt.start(); // 开局：初始层视为一次抵达
        rt.visitFloor('f2');
        rt.flyTo('f2');
        expect(rt.hasVisited('f2')).toBe(true);
        expect(rt.hasVisited('f1')).toBe(true); // 初始层
    });
});
