import { describe, expect, test } from 'bun:test';
import { autotileAround, autotileCommands, buildAutotileEdges } from '../src/engine/autotile';

/** 生成 size x size 的地图，fill 返回每格的编号 */
function makeMap(size: number, fill: (x: number, y: number) => number): number[][] {
    return Array.from({ length: size }, (_, y) =>
        Array.from({ length: size }, (_, x) => fill(x, y)),
    );
}

describe('autotileAround', () => {
    test('越界视为连通（地图边缘不留边）', () => {
        const map = [[1]];
        expect(autotileAround(map, {}, 1, -1, 0)).toBe(true);
        expect(autotileAround(map, {}, 1, 0, -1)).toBe(true);
        expect(autotileAround(map, {}, 1, 1, 0)).toBe(true);
        expect(autotileAround(map, {}, 1, 0, 0)).toBe(true);
    });

    test('编号不同不连通，连通表可声明等价', () => {
        const map = [[1, 2]];
        expect(autotileAround(map, {}, 1, 1, 0)).toBe(false);
        expect(autotileAround(map, { 1: [1, 2] }, 1, 1, 0)).toBe(true);
    });
});

describe('autotileCommands', () => {
    test('孤立图块按索引 0 绘制四个象限', () => {
        const map = makeMap(3, (x, y) => (x === 1 && y === 1 ? 1 : 0));
        const commands = autotileCommands(map, 1, 1, {});
        expect(commands).toHaveLength(4);
        expect(commands[0]).toEqual({ sx: 0, sy: 0, sw: 16, sh: 16, ox: 0, oy: 0, ow: 16, oh: 16 });
        expect(commands.map((c) => `${c.ox},${c.oy}`).sort()).toEqual([
            '0,0',
            '0,16',
            '16,0',
            '16,16',
        ]);
    });

    test('四邻全连通绘制内部块（索引 15）', () => {
        const map = makeMap(3, () => 1);
        const commands = autotileCommands(map, 1, 1, {});
        expect(commands).toHaveLength(4);
        expect(commands[0]).toMatchObject({ sx: 32, sy: 64, sw: 16, sh: 16 });
    });

    test('缺对角时补画拐角并把整块切分到剩余象限', () => {
        // 左上角缺块，其余连通
        const map = makeMap(3, (x, y) => (x === 0 && y === 0 ? 0 : 1));
        const commands = autotileCommands(map, 1, 1, {});

        const quadrants = commands.map((c) => `${c.ox},${c.oy}`);
        expect(quadrants.sort()).toEqual(['0,0', '0,16', '16,0', '16,16']);
        // 拐角来自索引 16（base+64, sy 0）
        expect(commands.find((c) => c.ox === 0 && c.oy === 0)).toMatchObject({
            sx: 64,
            sy: 0,
            sw: 16,
            sh: 16,
        });
    });

    test('status 按图集状态组取模', () => {
        const map = makeMap(3, (x, y) => (x === 1 && y === 1 ? 1 : 0));
        const commands = autotileCommands(map, 1, 1, {}, 5, 4);
        expect(commands[0]?.sx).toBe(96); // 5 % 4 = 1
        expect(autotileCommands(map, 1, 1, {}, 1, 0)[0]?.sx).toBe(0); // groups 至少为 1
    });
});

describe('buildAutotileEdges', () => {
    test('左上块像素相同则视为连通（方向性对齐旧实现）', () => {
        const edges = buildAutotileEdges([1, 2, 3], (id, index) => {
            if (id === 1) return index === 0 ? 'A' : null;
            if (id === 2) return index === 0 ? 'B' : 'A';
            return null;
        });
        expect(edges[1]).toEqual([1, 2]);
        expect(edges[2]).toEqual([2]);
        expect(edges[3]).toBeUndefined();
    });
});
