import { describe, expect, test } from 'bun:test';
import { MotaRuntime, type StorageLike } from '../src/engine/runtime';
import type { RuntimeData } from '../src/engine/types';

const data: RuntimeData = {
    tower: {
        main: { floorIds: ['f1', 'f2'] },
        firstData: { title: 't', name: 'n', version: '1', floorId: 'f1' },
        values: {},
        flags: {},
    },
    maps: {
        '1': { cls: 'terrains', id: 'ground' },
        '2': { cls: 'animates', id: 'wall' },
        '3': { cls: 'terrains', id: 'upFloor' },
    },
    icons: {},
    floors: {
        f1: {
            floorId: 'f1',
            title: '一层',
            name: '1',
            map: [
                [1, 1, 1],
                [1, 0, 2],
                [1, 3, 1],
            ],
            changeFloor: { '1,2': { floorId: 'f2', loc: [0, 0] } },
        },
        f2: {
            floorId: 'f2',
            title: '二层',
            name: '2',
            map: [
                [1, 1],
                [1, 1],
            ],
        },
    },
};

function memStorage(): StorageLike & { map: Map<string, string> } {
    const map = new Map<string, string>();
    return {
        map,
        getItem: (k) => map.get(k) ?? null,
        setItem: (k, v) => void map.set(k, v),
    };
}

describe('MotaRuntime', () => {
    test('初始状态来自 firstData 与默认位置', () => {
        const rt = new MotaRuntime(data, null);
        expect(rt.state.floorId).toBe('f1');
        expect(rt.state.hero).toEqual({ x: 1, y: 1 });
    });

    test('移动在边界内生效，越界不动', () => {
        const rt = new MotaRuntime(data, null);
        rt.move(-1, 0);
        expect(rt.state.hero).toEqual({ x: 0, y: 1 });
        rt.move(-1, 0);
        expect(rt.state.hero).toEqual({ x: 0, y: 1 }); // x=0 已是左边界
    });

    test('canPass 判断地形可通行性', () => {
        const rt = new MotaRuntime(data, null);
        expect(rt.canPass(1, 1)).toBe(true); // 空地
        expect(rt.canPass(0, 0)).toBe(true); // 地面
        expect(rt.canPass(2, 1)).toBe(false); // 墙
        expect(rt.canPass(-1, 0)).toBe(false); // 越界
    });

    test('不能走进墙', () => {
        const rt = new MotaRuntime(data, null);
        rt.move(1, 0);
        expect(rt.state.hero).toEqual({ x: 1, y: 1 });
    });

    test('踩到楼梯切换楼层与坐标', () => {
        const rt = new MotaRuntime(data, null);
        rt.move(0, 1);
        expect(rt.state.floorId).toBe('f2');
        expect(rt.state.hero).toEqual({ x: 0, y: 0 });
    });

    test('存档与读档往返', () => {
        const storage = memStorage();
        const rt = new MotaRuntime(data, storage);
        rt.move(0, 1); // 到 f2
        expect(rt.save()).toBe(true);
        expect(storage.map.size).toBe(1);

        const rt2 = new MotaRuntime(data, storage);
        expect(rt2.load()).toBe(true);
        expect(rt2.state.floorId).toBe('f2');
    });

    test('无 storage 时 save/load 返回 false', () => {
        const rt = new MotaRuntime(data, null);
        expect(rt.save()).toBe(false);
        expect(rt.load()).toBe(false);
    });

    test('api 暴露 move/save/load/getState', () => {
        const storage = memStorage();
        const rt = new MotaRuntime(data, storage);
        expect(Object.keys(rt.api).sort()).toEqual(['getState', 'load', 'move', 'save']);
        rt.api.move(-1, 0);
        expect(rt.api.getState().hero).toEqual({ x: 0, y: 1 });
    });
});
