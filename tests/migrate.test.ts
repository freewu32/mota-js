import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, parseAssignment } from '../src/shared/data/migrate';
import { floorSchema, towerDataSchema } from '../src/shared/data/schema';

describe('parseAssignment', () => {
    test('解析 var 赋值', () => {
        expect(parseAssignment('var a = {"x":1};', /var\s+(\w+)\s*=/)).toEqual({ x: 1 });
    });

    test('解析 main.floors 赋值', () => {
        expect(parseAssignment('main.floors.MT0=\n{"a":1}', /main\.floors\.(\w+)\s*=/)).toEqual({
            a: 1,
        });
    });

    test('无法匹配时抛错', () => {
        expect(() => parseAssignment('nope', /var\s+(\w+)\s*=/)).toThrow();
    });
});

describe('migrate', () => {
    test('迁移示例塔并通过 schema 校验', async () => {
        const out = mkdtempSync(join(tmpdir(), 'mota-migrate-'));
        const result = await migrate({ from: 'project', out });

        expect(result.files).toContain('tower.json');
        expect(result.files).toContain('enemys.json');
        expect(result.files).toContain('items.json');
        expect(result.files).toContain('maps.json');
        expect(result.files).toContain('icons.json');
        expect(result.files).toContain('events.json');
        expect(result.floors.length).toBeGreaterThan(0);
        expect(result.scripts).toEqual(['functions.js', 'plugins.js']);

        const tower = await Bun.file(join(out, 'tower.json')).json();
        expect(towerDataSchema.safeParse(tower).success).toBe(true);

        const floorId = result.floors[0]!;
        const floor = await Bun.file(join(out, 'floors', `${floorId}.json`)).json();
        expect(floorSchema.safeParse(floor).success).toBe(true);

        // 道具效果被转成剧本动作 / 值块表达式
        const items = (await Bun.file(join(out, 'items.json')).json()) as Record<
            string,
            Record<string, unknown>
        >;
        expect(items.redPotion?.itemEffect).toEqual([
            {
                type: 'setValue',
                name: 'status:hp',
                operator: '+=',
                value: 'value:redPotion * floor:ratio',
            },
        ]);
        expect(items.redPotion?.canUseItemEffect).toBe('true');
        expect(items.redPotion?.itemEffectTip).toBe('，生命+${value:redPotion * floor:ratio}');
        expect(items.poisonWine?.useItemEffect).toEqual([
            { type: 'triggerDebuff', action: 'remove', kind: 'poison' },
        ]);
        expect(items.poisonWine?.canUseItemEffect).toBe('flag:poison');

        // 成句的复杂道具由规则逐条改写，示例塔的道具已全部迁移：
        // 不再有 core 引用、不再有 *Legacy 字段、也没有需人工迁移的字段
        expect(result.untranslated).toEqual([]);
        expect(JSON.stringify(items)).not.toContain('core.');
        expect(JSON.stringify(items)).not.toContain('Legacy');
        expect(items.book?.useItemEffect).toEqual([{ type: 'openPanel', panel: 'monsterManual' }]);
        expect(items.freezeBadge?.useItemEffect).toEqual([
            { type: 'removeBlock', loc: ['nextX()', 'nextY()'] },
            { type: 'playSound', name: '打开界面' },
            { type: 'tip', text: '冰冻徽章使用成功' },
        ]);
        expect(items.freezeBadge?.canUseItemEffect).toBe("blockId(nextX(), nextY()) == 'lava'");
        expect(items.bomb?.useItemEffect).toEqual({ script: 'items/bomb' });
        expect(result.scriptRefs).toEqual(['bomb -> project/scripts/items/bomb.ts']);
        expect(items.skill1?.useItemEffect).toEqual([
            {
                type: 'if',
                condition: 'flag:skill != 1',
                true: [
                    {
                        type: 'if',
                        condition: 'status:mana >= 5',
                        true: [
                            { type: 'playSound', name: '打开界面' },
                            { type: 'setValue', name: 'flag:skill', value: '1' },
                            { type: 'setValue', name: 'flag:skillName', value: "'二倍斩'" },
                        ],
                        false: [
                            { type: 'playSound', name: '操作失败' },
                            { type: 'tip', text: '魔力不足，无法开启技能' },
                        ],
                    },
                ],
                false: [
                    { type: 'setValue', name: 'flag:skill', value: '0' },
                    { type: 'setValue', name: 'flag:skillName', value: "'无'" },
                ],
            },
        ]);
        // 旧 `function` 动作字符串逐条翻译（生命魔杖）
        expect(items.lifeWand?.useItemEvent).toContainEqual({
            type: 'setValue',
            name: 'item:lifeWand',
            operator: '+=',
            value: '1',
        });
        expect(result.notes.length).toBeGreaterThan(0);
    });
});
