import { describe, expect, test } from 'bun:test';
import {
    isValidExpression,
    splitStatements,
    stripComments,
    translateExpression,
    translateItemActions,
    translateItemCondition,
    translateTipText,
    unwrapIife,
} from '../src/shared/data/item-effect';

describe('stripComments', () => {
    test('去掉行注释与块注释，保留字符串里的斜杠', () => {
        expect(stripComments('a; // 注释\nb;')).toBe('a; \nb;');
        expect(stripComments('a /* x */ b')).toBe('a   b');
        expect(stripComments(`core.playSound('a//b')`)).toBe(`core.playSound('a//b')`);
    });
});

describe('splitStatements', () => {
    test('按顶层分号切分，忽略括号内的分号', () => {
        expect(splitStatements('a; b; c')).toEqual(['a', 'b', 'c']);
        expect(splitStatements('f(a;b)')).toEqual(['f(a;b)']);
    });

    test('分号在字符串里不切分', () => {
        expect(splitStatements(`x('a;b'); y`)).toEqual([`x('a;b')`, 'y']);
    });

    test('遇到代码块或括号不配对时放弃', () => {
        expect(splitStatements('if (a) { b; }')).toBeNull();
        expect(splitStatements('f(a')).toBeNull();
        expect(splitStatements(`f('a`)).toBeNull();
    });
});

describe('translateExpression', () => {
    test('旧核心引用改写为新值块', () => {
        expect(translateExpression('core.values.redGem * core.status.thisMap.ratio')).toBe(
            'value:redGem * floor:ratio',
        );
        expect(translateExpression('core.status.hero.hp')).toBe('status:hp');
        expect(translateExpression('core.status.atk + 1')).toBe('status:atk + 1');
        expect(translateExpression(`core.getStatus('mana') >= 5`)).toBe('status:mana >= 5');
        expect(translateExpression(`core.hasFlag('poison')`)).toBe('flag:poison');
        expect(translateExpression(`core.itemCount('yellowKey')`)).toBe('item:yellowKey');
        expect(translateExpression(`core.flags.flyNearStair`)).toBe('flag:flyNearStair');
    });

    test('getFlag 只接受缺省或 0 / false 的默认值', () => {
        expect(translateExpression(`core.getFlag('skill') != 1`)).toBe('flag:skill != 1');
        expect(translateExpression(`core.getFlag('skill', 0) != 1`)).toBe('flag:skill != 1');
        expect(translateExpression(`core.getFlag('skill', 3) != 1`)).toBeNull();
    });

    test('认不出的调用一律放弃', () => {
        expect(translateExpression('core.nextX()')).toBeNull();
        expect(translateExpression('core.status.thisMap.blocks.length')).toBeNull();
        expect(translateExpression('skillValue')).toBeNull();
        expect(translateExpression('core.bigmap.width')).toBeNull();
    });

    test('未涉及 core 的合法表达式原样保留', () => {
        expect(translateExpression('true')).toBe('true');
        expect(translateExpression('1 + 2 * 3')).toBe('1 + 2 * 3');
        expect(translateExpression('flag:x || flag:y')).toBe('flag:x || flag:y');
    });
});

describe('isValidExpression', () => {
    test('只允许值块、数字、运算符与 true/false/null', () => {
        expect(isValidExpression('status:hp * 2 >= value:x')).toBe(true);
        expect(isValidExpression('false')).toBe(true);
        expect(isValidExpression('foo')).toBe(false);
        expect(isValidExpression('core.status.hero.hp')).toBe(false);
        expect(isValidExpression('status:hp = 1')).toBe(false);
        expect(isValidExpression('f(1)')).toBe(false);
    });
});

describe('unwrapIife', () => {
    test('展开只有一条 return 的立即执行函数', () => {
        expect(unwrapIife('(function () {\n return 1 + 2;\n})();')).toBe('1 + 2');
        expect(unwrapIife('(function() {\n\tif (a) return false;\n\treturn b;\n})();')).toBeNull();
        expect(unwrapIife('1 + 2')).toBeNull();
    });
});

describe('translateItemActions', () => {
    test('属性赋值转换为 setValue 动作', () => {
        expect(translateItemActions('core.status.hero.atk += 10').actions).toEqual([
            { type: 'setValue', name: 'status:atk', operator: '+=', value: '10' },
        ]);
        expect(translateItemActions('core.status.hero.hp *= 2;').actions).toEqual([
            { type: 'setValue', name: 'status:hp', operator: '*=', value: '2' },
        ]);
        expect(translateItemActions(`core.status.hero.hp = core.status.hpmax`).actions).toEqual([
            { type: 'setValue', name: 'status:hp', value: 'status:hpmax' },
        ]);
    });

    test('多条语句按顺序转换', () => {
        expect(
            translateItemActions('core.status.hero.hp+=1000;core.status.hero.atk+=6;').actions,
        ).toEqual([
            { type: 'setValue', name: 'status:hp', operator: '+=', value: '1000' },
            { type: 'setValue', name: 'status:atk', operator: '+=', value: '6' },
        ]);
    });

    test('背包、flag、音效与毒衰咒', () => {
        expect(translateItemActions(`core.addItem('yellowKey', 1);`).actions).toEqual([
            { type: 'setValue', name: 'item:yellowKey', operator: '+=', value: '1' },
        ]);
        expect(translateItemActions(`core.addItem('yellowKey');`).actions).toEqual([
            { type: 'setValue', name: 'item:yellowKey', operator: '+=', value: '1' },
        ]);
        expect(translateItemActions(`core.setItem('yellowKey', 2);`).actions).toEqual([
            { type: 'setValue', name: 'item:yellowKey', value: '2' },
        ]);
        expect(translateItemActions(`core.setFlag('skill', 1);`).actions).toEqual([
            { type: 'setValue', name: 'flag:skill', value: '1' },
        ]);
        expect(translateItemActions(`core.removeFlag('skill');`).actions).toEqual([
            { type: 'setValue', name: 'flag:skill', value: 'false' },
        ]);
        expect(translateItemActions(`core.playSound('回血');`).actions).toEqual([
            { type: 'playSound', name: '回血' },
        ]);
        expect(translateItemActions(`core.drawTip('使用成功');`).actions).toEqual([
            { type: 'tip', text: '使用成功' },
        ]);
    });

    test('毒衰咒的解除，多类型转成数组', () => {
        expect(translateItemActions(`core.triggerDebuff('remove', 'poison');`).actions).toEqual([
            { type: 'triggerDebuff', action: 'remove', kind: 'poison' },
        ]);
        expect(
            translateItemActions(`core.triggerDebuff('remove', ['poison', 'weak', 'curse']);`)
                .actions,
        ).toEqual([{ type: 'triggerDebuff', action: 'remove', kind: ['poison', 'weak', 'curse'] }]);
    });

    test('已是动作列表时原样返回', () => {
        const actions = [{ type: 'tip', text: 'x' }];
        expect(translateItemActions(actions).actions).toEqual(actions);
    });

    test('无法转换时给出原因而不是半成品', () => {
        const result = translateItemActions('(function () { core.addItem("x", 1); })();');
        expect(result.actions).toBeUndefined();
        expect(result.reason).toContain('函数表达式');
        expect(translateItemActions('core.ui.drawBook(0);').reason).toContain('core.ui.drawBook');
        expect(translateItemActions('core.clearMap("hero");').reason).toBeDefined();
    });

    test('空效果视为空动作列表', () => {
        expect(translateItemActions('').actions).toEqual([]);
        expect(translateItemActions('  // 只有注释\n').actions).toEqual([]);
    });
});

describe('translateItemCondition', () => {
    test('常量与简单条件', () => {
        expect(translateItemCondition('true').expression).toBe('true');
        expect(translateItemCondition(`core.hasFlag('poison');`).expression).toBe('flag:poison');
        expect(
            translateItemCondition(
                `(function() {\n return core.hasFlag('poison') || core.hasFlag('weak');\n})();`,
            ).expression,
        ).toBe('flag:poison || flag:weak');
    });

    test('多语句函数体交人工迁移', () => {
        const result = translateItemCondition('(function () {\n var a = 1;\n return a;\n})();');
        expect(result.expression).toBeUndefined();
        expect(result.reason).toBeDefined();
    });

    test('认不出的返回值交人工迁移', () => {
        expect(
            translateItemCondition(`(function () { return core.nextX(); })();`).reason,
        ).toContain('无法转换的函数返回值');
        expect(translateItemCondition('').reason).toBe('空条件');
    });
});

describe('translateTipText', () => {
    test('改写 ${} 里的旧引用', () => {
        expect(
            translateTipText('，生命+${core.values.redPotion * core.status.thisMap.ratio}'),
        ).toBe('，生命+${value:redPotion * floor:ratio}');
    });

    test('认不出时保持原样', () => {
        expect(translateTipText('，攻击+${core.getEnemyValue(id, "atk")}')).toBe(
            '，攻击+${core.getEnemyValue(id, "atk")}',
        );
        expect(translateTipText('没有插值')).toBe('没有插值');
        expect(translateTipText(undefined)).toBeUndefined();
    });
});
