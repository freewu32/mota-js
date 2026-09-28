import { describe, expect, test } from 'bun:test';
import {
    animateFrames,
    atlasTileCommand,
    frameCount,
    frameIndex,
    getTilesetOffset,
    tileHeight,
} from '../src/engine/tiles';
import type { Icons } from '../src/shared/data/schema';

const icons: Icons = {
    terrains: { ground: 0 },
    enemys: { bat: 5 },
    enemy48: { angel: 2 },
    animates: { lava: 1 },
};

describe('图块几何', () => {
    test('帧数由 cls 决定，animate 覆盖优先', () => {
        expect(animateFrames('terrains')).toBe(1);
        expect(animateFrames('enemys')).toBe(2);
        expect(animateFrames('animates')).toBe(4);
        expect(frameCount({ cls: 'enemys', id: 'bat' }, 'enemys')).toBe(2);
        expect(frameCount({ cls: 'enemys', id: 'bat', animate: 1 }, 'enemys')).toBe(1);
        expect(frameCount({ cls: 'animates', id: 'lava', animate: false }, 'animates')).toBe(1);
    });

    test('48 高图块向上偏移 16 像素', () => {
        expect(tileHeight('enemy48')).toBe(48);
        expect(atlasTileCommand({ cls: 'enemy48', id: 'angel' }, icons)).toEqual({
            sx: 0,
            sy: 96,
            sw: 32,
            sh: 48,
            ox: 0,
            oy: -16,
            ow: 32,
            oh: 48,
        });
    });

    test('动画帧沿图集行取列', () => {
        const command = atlasTileCommand({ cls: 'enemys', id: 'bat' }, icons, 3);
        expect(command?.sx).toBe(32); // 3 % 2 = 1
        expect(command?.sy).toBe(160); // 行 5 * 32
    });

    test('未登记的 id 返回 null，负动画计数不越界', () => {
        expect(atlasTileCommand({ cls: 'terrains', id: 'missing' }, icons)).toBeNull();
        expect(atlasTileCommand({ cls: 'bad', id: 'x' }, icons)).toBeNull();
        expect(frameIndex({ cls: 'enemys', id: 'bat' }, 'enemys', -1)).toBe(1);
    });
});

describe('tileset 偏移', () => {
    // 256x1216 => 8 列 38 行，一个 tileset 占 10000 个编号
    const sizes = [{ name: 'magictower.png', width: 256, height: 1216 }];

    test('编号解析为 tileset 与格坐标', () => {
        expect(getTilesetOffset(10000, sizes)).toEqual({ name: 'magictower.png', x: 0, y: 0 });
        expect(getTilesetOffset('X10009', sizes)).toEqual({ name: 'magictower.png', x: 1, y: 1 });
    });

    test('越界与非法编号返回 null', () => {
        expect(getTilesetOffset(9999, sizes)).toBeNull();
        expect(getTilesetOffset('abc', sizes)).toBeNull();
        expect(getTilesetOffset(10000 + 8 * 38, sizes)).toBeNull();
        expect(getTilesetOffset(10000, [])).toBeNull();
    });

    test('多个 tileset 依次占用编号区间', () => {
        // 每个 tileset 占用 10000 个编号，编号不连续拼接
        const two = [...sizes, { name: 'second.png', width: 64, height: 64 }];
        expect(getTilesetOffset(10000 + 8 * 38, sizes)).toBeNull();
        expect(getTilesetOffset(20000, two)).toEqual({ name: 'second.png', x: 0, y: 0 });
        expect(getTilesetOffset(20003, two)).toEqual({ name: 'second.png', x: 1, y: 1 });
        expect(getTilesetOffset(20003, sizes)).toBeNull();
    });
});
