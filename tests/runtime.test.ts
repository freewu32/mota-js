import { describe, expect, test } from 'bun:test';
import { MotaRuntime, type StorageLike } from '../src/engine/runtime';
import type { RuntimeData } from '../src/engine/types';

const data: RuntimeData = {
    tower: {
        main: { floorIds: ['f1', 'f2'] },
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
        values: { hatred: 2 },
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
        redPotion: { cls: 'items', name: '红血瓶' },
        yellowKey: { cls: 'tools', name: '黄钥匙' },
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
                [0, 0, 0],
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

    test('api 暴露 move/save/load/getState', () => {
        const storage = memStorage();
        const rt = new MotaRuntime(data, storage);
        expect(Object.keys(rt.api).sort()).toEqual(['getState', 'load', 'move', 'save']);
        rt.api.move(-1, 0);
        expect(rt.api.getState().hero.x).toBe(0);
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
});
