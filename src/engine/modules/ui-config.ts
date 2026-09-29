/**
 * 塔作者的 UI 定制（旧 `project/functions.js` 的 `eventdata.ui`）。
 *
 * 旧塔可以覆写 `getToolboxItems` / `drawStatusBar` / `drawStatistics` / `drawAbout`
 * 四个函数，直接操作 DOM 与 canvas。新架构把「界面长什么样」交给引擎与 `src/ui`，
 * 因此定制分两层：
 *
 * 1. **声明式数据**（推荐）：`firstData.ui` —— 统计哪些图块、道具栏怎么排序、
 *    状态栏显示哪些项、帮助 / 关于写什么，覆盖绝大多数塔的需求；
 * 2. **脚本钩子**：`project/scripts/ui.ts` 里 `mota.ui.register({...})`，
 *    用于确实要写代码的场景（按名字排序、动态生成统计项）。脚本只返回数据，
 *    不接触 DOM，因此录像与存档的一致性不受影响。
 *
 * 「自绘状态栏」这类直接改渲染的定制在新架构下没有等价物：状态栏是 DOM，
 * 塔作者改不了它的布局，只能改主题 CSS 变量与显示项（见「十一、风险与建议」）。
 */
import type { UiHookRegistry } from './ui-hooks';

export interface UiConfig {
    /** 地图浏览 / 统计面板里要统计的图块 id（旧 `drawStatistics` 的返回数组） */
    statistics?: string[];
    /** 道具栏排序：`id`（默认，按 id 升序）或 `name`（按名称） */
    toolboxSort?: 'id' | 'name';
    /** 状态栏显示项（覆盖 `flags.statusBarItems`） */
    statusBarItems?: string[];
    /** 状态栏文字颜色（CSS 颜色值，覆盖主题默认） */
    statusBarColor?: string;
    /** 帮助 / 关于面板的额外文本 */
    about?: string;
    /** 帮助面板的额外说明（键位提示之外） */
    help?: string;
}

/** 从塔数据里解析 UI 配置；非法字段直接忽略（旧塔多半没有这段配置） */
export function parseUiConfig(raw: unknown): UiConfig {
    if (!raw || typeof raw !== 'object') return {};
    const source = raw as Record<string, unknown>;
    const config: UiConfig = {};
    if (Array.isArray(source.statistics)) {
        config.statistics = source.statistics.filter(
            (one): one is string => typeof one === 'string',
        );
    }
    if (source.toolboxSort === 'id' || source.toolboxSort === 'name') {
        config.toolboxSort = source.toolboxSort;
    }
    if (Array.isArray(source.statusBarItems)) {
        config.statusBarItems = source.statusBarItems.filter(
            (one): one is string => typeof one === 'string',
        );
    }
    if (typeof source.statusBarColor === 'string') config.statusBarColor = source.statusBarColor;
    if (typeof source.about === 'string') config.about = source.about;
    if (typeof source.help === 'string') config.help = source.help;
    return config;
}

/**
 * 按配置与脚本钩子对道具栏排序。
 *
 * 与旧 `getToolboxItems(cls)` 一致：只调整「显示项与顺序」，不改数量与可用性。
 * 钩子优先于声明式配置（脚本更具体）。
 */
export function orderToolboxItems(
    cls: string,
    ids: readonly string[],
    options: {
        config?: UiConfig;
        hooks?: UiHookRegistry;
        nameOf?: (id: string) => string;
    },
): string[] {
    const custom = options.hooks?.getToolboxItems(cls, ids);
    if (custom) {
        // 钩子返回的列表里可能有未知 id，过滤掉以免面板出现幻影道具
        return custom.filter((id) => ids.includes(id));
    }
    if (options.config?.toolboxSort === 'name' && options.nameOf) {
        const nameOf = options.nameOf;
        return [...ids].sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'zh-Hans-CN'));
    }
    return [...ids].sort();
}

/** 统计面板要统计的图块 id：脚本钩子 → 声明式配置 → 空 */
export function statisticsIds(options: { config?: UiConfig; hooks?: UiHookRegistry }): string[] {
    return options.hooks?.statistics() ?? options.config?.statistics ?? [];
}
