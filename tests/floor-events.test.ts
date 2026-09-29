import { describe, expect, test } from 'bun:test';
import {
    FloorEvents,
    arriveActions,
    collectAutoEvents,
    positionActions,
    type FloorEventsHost,
} from '../src/engine/modules/floor-events';
import { MotaRuntime } from '../src/engine/runtime';
import type { RuntimeData } from '../src/engine/types';

describe('楼层生命周期：纯函数', () => {
    test('arriveActions：firstArrive 在 eachArrive 之前，首次之后只剩 eachArrive', () => {
        const floor = { firstArrive: ['first'], eachArrive: ['each'] };
        expect(arriveActions(floor, true)).toEqual(['first', 'each']);
        expect(arriveActions(floor, false)).toEqual(['each']);
        expect(arriveActions(undefined, true)).toEqual([]);
        expect(arriveActions({ firstArrive: [] }, true)).toEqual([]);
    });

    test('positionActions：数组 / {data} / 缺失', () => {
        const floor = {
            afterBattle: { '1,2': ['win'], '3,4': { data: ['gentle'], disableOnGentleClick: true } },
        };
        expect(positionActions(floor, 'afterBattle', 1, 2)).toEqual(['win']);
        expect(positionActions(floor, 'afterBattle', 3, 4)).toEqual(['gentle']);
        expect(positionActions(floor, 'afterBattle', 9, 9)).toEqual([]);
        expect(positionActions(floor, 'afterOpenDoor', 1, 2)).toEqual([]);
        expect(positionActions(undefined, 'afterBattle', 1, 2)).toEqual([]);
    });

    test('collectAutoEvents：跳过缺 condition/data 的项，按优先级 / 楼层 / 坐标 / 序号排序', () => {
        const floors: Record<string, Record<string, unknown>> = {
            f1: {
                autoEvent: {
                    '1,1': { 0: { condition: 'true', data: ['a'], priority: 1 } },
                },
            },
            f2: {
                autoEvent: {
                    '0,0': { 0: { condition: 'true', data: ['b'], priority: 5 } },
                    '2,2': {
                        0: { condition: 'true', data: ['c'] },
                        1: { data: ['no condition'] },
                    },
                },
            },
        };
        const events = collectAutoEvents(['f1', 'f2'], (id) => floors[id]);
        expect(events.map((one) => one.symbol)).toEqual([
            'f2@0@0@0',
            'f1@1@1@0',
            'f2@2@2@0',
        ]);
        expect(events[1]!.x).toBe(1);
        expect(events[1]!.currentFloor).toBe(false);
        expect(events[1]!.multiExecute).toBe(false);
    });
});

describe('FloorEvents 调度', () => {
    function makeHost(): {
        host: FloorEventsHost;
        inserted: { actions: unknown; x?: number | null }[];
        flags: Record<string, unknown>;
    } {
        const flags: Record<string, unknown> = {};
        const inserted: { actions: unknown; x?: number | null }[] = [];
        const floors: Record<string, Record<string, unknown>> = {
            f1: {
                firstArrive: ['first'],
                eachArrive: ['each'],
                afterBattle: { '1,1': ['win'] },
                autoEvent: {
                    '2,2': { 0: { condition: 'flag:ok == 1', data: ['auto'], multiExecute: true } },
                },
            },
        };
        const host: FloorEventsHost = {
            floorIds: ['f1'],
            floorId: () => 'f1',
            getFloor: (id) => floors[id],
            insert: (actions, x) => void inserted.push({ actions, x }),
            autoEventLoc: () => {},
            evaluate: (condition) => condition === 'flag:ok == 1' && flags.ok === 1,
            getFlag: (name, fallback) => flags[name] ?? fallback,
            setFlag: (name, value) => void (flags[name] = value),
        };
        return { host, inserted, flags };
    }

    test('arrive 首次含 firstArrive，之后不再含', () => {
        const { host, inserted } = makeHost();
        const events = new FloorEvents(host);
        events.arrive('f1', true);
        events.arrive('f1', false);
        expect(inserted).toEqual([
            { actions: ['first', 'each'], x: undefined },
            { actions: ['each'], x: undefined },
        ]);
    });

    test('checkAutoEvents：把自动事件坐标交给事件流（旧 `pushEventLoc`）', () => {
        const flags: Record<string, unknown> = {};
        const locs: [number | null, number | null, string][] = [];
        const events = new FloorEvents({
            floorIds: ['f1'],
            floorId: () => 'f1',
            getFloor: () => ({
                autoEvent: {
                    '3,4': { 0: { condition: 'true', data: [{ type: 'openDoor' }] } },
                },
            }),
            insert: () => {},
            autoEventLoc: (x, y, floorId) => void locs.push([x, y, floorId]),
            evaluate: () => true,
            getFlag: (name, fallback) => flags[name] ?? fallback,
            setFlag: (name, value) => void (flags[name] = value),
        });
        events.checkAutoEvents();
        expect(locs).toEqual([[3, 4, 'f1']]);
    });

    test('after 带坐标插入', () => {
        const { host, inserted } = makeHost();
        const events = new FloorEvents(host);
        events.after('afterBattle', 1, 1);
        events.after('afterBattle', 3, 3);
        expect(inserted).toEqual([{ actions: ['win'], x: 1 }]);
    });

    test('checkAutoEvents：条件不成立不执行；成立后包 dowhile 与 reset，multiExecute 可重复', () => {
        const { host, inserted, flags } = makeHost();
        const events = new FloorEvents(host);
        events.checkAutoEvents();
        expect(inserted).toEqual([]);

        flags.ok = 1;
        events.checkAutoEvents();
        // 上一批还在「执行中」，不能重入
        events.checkAutoEvents();
        expect(inserted).toEqual([
            {
                actions: [
                    { type: 'dowhile', condition: 'false', data: ['auto'] },
                    { type: 'autoEventReset', symbol: 'f1@2@2@0' },
                ],
                x: undefined,
            },
        ]);

        // 事件流收尾后清理执行中标记，multiExecute 允许再触发
        events.clearExecuting('f1@2@2@0');
        events.checkAutoEvents();
        expect(inserted.length).toBe(2);
    });

    test('non-multiExecute 只执行一次，且 currentFloor 之外不触发', () => {
        const flags: Record<string, unknown> = {};
        const inserted: unknown[] = [];
        let floorId = 'f1';
        const events = new FloorEvents({
            floorIds: ['f1', 'f2'],
            floorId: () => floorId,
            getFloor: (id) => ({
                autoEvent: {
                    '1,1': { 0: { condition: 'true', data: ['once'], currentFloor: true } },
                },
                floorId: id,
            }),
            insert: (actions) => void inserted.push(actions),
            autoEventLoc: () => {},
            evaluate: () => true,
            getFlag: (name, fallback) => flags[name] ?? fallback,
            setFlag: (name, value) => void (flags[name] = value),
        });
        // 不在当前层：不触发
        floorId = 'f2';
        events.checkAutoEvents();
        expect(inserted.length).toBe(1); // 只有 f2 自己的自动事件
        events.clearExecuting('f2@1@1@0');

        // 回到 f1：f1 的自动事件触发一次
        floorId = 'f1';
        events.checkAutoEvents();
        expect(inserted.length).toBe(2);
        expect(inserted[1]).toEqual([
            { type: 'dowhile', condition: 'false', data: ['once'] },
            { type: 'autoEventReset', symbol: 'f1@1@1@0' },
        ]);
        // 清理执行中后仍不重复（非 multiExecute）
        events.clearExecuting('f1@1@1@0');
        events.checkAutoEvents();
        expect(inserted.length).toBe(2);
    });
});

describe('MotaRuntime 楼层事件', () => {
    const data: RuntimeData = {
        tower: {
            main: { floorIds: ['f1', 'f2'], equipName: ['武器'] },
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
        maps: {
            '2': { cls: 'animates', id: 'wall' },
            '3': {
                cls: 'terrains',
                id: 'upFloor',
                canPass: true,
                trigger: 'changeFloor',
                data: { floorId: 'f2', loc: [0, 0] },
            },
            '20': { cls: 'enemys', id: 'slime' },
            '10': { cls: 'items', id: 'redPotion' },
        },
        enemys: {
            slime: { name: '史莱姆', hp: 30, atk: 5, def: 0, money: 5, exp: 3, point: 0, special: 0 },
        },
        items: { redPotion: { cls: 'items', name: '红血瓶' } },
        icons: {},
        floors: {
            f1: {
                floorId: 'f1',
                title: '一层',
                name: '1',
                canFlyFrom: true,
                map: [
                    [0, 20, 0],
                    [0, 0, 0],
                    [3, 10, 0],
                ],
                firstArrive: [{ type: 'setValue', name: 'flag:first', value: '1' }],
                eachArrive: [{ type: 'addValue', name: 'flag:each', value: '1' }],
                afterBattle: { '1,0': [{ type: 'setValue', name: 'flag:battle', value: '1' }] },
                afterGetItem: { '1,2': [{ type: 'setValue', name: 'flag:item', value: '1' }] },
                autoEvent: {
                    '0,0': {
                        0: {
                            condition: 'flag:first == 1',
                            data: [{ type: 'setValue', name: 'flag:auto', value: '1' }],
                        },
                    },
                },
            },
            f2: {
                floorId: 'f2',
                title: '二层',
                name: '2',
                canFlyTo: true,
                map: [
                    [0, 0],
                    [0, 0],
                ],
            },
        },
    };

    test('start 触发 firstArrive + eachArrive 并标记已到达', () => {
        const rt = new MotaRuntime(data, null);
        expect(rt.hasVisited('f1')).toBe(false);
        rt.start();
        expect(rt.state.flags.first).toBe(1);
        expect(rt.state.flags.each).toBe(1);
        expect(rt.hasVisited('f1')).toBe(true);
    });

    test('换层时触发新层的 firstArrive / eachArrive', () => {
        const rt = new MotaRuntime(data, null);
        rt.start();
        rt.state.hero.x = 0;
        rt.state.hero.y = 1;
        rt.move(0, 1); // 走到 (0,2) 的上楼块
        expect(rt.state.floorId).toBe('f2');
        expect(rt.hasVisited('f2')).toBe(true);
    });

    test('战斗 / 拾取后触发位置事件', () => {
        const rt = new MotaRuntime(data, null);
        rt.start();
        rt.state.hero.x = 0;
        rt.state.hero.y = 0;
        rt.move(1, 0); // 攻击 (1,0) 的史莱姆
        expect(rt.state.flags.battle).toBe(1);

        const rt2 = new MotaRuntime(data, null);
        rt2.start();
        rt2.state.hero.x = 0;
        rt2.state.hero.y = 2;
        rt2.move(1, 0); // 拾取 (1,2) 的红血瓶
        expect(rt2.state.flags.item).toBe(1);
    });

    test('update 检查自动事件，条件成立后执行一次', () => {
        const rt = new MotaRuntime(data, null);
        rt.start();
        expect(rt.state.flags.auto).toBeUndefined();
        rt.update();
        expect(rt.state.flags.auto).toBe(1);
        // 已执行且非 multiExecute，不会重复
        rt.state.flags.auto = 0;
        rt.update();
        expect(rt.state.flags.auto).toBe(0);
    });

    test('changeFloor 呈现层通知带 reason', () => {
        const seen: Record<string, unknown>[] = [];
        const rt = new MotaRuntime(data, null, {
            effect: (type, payload) => {
                if (type === 'changeFloor') seen.push(payload as Record<string, unknown>);
            },
        });
        rt.start();
        expect(seen[0]).toMatchObject({ floorId: 'f1', first: true, reason: 'start' });
        rt.visitFloor('f2');
        rt.flyTo('f2');
        expect(seen.at(-1)).toMatchObject({ floorId: 'f2', reason: 'fly' });
    });

    test('回合结果监听收到 move 与 move.action', () => {
        const rt = new MotaRuntime(data, null);
        rt.start();
        rt.state.hero.x = 0;
        rt.state.hero.y = 0;
        const outcomes: { token: string; action?: string }[] = [];
        rt.turns.onOutcome((outcome) => {
            outcomes.push({ token: outcome.token, action: outcome.move?.action });
        });
        rt.turns.run('right'); // 攻击史莱姆
        rt.turns.run('down'); // 空走
        expect(outcomes).toEqual([
            { token: 'right', action: 'battle' },
            { token: 'down', action: 'move' },
        ]);
    });
});
