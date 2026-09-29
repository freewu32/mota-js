/**
 * 全局商店（旧 `project/plugins.js` 的 shop 插件 + `firstData.shops`）。
 *
 * 旧实现把商店「翻译」成一段公共事件（`choices` + `while(true)` + `break`），
 * 新引擎沿用这个思路，但翻译代码放在引擎里，不再需要塔作者写 `function` 动作：
 *
 * - 商店数据来自 `firstData.shops`；
 * - 未访问过的商店默认进入「预览模式」（选项灰掉、点了只给提示），
 *   只有剧本里的 `openShop` 动作（`open: true`）标记过访问才真正可买；
 * - `disablePreview` 的商店在未访问时直接拒绝打开；
 * - 离开商店由固定的「离开」选项 `break` 退出循环，可以连续购买。
 *
 * 与旧插件的差异：
 * - 旧的 `core.plugin.openShop(id, noRoute)` 的 `noRoute` 参数在新引擎里表示
 *   「不重复记录像」，改名成 `noRoute` 保留；
 * - `shop.item`（道具商店插件）与 `shop.commonEvent` 旧走插件回调，新引擎里
 *   `commonEvent` 直接插公共事件，`item` 暂未支持（打开时提示）。
 */
import type { ChoiceItem, ScriptAction, ScriptActionList, ScriptActionObject } from './events';

/** 商店里的一个选项 */
export interface ShopChoice {
    text: string;
    /** 购买条件（值块表达式）；不满足时点击只给提示 */
    need?: string;
    /** 是否显示该选项 */
    condition?: string;
    icon?: string | number;
    color?: unknown;
    action?: ScriptActionList;
    [key: string]: unknown;
}

export interface ShopData {
    id: string;
    text: string;
    /** 快捷商店列表里的名字 */
    textInList?: string;
    /** 必须由剧本 `openShop` 开启后才能打开 */
    mustEnable?: boolean;
    /** 未访问时不允许预览（直接拒绝打开） */
    disablePreview?: boolean;
    choices?: ShopChoice[];
    /** 道具商店插件的 id（未支持） */
    item?: string;
    /** 打开一个公共事件代替商店界面 */
    commonEvent?: string;
    args?: unknown[];
    [key: string]: unknown;
}

/** 商店界面里「离开」选项的文本 */
export const SHOP_LEAVE_TEXT = '离开';

/** 快捷商店列表项（游戏入口的商店面板用） */
export interface ShopEntry {
    id: string;
    text: string;
    /** 是否已访问过（未访问的商店只能预览） */
    visited: boolean;
    canOpen: boolean;
}

export interface ShopsHost {
    /** 塔里的全部商店（`firstData.shops`） */
    all(): ShopData[];
    get(id: string): ShopData | undefined;
    getFlag(name: string, fallback?: unknown): unknown;
    setFlag(name: string, value: unknown): void;
    /** 当前楼层是否允许使用快捷商店（旧 `canUseQuickShop`） */
    quickShopAllowed(): boolean;
    /** 执行一段剧本（商店界面本身就是一个 `choices` 事件） */
    run(actions: ScriptActionList): void;
    /** 记录录像 token */
    record(token: string): void;
    /** 求值值块表达式（`need` / `condition`） */
    evaluate(expression: string): boolean;
    /** 打开公共事件 */
    insertCommonEvent?(name: string, args: unknown[]): void;
}

/** 把商店选项翻译成 `choices` 的选项（旧 `_convertShop_replaceChoices`） */
export function buildShopChoices(
    shop: ShopData,
    options: { preview?: boolean; evaluate: (expression: string) => boolean },
): ChoiceItem[] {
    const preview = options.preview === true;
    const choices: ChoiceItem[] = [];
    for (const choice of shop.choices ?? []) {
        if (
            choice.condition != null &&
            choice.condition !== '' &&
            !options.evaluate(choice.condition)
        ) {
            continue;
        }
        const ableToBuy =
            choice.need == null || choice.need === '' || options.evaluate(choice.need);
        // 可购买：先补一个「商店」音效，再执行选项动作
        let action: ScriptActionList;
        if (preview) {
            action = [
                { type: 'playSound', name: '操作失败' },
                { type: 'tip', text: '预览模式下不可购买' },
            ];
        } else if (ableToBuy) {
            const list: ScriptAction[] = [{ type: 'playSound', name: '商店' }];
            if (choice.action != null) {
                // 选项动作可以写成数组（等价于顺序执行），这里展开一层
                if (Array.isArray(choice.action)) list.push(...choice.action);
                else list.push(choice.action);
            }
            action = list;
        } else {
            action = [
                { type: 'playSound', name: '操作失败' },
                { type: 'tip', text: '购买条件不足' },
            ];
        }
        choices.push({
            text: choice.text,
            icon: choice.icon,
            // 买不起 / 预览时灰掉（旧版用 [153,153,153,1]）
            color: ableToBuy && !preview ? choice.color : [153, 153, 153, 1],
            action,
        });
    }
    choices.push({
        text: SHOP_LEAVE_TEXT,
        action: [{ type: 'playSound', name: '取消' }, { type: 'break' }],
    });
    return choices;
}

/** 商店管理器：访问状态、能否打开、生成剧本 */
export class MotaShops {
    constructor(private readonly host: ShopsHost) {}

    /** 塔里的全部商店 */
    list(): ShopData[] {
        return this.host.all();
    }

    get(id: string): ShopData | undefined {
        return this.host.get(id);
    }

    /** 旧 `isShopVisited`：访问记录放在 `flags.__shops__` 里 */
    isVisited(id: string): boolean {
        const shops = this.flags();
        return Boolean((shops[id] as { visited?: boolean } | undefined)?.visited);
    }

    /** 旧 `setShopVisited` */
    setVisited(id: string, visited: boolean): void {
        const shops = this.flags();
        const entry = (shops[id] ?? {}) as { visited?: boolean };
        if (visited) entry.visited = true;
        else delete entry.visited;
        shops[id] = entry;
        this.host.setFlag('__shops__', shops);
    }

    private flags(): Record<string, unknown> {
        const raw = this.host.getFlag('__shops__', {});
        return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    }

    /** 旧 `listShopIds`：访问过的商店，或不需要开启的商店 */
    listIds(): string[] {
        return this.list()
            .filter((shop) => this.isVisited(shop.id) || !shop.mustEnable)
            .map((shop) => shop.id);
    }

    /** 旧 `canOpenShop` */
    canOpen(id: string): boolean {
        if (this.isVisited(id)) return true;
        const shop = this.get(id);
        if (!shop) return false;
        if (shop.item || shop.commonEvent || shop.mustEnable) return false;
        return true;
    }

    /** 旧 `canUseQuickShop`：返回提示文本表示不能使用，null 表示可以 */
    canUseQuickShop(_id: string): string | null {
        if (!this.host.quickShopAllowed()) return '当前楼层不能使用快捷商店。';
        return null;
    }

    /**
     * 打开商店。返回 false 表示无法打开（调用方负责提示）。
     *
     * `noRoute` 为真时不记录像（旧 `core.openShop(id, true)`，用于剧本动作与回放）。
     */
    open(id: string, noRoute = false): boolean {
        const shop = this.get(id);
        if (!shop) return false;
        if (!this.canOpen(id)) return false;
        if (shop.item) {
            // 道具商店插件在 3.0 里没有对应实现，明确提示而不是静默失败
            this.host.run([
                { type: 'playSound', name: '操作失败' },
                { type: 'tip', text: `道具商店插件不存在：${shop.item}` },
            ]);
            return true;
        }
        if (shop.commonEvent) {
            this.host.insertCommonEvent?.(shop.commonEvent, (shop.args as unknown[]) ?? []);
            return true;
        }
        if (!noRoute) this.host.record(`shop:${id}`);
        const preview = !this.isVisited(id);
        this.host.run(this.buildScript(id, preview));
        return true;
    }

    /**
     * 生成商店剧本：`while(true)` 让买完一个选项后回到商店界面，
     * 「离开」选项里的 `break` 退出。
     */
    buildScript(id: string, preview: boolean): ScriptAction[] {
        const shop = this.get(id);
        if (!shop) return [];
        return [
            {
                type: 'while',
                condition: 'true',
                data: [
                    {
                        type: 'choices',
                        text: shop.text,
                        choices: buildShopChoices(shop, {
                            preview,
                            evaluate: (expression) => this.host.evaluate(expression),
                        }),
                    },
                ],
            },
        ];
    }

    /**
     * 旧 `_action_openShop`：标记为已访问；只有 `open` 为真才弹出商店界面。
     * 因此 `{"type":"openShop","id":"shop1"}` 只「开启」商店不打扰玩家。
     */
    handleScriptAction(data: ScriptActionObject): boolean {
        const id = String(data.id ?? '');
        if (!id) return false;
        this.setVisited(id, true);
        if (!data.open) return true;
        return this.open(id, true);
    }
}
