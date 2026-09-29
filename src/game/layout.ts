/**
 * 游戏页布局计算（旧 `control.resize` 的等价物）。
 *
 * 旧引擎把整页排版交给 `libs/control.js` 的 `resize`：横屏时状态栏/工具栏是一列
 * 贴在左边、地图在右；竖屏时状态栏铺在顶部（每行 3 项）、地图居中、工具栏在地图
 * 下方；地图按窗口大小缩放（横屏只取整数档位 `availableScale`，竖屏按宽度撑满）。
 *
 * 3.0 的 DOM 结构不同（网格 + CSS 变量），但**数字全部沿用旧公式**，这样
 * 「换个窗口大小，版面与旧版一致」是算出来的而不是试出来的。本文件保持纯函数，
 * 由 `tests/layout.test.ts` 覆盖。
 */
import { TILE } from '../engine/tiles';

/** 地图外围边框（旧 `BORDER`），也是 `#gameDraw` 的 border 宽度 */
export const LAYOUT_BORDER = 3;
/** 工具栏一行的高度（旧 `TOOLBAR_HEIGHT`） */
export const LAYOUT_TOOLBAR = 38;
/** 横屏允许的放大档位（旧 `core.domStyle.availableScale` 候选） */
export const AVAILABLE_SCALES: readonly number[] = [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5];

export interface LayoutInput {
    /** 视口宽高（旧 `main.dom.body.clientWidth/clientHeight`） */
    clientWidth: number;
    clientHeight: number;
    /** 地图像素尺寸（未缩放） */
    mapWidth: number;
    mapHeight: number;
    /** 竖屏状态栏行数（旧 `col = ceil(显示项数 / 3)`） */
    statusRows: number;
    /** 横屏参与排版的显示项数（旧 `obj.count`，用于压缩每行高度） */
    statusCount: number;
    /** 当前缩放；命中档位时保持不变（旧 `core.domStyle.scale`） */
    scale?: number;
    /** `flags.extendToolbar` */
    extendToolbar?: boolean;
    /** `flags.hideLeftStatusBar` */
    hideLeftStatusBar?: boolean;
}

export interface GameLayout {
    /** 竖屏：状态栏在顶部、工具栏在地图下方 */
    vertical: boolean;
    /** 地图显示缩放 */
    scale: number;
    border: number;
    /** 地图原始尺寸 */
    mapWidth: number;
    mapHeight: number;
    /** 地图显示尺寸（`mapWidth * scale`） */
    displayWidth: number;
    displayHeight: number;
    /** 地图外框（含边框），即旧 `outerWidth/outerHeight` */
    outerWidth: number;
    outerHeight: number;
    /** 整块游戏区域尺寸（旧 `totalWidth/totalHeight`，用于居中） */
    totalWidth: number;
    totalHeight: number;
    /** 横屏左侧状态栏/工具栏列宽（未缩放） */
    barWidth: number;
    /** 状态栏区域高度：竖屏为顶部整块，横屏为左列高度 */
    statusBarHeight: number;
    /** 工具栏高度：竖屏为地图下方一行；横屏 `extendToolbar` 时为额外一行 */
    toolbarHeight: number;
    /** 横屏：工具栏是否独占地图下方一行（旧 `extendToolbar`） */
    extendToolbar: boolean;
    /** `flags.hideLeftStatusBar`（横屏隐藏左列） */
    hideLeftStatusBar: boolean;
    /** 每个状态项的高度（旧 `statusHeight`） */
    statusItemHeight: number;
    /** 状态栏字号（旧 `statusBar.style.fontSize`） */
    statusFontSize: number;
    /** 工具栏图标高度（旧 `toolsHeight`） */
    toolbarItemHeight: number;
    /** 通用字号（旧 `16 * scale`） */
    fontSize: number;
}

const clampScale = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 1);

/**
 * 计算排版参数。与旧实现的对应关系逐行写在注释里，便于日后对照。
 */
export function computeGameLayout(input: LayoutInput): GameLayout {
    const border = LAYOUT_BORDER;
    const { clientWidth, clientHeight, mapWidth, mapHeight, statusRows, statusCount } = input;
    const tilesHeight = mapHeight / TILE;

    let hideLeftStatusBar = input.hideLeftStatusBar === true;
    let extendToolbar = input.extendToolbar === true;
    let barWidth = hideLeftStatusBar ? 0 : Math.round(mapWidth * 0.31);

    // 旧：horizontalMaxRatio = (clientHeight - 2*BORDER - (hideLeftStatusBar ? BORDER : 0)) / (_PY_ + ...)
    const horizontalMaxRatio =
        (clientHeight - 2 * border - (hideLeftStatusBar ? border : 0)) /
        (mapHeight + (hideLeftStatusBar ? LAYOUT_TOOLBAR : 0));

    let scale = clampScale(input.scale ?? 1);
    // 旧：clientWidth - 3*BORDER >= _PX_ + BAR_WIDTH || (clientWidth > clientHeight && horizontalMaxRatio < 1)
    const vertical = !(
        clientWidth - 3 * border >= mapWidth + barWidth ||
        (clientWidth > clientHeight && horizontalMaxRatio < 1)
    );

    if (!vertical) {
        // 横屏：只在能同时放下宽度/高度的档位里挑（旧 availableScale）
        const available = AVAILABLE_SCALES.filter(
            (value) =>
                clientWidth - 3 * border >= value * (mapWidth + barWidth) &&
                horizontalMaxRatio >= value,
        );
        if (!available.includes(scale)) scale = Math.min(1, horizontalMaxRatio);
        scale = clampScale(scale);
    } else {
        // 竖屏：按宽度撑满（旧版不设上限），工具栏回到地图下方一行
        extendToolbar = false;
        hideLeftStatusBar = false;
        barWidth = Math.round(mapWidth * 0.3);
        scale = clampScale(Math.min((clientWidth - 2 * border) / mapWidth));
    }

    const displayWidth = mapWidth * scale;
    const displayHeight = mapHeight * scale;
    const outerWidth = displayWidth + 2 * border;
    const outerHeight = displayHeight + 2 * border;
    const count = Math.max(1, statusCount);

    // 旧 `_resize_statusBar` / `_resize_toolBar` / `_resize_gameGroup`：
    // 横屏时工具栏只有 `extendToolbar` 或 `hideLeftStatusBar` 才会跑到地图下方
    const toolbarOutside = vertical || extendToolbar || hideLeftStatusBar;
    const toolbarHeight = vertical
        ? LAYOUT_TOOLBAR * scale + 2 * border
        : toolbarOutside
          ? LAYOUT_TOOLBAR * scale + border
          : 0;
    const statusBarHeight = vertical
        ? (32 * statusRows + 6) * scale + 2 * border
        : outerHeight + (extendToolbar ? LAYOUT_TOOLBAR * scale + border : 0);
    const totalWidth = outerWidth + (vertical || hideLeftStatusBar ? 0 : barWidth * scale + border);
    const totalHeight =
        outerHeight +
        (vertical ? statusBarHeight + toolbarHeight : toolbarOutside ? toolbarHeight : 0);

    // 旧 `_resize_status` / `_resize_statusBar` / `_resize_tools`
    const statusItemHeight = vertical
        ? 32 * scale * 0.8
        : ((tilesHeight - 4) / count) * 32 * scale * 0.8;
    const statusFontSize = vertical
        ? 16 * scale
        : 16 * Math.min(1, (tilesHeight - 4) / count) * scale;
    const toolbarItemHeight = 32 * scale * (vertical || extendToolbar ? 0.95 : 1);

    return {
        vertical,
        scale,
        border,
        mapWidth,
        mapHeight,
        displayWidth,
        displayHeight,
        outerWidth,
        outerHeight,
        totalWidth,
        totalHeight,
        barWidth,
        statusBarHeight,
        toolbarHeight,
        extendToolbar,
        hideLeftStatusBar,
        statusItemHeight,
        statusFontSize,
        toolbarItemHeight,
        fontSize: 16 * scale,
    };
}

/** 视口尺寸（旧 `main.dom.body.clientWidth/clientHeight`） */
export function viewportSize(): { width: number; height: number } {
    if (typeof document === 'undefined') return { width: 0, height: 0 };
    return { width: document.body.clientWidth, height: document.body.clientHeight };
}
