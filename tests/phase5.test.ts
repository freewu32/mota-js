import { describe, expect, test } from 'bun:test';
import { MotaRuntime } from '../src/engine/runtime';
import { createHeadlessPresenter, type EventPresenter } from '../src/engine/modules/events';
import type { RuntimeData } from '../src/engine/types';

/**
 * 一个「演示塔」：两层楼，怪物与商店都齐了，供阶段 5 的新能力做端到端验证。
 */
function demoData(overrides: Partial<RuntimeData['tower']['firstData']> = {}): RuntimeData {
    return {
        tower: {
            main: { floorIds: ['f1', 'f2'], equipName: ['武器'] },
            firstData: {
                title: 't',
                name: 'n',
                version: '1',
                floorId: 'f1',
                hero: {
                    hp: 1000,
                    atk: 100,
                    def: 100,
                    mdef: 0,
                    money: 100,
                    exp: 0,
                    lv: 1,
                    items: { constants: {}, tools: {}, equips: {} },
                    loc: { x: 0, y: 0, direction: 'down' },
                },
                shops: [
                    {
                        id: 'shop1',
                        text: '金币商店',
                        textInList: '1F金币商店',
                        choices: [
                            {
                                text: '生命+800',
                                need: 'status:money>=20',
                                action: [
                                    {
                                        type: 'setValue',
                                        name: 'status:money',
                                        operator: '-=',
                                        value: '20',
                                    },
                                    {
                                        type: 'setValue',
                                        name: 'status:hp',
                                        operator: '+=',
                                        value: '800',
                                    },
                                ],
                            },
                        ],
                    },
                ],
                ...overrides,
            },
            values: { moveSpeed: 100, hatred: 0 },
            flags: { enableMoveDirectly: true },
        },
        maps: {
            '10': { cls: 'enemys', id: 'slime' },
            '11': { cls: 'enemys', id: 'guard' },
            '12': { cls: 'animates', id: 'wall' },
            '13': { cls: 'items', id: 'yellowKey' },
            '14': { cls: 'terrains', id: 'upFloor', canPass: true },
        },
        enemys: {
            // 攻高一点，保证伤害 > 0，便于断言「只结算一次」
            slime: {
                name: '史莱姆',
                hp: 10,
                atk: 200,
                def: 0,
                money: 5,
                exp: 3,
                point: 0,
                special: [],
            },
            guard: {
                name: '守卫',
                hp: 10,
                atk: 1,
                def: 0,
                money: 7,
                exp: 4,
                point: 0,
                special: [26],
            },
        },
        items: { yellowKey: { cls: 'tools', name: '黄钥匙' } },
        icons: {},
        floors: {
            f1: {
                floorId: 'f1',
                title: '一层',
                name: '1',
                // (1,1) 是「被支援」的怪，(2,1) 是带支援技能的守卫
                map: [
                    [0, 0, 0, 12],
                    [0, 10, 11, 12],
                    [0, 0, 14, 12],
                ],
                changeFloor: { '2,2': null },
            },
            f2: {
                floorId: 'f2',
                title: '二层',
                name: '2',
                map: [
                    [0, 0],
                    [0, 0],
                ],
            },
        },
    };
}

function memStorage() {
    const map = new Map<string, string>();
    return {
        map,
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => void map.set(k, v),
    };
}

describe('战前剧本（beforeBattle）', () => {
    test('楼层 beforeBattle：先跑剧本，再打，最后只算一次伤害', () => {
        const data = demoData();
        const floor = data.floors.f1 as Record<string, unknown>;
        floor.beforeBattle = { '1,1': [{ type: 'tip', text: '先聊两句' }] };
        const tips: string[] = [];
        const presenter: EventPresenter = {
            ...createHeadlessPresenter(),
            tip: (text) => void tips.push(text),
        };
        const rt = new MotaRuntime(data, null, presenter);
        rt.move(1, 1); // 走到 (1,1) 前的准备：从 (0,0) 向下到 (0,1)
        rt.move(1, 0); // 现在在 (1,1)? 不，先确认位置
        // 直接对着 (1,1) 的怪走
        rt.state.hero.x = 0;
        rt.state.hero.y = 1;
        const money = rt.state.hero.money;
        const exp = rt.state.hero.exp;
        rt.move(1, 0);
        expect(tips).toContain('先聊两句');
        // 剧本之后确实打了（史莱姆被秒，奖励到手），而且只结算一次；
        // 旁边的守卫（support）一起参战，因此金币经验也含它一份
        expect(rt.state.hero.money).toBe(money + 5 + 7);
        expect(rt.state.hero.exp).toBe(exp + 3 + 4);
        expect(rt.api.blockId(1, 1)).toBeNull();
        const afterOnce = { money: rt.state.hero.money, exp: rt.state.hero.exp };
        rt.update();
        expect({ money: rt.state.hero.money, exp: rt.state.hero.exp }).toEqual(afterOnce);
    });

    test('怪物自己的 beforeBattle 也会先生效', () => {
        const data = demoData();
        (data.enemys.slime as Record<string, unknown>).beforeBattle = [
            { type: 'tip', text: '怪物先说话' },
        ];
        const tips: string[] = [];
        const rt = new MotaRuntime(data, null, {
            ...createHeadlessPresenter(),
            tip: (text) => void tips.push(text),
        });
        rt.move(1, 1); // 到 (1,0)? 说明：向下走到 (1,0)
        rt.state.hero.x = 0;
        rt.state.hero.y = 1;
        rt.move(1, 0);
        expect(tips).toContain('怪物先说话');
    });
});

describe('支援怪（guards）', () => {
    test('打主怪时支援怪一起结算金币经验，并一起消失', () => {
        const data = demoData();
        const rt = new MotaRuntime(data, null);
        rt.state.hero.x = 0;
        rt.state.hero.y = 1;
        const money = rt.state.hero.money;
        const exp = rt.state.hero.exp;
        const result = rt.move(1, 0); // 打 (1,1) 的 slime，旁边 (2,1) 是支援怪 guard
        expect(result.action).toBe('battle');
        expect(rt.state.hero.money).toBe(money + 5 + 7);
        expect(rt.state.hero.exp).toBe(exp + 3 + 4);
        // 主怪与支援怪都被移除
        expect(rt.api.blockId(1, 1)).toBeNull();
        expect(rt.api.blockId(2, 1)).toBeNull();
    });
});

describe('跟随者（引擎侧）', () => {
    test('follow / unfollow 动作改状态，移动时跟随者跟上', () => {
        const data = demoData();
        const rt = new MotaRuntime(data, null);
        rt.events.start([
            { type: 'follow', name: 'bear.png' },
            { type: 'text', text: '跟上了' },
        ]);
        expect(rt.state.hero.followers).toHaveLength(1);
        expect(rt.state.hero.followers![0]).toMatchObject({ name: 'bear.png', x: 0, y: 0 });
        rt.move(0, 1);
        expect(rt.state.hero.followers![0]).toMatchObject({ x: 0, y: 0, stop: false });

        rt.events.start([{ type: 'unfollow' }]);
        expect(rt.state.hero.followers).toHaveLength(0);
    });

    test('保存与读取会带上跟随者', () => {
        const data = demoData();
        const storage = memStorage();
        const rt = new MotaRuntime(data, storage);
        rt.events.start([{ type: 'follow', name: 'bear.png' }]);
        rt.save();
        rt.events.start([{ type: 'unfollow' }]);
        expect(rt.state.hero.followers).toHaveLength(0);
        rt.load();
        expect(rt.state.hero.followers).toHaveLength(1);
    });
});

describe('商店（运行时侧）', () => {
    test('shopView / openQuickShop / 录像', () => {
        const data = demoData();
        const recorded: string[] = [];
        const rt = new MotaRuntime(data, null);
        rt.turns.register('spy', (token) => {
            recorded.push(token);
            return false;
        });
        expect(rt.shopView()).toEqual([
            { id: 'shop1', text: '1F金币商店', visited: false, canOpen: true },
        ]);
        expect(rt.openQuickShop('shop1')).toBe(true);
        expect(rt.route.route).toContain('shop:shop1');
        expect(rt.shops.isVisited('shop1')).toBe(false); // 只是打开，还没访问过
        rt.shops.setVisited('shop1', true);
        expect(rt.shopView()[0]!.visited).toBe(true);
    });

    test('楼层 canUseQuickShop: false 时拒绝', () => {
        const data = demoData();
        (data.floors.f1 as Record<string, unknown>).canUseQuickShop = false;
        const rt = new MotaRuntime(data, null);
        expect(rt.openQuickShop('shop1')).toBe(false);
        expect(rt.route.route).toHaveLength(0);
    });
});

describe('自动寻路（运行时侧）', () => {
    test('findPath 绕过墙；findDirectPath 只在空白格上走', () => {
        const data = demoData();
        const rt = new MotaRuntime(data, null);
        // (3,1) 是墙，(1,1)/(2,1) 是怪：目标 (2,2) 只能绕到下面那行
        const path = rt.findPath(2, 2);
        expect(path.map((step) => [step.x, step.y])).toEqual([
            [0, 1],
            [0, 2],
            [1, 2],
            [2, 2],
        ]);
        // 瞬移路径不会穿过 (1,1) / (2,1) 的怪物，从 (0,1) 绕到下面
        const direct = rt.findDirectPath(2, 2);
        expect(direct.some((step) => step.x === 1 && step.y === 1)).toBe(false);
        expect(direct.some((step) => step.x === 2 && step.y === 1)).toBe(false);
        expect([direct[direct.length - 1]!.x, direct[direct.length - 1]!.y]).toEqual([2, 2]);
    });

    test('tryMoveDirectly 沿通道瞬移并记录方向', () => {
        const data = demoData();
        const rt = new MotaRuntime(data, null);
        const ok = rt.tryMoveDirectly(0, 2);
        expect(ok).toBe(true);
        expect([rt.state.hero.x, rt.state.hero.y]).toEqual([0, 2]);
        expect(rt.route.route).toEqual(['down', 'down']);
    });

    test('__potionNoRouting__ 让寻路绕开中间的血瓶', () => {
        const data = demoData();
        data.maps['15'] = { cls: 'items', id: 'redPotion' };
        data.items.redPotion = { cls: 'items', name: '红血瓶' };
        // 全空的三行地图，血瓶摆在正中间 (1,1)
        data.floors.f1!.map = [
            [0, 0, 0],
            [0, 15, 0],
            [0, 0, 0],
        ];
        data.floors.f1!.changeFloor = {};
        const rt = new MotaRuntime(data, null);
        rt.state.flags.__potionNoRouting__ = true;
        const path = rt.findPath(2, 2);
        // 「绕开血瓶」只是加价：路还是 4 步，但不从血瓶上走
        expect(path).toHaveLength(4);
        expect(path.some((step) => step.x === 1 && step.y === 1)).toBe(false);

        // 不加价时会从中间穿过去（4 步里包含血瓶那格）
        const plain = new MotaRuntime(data, null);
        expect(plain.findPath(2, 2).some((step) => step.x === 1 && step.y === 1)).toBe(true);
    });
});

describe('塔作者 UI 定制', () => {
    test('firstData.ui 影响帮助文本与统计项', () => {
        const data = demoData({ ui: { about: '塔作者的话', statistics: ['yellowKey'] } });
        const rt = new MotaRuntime(data, null);
        expect(rt.aboutText()).toBe('塔作者的话');
        expect(rt.statisticsView()).toEqual([{ id: 'yellowKey', name: '黄钥匙', count: 0 }]);
        // (2,1) 的黄钥匙？数据里没有黄钥匙，换个有道具的层验证计数
        data.maps['16'] = { cls: 'items', id: 'yellowKey' };
        data.floors.f1!.map[3] = [13, 0, 0, 12];
        const rt2 = new MotaRuntime(data, null);
        expect(rt2.statisticsView()).toEqual([{ id: 'yellowKey', name: '黄钥匙', count: 1 }]);
    });

    test('脚本钩子优先于声明式配置', () => {
        const data = demoData({ ui: { about: '塔作者的话', statistics: ['yellowKey'] } });
        const rt = new MotaRuntime(data, null);
        rt.registerUiHooks({
            about: () => '脚本说了算',
            statistics: () => [],
        });
        expect(rt.aboutText()).toBe('脚本说了算');
        expect(rt.statisticsView()).toEqual([]);
    });

    test('toolboxSort: name 改变道具栏顺序', () => {
        const data = demoData({ ui: { toolboxSort: 'name' } });
        data.items.zebra = { cls: 'tools', name: 'Ａ道具' };
        data.items.alpha = { cls: 'tools', name: 'Ｂ道具' };
        const rt = new MotaRuntime(data, null);
        rt.items.add('zebra');
        rt.items.add('alpha');
        expect(rt.toolboxView().tools.map((one) => one.id)).toEqual(['zebra', 'alpha']);

        // 默认按 id 升序
        const plain = new MotaRuntime(demoData(), null);
        plain.items.add('zebra');
        plain.items.add('alpha');
        expect(plain.toolboxView().tools.map((one) => one.id)).toEqual(['alpha', 'zebra']);
    });
});
