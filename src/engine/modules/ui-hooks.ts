/**
 * 塔作者 UI 脚本钩子（`mota.ui.register({...})`）。
 *
 * 与 `functions.ui` 的旧写法相比，钩子只返回**数据**，不接触 DOM：
 * 引擎拿到排序结果 / 统计项列表后照常渲染，因此录像、存档与 UI 的解耦不被破坏。
 * 钩子返回 null / undefined 表示「不改」，回退到 `firstData.ui` 的声明式配置。
 */
import type { UiConfig } from './ui-config';

export interface UiHooks {
    /** 旧 `getToolboxItems(cls)`：返回道具栏的显示项与顺序 */
    getToolboxItems?(cls: string, ids: readonly string[]): string[] | null;
    /** 旧 `drawStatistics()`：返回要统计的图块 id */
    statistics?(): string[] | null;
    /** 旧 `drawAbout()`：关于 / 帮助文本 */
    about?(): string | null;
}

/** 塔作者脚本注册 UI 钩子的地方（`mota.ui`） */
export class UiHookRegistry {
    private hooks: UiHooks = {};

    register(hooks: UiHooks | null | undefined): void {
        if (!hooks || typeof hooks !== 'object') return;
        this.hooks = { ...this.hooks, ...hooks };
    }

    /** 当前钩子（只读；引擎内部用） */
    get current(): UiHooks {
        return this.hooks;
    }

    getToolboxItems(cls: string, ids: readonly string[]): string[] | null {
        const result = this.hooks.getToolboxItems?.(cls, ids);
        return Array.isArray(result) ? result : null;
    }

    statistics(): string[] | null {
        const result = this.hooks.statistics?.();
        return Array.isArray(result) ? result : null;
    }

    about(): string | null {
        const result = this.hooks.about?.();
        return typeof result === 'string' ? result : null;
    }

    clear(): void {
        this.hooks = {};
    }
}

/** 供测试与 `parseUiConfig` 共用：配置里的统计项 */
export type { UiConfig };
