/**
 * 排版计算的回归测试。
 *
 * 期望值取自旧引擎在浏览器里的实测（1280x720 横屏、393x852 竖屏、1280x800 横屏），
 * 以及 `libs/control.js` 的 `resize` 公式。
 */
import { describe, expect, test } from 'bun:test';
import { AVAILABLE_SCALES, computeGameLayout, LAYOUT_BORDER } from '../src/game/layout';

/** 13x13 地图（416x416），示例塔的显示项：12 项 -> 竖屏 4 行 */
const sample = {
    mapWidth: 416,
    mapHeight: 416,
    statusRows: 4,
    statusCount: 12,
};

describe('computeGameLayout', () => {
    test('横屏：左列 31% 宽，地图取整数档位缩放', () => {
        const layout = computeGameLayout({ ...sample, clientWidth: 1280, clientHeight: 720 });
        expect(layout.vertical).toBe(false);
        expect(layout.barWidth).toBe(129); // round(416 * 0.31)
        // 旧版在 1280x800 实测为 scale=1（初始档位命中就保持不变）
        expect(layout.scale).toBe(1);
        expect(layout.outerWidth).toBe(422);
        expect(layout.outerHeight).toBe(422);
        expect(layout.totalWidth).toBe(422 + 129 + 3);
        expect(layout.totalHeight).toBe(422);
        expect(layout.statusBarHeight).toBe(422);
        expect(layout.toolbarHeight).toBe(0);
        expect(layout.extendToolbar).toBe(false);
        expect(layout.toolbarItemHeight).toBe(32);
    });

    test('横屏：窗口足够大时用 1.25/1.5 档位', () => {
        const layout = computeGameLayout({ ...sample, clientWidth: 1600, clientHeight: 1200 });
        expect(layout.vertical).toBe(false);
        // 初始档位 1 -> 命中 availableScale 就保持 1（旧版语义：不主动放大）
        expect(layout.scale).toBe(1);

        const scaled = computeGameLayout({
            ...sample,
            clientWidth: 1600,
            clientHeight: 1200,
            scale: 1.5,
        });
        expect(scaled.scale).toBe(1.5);
        expect(scaled.outerWidth).toBe(416 * 1.5 + 6);
        expect(scaled.statusItemHeight).toBeCloseTo(((13 - 4) / 12) * 32 * 1.5 * 0.8, 6);
        expect(scaled.statusFontSize).toBeCloseTo(16 * 0.75 * 1.5, 6);
    });

    test('横屏：高度不够时按 horizontalMaxRatio 缩小', () => {
        const layout = computeGameLayout({ ...sample, clientWidth: 1600, clientHeight: 500 });
        // (500 - 6) / 416 = 1.1875 -> 命中 1 档？1 <= ratio，且宽度够 -> 保持 1
        expect(layout.scale).toBe(1);

        const small = computeGameLayout({ ...sample, clientWidth: 1600, clientHeight: 300 });
        // (300 - 6) / 416 = 0.7067 -> 没有可用档位 -> min(1, ratio)
        expect(small.scale).toBeCloseTo((300 - 6) / 416, 6);
        expect(small.outerHeight).toBeCloseTo(416 * ((300 - 6) / 416) + 6, 6);
    });

    test('竖屏：状态栏在顶部、工具栏在地图下方、地图撑满宽度', () => {
        const layout = computeGameLayout({ ...sample, clientWidth: 393, clientHeight: 852 });
        expect(layout.vertical).toBe(true);
        const scale = (393 - 6) / 416;
        expect(layout.scale).toBeCloseTo(scale, 6);
        expect(layout.barWidth).toBe(125); // round(416 * 0.3)
        expect(layout.outerWidth).toBeCloseTo(393, 6);
        expect(layout.statusBarHeight).toBeCloseTo((32 * 4 + 6) * scale + 6, 6);
        expect(layout.toolbarHeight).toBeCloseTo(38 * scale + 6, 6);
        expect(layout.totalWidth).toBeCloseTo(393, 6);
        expect(layout.totalHeight).toBeCloseTo(
            416 * scale + 6 + layout.statusBarHeight + layout.toolbarHeight,
            6,
        );
        expect(layout.statusItemHeight).toBeCloseTo(32 * scale * 0.8, 6);
        expect(layout.statusFontSize).toBeCloseTo(16 * scale, 6);
        expect(layout.toolbarItemHeight).toBeCloseTo(32 * scale * 0.95, 6);
        expect(layout.extendToolbar).toBe(false);
    });

    test('横屏 + extendToolbar：工具栏占地图下方一行，总高度变大', () => {
        const layout = computeGameLayout({
            ...sample,
            clientWidth: 1280,
            clientHeight: 800,
            extendToolbar: true,
        });
        expect(layout.vertical).toBe(false);
        expect(layout.extendToolbar).toBe(true);
        // 横屏多出的一行用 +BORDER（旧 `_resize_toolBar`），竖屏才是 +2*BORDER
        expect(layout.toolbarHeight).toBe(38 * layout.scale + 3);
        expect(layout.statusBarHeight).toBe(416 * layout.scale + 6 + 38 * layout.scale + 3);
        expect(layout.totalHeight).toBe(416 * layout.scale + 6 + 38 * layout.scale + 3);
    });

    test('hideLeftStatusBar：横屏不占左列，工具栏改到地图下方', () => {
        const layout = computeGameLayout({
            ...sample,
            clientWidth: 1280,
            clientHeight: 800,
            hideLeftStatusBar: true,
        });
        expect(layout.hideLeftStatusBar).toBe(true);
        expect(layout.barWidth).toBe(0);
        expect(layout.totalWidth).toBe(layout.outerWidth);
        // 旧 `_resize_toolBar`：extendToolbar || hideLeftStatusBar 时工具栏在地图下方（+BORDER）
        expect(layout.toolbarHeight).toBe(38 * layout.scale + 3);
        expect(layout.totalHeight).toBe(layout.outerHeight + layout.toolbarHeight);
    });

    test('竖屏强制忽略 extendToolbar / hideLeftStatusBar（旧版一致）', () => {
        const layout = computeGameLayout({
            ...sample,
            clientWidth: 400,
            clientHeight: 900,
            extendToolbar: true,
            hideLeftStatusBar: true,
        });
        expect(layout.vertical).toBe(true);
        expect(layout.extendToolbar).toBe(false);
        expect(layout.hideLeftStatusBar).toBe(false);
        expect(layout.barWidth).toBe(125);
    });

    test('档位表与旧版一致', () => {
        expect(AVAILABLE_SCALES).toEqual([1, 1.25, 1.5, 1.75, 2, 2.25, 2.5]);
        expect(LAYOUT_BORDER).toBe(3);
    });

    test('非整数缩放也不会算出 0 或负数', () => {
        const layout = computeGameLayout({ ...sample, clientWidth: 100, clientHeight: 100 });
        expect(layout.scale).toBeGreaterThan(0);
        expect(layout.outerWidth).toBeGreaterThan(0);
    });
});
