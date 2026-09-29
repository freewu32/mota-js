import { describe, expect, test } from 'bun:test';
import { evaluateValue } from '../src/engine/modules/values';
import { MotaRuntime, type StorageLike } from '../src/engine/runtime';
import type { RuntimeData } from '../src/engine/types';

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
                loc: { x: 1, y: 0, direction: 'down' },
            },
        },
        values: { hatred: 2, redPotion: 100 },
        flags: { enableNegativeDamage: true },
    },
    maps: {
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
    },
    enemys: {
        slime: { name: '史莱姆', hp: 30, atk: 5, def: 0, money: 5, exp: 3, point: 0, special: 0 },
    },
    items: {
        redPotion: {
            cls: 'items',
            name: '红血瓶',
            itemEffect: [
                { type: 'setValue', name: 'status:hp', operator: '+=', value: 'value:redPotion' },
            ],
            itemEffectTip: '，生命+${value:redPotion}',
        },
        yellowKey: { cls: 'tools', name: '黄钥匙' },
        superPotion: {
            cls: 'tools',
            name: '超级血瓶',
            canUseItemEffect: 'status:hp < 150',
            useItemEffect: [{ type: 'setValue', name: 'status:hp', operator: '+=', value: '500' }],
        },
        sword1: { cls: 'equips', name: '铁剑', equip: { type: 0, value: { atk: 10 } } },
    },
    icons: {},
    floors: {
        f1: {
            floorId: 'f1',
            title: '一层',
            name: '1',
            map: [
                [11, 0, 0],
                [0, 0, 12],
                [3, 20, 2],
            ],
            changeFloor: { '0,2': { floorId: 'f2', loc: [1, 1] } },
        },
        f2: {
            floorId: 'f2',
            title: '二层',
            name: '2',
            map: [
                [10, 0, 0],
                [0, 0, 0],
                [0, 0, 0],
            ],
        },
    },
};

function memStorage(): StorageLike & { map: Map<string, string> } {
    const map = new Map<string, string>();
    return {
        map,
        getItem: (k) => map.get(k) ?? null,
        setItem: (k, v) => void map.set(k, v),
    };
}

describe('MotaRuntime', () => {
    test('初始状态来自 firstData 与默认位置', () => {
        const rt = new MotaRuntime(data, null);
        expect(rt.state.floorId).toBe('f1');
        expect(rt.state.hero.x).toBe(1);
        expect(rt.state.hero.y).toBe(0);
        expect(rt.state.hero.hp).toBe(100);
        expect(rt.state.hero.direction).toBe('down');
    });

    test('移动在边界内生效，越界不动', () => {
        const rt = new MotaRuntime(data, null);
        rt.move(-1, 0);
        expect(rt.state.hero.x).toBe(0);
        rt.move(-1, 0);
        expect(rt.state.hero.x).toBe(0); // 左边界
    });

    test('canPass 判断地形与阻挡', () => {
        const rt = new MotaRuntime(data, null);
        expect(rt.canPass(1, 1)).toBe(true); // 空地
        expect(rt.canPass(2, 2)).toBe(false); // 墙
        expect(rt.canPass(2, 1)).toBe(false); // 门
        expect(rt.canPass(-1, 0)).toBe(false); // 越界
    });

    test('不能走进墙', () => {
        const rt = new MotaRuntime(data, null);
        rt.move(1, 0); // -> (2,0)
        rt.move(0, 1); // -> (2,1) 门，未持钥匙，不动
        expect(rt.state.hero.x).toBe(2);
        expect(rt.state.hero.y).toBe(0);
    });

    test('踩到物品拾取并移除图块', () => {
        const rt = new MotaRuntime(data, null);
        const result = rt.move(-1, 0); // 走到 (0,0) 黄钥匙
        expect(result.action).toBe('item');
        expect(rt.state.hero.items.tools.yellowKey).toBe(1);
        expect(rt.canPass(0, 0)).toBe(true); // 移除后仍可通行
    });

    test('持钥匙可开门并消耗钥匙', () => {
        const rt = new MotaRuntime(data, null);
        rt.move(-1, 0); // 拿钥匙
        rt.move(1, 0); // 回 (1,0)
        rt.move(1, 0); // (2,0)
        const opened = rt.move(0, 1); // 开门
        expect(opened.action).toBe('door');
        expect(rt.state.hero.items.tools.yellowKey ?? 0).toBe(0);
        expect(rt.canPass(2, 1)).toBe(true);
    });

    test('战斗获胜后扣血、加钱加经验并移除怪物', () => {
        const rt = new MotaRuntime(data, null);
        rt.move(0, 1); // (1,1)
        const result = rt.move(0, 1); // 打 (1,2) 史莱姆
        expect(result.action).toBe('battle');
        expect(rt.state.hero.money).toBe(5);
        expect(rt.state.hero.exp).toBe(3);
        expect(rt.state.hero.hp).toBe(100); // 伤害为 0
        expect(rt.canPass(1, 2)).toBe(true);
    });

    test('踩到楼梯切换楼层与坐标', () => {
        const rt = new MotaRuntime(data, null);
        rt.move(0, 1); // (1,1)
        rt.move(-1, 0); // (0,1)
        const result = rt.move(0, 1); // (0,2) 楼梯
        expect(result.action).toBe('floor');
        expect(rt.state.floorId).toBe('f2');
        expect(rt.state.hero.x).toBe(1);
        expect(rt.state.hero.y).toBe(1);
    });

    test('存档与读档往返，包含已移除图块', () => {
        const storage = memStorage();
        const rt = new MotaRuntime(data, storage);
        rt.move(-1, 0); // 拿钥匙
        expect(rt.save()).toBe(true);
        expect(storage.map.size).toBe(1);

        const rt2 = new MotaRuntime(data, storage);
        expect(rt2.load()).toBe(true);
        expect(rt2.state.hero.items.tools.yellowKey).toBe(1);
        expect(rt2.state.flags['__block_f1_0_0__']).toBe(true);
    });

    test('无 storage 时 save/load 返回 false', () => {
        const rt = new MotaRuntime(data, null);
        expect(rt.save()).toBe(false);
        expect(rt.load()).toBe(false);
    });

    test('api 暴露移动、存档与道具操作', () => {
        const storage = memStorage();
        const rt = new MotaRuntime(data, storage);
        expect(Object.keys(rt.api).sort()).toEqual([
            'addItem',
            'equip',
            'getState',
            'hasItem',
            'load',
            'move',
            'save',
            'unequip',
            'useItem',
        ]);
        rt.api.move(-1, 0);
        expect(rt.api.getState().hero.x).toBe(0);
    });

    test('valueScope 供值块求值（含注入函数）', () => {
        const rt = new MotaRuntime(data, null);
        expect(evaluateValue('value:hatred', rt.valueScope())).toBe(2);
        expect(evaluateValue('status:hp', rt.valueScope())).toBe(100);
        rt.functions.rand = () => 7;
        expect(evaluateValue('rand()', rt.valueScope())).toBe(7);
    });

    test('nextLvUpNeed 按等级表求值，满级返回 null', () => {
        const withLevel: RuntimeData = structuredClone(data);
        (withLevel.tower.firstData as Record<string, unknown>).levelUp = [
            { need: '0', title: '新手' },
            { need: '20', title: '学徒' },
            { need: 'status:lv * 50', title: '老兵' },
        ];
        const rt = new MotaRuntime(withLevel, null);
        expect(rt.nextLvUpNeed()).toBe(20);
        rt.state.hero.lv = 2;
        expect(rt.nextLvUpNeed()).toBe(100); // 2 * 50
        rt.state.hero.lv = 3;
        expect(rt.nextLvUpNeed()).toBeNull(); // 已满级
    });

    test('levelUpLeftMode 时下一级经验按差值显示', () => {
        const withLevel: RuntimeData = structuredClone(data);
        (withLevel.tower.firstData as Record<string, unknown>).levelUp = [
            { need: '0' },
            { need: '20' },
        ];
        withLevel.tower.flags.statusBarItems = ['enableLevelUp', 'levelUpLeftMode'];
        const rt = new MotaRuntime(withLevel, null);
        rt.state.hero.exp = 5;
        expect(rt.nextLvUpNeed()).toBe(15);
    });

    test('statusBarView 反映状态栏开关与道具', () => {
        const rt = new MotaRuntime(data, null);
        expect(rt.statusBarView().visibility.slots).toEqual([]);
        expect(rt.statusBarView().slots.floor).toBe('1'); // 楼层名取自 floor.name

        rt.move(-1, 0); // 拾取黄钥匙
        const bar = rt.statusBarView();
        expect(bar.keys.find((one) => one.id === 'yellowKey')?.count).toBe('01');
    });

    test('listEnemies 返回怪物伤害信息', () => {
        const rt = new MotaRuntime(data, null);
        const list = rt.listEnemies();
        expect(list).toHaveLength(1);
        expect(list[0].id).toBe('slime');
        expect(list[0].damage).toBe('0');
    });

    test('撞上剧本事件块时执行剧本并停步', () => {
        const withEvent: RuntimeData = structuredClone(data);
        withEvent.floors.f1.events = { '1,1': ['你好'] };
        const rt = new MotaRuntime(withEvent, null);
        const texts: string[] = [];
        rt.setPresenter({
            text: (text, _data, done) => {
                texts.push(text);
                done();
            },
        });

        const result = rt.move(0, 1); // 目标 (1,1) 的 NPC
        expect(result.action).toBe('event');
        expect(result.moved).toBe(false);
        expect(texts).toEqual(['你好']);
        expect(rt.state.hero.y).toBe(0); // 剧本事件不移动
        expect(rt.state.hero.direction).toBe('down');
    });

    test('移动、转向与剧本事件都记入录像路线', () => {
        const rt = new MotaRuntime(data, null);
        rt.move(-1, 0); // 走到 (0,0) 黄钥匙，朝向 left
        rt.turn(); // 顺时针：left -> up
        rt.turn('down');
        expect(rt.route.route).toEqual(['left', 'turn', 'turn:down']);

        const withEvent: RuntimeData = structuredClone(data);
        withEvent.floors.f1.events = { '1,1': ['你好'] };
        const rt2 = new MotaRuntime(withEvent, null);
        rt2.move(0, 1);
        expect(rt2.route.route).toEqual(['down']);
    });

    test('存档包含录像路线并可还原', () => {
        const storage = memStorage();
        const rt = new MotaRuntime(data, storage);
        rt.move(-1, 0);
        rt.turn('down');
        expect(rt.save()).toBe(true);

        const raw = JSON.parse(storage.map.get('mota-save-v3') as string) as {
            route: string;
        };
        expect(typeof raw.route).toBe('string');

        const rt2 = new MotaRuntime(data, storage);
        expect(rt2.load()).toBe(true);
        expect(rt2.route.route).toEqual(['left', 'turn:down']);
    });

    test('拾取即捡即用道具：立刻生效、不进背包并弹出提示', () => {
        const tips: string[] = [];
        const rt = new MotaRuntime(data, null, {
            tip: (text) => void tips.push(text),
        });
        rt.move(0, 1); // (1,1)
        rt.move(-1, 0); // (0,1)
        rt.move(0, 1); // (0,2) 楼梯 -> 二层 (1,1)
        expect(rt.state.floorId).toBe('f2');

        const hpBefore = rt.state.hero.hp;
        rt.move(-1, 0); // (0,1)
        const result = rt.move(0, -1); // (0,0) 红血瓶
        expect(result.action).toBe('item');
        expect(rt.state.hero.hp).toBe(hpBefore + 100);
        expect(rt.items.has('redPotion')).toBe(false);
        expect(tips).toEqual(['，生命+100']);
        expect(rt.state.hero.statistics?.hp).toBe(100);
        // 图块被移除，可以再走上去
        // 图块被禁用（旧 `removeBlock` 语义），可以再走上去
        expect(rt.canPass(0, 0)).toBe(true);
        expect(rt.getBlocks('f2').find((b) => b.x === 0 && b.y === 0)?.disable).toBe(true);
    });

    test('使用背包道具：条件校验、扣数量并记录像', () => {
        const rt = new MotaRuntime(data, null);
        rt.items.add('superPotion', 2);
        expect(rt.items.has('superPotion')).toBe(true);

        const hpBefore = rt.state.hero.hp;
        expect(rt.items.use('superPotion')).toBe(true);
        expect(rt.state.hero.hp).toBe(hpBefore + 500);
        expect(rt.items.count('superPotion')).toBe(1);
        expect(rt.route.route).toEqual(['item:superPotion']);

        // 回满血后条件不再满足，道具不会被消耗
        rt.state.hero.hp = 999;
        expect(rt.items.use('superPotion')).toBe(false);
        expect(rt.items.count('superPotion')).toBe(1);
    });

    test('装备与卸下：属性差生效并写入槽位，录像记 item 之外不额外记录', () => {
        const rt = new MotaRuntime(data, null);
        rt.items.add('sword1', 1);
        const atkBefore = rt.state.hero.atk;

        expect(rt.items.equip('sword1')).toBe(true);
        expect(rt.state.hero.atk).toBe(atkBefore + 10);
        expect(rt.state.hero.equipment[0]).toBe('sword1');
        expect(rt.state.hero.items.equips.sword1).toBeUndefined();

        expect(rt.items.unequip(0)).toBe(true);
        expect(rt.state.hero.atk).toBe(atkBefore);
        expect(rt.items.count('sword1')).toBe(1);
    });

    test('毒衰咒道具：条件成立时解除状态', () => {
        const withWine: RuntimeData = structuredClone(data);
        withWine.items.poisonWine = {
            cls: 'tools',
            name: '解毒药水',
            canUseItemEffect: 'flag:poison',
            useItemEffect: [{ type: 'triggerDebuff', action: 'remove', kind: 'poison' }],
        };
        const rt = new MotaRuntime(withWine, null);
        rt.items.add('poisonWine', 1);
        expect(rt.items.canUse('poisonWine')).toBe(false);

        rt.events.start([{ type: 'triggerDebuff', kind: 'poison' }]);
        expect(rt.state.flags.poison).toBe(true);
        expect(rt.items.canUse('poisonWine')).toBe(true);
        expect(rt.items.use('poisonWine')).toBe(true);
        expect(rt.state.flags.poison).toBe(false);
    });
});
