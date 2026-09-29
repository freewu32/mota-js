import { describe, expect, test } from 'bun:test';
import {
    RegisteredActions,
    ReplayController,
    RouteRecorder,
    base64Decode,
    base64Encode,
    decodeRoute,
    encodeRoute,
    replayMoveTiming,
    replayTimeout,
    routeCodecFor,
    subarray,
    type Route,
} from '../src/engine/modules/actions';
import { idByNumber, numberById } from '../src/engine/modules/maps';
import type { Maps } from '../src/shared/data/schema';

const maps: Maps = {
    '1': { cls: 'terrains', id: 'ground' },
    '10': { cls: 'items', id: 'redPotion' },
    '20': { cls: 'enemys', id: 'slime' },
};

const identity = (text: string): string => text;

describe('RegisteredActions 交互注册', () => {
    test('按优先级依次执行，返回真值即中止', () => {
        const actions = new RegisteredActions();
        const calls: string[] = [];
        actions.register('ondown', 'low', () => void calls.push('low'), 0);
        actions.register(
            'ondown',
            'high',
            () => {
                calls.push('high');
                return true;
            },
            1,
        );
        expect(actions.do('ondown')).toBe(true);
        expect(calls).toEqual(['high']);

        actions.unregister('ondown', 'high');
        expect(actions.do('ondown')).toBe(false);
        expect(calls).toEqual(['high', 'low']);
    });

    test('onclick 视为 ondown，同名重复注册覆盖前者', () => {
        const actions = new RegisteredActions();
        let count = 0;
        actions.register('onclick', 'one', () => void count++);
        actions.register('ondown', 'one', () => void count++);
        actions.do('ondown');
        expect(count).toBe(1);
    });

    test('抛错的回调被跳过，不影响后续', () => {
        const actions = new RegisteredActions();
        const original = console.error;
        console.error = () => undefined;
        try {
            actions.register('onup', 'bad', () => {
                throw new Error('boom');
            });
            actions.register('onup', 'good', () => true);
            expect(actions.do('onup')).toBe(true);
        } finally {
            console.error = original;
        }
    });

    test('未注册的行为返回 false', () => {
        expect(new RegisteredActions().do('nothing')).toBe(false);
    });
});

describe('RouteRecorder 录像记录', () => {
    test('记录、撤销与最后一步', () => {
        const recorder = new RouteRecorder();
        recorder.record('up');
        recorder.record('item:redPotion');
        expect(recorder.length).toBe(2);
        expect(recorder.last()).toBe('item:redPotion');
        recorder.replaceLast('item:bluePotion');
        expect(recorder.route).toEqual(['up', 'item:bluePotion']);
        expect(recorder.undo()).toBe('item:bluePotion');
        expect(recorder.route).toEqual(['up']);
    });

    test('非移动/转向操作会清空折叠信息', () => {
        const recorder = new RouteRecorder();
        recorder.record('up');
        recorder.record('up');
        recorder.folding['1,1,u'] = { hero: 'hp=100', length: 2 };
        recorder.record('item:redPotion');
        expect(recorder.folding).toEqual({});

        recorder.folding['1,1,u'] = { hero: 'hp=100', length: 2 };
        recorder.record('move:3:4');
        expect(recorder.folding).not.toEqual({});
    });

    test('checkFolding 回到同状态节点时截断录像', () => {
        const recorder = new RouteRecorder();
        const hero = { hp: 100, atk: 5 };
        recorder.record('up');
        recorder.record('down');
        recorder.checkFolding(hero, 1, 1, 'up', true);
        recorder.record('left');
        expect(recorder.length).toBe(3);

        // 数值一致：回到长度 2
        recorder.checkFolding(hero, 1, 1, 'up', true);
        expect(recorder.route).toEqual(['up', 'down']);
    });

    test('数值不一致时不截断录像', () => {
        const recorder = new RouteRecorder();
        recorder.record('up');
        recorder.checkFolding({ hp: 100 }, 1, 1, 'up', true);
        recorder.record('down');
        recorder.checkFolding({ hp: 99 }, 1, 1, 'up', true);
        expect(recorder.route).toEqual(['up', 'down']);
    });

    test('关闭折叠时只清空记录', () => {
        const recorder = new RouteRecorder();
        recorder.record('up');
        recorder.folding['1,1,u'] = { hero: 'hp=100', length: 1 };
        recorder.checkFolding({ hp: 100 }, 1, 1, 'up', false);
        expect(recorder.folding).toEqual({});
        expect(recorder.route).toEqual(['up']);
    });
});

describe('路线编解码', () => {
    test('明文路线直接解析（无压缩标记）', () => {
        expect(decodeRoute('U3')).toEqual(['up', 'up', 'up']);
        expect(decodeRoute('UU')).toEqual(['up', 'up']);
        expect(decodeRoute('DDL2')).toEqual(['down', 'down', 'left', 'left']);
    });

    test('空路线返回空数组', () => {
        expect(decodeRoute('')).toEqual([]);
        expect(decodeRoute(null)).toEqual([]);
        expect(decodeRoute(undefined)).toEqual([]);
    });

    test('连续移动合并为 U2 形式', () => {
        expect(encodeRoute(['up', 'up', 'down'], { compress: identity })).toBe('U2D');
        expect(encodeRoute(['up', 'up', 'down'], { compress: identity })).toBe('U2D');
    });

    test('id 到编号的压缩与还原', () => {
        const options = { ...routeCodecFor(maps), compress: identity, decompress: identity };
        expect(encodeRoute(['item:redPotion', 'equip:slime'], options)).toBe('I10:e20:');
        expect(decodeRoute('I10:e20:', options)).toEqual(['item:redPotion', 'equip:slime']);
        // 未知 id 退回 id 本身
        expect(encodeRoute(['item:yellowKey'], options)).toBe('IyellowKey:');
        expect(decodeRoute('IyellowKey:', options)).toEqual(['item:yellowKey']);
    });

    test('富路线往返一致', () => {
        const route: Route = [
            'up',
            'up',
            'down',
            'left',
            'left',
            'left',
            'item:redPotion',
            'item:yellowKey',
            'unEquip:0',
            'saveEquip:1',
            'loadEquip:2',
            'fly:f2',
            'choices:none',
            'choices:2',
            'shop:shop1',
            'turn',
            'turn:right',
            'getNext',
            'input:none',
            'input:12345',
            'input2:hello world',
            'no',
            'move:3:4',
            'key:65',
            'click:0:200:50',
            'random:7',
            '自定义操作',
        ];
        const encoded = encodeRoute(route, routeCodecFor(maps));
        expect(encoded.startsWith('mota-route-v1:')).toBe(true);
        expect(decodeRoute(encoded, routeCodecFor(maps))).toEqual(route);
    });

    test('自定义压缩函数可替换默认 base64', () => {
        const options = { compress: identity, decompress: identity };
        const encoded = encodeRoute(['up', 'item:redPotion'], options);
        expect(encoded).toBe('UIredPotion:');
        expect(decodeRoute(encoded, options)).toEqual(['up', 'item:redPotion']);
    });

    test('base64 编解码支持多字节字符', () => {
        expect(base64Decode(base64Encode('中文abc'))).toBe('中文abc');
    });
});

describe('subarray', () => {
    test('前缀返回剩余部分，否则 null', () => {
        expect(subarray(['a', 'b', 'c'], ['a', 'b'])).toEqual(['c']);
        expect(subarray(['a', 'b'], ['a', 'c'])).toBeNull();
        expect(subarray(['a'], ['a', 'b'])).toBeNull();
    });
});

describe('图块 id 与编号互转', () => {
    test('numberById / idByNumber', () => {
        expect(numberById(maps, 'redPotion')).toBe(10);
        expect(numberById(maps, 'X5')).toBe(5);
        expect(numberById(maps, 'airwall')).toBe(17);
        expect(numberById(maps, 'unknown')).toBe(0);

        expect(idByNumber(maps, 10)).toBe('redPotion');
        expect(idByNumber(maps, 99)).toBe('99');
        expect(idByNumber(maps, 'yellowKey')).toBe('yellowKey');
    });
});

describe('ReplayController 录像播放', () => {
    test('start 后处于暂停，恢复才可取下一步', () => {
        const controller = new ReplayController();
        expect(controller.start(['up', 'down'], ['up'])).toBe(true);
        expect(controller.replaying).toBe(true);
        expect(controller.state.pausing).toBe(true);
        expect(controller.total).toBe(3);
        expect(controller.pending).toBe(2);
        const progress = controller.progress();
        expect(progress.done).toBe(1);
        expect(progress.total).toBe(3);
        expect(progress.percent).toBeCloseTo(100 / 3);

        expect(controller.next()).toBeNull();
        expect(controller.resume()).toBe(true);
        expect(controller.next()).toBe('up');
        expect(controller.next()).toBe('down');
        expect(controller.next()).toBeNull(); // 播放完毕
        expect(controller.replaying).toBe(false);
    });

    test('busy 时不能恢复，单步可忽略暂停', () => {
        let busy = false;
        const controller = new ReplayController({ isBusy: () => busy });
        controller.start(['up'], []);
        busy = true;
        expect(controller.resume()).toBe(false);
        busy = false;
        expect(controller.next(true)).toBe('up'); // force 单步
    });

    test('未开始时 isPlaying 为假则无法启动', () => {
        const controller = new ReplayController({ isPlaying: () => false });
        expect(controller.start(['up'], [])).toBe(false);
    });

    test('倍速档位升降', () => {
        const controller = new ReplayController();
        controller.start(['up'], []);
        expect(controller.state.speed).toBe(1);
        expect(controller.speedUp()).toBe(2);
        expect(controller.speedUp()).toBe(3);
        expect(controller.speedDown()).toBe(2);
        expect(controller.setSpeed(24)).toBe(true);
        expect(controller.speedUp()).toBe(24); // 已是最高档
    });

    test('stop 复位并清空路线', () => {
        const controller = new ReplayController();
        controller.start(['up'], []);
        expect(controller.stop()).toBe(true);
        expect(controller.replaying).toBe(false);
        expect(controller.state.toReplay).toEqual([]);
        expect(controller.state.speed).toBe(1);
        expect(controller.stop()).toBe(false);
        expect(controller.stop(true)).toBe(true);
    });

    test('finish 判断记录是否一致', () => {
        const controller = new ReplayController();
        controller.start(['down'], ['up']);
        controller.resume();
        expect(controller.next()).toBe('down');
        expect(controller.finish(['up', 'down'])).toBe(true);
        expect(controller.finish(['up', 'left'])).toBe(false);
        expect(controller.finish(['up'])).toBe(false);
    });

    test('失败后停止取动作', () => {
        const controller = new ReplayController();
        controller.start(['up', 'down'], []);
        controller.resume();
        controller.fail();
        expect(controller.state.failed).toBe(true);
        expect(controller.next()).toBeNull();
    });

    test('每 40 步保存回退节点，可回退', () => {
        const controller = new ReplayController();
        const list = Array.from({ length: 45 }, () => 'up');
        controller.start(list, []);
        controller.resume();

        expect(controller.next()).toBe('up');
        expect(controller.state.steps).toBe(1);
        for (let i = 0; i < 39; i++) controller.next();
        expect(controller.state.steps).toBe(40);
        expect(controller.state.save.map((node) => node.steps)).toEqual([1]);

        controller.next();
        expect(controller.state.steps).toBe(41);
        expect(controller.state.save.map((node) => node.steps)).toEqual([1, 41]);

        controller.pause();
        const node = controller.rewind();
        expect(node?.steps).toBe(41);
        expect(controller.state.steps).toBe(41);
        expect(controller.state.toReplay).toHaveLength(5); // 40 步后剩下的 5 步
        expect(controller.state.totalList).toHaveLength(45);
    });

    test('回退节点最多保留 30 个', () => {
        const controller = new ReplayController();
        const list = Array.from({ length: 1201 }, () => 'up');
        controller.start(list, []);
        controller.resume();
        for (let i = 0; i < 1201; i++) controller.next();
        expect(controller.state.save).toHaveLength(30);
        expect(controller.state.save[0]?.steps).toBe(41);
        expect(controller.state.save[29]?.steps).toBe(1201);
    });

    test('未暂停时不能回退', () => {
        const controller = new ReplayController();
        controller.start(['up'], []);
        controller.resume();
        controller.next();
        expect(controller.rewind()).toBeNull();
    });
});

describe('录像时序', () => {
    test('replayTimeout 随倍速递减，24 倍速为 0', () => {
        expect(replayTimeout(1)).toBe(750);
        expect(replayTimeout(2)).toBe(375);
        expect(replayTimeout(24)).toBe(0);
        expect(replayTimeout(0.2)).toBe(750); // Math.max(1, speed)
    });

    test('replayMoveTiming 按倍速提高每次推进量', () => {
        expect(replayMoveTiming(1, 8)).toEqual({ interval: 1, step: 1 });
        // 旧实现：>3 记 2，>6 记 4，>12 记 8
        expect(replayMoveTiming(4, 8).step).toBe(2);
        expect(replayMoveTiming(12, 8).step).toBe(4);
        expect(replayMoveTiming(12, 8).interval).toBeCloseTo(4 / 12);
        expect(replayMoveTiming(24, 8).step).toBe(8);
    });
});
