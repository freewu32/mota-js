import { describe, expect, test } from 'bun:test';
import { MotaRuntime } from '../src/engine/runtime';
import {
    AnimateClock,
    DialogController,
    createMemoryDialogView,
    extractTextMarkers,
    findPosition,
    formatBigNumber,
    formatMonsterManual,
    formatStatusBar,
    parseRichText,
    richTextLength,
    richTextToPlain,
    setTwoDigits,
    sliceRichText,
    statusBarVisibility,
    type Timers,
} from '../src/engine/modules/ui';
import type { ScriptActionObject } from '../src/engine/modules/events';
import type { HeroState, RuntimeData } from '../src/engine/types';

/** 对话框方法只关心文本，事件数据内容随意 */
const NO_DATA: ScriptActionObject = { type: 'text' };

////// 假时钟 //////

function fakeTimers(): { timers: Timers; advance(ms: number): void; pending(): number } {
    let now = 0;
    const queue: { at: number; fn: () => void; handle: object }[] = [];
    return {
        timers: {
            now: () => now,
            setTimeout: (fn, ms) => {
                const handle = {};
                queue.push({ at: now + ms, fn, handle });
                return handle;
            },
            clearTimeout: (handle) => {
                const index = queue.findIndex((one) => one.handle === handle);
                if (index >= 0) queue.splice(index, 1);
            },
        },
        advance(ms) {
            now += ms;
            for (;;) {
                const next = queue.filter((one) => one.at <= now).sort((a, b) => a.at - b.at)[0];
                if (!next) break;
                queue.splice(queue.indexOf(next), 1);
                next.fn();
            }
        },
        pending: () => queue.length,
    };
}

function hero(overrides: Partial<HeroState> = {}): HeroState {
    return {
        x: 1,
        y: 1,
        direction: 'down',
        hp: 100,
        hpmax: 150,
        atk: 10,
        def: 5,
        mdef: 2,
        money: 3,
        exp: 0,
        lv: 1,
        steps: 0,
        name: '勇士',
        items: { constants: {}, tools: {}, equips: {} },
        equipment: [],
        ...overrides,
    };
}

describe('数字格式化', () => {
    test('setTwoDigits 补前导零', () => {
        expect(setTwoDigits(0)).toBe('00');
        expect(setTwoDigits(9)).toBe('09');
        expect(setTwoDigits(10)).toBe('10');
        expect(setTwoDigits(100)).toBe('100');
        expect(setTwoDigits('3')).toBe('03');
    });

    test('formatBigNumber 与旧实现一致', () => {
        expect(formatBigNumber(0)).toBe('0');
        expect(formatBigNumber('3.9')).toBe('3');
        expect(formatBigNumber(12345)).toBe('12345');
        expect(formatBigNumber(999999)).toBe('999999');
        expect(formatBigNumber(1e6)).toBe('100.0w');
        expect(formatBigNumber(1e8)).toBe('10000w');
        expect(formatBigNumber(1.5e12)).toBe('15000e');
        expect(formatBigNumber(-1234)).toBe('-1234');
        expect(formatBigNumber(NaN)).toBe('???');
        expect(formatBigNumber(Infinity)).toBe('???');
        // digits 为 true 时按旧版 onMap 约定当作 5
        expect(formatBigNumber(1e6, true)).toBe('100w');
        expect(formatBigNumber(1e6, 8)).toBe('1000000');
    });
});

describe('富文本标记解析', () => {
    test('普通文字合并为一个节点', () => {
        expect(parseRichText('abc')).toEqual([{ type: 'text', text: 'abc' }]);
    });

    test('换行：真实换行与 \\n 写法都支持', () => {
        expect(parseRichText('a\nb')).toEqual([
            { type: 'text', text: 'a' },
            { type: 'break' },
            { type: 'text', text: 'b' },
        ]);
        expect(parseRichText('a\\nb').map((one) => one.type)).toEqual(['text', 'break', 'text']);
    });

    test('变色与复位', () => {
        const nodes = parseRichText('\\r[#FF0000]红\\r[]黑');
        expect(nodes).toEqual([
            { type: 'text', text: '红', color: '#FF0000' },
            { type: 'text', text: '黑', color: undefined },
        ]);
    });

    test('粗体 / 斜体切换', () => {
        const nodes = parseRichText('\\d粗\\d细');
        expect(nodes).toEqual([
            { type: 'text', text: '粗', bold: true },
            { type: 'text', text: '细', bold: false },
        ]);
        expect(parseRichText('\\e斜\\e正')[1]).toEqual({ type: 'text', text: '正', italic: false });
    });

    test('字号、字体与空位', () => {
        expect(parseRichText('\\c[20]大字')[0]).toEqual({
            type: 'text',
            text: '大字',
            fontSize: 20,
        });
        // 非数字内容回退到默认字号
        expect(parseRichText('\\c[x]小', { fontSize: 16 })[0]).toEqual({
            type: 'text',
            text: '小',
            fontSize: 16,
        });
        expect(parseRichText('\\g[黑体]字')[0]).toEqual({ type: 'text', text: '字', font: '黑体' });
        expect(parseRichText('a\\z[3]b')).toEqual([
            { type: 'text', text: 'a' },
            { type: 'space', count: 3 },
            { type: 'text', text: 'b' },
        ]);
        expect(parseRichText('\\z')).toEqual([{ type: 'space', count: 1 }]);
    });

    test('旧数据里的退格符写法（U+0008）也认作文本框位置', () => {
        expect(parseRichText('\u0008[this]你好')).toEqual([
            { type: 'position', position: 'this', target: null },
            { type: 'text', text: '你好' },
        ]);
        // 制表符写法的标题标记由 extractTextMarkers 负责
        expect(extractTextMarkers('\t[少女,npc0]\u0008[this]你好')).toEqual({
            text: '\u0008[this]你好',
            title: '少女',
            icon: 'npc0',
        });
    });

    test('行内图标与文本框位置标记', () => {
        expect(parseRichText('得到\\i[redPotion]')).toEqual([
            { type: 'text', text: '得到' },
            { type: 'icon', id: 'redPotion' },
        ]);
        const nodes = parseRichText('\\b[up,3,4]你好');
        expect(nodes[0]).toEqual({ type: 'position', position: 'up', target: '3,4' });
        expect(findPosition(nodes)).toEqual({ position: 'up', target: '3,4' });
        expect(findPosition(parseRichText('你好'))).toBeNull();
    });

    test('可见长度与截取（打字机）', () => {
        const nodes = parseRichText('ab\\i[key]cd');
        expect(richTextLength(nodes)).toBe(5);
        expect(richTextToPlain(sliceRichText(nodes, 2))).toBe('ab');
        expect(richTextToPlain(sliceRichText(nodes, 3))).toBe('ab[key]');
        expect(richTextToPlain(sliceRichText(nodes, 4))).toBe('ab[key]c');
        expect(sliceRichText(nodes, 0)).toEqual([]);
        // 空位也计入长度
        expect(richTextToPlain(sliceRichText(parseRichText('a\\z[3]b'), 3))).toBe('a  ');
    });

    test('richTextToPlain 丢掉样式标记', () => {
        expect(richTextToPlain(parseRichText('\\r[#FFF]\\d红字\\d\\r[]\n尾'))).toBe('红字\n尾');
    });

    test('抽取标题与头像标记', () => {
        expect(extractTextMarkers('\\t[hero]你好')).toEqual({
            text: '你好',
            title: null,
            icon: null,
        });
        expect(extractTextMarkers('\\t[老人,npc1]你好')).toEqual({
            text: '你好',
            title: '老人',
            icon: 'npc1',
        });
        // 只给一个值时既是标题也是头像
        expect(extractTextMarkers('\t[怪物]hi')).toEqual({
            text: 'hi',
            title: '怪物',
            icon: '怪物',
        });
        expect(extractTextMarkers('你好')).toEqual({ text: '你好', title: null, icon: null });
    });
});

describe('状态栏模型', () => {
    test('statusBarVisibility 依据 statusBarItems', () => {
        expect(statusBarVisibility([])).toEqual({
            slots: [],
            keys: false,
            pzf: false,
            debuff: false,
        });
        const view = statusBarVisibility([
            'enableFloor',
            'enableHP',
            'enableHPMax',
            'enableExp',
            'enableKeys',
            'enablePZF',
            'enableDebuff',
        ]);
        expect(view.slots).toEqual(['floor', 'hp', 'hpmax', 'exp']);
        expect(view.keys).toBe(true);
        expect(view.pzf).toBe(true);
        expect(view.debuff).toBe(true);
        // levelUpLeftMode 下经验项隐藏
        expect(statusBarVisibility(['enableExp', 'levelUpLeftMode']).slots).toEqual([]);
    });

    test('formatStatusBar 组装数值、增幅与道具计数', () => {
        const state = hero({
            items: { constants: { yellowKey: 3 }, tools: { pickaxe: 2 }, equips: {} },
        });
        const view = formatStatusBar({
            hero: state,
            flags: { __atk_buff__: 1.5, poison: true, skillName: '火球' },
            floorName: '第一层',
            statusBarItems: ['enableFloor', 'enableName', 'enableLv', 'enableAtk', 'enableKeys'],
            levelTitles: ['新手'],
            nextLvUpNeed: 20,
        });
        expect(view.slots.floor).toBe('第一层');
        expect(view.slots.name).toBe('勇士');
        expect(view.slots.lv).toBe('新手');
        expect(view.slots.hpmax).toBe('150');
        expect(view.slots.hp).toBe('100');
        expect(view.slots.atk).toBe('15'); // 10 * 1.5
        expect(view.slots.up).toBe('20');
        expect(view.slots.skill).toBe('火球');
        expect(view.visibility.slots).toEqual(['floor', 'name', 'lv', 'atk']);
        expect(view.visibility.keys).toBe(true);
        expect(view.keys.find((one) => one.id === 'yellowKey')?.count).toBe('03');
        expect(view.keys.find((one) => one.id === 'blueKey')?.count).toBe('00');
        expect(view.tools.find((one) => one.id === 'pickaxe')?.count).toBe('02');
        expect(view.debuffs).toEqual(['毒']);
    });

    test('没有 hpmax / manamax 时的降级显示', () => {
        const state = hero({ hpmax: undefined, mana: undefined, manamax: undefined });
        const view = formatStatusBar({ hero: state, flags: {} });
        expect(view.slots.hpmax).toBe('100'); // 退回当前生命
        expect(view.slots.mana).toBe('0');
        expect(view.slots.hard).toBe('');
        expect(view.slots.up).toBe(''); // 未给出下一级经验
    });

    test('manamax 为负时不显示上限', () => {
        const state = hero({ mana: 5, manamax: -1 });
        expect(formatStatusBar({ hero: state, flags: {} }).slots.mana).toBe('5');
        const capped = hero({ mana: 5, manamax: 20 });
        expect(formatStatusBar({ hero: capped, flags: {} }).slots.mana).toBe('5/20');
    });
});

describe('怪物手册', () => {
    test('formatMonsterManual 输出数值、特殊属性与坐标', () => {
        const lines = formatMonsterManual([
            {
                id: 'slime',
                name: '史莱姆',
                hp: 100,
                atk: 20,
                def: 1,
                money: 3,
                exp: 2,
                damage: '先攻 35',
                specials: ['先攻', '魔攻'],
                description: '很弱。',
                locs: [[1, 2]],
            },
        ]);
        expect(lines[0]).toBe('\r[#FF6A6A]\\d史莱姆\\d\\r[]');
        expect(lines[1]).toBe('生命 100，攻击 20，防御 1，金币 3，经验 2');
        expect(lines[2]).toBe('战斗伤害 先攻 35');
        expect(lines[3]).toBe('特殊属性：先攻、魔攻');
        expect(lines[4]).toBe('怪物坐标：(1,2)');
        expect(lines[5]).toBe('很弱。');
        expect(lines.at(-1)).toBe('');
    });

    test('无特殊属性与数值时给出默认文案', () => {
        const lines = formatMonsterManual([{ id: 'ghost' }]);
        expect(lines).toEqual(['\r[#FF6A6A]\\dghost\\d\\r[]', '该怪物无特殊属性。', '']);
    });
});

describe('对话框状态机', () => {
    test('不逐字显示时立即等玩家确认', () => {
        const view = createMemoryDialogView();
        const controller = new DialogController(view);
        let done = false;
        controller.text('你好', NO_DATA, () => {
            done = true;
        });
        expect(view.text).toBe('你好');
        expect(controller.busy).toBe(true);
        expect(controller.isTyping).toBe(false);
        expect(done).toBe(false);

        expect(controller.advance()).toBe(true);
        expect(done).toBe(true);
        expect(controller.busy).toBe(false);
        expect(view.log).toContain('hide');
    });

    test('逐字显示：先补全再继续', () => {
        const clock = fakeTimers();
        const view = createMemoryDialogView();
        const controller = new DialogController(view, {
            charInterval: 10,
            timers: clock.timers,
        });
        let done = false;
        controller.text('abcd', NO_DATA, () => {
            done = true;
        });
        expect(controller.isTyping).toBe(true);
        expect(view.text).toBe('');

        clock.advance(10);
        controller.tick();
        expect(view.text).toBe('a');

        clock.advance(10);
        controller.tick();
        expect(view.text).toBe('ab');

        clock.advance(10);
        controller.tick();
        expect(view.text).toBe('abc');

        // 点一下补全，但还没继续脚本
        controller.advance();
        expect(view.texts.at(-1)).toBe('abcd');
        expect(controller.isTyping).toBe(false);
        expect(controller.busy).toBe(true);
        expect(done).toBe(false);

        controller.advance();
        expect(done).toBe(true);
        expect(controller.busy).toBe(false);
    });

    test('逐帧推进时不足一个字的时间要累计', () => {
        const clock = fakeTimers();
        const view = createMemoryDialogView();
        const controller = new DialogController(view, { charInterval: 25, timers: clock.timers });
        controller.text('ab', NO_DATA, () => {});
        // 60fps：每帧约 16.7ms，单帧不足 25ms 也要能继续显示
        controller.tick(16);
        expect(view.text).toBe('');
        controller.tick(33);
        expect(view.text).toBe('a');
        controller.tick(50);
        expect(view.text).toBe('ab');
        expect(view.text).toBe('ab');
        expect(controller.isTyping).toBe(false);
    });

    test('打字机走完会自行停下等确认', () => {
        const clock = fakeTimers();
        const view = createMemoryDialogView();
        const controller = new DialogController(view, { charInterval: 10, timers: clock.timers });
        let done = false;
        controller.text('ab', NO_DATA, () => {
            done = true;
        });
        clock.advance(100);
        controller.tick();
        expect(view.text).toBe('ab');
        expect(controller.isTyping).toBe(false);
        expect(controller.busy).toBe(true);
        controller.advance();
        expect(done).toBe(true);
    });

    test('标题与位置标记落到 view', () => {
        const view = createMemoryDialogView();
        const controller = new DialogController(view);
        controller.text('\\t[老人,npc1]\\b[up]你好', NO_DATA, () => {});
        expect(view.text).toBe('你好');
    });

    test('选择项：返回下标，禁用项视为不选', () => {
        const view = createMemoryDialogView();
        const controller = new DialogController(view);
        const picked: (number | null)[] = [];
        controller.choices(
            '选一个',
            [{ text: 'A' }, { text: 'B', _disabled: true }],
            NO_DATA,
            (index) => picked.push(index),
        );
        expect(view.log).toContain('choices:A|×');
        expect(controller.busy).toBe(true);
        view.pick(0);
        expect(picked).toEqual([0]);
        expect(controller.busy).toBe(false);
    });

    test('选择项：选中禁用项等价于不选', () => {
        const view = createMemoryDialogView();
        const controller = new DialogController(view);
        let picked: number | null | undefined;
        controller.choices(
            '选一个',
            [{ text: 'A' }, { text: 'B', _disabled: true }],
            NO_DATA,
            (index) => {
                picked = index;
            },
        );
        view.pick(1);
        expect(picked).toBeNull();
    });

    test('确认框与输入框', () => {
        const view = createMemoryDialogView();
        const controller = new DialogController(view);
        const answers: (boolean | null)[] = [];
        controller.confirm('确定吗', NO_DATA, (ok) => answers.push(ok));
        expect(view.log).toContain('confirm:确定吗');
        view.answer(true);
        expect(answers).toEqual([true]);

        const values: string[] = [];
        controller.input('输入名字', true, (value) => values.push(value));
        expect(view.log).toContain('input:输入名字:text');
        view.submit('魔塔');
        expect(values).toEqual(['魔塔']);
    });

    test('modal 打开时提示排队，关闭后补发', () => {
        const view = createMemoryDialogView();
        const controller = new DialogController(view);
        controller.choices('选一个', [{ text: 'A' }], NO_DATA, () => {});
        controller.tip('提示一号');
        controller.tip('提示二号');
        expect(view.tips).toEqual([]);
        view.pick(0);
        // 提示是瞬时状态：对话框关闭后只显示最后一条
        expect(view.tips).toEqual(['提示二号']);
    });

    test('普通提示直接显示', () => {
        const view = createMemoryDialogView();
        const controller = new DialogController(view);
        controller.tip('注意脚下');
        expect(view.tips).toEqual(['注意脚下']);
        expect(controller.busy).toBe(false);
    });

    test('effect 同时交给 view 与宿主回调', () => {
        const view = createMemoryDialogView();
        const seen: string[] = [];
        const controller = new DialogController(view, { onEffect: (type) => seen.push(type) });
        controller.effect('playSound', { type: 'playSound', name: '确定' });
        expect(view.effects).toEqual([
            { type: 'playSound', data: { type: 'playSound', name: '确定' } },
        ]);
        expect(seen).toEqual(['playSound']);
    });

    test('wait 与 sleep 走注入的定时器', () => {
        const clock = fakeTimers();
        const controller = new DialogController(createMemoryDialogView(), { timers: clock.timers });
        let waited = false;
        let slept = false;
        controller.wait(() => {
            waited = true;
        });
        controller.sleep(500, () => {
            slept = true;
        });
        expect(clock.pending()).toBe(2);
        clock.advance(0);
        expect(waited).toBe(true);
        expect(slept).toBe(false);
        clock.advance(500);
        expect(slept).toBe(true);
    });

    test('setText 直接替换文本，clear 收起对话框', () => {
        const view = createMemoryDialogView();
        const controller = new DialogController(view);
        controller.setText({ type: 'setText', text: '\\d状态\\d' });
        expect(view.text).toBe('状态');
        controller.clear();
        expect(view.log).toContain('hide');
        expect(view.log).toContain('hideTip');
        expect(controller.busy).toBe(false);
    });
});

describe('动画时钟', () => {
    test('按间隔累计帧数', () => {
        const clock = new AnimateClock(120);
        expect(clock.tick(1000)).toBe(0);
        expect(clock.tick(1100)).toBe(0);
        expect(clock.tick(1300)).toBe(2);
        expect(clock.tick(1350)).toBe(0);
        expect(clock.tick(1600)).toBe(3);
    });

    test('interval 为 0 时不推进，reset 重新开始', () => {
        const clock = new AnimateClock(0);
        clock.tick(0);
        expect(clock.tick(1000)).toBe(0);
        clock.reset(1000);
        expect(clock.tick(4000)).toBe(0);
    });
});

////// 与事件解释器的联动 //////

const data: RuntimeData = {
    icons: {},
    tower: {
        main: { floorIds: ['f1'] },
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
        values: {},
        flags: {},
    },
    maps: {
        '2': { cls: 'animates', id: 'wall' },
        '10': { cls: 'items', id: 'redPotion' },
    },
    enemys: {},
    items: {},
    floors: {
        f1: {
            floorId: 'f1',
            title: '一层',
            name: '一层',
            map: [
                [0, 0, 0],
                [0, 0, 0],
            ],
            events: {},
        },
        f2: { floorId: 'f2', title: '二层', name: '二层', map: [[0]], events: {} },
    },
};

describe('DialogController 驱动剧本', () => {
    test('作为 runtime 的事件呈现器，逐句等待玩家点击', () => {
        const view = createMemoryDialogView();
        const controller = new DialogController(view);
        const withEvent: RuntimeData = structuredClone(data);
        withEvent.floors.f1!.events = { '1,1': ['你好', { type: 'text', text: '第二句' }] };
        const runtime = new MotaRuntime(withEvent, null);
        runtime.setPresenter(controller);

        runtime.move(0, 1);
        expect(view.texts).toEqual(['你好']);
        expect(runtime.events.isRunning).toBe(true);

        controller.advance();
        expect(view.texts).toEqual(['你好', '第二句']);
        expect(runtime.events.isRunning).toBe(true);

        controller.advance();
        expect(runtime.events.isRunning).toBe(false);
    });
});
