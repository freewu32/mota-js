import { describe, expect, test } from 'bun:test';
import { AutoRoute, tileAt } from '../src/game/autopath';
import { MotaRuntime } from '../src/engine/runtime';
import type { RuntimeData } from '../src/engine/types';

/** 一张 3x3 的空地，起点 (0,0)，用来验证点击行为 */
function makeData(): RuntimeData {
    return {
        tower: {
            main: { floorIds: ['f1'] },
            firstData: {
                title: 't',
                name: 'n',
                version: '1',
                floorId: 'f1',
                hero: {
                    hp: 100,
                    atk: 10,
                    def: 0,
                    mdef: 0,
                    money: 0,
                    exp: 0,
                    lv: 1,
                    items: { constants: {}, tools: {}, equips: {} },
                    loc: { x: 0, y: 0, direction: 'down' },
                },
            },
            values: { moveSpeed: 100 },
            flags: { enableMoveDirectly: true },
        },
        maps: {},
        enemys: {},
        items: {},
        icons: {},
        floors: {
            f1: {
                floorId: 'f1',
                title: '一层',
                name: '1',
                map: [
                    [0, 0, 0],
                    [0, 0, 0],
                    [0, 0, 0],
                ],
            },
        },
    };
}

function makeRoute(options: { blocked?: () => boolean; direct?: boolean } = {}) {
    const data = makeData();
    if (options.direct === false) {
        (data.tower.flags as Record<string, unknown>).enableMoveDirectly = false;
    }
    const runtime = new MotaRuntime(data, null);
    const routes: ({ x: number; y: number }[] | null)[] = [];
    let now = 0;
    const route = new AutoRoute(
        {
            runtime,
            setRoute: (steps) => void routes.push(steps ? steps.map((one) => ({ ...one })) : null),
            step: (direction) => runtime.turns.run(direction),
            blocked: options.blocked ?? (() => false),
            refresh: () => {},
        },
        { interval: 100, now: () => now },
    );
    return {
        route,
        runtime,
        routes,
        tick: (ms: number) => {
            now += ms;
            route.update();
        },
    };
}

describe('AutoRoute', () => {
    test('点远处的格子：逐步走过去，走完自动取消', () => {
        const { route, runtime, tick } = makeRoute({ direct: false });
        expect(route.click(2, 2)).toBe(true);
        expect(route.active).toBe(true);
        tick(0);
        expect([runtime.state.hero.x, runtime.state.hero.y]).toEqual([0, 1]);
        tick(100);
        tick(200);
        tick(300);
        // 走满 4 步到目标
        expect([runtime.state.hero.x, runtime.state.hero.y]).toEqual([2, 2]);
        expect(route.active).toBe(false);
    });

    test('每一步都进录像（与手动操作一致）', () => {
        const { route, runtime, tick } = makeRoute({ direct: false });
        route.click(0, 2);
        tick(0);
        tick(100);
        expect(runtime.route.route).toEqual(['down', 'down']);
    });

    test('允许瞬移时，点空白通道直接闪过去', () => {
        const { route, runtime, routes } = makeRoute();
        route.click(2, 2);
        expect([runtime.state.hero.x, runtime.state.hero.y]).toEqual([2, 2]);
        expect(route.active).toBe(false);
        // 瞬移也记方向，录像可回放
        expect(runtime.route.route).toEqual(['down', 'down', 'right', 'right']);
        // 瞬移只清一次预览（没有画出过路线）
        expect(routes).toEqual([null]);
    });

    test('点自己那一格：延迟后原地转向', () => {
        const { route, runtime, tick } = makeRoute();
        expect(route.click(0, 0)).toBe(true);
        expect(route.active).toBe(false);
        tick(100);
        expect(runtime.state.hero.direction).toBe('down');
        tick(200);
        expect(runtime.state.hero.direction).toBe('left');
    });

    test('走同一个目标再点一次：停下并尝试瞬移', () => {
        const { route, runtime, tick } = makeRoute({ direct: false });
        route.click(2, 2);
        tick(0);
        expect(route.active).toBe(true);
        route.click(2, 2);
        expect(route.active).toBe(false);
        // 关掉瞬移时不会移动，但路线确实取消了
        expect([runtime.state.hero.x, runtime.state.hero.y]).toEqual([0, 1]);
    });

    test('对话框 / 面板接管时路线作废', () => {
        let blocked = false;
        const { route, runtime, tick } = makeRoute({ blocked: () => blocked, direct: false });
        route.click(2, 2);
        tick(0);
        blocked = true;
        tick(100);
        expect(route.active).toBe(false);
        expect([runtime.state.hero.x, runtime.state.hero.y]).toEqual([0, 1]);
    });

    test('blocked 为真时不消费点击', () => {
        const { route } = makeRoute({ blocked: () => true });
        expect(route.click(2, 2)).toBe(false);
    });

    test('cancel 清掉路线预览', () => {
        const { route, routes } = makeRoute({ direct: false });
        route.click(2, 2);
        expect(routes.length).toBeGreaterThan(0);
        route.cancel();
        expect(routes[routes.length - 1]).toBeNull();
    });

    test('cancelMoveDirectly 相关 flag 生效', () => {
        const { route, runtime } = makeRoute();
        runtime.state.flags.__noClickMove__ = true;
        route.click(2, 2);
        // 禁止瞬移 -> 变成逐步走
        expect([runtime.state.hero.x, runtime.state.hero.y]).toEqual([0, 0]);
        expect(route.active).toBe(true);
    });
});

describe('tileAt', () => {
    const canvas = {
        width: 96,
        height: 96,
        getBoundingClientRect: () => ({ left: 10, top: 20, width: 96, height: 96 }),
    } as unknown as HTMLCanvasElement;

    test('按格子尺寸换算坐标', () => {
        expect(tileAt(canvas, 10, 20)).toEqual({ x: 0, y: 0 });
        expect(tileAt(canvas, 42, 52)).toEqual({ x: 1, y: 1 });
    });

    test('越界返回 null', () => {
        expect(tileAt(canvas, 9, 50)).toBeNull();
        expect(tileAt(canvas, 200, 50)).toBeNull();
    });

    test('画布被 CSS 缩放时按缩放后的格子尺寸换算', () => {
        const scaled = {
            width: 96,
            height: 96,
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 48, height: 48 }),
        } as unknown as HTMLCanvasElement;
        // 显示倍率 0.5 -> 显示格子边长 16
        expect(tileAt(scaled, 24, 24, 16)).toEqual({ x: 1, y: 1 });
        expect(tileAt(scaled, 47, 47, 16)).toEqual({ x: 2, y: 2 });
        expect(tileAt(scaled, 48, 24, 16)).toBeNull();
    });
});
