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
    });
});
