import { describe, expect, test } from 'bun:test';
import { MaterialStore } from '../src/engine/materials';

describe('MaterialStore', () => {
    test('无图集时 drawElement 回退（返回 false）', () => {
        const store = new MaterialStore({});
        const ctx = {} as CanvasRenderingContext2D;
        expect(store.drawElement(ctx, { cls: 'terrains', id: 'ground' }, 0, 0)).toBe(false);
        expect(store.drawElement(ctx, { cls: 'tileset', id: 'X10000' }, 0, 0)).toBe(false);
    });

    test('无图集时 drawAutotile 回退（返回 false）', () => {
        const store = new MaterialStore({});
        const ctx = {} as CanvasRenderingContext2D;
        expect(store.drawAutotile(ctx, { cls: 'autotile', id: 'autotile' }, 0, 0, [[20]])).toBe(
            false,
        );
    });

    test('rowIndex 从 icons 读取图集行号', () => {
        const store = new MaterialStore({ terrains: { ground: 3 }, enemys: { bat: 4 } });
        expect(store.rowIndex('terrains', 'ground')).toBe(3);
        expect(store.rowIndex('enemys', 'bat')).toBe(4);
        expect(store.rowIndex('terrains', 'missing')).toBeNull();
        expect(store.rowIndex('unknown', 'x')).toBeNull();
    });

    test('无图集时 autotileStatus 为 0', () => {
        const store = new MaterialStore({});
        expect(store.autotileStatus('autotile', 7)).toBe(0);
    });

    test('非浏览器环境构建连通表不会报错', () => {
        const store = new MaterialStore({ autotile: { autotile: 0 } });
        expect(() => store.buildAutotileEdges({ 20: 'autotile' })).not.toThrow();
        expect(store.autotileEdges).toEqual({});
    });
});
