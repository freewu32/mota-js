/**
 * 塔作者脚本。
 *
 * 新引擎的对外契约是「数据驱动优先，脚本仅兜底」：能用剧本动作与值块表达的
 * 都写进数据（见 `builtins.ts`），只有真正需要命令式逻辑的（炸弹扫怪算钱、
 * 破墙镐多方向、技能开关、面板类道具）才写脚本。
 *
 * 脚本是一个模块，默认导出一个函数：
 *
 * ```ts
 * // project/scripts/items/bomb.ts
 * export default (({ api, itemId }) => {
 *     const target = api.blockAt(api.nextX(), api.nextY());
 *     if (!target) {
 *         api.playSound('操作失败');
 *         api.addItem(itemId, 1); // 不消耗
 *         return;
 *     }
 *     api.removeBlock(target.x, target.y);
 *     return [{ type: 'tip', text: '炸弹使用成功' }];
 * }) satisfies ItemScript;
 * ```
 *
 * 数据里用 `{ "script": "items/bomb" }` 引用；引擎不直接 `import`，而是调用
 * 宿主注入的 `loadScript(name)`（浏览器用动态 `import()`、测试用注册表），
 * 因此引擎本身无 IO、可单测。
 */
import type { ScriptAction } from './events';
import type { GameApi, Value } from './game-api';

/** 数据里引用脚本的写法：`{ "script": "items/bomb" }` */
export interface ScriptRef {
    script: string;
}

export function isScriptRef(value: unknown): value is ScriptRef {
    return (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as ScriptRef).script === 'string' &&
        Object.keys(value as ScriptRef).length === 1
    );
}

/** 脚本的触发时机 */
export type ScriptTrigger = 'pickUp' | 'use' | 'event' | 'function';

/** 传给塔作者脚本的上下文 */
export interface ScriptContext {
    /** 游戏 API（只读查询 + 写操作 + 注入剧本动作） */
    api: GameApi;
    /** 道具脚本：当前道具 id */
    itemId?: string;
    /** 触发时机 */
    trigger: ScriptTrigger;
    /** `function` 动作传入的参数（来自塔数据的 JSON 值） */
    args?: Value[];
}

/** 脚本返回值：可直接返回剧本动作，也可以只用 `api` 改状态 */
export type TowerScript = (ctx: ScriptContext) => ScriptAction | ScriptAction[] | void;

/** 宿主注入的加载器：浏览器用动态 `import()`，测试用内存注册表 */
export type ScriptLoader = (name: string) => unknown | Promise<unknown>;

/** 从加载结果里取出脚本函数：支持模块默认导出与直接导出函数 */
export function toTowerScript(loaded: unknown): TowerScript | null {
    if (typeof loaded === 'function') return loaded as TowerScript;
    if (loaded && typeof loaded === 'object') {
        const mod = loaded as { default?: unknown };
        if (typeof mod.default === 'function') return mod.default as TowerScript;
    }
    return null;
}

/** 收集数据里出现的所有 `{ script }` 引用名（用于开局预加载） */
export function collectScriptRefs(value: unknown, out = new Set<string>()): string[] {
    if (Array.isArray(value)) {
        for (const item of value) collectScriptRefs(item, out);
    } else if (value && typeof value === 'object') {
        if (isScriptRef(value)) out.add(value.script);
        else for (const item of Object.values(value)) collectScriptRefs(item, out);
    }
    return [...out];
}

/**
 * 脚本注册表。
 *
 * 引擎执行效果是同步的（帧栈模型），所以脚本在开局前由 `loadAll` 预加载进注册表，
 * 运行时只做同步查表；加载失败的脚本名会被返回，便于宿主报告给塔作者。
 */
export class ScriptRegistry {
    private readonly scripts = new Map<string, TowerScript>();

    register(name: string, script: TowerScript): void {
        this.scripts.set(name, script);
    }

    has(name: string): boolean {
        return this.scripts.has(name);
    }

    get(name: string): TowerScript | undefined {
        return this.scripts.get(name);
    }

    get names(): string[] {
        return [...this.scripts.keys()];
    }

    get size(): number {
        return this.scripts.size;
    }

    clear(): void {
        this.scripts.clear();
    }

    /** 批量加载脚本；返回加载失败的脚本名（找不到模块或没有导出函数） */
    async loadAll(names: readonly string[], loader: ScriptLoader): Promise<string[]> {
        const failed: string[] = [];
        for (const name of names) {
            if (this.has(name)) continue;
            try {
                const script = toTowerScript(await loader(name));
                if (script) this.register(name, script);
                else {
                    failed.push(name);
                    console.error(`脚本 ${name} 没有默认导出函数`);
                }
            } catch (error) {
                failed.push(name);
                console.error(`脚本 ${name} 加载失败：`, error);
            }
        }
        return failed;
    }
}
