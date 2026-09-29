import { describe, expect, test } from 'bun:test';
import {
    isValidExpression,
    splitStatements,
    stripComments,
    translateExpression,
    translateItemActions,
    translateItemCondition,
    translateTipText,
    ITEM_RULE_NAMES,
    translateActionsDeep,
    translateFunctionAction,
    translateKnownItem,
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

describe('translateKnownItem 成句道具规则', () => {
    /** 从旧塔里摘出的片段，确保规则不会因为措辞差异漏掉 */
    const snippets: Record<string, { name: string; effect: string; condition?: string }> = {
        怪物手册: { name: '怪物手册', effect: 'core.ui.drawBook(0);' },
        楼层传送器: {
            name: '楼层传送器',
            effect: 'core.ui.drawFly(core.floorIds.indexOf(core.status.floorId));',
            condition:
                '(function () {\n\tif (core.flags.flyNearStair && !core.nearStair()) return false;\n\treturn core.status.maps[core.status.floorId].canFlyFrom;\n})();',
        },
        冰冻徽章: {
            name: '冰冻徽章',
            effect: "(function () {\n\tif (core.getBlockId(core.nextX(), core.nextY()) == 'lava') {\n\t\tcore.removeBlock(core.nextX(), core.nextY());\n\t}\n})();",
        },
        大黄门钥匙: {
            name: '大黄门钥匙',
            effect: '(function () {\n\tvar actions = core.searchBlock("yellowDoor").map(function (block) { return 1; });\n})();',
            condition: "(function () {\n\treturn core.searchBlock('yellowDoor').length > 0;\n})();",
        },
        破墙镐: {
            name: '破墙镐',
            effect: '(function () {\n\tvar canBreak = function (x, y) {\n\t\treturn core.getBlock(x, y).event.canBreak;\n\t};\n})();',
        },
        破冰镐: {
            name: '破冰镐',
            effect: '(function () {\n\tcore.insertAction({ "type": "openDoor", "loc": ["core.nextX()", "core.nextY()"] });\n})();',
            condition:
                "(function () {\n\treturn core.getBlockId(core.nextX(), core.nextY()) == 'ice';\n})();",
        },
        炸弹: {
            name: '炸弹',
            effect: '(function () {\n\tvar bombList = [];\n\tvar canBomb = function (x, y) {};\n})();',
        },
        中心对称飞行器: {
            name: '中心对称飞行器',
            effect: "core.setHeroLoc('x', core.bigmap.width - 1 - core.getHeroLoc('x'));",
        },
        上楼器: {
            name: '上楼器',
            effect: 'var floorId = core.floorIds[core.floorIds.indexOf(core.status.floorId) + 1];',
        },
        下楼器: {
            name: '下楼器',
            effect: 'var floorId = core.floorIds[core.floorIds.indexOf(core.status.floorId) - 1];',
        },
        地震卷轴: {
            name: '地震卷轴',
            effect: '(function () {\n\tcore.removeBlockByIndexes(indexes);\n})();',
            condition:
                '(function () {\n\treturn core.status.thisMap.blocks.filter(function (block) {\n\t\treturn !block.disable && block.event.canBreak;\n\t}).length > 0;\n})();',
        },
        跳跃靴: {
            name: '跳跃靴',
            effect: 'core.playSound("跳跃");\ncore.insertAction({ "type": "jumpHero", "loc": [core.nextX(2), core.nextY(2)] });',
        },
        技能开关: {
            name: '技能：二倍斩',
            effect: "(function () {\n\tvar skillValue = 1;\n\tvar skillNeed = 5;\n\tvar skillName = '二倍斩';\n\tif (core.getFlag('skill', 0) != skillValue) {}\n})();",
        },
    };

    test('规则覆盖 13 个成句道具', () => {
        expect(ITEM_RULE_NAMES).toHaveLength(13);
    });

    for (const [rule, snippet] of Object.entries(snippets)) {
        test(`${rule}：命中规则并产出新写法`, () => {
            const result = translateKnownItem({
                id: rule,
                name: snippet.name,
                effect: snippet.effect,
                condition: snippet.condition ?? '',
            });
            expect(result).not.toBeNull();
            expect(result!.useItemEffect ?? result!.canUseItemEffect).toBeDefined();
        });
    }

    test('冰冻徽章：条件与效果都改写，提示带上道具名', () => {
        const result = translateKnownItem({
            id: 'freezeBadge',
            name: '冰冻徽章',
            effect: "if (core.getBlockId(core.nextX(), core.nextY()) == 'lava') {}",
            condition: '',
        });
        expect(result?.canUseItemEffect).toBe("blockId(nextX(), nextY()) == 'lava'");
        expect(result?.useItemEffect).toEqual([
            { type: 'removeBlock', loc: ['nextX()', 'nextY()'] },
            { type: 'playSound', name: '打开界面' },
            { type: 'tip', text: '冰冻徽章使用成功' },
        ]);
        expect(result?.notes?.[0]).toContain('退还道具');
    });

    test('炸弹：指向塔作者脚本并提示自备', () => {
        const result = translateKnownItem({
            id: 'bomb',
            name: '炸弹',
            effect: 'var bombList = [];',
            condition: '',
        });
        expect(result?.useItemEffect).toEqual({ script: 'items/bomb' });
        expect(result?.script).toBe('items/bomb');
        expect(result?.canUseItemEffect).toContain('enemyAttr');
    });

    test('技能开关：从旧片段里读出技能值 / 需求 / 名称', () => {
        const result = translateKnownItem({
            id: 'skill2',
            name: '技能：三倍斩',
            effect: "var skillValue = 2;\nvar skillNeed = 8;\nvar skillName = '三倍斩';\nif (core.getFlag('skill', 0) != skillValue) {}",
            condition: '',
        });
        const actions = result?.useItemEffect as Record<string, unknown>[];
        expect(actions[0]).toMatchObject({ type: 'if', condition: 'flag:skill != 2' });
        const nested = (actions[0]!.true as Record<string, unknown>[])[0]!;
        expect(nested).toMatchObject({ type: 'if', condition: 'status:mana >= 8' });
        expect(nested.true).toContainEqual({
            type: 'setValue',
            name: 'flag:skillName',
            value: "'三倍斩'",
        });
    });

    test('技能开关缺变量时不产出新字段，交回逐条翻译', () => {
        const result = translateKnownItem({
            id: 'skill9',
            name: '技能',
            effect: "var skillValue = 9;\nif (core.getFlag('skill', 0) != skillValue) {}",
            condition: '',
        });
        expect(result).toEqual({});
    });

    test('认不出的效果返回 null', () => {
        expect(
            translateKnownItem({ id: 'x', name: 'x', effect: 'core.drawTip("hi")', condition: '' }),
        ).toBeNull();
    });
});

describe('translateFunctionAction / translateActionsDeep', () => {
    test('把 function 动作里的旧 JS 翻译成动作列表', () => {
        expect(
            translateFunctionAction({
                type: 'function',
                function: "function(){\ncore.addItem('lifeWand', 1);\n}",
            }),
        ).toEqual([{ type: 'setValue', name: 'item:lifeWand', operator: '+=', value: '1' }]);
    });

    test('认不出的函数体返回 null', () => {
        expect(
            translateFunctionAction({ type: 'function', function: 'function(){ return 1; }' }),
        ).toBeNull();
        expect(
            translateFunctionAction({ type: 'function', function: 'function(){ core.foo(); }' }),
        ).toBeNull();
        expect(translateFunctionAction({ type: 'tip', text: 'hi' })).toBeNull();
        expect(translateFunctionAction('function(){}')).toBeNull();
    });

    test('递归翻译嵌套分支里的 function 动作', () => {
        const actions = [
            {
                type: 'if',
                condition: 'flag:x',
                true: [{ type: 'function', function: "function(){ core.setFlag('y', 1); }" }],
                false: [{ type: 'tip', text: 'no' }],
            },
        ];
        expect(translateActionsDeep(actions)).toEqual([
            {
                type: 'if',
                condition: 'flag:x',
                true: [{ type: 'setValue', name: 'flag:y', value: '1' }],
                false: [{ type: 'tip', text: 'no' }],
            },
        ]);
    });

    test('没有可翻译项时返回 null（不产生无意义改动）', () => {
        expect(translateActionsDeep([{ type: 'tip', text: 'hi' }])).toBeNull();
        expect(translateActionsDeep('不是数组')).toBeNull();
    });
});
