import { describe, expect, test } from 'bun:test';
import { extractBlocks } from '../src/engine/modules/maps';
import {
    applyOperator,
    evaluateCondition,
    evaluateValue,
    replaceText,
    tokenize,
    ValueSyntaxError,
    writeValue,
    type ValueScope,
} from '../src/engine/modules/values';
import type { FloorData, Maps } from '../src/shared/data/schema';
import type { HeroState } from '../src/engine/types';

const maps: Maps = {
    '1': { cls: 'terrains', id: 'ground' },
    '10': { cls: 'items', id: 'redPotion' },
    '12': { cls: 'animates', id: 'yellowDoor', doorInfo: { keys: { yellowKey: 1 } } },
};

const floor: FloorData = {
    floorId: 'f1',
    title: '一层',
    name: '1',
    map: [
        [1, 10],
        [12, 0],
    ],
};

function newHero(overrides: Partial<HeroState> = {}): HeroState {
    return {
        x: 1,
        y: 0,
        direction: 'down',
        hp: 100,
        atk: 50,
        def: 10,
        mdef: 3,
        money: 20,
        exp: 5,
        lv: 1,
        steps: 0,
        items: { constants: {}, tools: { yellowKey: 2 }, equips: { sword: 1 } },
        equipment: ['sword', 'shield'],
        ...overrides,
    };
}

function newScope(overrides: Partial<ValueScope> = {}): ValueScope {
    const blocks = extractBlocks(floor, maps);
    return {
        flags: { woman_times: 2, '@temp@A': 7 },
        values: { weakValue: 5 },
        globals: { achievement: 3 },
        hero: newHero(),
        enemys: { slime: { name: '史莱姆', hp: 30, atk: 5 } },
        prefix: 'f1@3@4',
        getBlock: (x, y) => blocks.find((b) => b.x === x && b.y === y),
        ...overrides,
    };
}

describe('values 词法', () => {
    test('切分数字、字符串与值块', () => {
        const tokens = tokenize('flag:woman_times >= 1 && item:yellowKey');
        expect(tokens.map((t) => t.kind)).toEqual(['trait', 'op', 'number', 'op', 'trait']);
    });

    test('非法字符抛出 ValueSyntaxError', () => {
        expect(() => tokenize('#')).toThrow(ValueSyntaxError);
    });
});

describe('values 取值', () => {
    test('status / flag / item / buff / temp / global / value', () => {
        const scope = newScope();
        expect(evaluateValue('status:hp', scope)).toBe(100);
        expect(evaluateValue('status:x', scope)).toBe(1);
        expect(evaluateValue('flag:woman_times', scope)).toBe(2);
        expect(evaluateValue('flag:missing', scope)).toBe(0);
        expect(evaluateValue('item:yellowKey', scope)).toBe(2);
        expect(evaluateValue('buff:atk', scope)).toBe(1);
        expect(evaluateValue('temp:A', scope)).toBe(7);
        expect(evaluateValue('global:achievement', scope)).toBe(3);
        expect(evaluateValue('value:weakValue', scope)).toBe(5);
    });

    test('switch 按前缀取值', () => {
        const scope = newScope({ flags: { 'f1@3@4@A': true } });
        expect(evaluateValue('switch:A', scope)).toBe(true);
    });

    test('blockId / blockNumber / blockCls / equip / enemy', () => {
        const scope = newScope();
        expect(evaluateValue('blockId:1,0', scope)).toBe('redPotion');
        expect(evaluateValue('blockNumber:1,0', scope)).toBe(10);
        expect(evaluateValue('blockCls:0,1', scope)).toBe('animates');
        expect(evaluateValue('blockId:5,5', scope)).toBe(null);
        expect(evaluateValue('equip:1', scope)).toBe('shield');
        expect(evaluateValue('enemy:slime:hp', scope)).toBe(30);
        expect(evaluateValue('enemy:slime.hp', scope)).toBe(30);
    });
});

describe('values 表达式', () => {
    test('算术与比较优先级', () => {
        const scope = newScope();
        expect(evaluateValue('status:money>=9+flag:woman_times', scope)).toBe(true);
        expect(evaluateValue('1 + 2 * 3', scope)).toBe(7);
        expect(evaluateValue('(1 + 2) * 3', scope)).toBe(9);
        expect(evaluateValue('2 ** 3 ** 2', scope)).toBe(512);
    });

    test('逻辑、三元与字符串拼接', () => {
        const scope = newScope();
        expect(evaluateValue('flag:missing || "x"', scope)).toBe('x');
        expect(evaluateValue('true ? 1 : 2', scope)).toBe(1);
        expect(evaluateValue('"a" + 1', scope)).toBe('a1');
        expect(evaluateValue('!flag:missing', scope)).toBe(true);
        expect(evaluateValue('-flag:woman_times', scope)).toBe(-2);
    });

    test('Math 成员与宿主函数', () => {
        const scope = newScope({ functions: { rand: (n) => Number(n) - 1 } });
        expect(evaluateValue('Math.max(1, 5)', scope)).toBe(5);
        expect(evaluateValue('rand(3)', scope)).toBe(2);
        expect(() => evaluateValue('unknownFn(1)', scope)).toThrow(ValueSyntaxError);
    });

    test('条件求值失败时返回 false 而不是抛出', () => {
        const scope = newScope();
        const original = console.error;
        console.error = () => undefined;
        try {
            expect(evaluateCondition('core.getStatus("hp")', scope)).toBe(false);
        } finally {
            console.error = original;
        }
    });
});

describe('values 文本替换', () => {
    test('替换 ${} 并支持嵌套花括号与多次出现', () => {
        const scope = newScope();
        expect(replaceText('金币：${status:money}，钥匙：${item:yellowKey}', scope)).toBe(
            '金币：20，钥匙：2',
        );
    });

    test('null / undefined 视为空串', () => {
        const scope = newScope();
        expect(replaceText('x${flag:missing || null}y', scope)).toBe('xy');
    });

    test('非字符串原样转成字符串', () => {
        expect(replaceText(123, newScope())).toBe('123');
        expect(replaceText(null, newScope())).toBe('');
    });
});

describe('values 写值与复合赋值', () => {
    test('writeValue 支持各类可读写值块', () => {
        const scope = newScope();
        writeValue(scope, 'flag:door', 2);
        expect(scope.flags['door']).toBe(2);
        writeValue(scope, 'status:money', 99);
        expect(scope.hero.money).toBe(99);
        writeValue(scope, 'status:x', 4);
        expect(scope.hero.x).toBe(4);
        writeValue(scope, 'status:direction', 'up');
        expect(scope.hero.direction).toBe('up');
        writeValue(scope, 'temp:B', 1);
        expect(scope.flags['@temp@B']).toBe(1);
        writeValue(scope, 'global:achievement', 9);
        expect(scope.globals?.achievement).toBe(9);
        writeValue(scope, 'buff:atk', 1.23456);
        expect(evaluateValue('buff:atk', scope)).toBe(1.235);
    });

    test('item 写值按目标数量增删', () => {
        const scope = newScope();
        writeValue(scope, 'item:yellowKey', 5);
        expect(evaluateValue('item:yellowKey', scope)).toBe(5);
        writeValue(scope, 'item:yellowKey', 1);
        expect(evaluateValue('item:yellowKey', scope)).toBe(1);
    });

    test('applyOperator 与旧实现一致', () => {
        expect(applyOperator('+=', 1, '2')).toBe('12');
        expect(applyOperator('-=', 5, 2)).toBe(3);
        expect(applyOperator('//=', 7, 2)).toBe(3);
        expect(applyOperator('min=', 5, 2)).toBe(2);
        expect(applyOperator(undefined, 5, 2)).toBe(2);
    });
});
