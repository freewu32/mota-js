import { describe, expect, test } from 'bun:test';
import {
    MotaEvents,
    createHeadlessPresenter,
    turnDirection,
    type EventPresenter,
    type EventsHost,
    type ScriptAction,
} from '../src/engine/modules/events';
import { extractBlocks, type Block } from '../src/engine/modules/maps';
import { itemCount, type ControlContext } from '../src/engine/modules/control';
import type { EnemyData } from '../src/engine/modules/enemys';
import type { FloorData, Maps } from '../src/shared/data/schema';
import type { HeroState } from '../src/engine/types';

const maps: Maps = {
    '1': { cls: 'terrains', id: 'ground' },
    '2': { cls: 'animates', id: 'wall' },
    '3': { cls: 'terrains', id: 'upFloor', canPass: true },
    '10': { cls: 'items', id: 'redPotion' },
    '11': { cls: 'items', id: 'yellowKey' },
    '12': { cls: 'animates', id: 'yellowDoor', doorInfo: { keys: { yellowKey: 1 } } },
    '20': { cls: 'enemys', id: 'slime' },
    '13': { cls: 'animates', id: 'breakableWall', canBreak: true },
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
            [13, 0, 0],
        ],
    },
};

function newHero(overrides: Partial<HeroState> = {}): HeroState {
    return {
        x: 0,
        y: 0,
        direction: 'down',
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

interface Harness {
    events: MotaEvents;
    host: EventsHost;
    hero: HeroState;
    flags: Record<string, unknown>;
}

function makeEvents(
    options: {
        presenter?: EventPresenter;
        hero?: HeroState;
        flags?: Record<string, unknown>;
        enemys?: Record<string, EnemyData>;
        functions?: EventsHost['functions'];
        commonEvents?: EventsHost['commonEvents'];
        actions?: EventsHost['actions'];
    } = {},
): Harness {
    const hero = options.hero ?? newHero();
    const flags = options.flags ?? {};
    const cache: Record<string, Block[]> = {};
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
        floorIds: ['f1', 'f2'],
        getFloor: (id) => floors[id],
        getBlocks: (id) => {
            cache[id] ??= extractBlocks(floors[id], maps, {
                isDisabled: (x, y) => (flags[`__block_${id}_${x}_${y}__`] ? true : undefined),
            });
            return cache[id];
        },
    };
    const host: EventsHost = {
        ...ctx,
        presenter: options.presenter ?? createHeadlessPresenter(),
        functions: options.functions,
        commonEvents: options.commonEvents,
        actions: options.actions,
    };
    return { events: new MotaEvents(host), host, hero, flags };
}

/** 记录对话文本并按需手动放行的呈现器 */
function recordingPresenter(): {
    presenter: EventPresenter;
    texts: string[];
    pending: (() => void)[];
} {
    const texts: string[] = [];
    const pending: (() => void)[] = [];
    return {
        texts,
        pending,
        presenter: {
            text: (text, _data, done) => {
                texts.push(text);
                pending.push(done);
            },
        },
    };
}

describe('events 事件流与对话', () => {
    test('顺序执行字符串与 text 动作并替换 ${}', () => {
        const { presenter, texts } = recordingPresenter();
        presenter.text = (text, _data, done) => {
            texts.push(text);
            done();
        };
        const { events } = makeEvents({ presenter, flags: { count: 2 } });
        events.start(['第一句', { type: 'text', text: '共 ${flag:count} 次' }]);
        expect(texts).toEqual(['第一句', '共 2 次']);
        expect(events.isRunning).toBe(false);
    });

    test('异步对话挂起，调用 done 后继续', () => {
        const { presenter, texts, pending } = recordingPresenter();
        const { events } = makeEvents({ presenter });
        events.start(['a', 'b']);
        expect(texts).toEqual(['a']);
        expect(events.isRunning).toBe(true);
        // 放行第一句后展示第二句，再放行才结束
        pending.shift()?.();
        expect(texts).toEqual(['a', 'b']);
        expect(events.isRunning).toBe(true);
        pending.shift()?.();
        expect(events.isRunning).toBe(false);
    });

    test('事件结束时回调被调用', () => {
        let called = 0;
        const { events } = makeEvents();
        events.start(['a'], { callback: () => (called += 1) });
        expect(called).toBe(1);
    });
});

describe('events 条件分支', () => {
    test('if 根据条件选择 true / false 分支', () => {
        const { events, flags } = makeEvents({ flags: { door: 2 } });
        events.start([
            {
                type: 'if',
                condition: 'flag:door==2',
                true: { type: 'setValue', name: 'flag:hit', value: '1' },
                false: { type: 'setValue', name: 'flag:hit', value: '0' },
            },
        ]);
        expect(flags['hit']).toBe(1);
    });

    test('switch 命中 case，default 兜底，nobreak 贯穿', () => {
        const { events, flags } = makeEvents({ flags: { v: 2 } });
        events.start([
            {
                type: 'switch',
                condition: 'flag:v',
                caseList: [
                    { case: '1', action: { type: 'setValue', name: 'flag:one', value: '1' } },
                    {
                        case: '2',
                        action: { type: 'setValue', name: 'flag:two', value: '1' },
                        nobreak: true,
                    },
                    { case: 'default', action: { type: 'setValue', name: 'flag:def', value: '1' } },
                ],
            },
        ]);
        expect(flags['two']).toBe(1);
        expect(flags['def']).toBe(1);
        expect(flags['one']).toBeUndefined();
    });

    test('choices 过滤条件项并执行所选动作', () => {
        const choicesSeen: string[] = [];
        const presenter: EventPresenter = {
            choices: (_text, choices, _data, done) => {
                choicesSeen.push(...choices.map((c) => c.text));
                done(0);
            },
        };
        const { events, flags } = makeEvents({ presenter, flags: { rich: 1 } });
        events.start([
            {
                type: 'choices',
                text: '买吗',
                choices: [
                    {
                        text: '买（${flag:rich}）',
                        action: { type: 'setValue', name: 'flag:bought', value: '1' },
                    },
                    {
                        text: '不买',
                        condition: 'false',
                        action: { type: 'setValue', name: 'flag:bought', value: '0' },
                    },
                ],
            },
        ]);
        expect(choicesSeen).toEqual(['买（1）']);
        expect(flags['bought']).toBe(1);
    });

    test('confirm 选“是”执行 yes 分支', () => {
        const presenter: EventPresenter = { confirm: (_t, _d, done) => done(true) };
        const { events, flags } = makeEvents({ presenter });
        events.start([
            {
                type: 'confirm',
                text: '确定？',
                yes: { type: 'setValue', name: 'flag:ok', value: '1' },
                no: { type: 'setValue', name: 'flag:ok', value: '0' },
            },
        ]);
        expect(flags['ok']).toBe(1);
    });

    test('input 写入 flag:input', () => {
        const presenter: EventPresenter = { input: (_hint, _isText, done) => done('42') };
        const { events, flags } = makeEvents({ presenter });
        events.start([{ type: 'input', text: '加多少攻击' }]);
        expect(flags['input']).toBe(42);
    });
});

describe('events 循环', () => {
    test('while 循环累计临时变量', () => {
        const { events, flags } = makeEvents();
        events.start([
            {
                type: 'while',
                condition: 'temp:A < 3',
                data: [{ type: 'addValue', name: 'temp:A', value: '1' }],
            },
        ]);
        expect(flags['@temp@A']).toBe(3);
    });

    test('for 循环遍历区间', () => {
        const { events, flags } = makeEvents();
        events.start([
            {
                type: 'for',
                name: 'temp:A',
                from: 1,
                to: 3,
                step: 1,
                data: [{ type: 'addValue', name: 'flag:sum', value: 'temp:A' }],
            },
        ]);
        expect(flags['sum']).toBe(6);
    });

    test('forEach 遍历列表', () => {
        const { events, flags } = makeEvents();
        events.start([
            {
                type: 'forEach',
                name: 'temp:B',
                list: [2, 4, 6],
                data: [{ type: 'addValue', name: 'flag:sum', value: 'temp:B' }],
            },
        ]);
        expect(flags['sum']).toBe(12);
    });

    test('break 跳出循环', () => {
        const { events, flags } = makeEvents();
        events.start([
            {
                type: 'while',
                condition: 'temp:A < 10',
                data: [
                    { type: 'addValue', name: 'temp:A', value: '1' },
                    { type: 'if', condition: 'temp:A == 3', true: [{ type: 'break' }] },
                ],
            },
        ]);
        expect(flags['@temp@A']).toBe(3);
    });
});

describe('events 数值与地图', () => {
    test('setValue / addValue 修改勇士与背包', () => {
        const { events, hero } = makeEvents();
        events.start([
            { type: 'setValue', name: 'status:money', operator: '+=', value: '10+5' },
            { type: 'addValue', name: 'item:yellowKey', value: '2' },
        ]);
        expect(hero.money).toBe(15);
        expect(itemCount(hero, 'yellowKey')).toBe(2);
    });

    test('floor: 值块读取当前层属性（旧 thisMap.ratio）', () => {
        const { events, hero } = makeEvents();
        floors.f1.ratio = 3;
        try {
            events.start([
                { type: 'setValue', name: 'status:hp', operator: '+=', value: '10 * floor:ratio' },
            ]);
            expect(hero.hp).toBe(130);
        } finally {
            delete floors.f1.ratio;
        }
    });

    test('setBlock 按 id 换图块，number 为 0 时删除', () => {
        const { events, host } = makeEvents();
        events.start([{ type: 'setBlock', number: 'redPotion', loc: [[0, 0]] }]);
        expect(host.getBlocks('f1').find((b) => b.x === 0 && b.y === 0)?.event.id).toBe(
            'redPotion',
        );
        events.start([{ type: 'setBlock', number: 0, loc: [[0, 0]] }]);
        expect(host.getBlocks('f1').find((b) => b.x === 0 && b.y === 0)?.disable).toBe(true);
    });

    test('changePos 与 changeFloor', () => {
        const { events, hero, host } = makeEvents();
        events.start([{ type: 'changePos', loc: [1, 1], direction: ':back' }]);
        expect(hero.x).toBe(1);
        expect(hero.y).toBe(1);
        expect(hero.direction).toBe('up');

        events.start([{ type: 'changeFloor', floorId: 'f2', loc: [2, 2], direction: 'left' }]);
        expect(host.getFloor('f2').floorId).toBe('f2');
        expect(hero.x).toBe(2);
        expect(hero.direction).toBe('left');
    });
});

describe('events 交互与扩展', () => {
    test('trigger 触发拾取物品', () => {
        const { events, hero } = makeEvents();
        events.triggerAt(0, 0);
        expect(itemCount(hero, 'yellowKey')).toBe(1);
    });

    test('trigger 触发战斗', () => {
        const { events, host } = makeEvents();
        events.triggerAt(1, 2);
        expect(host.getBlocks('f1').find((b) => b.x === 1 && b.y === 2)?.disable).toBe(true);
    });

    test('function 调用宿主注册的函数', () => {
        let calls = 0;
        const { events } = makeEvents({
            functions: {
                heal: () => {
                    calls += 1;
                },
            },
        });
        events.start([{ type: 'function', function: 'heal' }]);
        expect(calls).toBe(1);
    });

    test('insert 插入公共事件', () => {
        const { events, flags } = makeEvents({
            commonEvents: { give: [{ type: 'setValue', name: 'flag:given', value: '1' }] },
        });
        events.start([{ type: 'insert', name: 'give' }]);
        expect(flags['given']).toBe(1);
    });

    test('未知事件类型插入提示文本', () => {
        const { presenter, texts } = recordingPresenter();
        presenter.text = (text, _data, done) => {
            texts.push(text);
            done();
        };
        const { events } = makeEvents({ presenter });
        events.start([{ type: 'notExist' } as ScriptAction]);
        expect(texts[0]).toContain('未知的事件类型');
    });

    test('视觉类动作交给 presenter.effect 而不报错', () => {
        const effects: string[] = [];
        const presenter: EventPresenter = { effect: (type) => effects.push(type) };
        const { events } = makeEvents({ presenter });
        events.start([{ type: 'setCurtain', color: [0, 0, 0], time: 100 }]);
        expect(effects).toEqual(['setCurtain']);
    });
});

describe('events 图块与跳跃', () => {
    test('removeBlock 按 loc 表达式移除前方图块', () => {
        const { events, host, hero } = makeEvents();
        hero.direction = 'down';
        // f2 的 (0,2) 是可破坏墙：站在 (0,1) 朝下，前方正是它
        events.start([{ type: 'changeFloor', floorId: 'f2', loc: [0, 1] }]);
        events.start([{ type: 'removeBlock', loc: ['nextX()', 'nextY()'] }]);
        const block = host.getBlocks('f2').find((b) => b.event.id === 'breakableWall');
        expect(block?.disable).toBe(true);
    });

    test('removeBlock 按 filter 批量移除可破坏图块', () => {
        const { events, host } = makeEvents();
        events.start([{ type: 'changeFloor', floorId: 'f2', loc: [1, 1] }]);
        events.start([{ type: 'removeBlock', filter: { canBreak: true } }]);
        const broken = host.getBlocks('f2').find((b) => b.event.id === 'breakableWall');
        expect(broken?.disable).toBe(true);
        // 不带 filter 的形态不影响其他图块
        expect(host.getBlocks('f2').filter((b) => !b.disable)).toHaveLength(0);
    });

    test('jumpHero 支持 dxy 相对位移并转发动画', () => {
        const effects: { type: string; data: unknown }[] = [];
        const presenter: EventPresenter = {
            effect: (type, data) => effects.push({ type, data: data as unknown }),
        };
        const { events, hero } = makeEvents({ presenter });
        hero.direction = 'down';
        events.start([{ type: 'jumpHero', dxy: [1, 2], time: 300 }]);
        expect([hero.x, hero.y]).toEqual([1, 2]);
        expect(effects[0]?.type).toBe('jumpHero');
        expect(effects[0]?.data).toMatchObject({ from: [0, 0], to: [1, 2], time: 300 });
    });

    test('jumpHero 支持 loc 表达式', () => {
        const { events, hero } = makeEvents();
        hero.direction = 'right';
        events.start([{ type: 'jumpHero', loc: ['nextX(2)', 'nextY(2)'] }]);
        expect([hero.x, hero.y]).toEqual([2, 0]);
    });

    test('changeFloor 支持 :before / :after 相对楼层', () => {
        const { events, hero, host } = makeEvents();
        events.start([{ type: 'changeFloor', floorId: ':after', loc: [2, 2] }]);
        expect(host.getFloor('f2').floorId).toBe('f2');
        expect([hero.x, hero.y]).toEqual([2, 2]);
        // f2 的上一层是 f1
        events.start([{ type: 'changeFloor', floorId: ':before', loc: [1, 0] }]);
        expect(host.getFloor('f1').floorId).toBe('f1');
        expect([hero.x, hero.y]).toEqual([1, 0]);
        // f1 再往上不存在：停在当前层（旧实现回退当前层，坐标照常生效）
        events.start([{ type: 'changeFloor', floorId: ':before', loc: [2, 1] }]);
        expect(host.getFloor('f1').floorId).toBe('f1');
        expect([hero.x, hero.y]).toEqual([2, 1]);
    });

    test('changeFloor 指向不存在的楼层时整条动作作废', () => {
        const { events, hero, host } = makeEvents();
        events.start([{ type: 'changeFloor', floorId: 'f9', loc: [2, 2] }]);
        expect(host.getFloor('f1').floorId).toBe('f1');
        expect([hero.x, hero.y]).toEqual([0, 0]);
    });

    test('openDoor 按 loc 开门且默认不扣钥匙（旧 needKey 缺省）', () => {
        const { events, hero, host } = makeEvents({
            hero: newHero({ items: { constants: {}, tools: { yellowKey: 1 }, equips: {} } }),
        });
        events.start([{ type: 'openDoor', loc: [1, 1] }]);
        const door = host.getBlocks('f1').find((b) => b.event.id === 'yellowDoor');
        expect(door?.disable).toBe(true);
        expect(itemCount(hero, 'yellowKey')).toBe(1);
    });

    test('openDoor 带 needKey 时检查并扣除钥匙', () => {
        const { events, hero, host } = makeEvents({
            hero: newHero({ items: { constants: {}, tools: { yellowKey: 1 }, equips: {} } }),
        });
        events.start([{ type: 'openDoor', loc: [1, 1], needKey: true }]);
        expect(host.getBlocks('f1').find((b) => b.event.id === 'yellowDoor')?.disable).toBe(true);
        expect(itemCount(hero, 'yellowKey')).toBe(0);
    });

    test('openDoor 按 filter 批量开门（大黄门钥匙）', () => {
        const { events, host } = makeEvents();
        events.start([{ type: 'openDoor', filter: { id: 'yellowDoor' } }]);
        expect(host.getBlocks('f1').find((b) => b.event.id === 'yellowDoor')?.disable).toBe(true);
    });

    test('openDoor 对非门图块无效', () => {
        const { events, host } = makeEvents();
        // (2,1) 是楼梯而不是门
        events.start([{ type: 'openDoor', loc: [2, 1] }]);
        const stair = host.getBlocks('f1').find((b) => b.x === 2 && b.y === 1);
        expect(stair?.disable).toBeUndefined();
    });

    test('openPanel 交给呈现层', () => {
        const effects: { type: string; data: unknown }[] = [];
        const presenter: EventPresenter = {
            effect: (type, data) => effects.push({ type, data: data as unknown }),
        };
        const { events } = makeEvents({ presenter });
        events.start([{ type: 'openPanel', panel: 'monsterManual' }]);
        expect(effects).toEqual([
            { type: 'openPanel', data: { type: 'openPanel', panel: 'monsterManual' } },
        ]);
    });
});

describe('events 工具函数', () => {
    test('turnDirection 支持相对转向', () => {
        expect(turnDirection(':left', 'up')).toBe('left');
        expect(turnDirection(':right', 'up')).toBe('right');
        expect(turnDirection(':back', 'up')).toBe('down');
        expect(turnDirection('left', 'up')).toBe('left');
        expect(turnDirection('未知', 'up')).toBe('up');
    });
});
