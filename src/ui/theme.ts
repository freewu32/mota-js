/**
 * 主题与外观。
 *
 * 旧引擎的外观分散在两处：`core.status.textAttribute`（配色）与
 * `project/images/winskin.png` 九宫格窗口皮肤（`ui._drawWindowSkin` 用 drawImage 平铺）。
 * 新方案把它们统一成「CSS 变量 + border-image」：
 *
 * - 配色 / 字体 → CSS 变量（塔作者可在数据里覆盖）；
 * - 窗口皮肤 → 九宫格 border-image（旧 drawWindowSkin 的 16px 边框 + 32px 平铺）。
 *
 * 面板 / 状态栏 / 对话框共用同一套类名，游戏端与编辑器复用。
 */

/** 主题模型；塔作者可只覆盖其中几项 */
export interface UiTheme {
    id: string;
    name: string;
    /** 窗口皮肤图片地址（九宫格） */
    skin?: string;
    /** 九宫格 slice（像素），旧 drawWindowSkin 固定 16 */
    skinSlice?: number;
    /** CSS 变量覆盖 */
    vars: Record<string, string>;
}

/** 设计令牌（CSS 变量）默认值，对应旧 textAttribute 的一组配色 */
export const defaultVars: Record<string, string> = {
    '--mota-font': 'system-ui, "Microsoft YaHei", sans-serif',
    '--mota-text': '#eeeeee',
    '--mota-bg': '#111111',
    '--mota-panel': '#1b1d23',
    '--mota-panel-border': '#4a4e59',
    '--mota-title': '#ffd479',
    '--mota-accent': '#9ad9ff',
    '--mota-highlight': '#ffd479',
    '--mota-muted': '#9aa0ad',
    '--mota-entry': '#262932',
    '--mota-skin': 'none',
    '--mota-skin-slice': '16',
    '--mota-skin-width': '16px',
};

export const defaultTheme: UiTheme = {
    id: 'default',
    name: '默认',
    vars: {},
};

/** 合并默认令牌与主题覆盖，得到最终的 CSS 变量表 */
export function themeVars(theme: UiTheme | null | undefined): Record<string, string> {
    const vars = { ...defaultVars, ...(theme?.vars ?? {}) };
    if (theme?.skin) {
        const slice = theme.skinSlice ?? 16;
        vars['--mota-skin'] = `url("${theme.skin}")`;
        vars['--mota-skin-slice'] = String(slice);
        vars['--mota-skin-width'] = `${slice}px`;
    }
    return vars;
}

/** 窗口皮肤的 CSS 声明（供样式表或调试面板使用） */
export function skinDeclarations(theme: UiTheme | null | undefined): Record<string, string> {
    if (!theme?.skin) return {};
    const slice = theme.skinSlice ?? 16;
    return {
        'border-image-source': `url("${theme.skin}")`,
        'border-image-slice': `${slice} fill`,
        'border-image-repeat': 'repeat',
    };
}

/**
 * 解析（可能来自数据的）主题对象；非法字段忽略，永不抛错。
 * 数据侧统一用 `{ id, name, skin, skinSlice, vars }`。
 */
export function parseTheme(input: unknown): UiTheme {
    if (input == null || typeof input !== 'object') return defaultTheme;
    const raw = input as Record<string, unknown>;
    const vars: Record<string, string> = {};
    if (raw.vars != null && typeof raw.vars === 'object') {
        for (const [key, value] of Object.entries(raw.vars as Record<string, unknown>)) {
            if (typeof value === 'string' || typeof value === 'number') {
                vars[key.startsWith('--') ? key : `--mota-${key}`] = String(value);
            }
        }
    }
    const theme: UiTheme = {
        id: typeof raw.id === 'string' ? raw.id : 'custom',
        name: typeof raw.name === 'string' ? raw.name : '自定义',
        vars,
    };
    if (typeof raw.skin === 'string' && raw.skin.length > 0) theme.skin = raw.skin;
    if (typeof raw.skinSlice === 'number' && raw.skinSlice > 0) theme.skinSlice = raw.skinSlice;
    return theme;
}

/** 把主题写进元素的 CSS 变量（默认 `<html>`） */
export function applyTheme(
    theme: UiTheme | null | undefined,
    root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement,
): void {
    if (!root) return;
    for (const [name, value] of Object.entries(themeVars(theme))) {
        root.style.setProperty(name, value);
    }
    // 有皮肤时切到九宫格 border-image，没有时用 CSS 变量兜底的纯色边框
    if (theme?.skin) root.dataset.skin = '1';
    else delete root.dataset.skin;
}
