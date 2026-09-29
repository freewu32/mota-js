/**
 * 塔作者脚本的类型声明（`mota:types` 模块）。
 *
 * 用法：脚本放在 `project/scripts/` 下，顶部引用本文件并声明默认导出：
 *
 * ```ts
 * /// <reference path="../../mota.d.ts" />
 * import type { ItemScript } from 'mota:types';
 *
 * export default (({ api, itemId }) => {
 *     const target = api.blockAt(api.nextX(), api.nextY());
 *     if (!target) {
 *         api.playSound('操作失败');
 *         api.addItem(itemId!, 1); // 不消耗
 *         return;
 *     }
 *     api.removeBlock(target.x, target.y);
 *     return [{ type: 'tip', text: `${api.itemName(itemId!)}使用成功` }];
 * }) satisfies ItemScript;
 * ```
 *
 * 数据里用 `{ "script": "items/bomb" }` 引用（相对 `project/scripts/` 的路径）。
 * 声明与 `src/engine/modules/game-api.ts`、`scripts.ts` 保持一致，
 * `tests/scripts.test.ts` 会校验字段没有遗漏。
 */
declare module 'mota:types' {
    /** 值块 / 标记的取值结果 */
    export type Value =
        | number
        | string
        | boolean
        | null
        | undefined
        | Record<string, unknown>
        | unknown[];

    export type Direction = 'up' | 'down' | 'left' | 'right';

    /** 勇士状态（常用字段；其余字段按需读取） */
    export interface HeroState {
        x: number;
        y: number;
        direction: Direction;
        hp: number;
        atk: number;
        def: number;
        mdef: number;
        money: number;
        exp: number;
        lv: number;
        steps: number;
        hpmax?: number;
        mana?: number;
        manamax?: number;
        name?: string;
        items: {
            constants: Record<string, number>;
            tools: Record<string, number>;
            equips: Record<string, number>;
        };
        equipment: (string | null)[];
        [key: string]: unknown;
    }

    /** 地图上的一个图块 */
    export interface Block {
        x: number;
        y: number;
        id: number;
        event: { cls: string; id: string; [key: string]: unknown };
    }

    /** 剧本动作 */
    export interface ScriptActionObject {
        type: string;
        [key: string]: unknown;
    }
    export type ScriptAction = string | ScriptActionObject;

    /** 面板类型 */
    export type PanelName =
        | 'monsterManual'
        | 'floorMap'
        | 'items'
        | 'equips'
        | 'help'
        | 'statistics'
        | 'shops'
        | 'shop';

    /**
     * 塔作者 UI 钩子（旧 `functions.ui` 的脚本版）。
     * 钩子只返回数据，不接触 DOM；未提供时回退到 `firstData.ui`。
     */
    export interface UiHooks {
        /** 旧 `getToolboxItems(cls)`：道具栏的显示项与顺序 */
        getToolboxItems?(cls: string, ids: readonly string[]): string[] | null;
        /** 旧 `drawStatistics()`：地图浏览 / 统计面板里要统计的图块 id */
        statistics?(): string[] | null;
        /** 旧 `drawAbout()`：关于 / 帮助文本 */
        about?(): string | null;
    }

    /**
     * 游戏 API。
     *
     * 只读查询与值块内建函数同源（`nextX()`、`blockId(x,y)` 在表达式里也能写）；
     * 写操作走引擎模块；提示 / 音效 / 面板交给呈现层。
     */
    export interface GameApi {
        /* 只读查询 */
        nextX(n?: number): number;
        nextY(n?: number): number;
        blockId(x: number, y: number, floorId?: string): string | null;
        blockNumber(x: number, y: number, floorId?: string): number | null;
        blockCls(x: number, y: number, floorId?: string): string | null;
        /** 某点图块的属性（如 `canBreak`），空格 / 禁用图块为 null */
        blockAttr(x: number, y: number, attr: string, floorId?: string): Value;
        /** 按 id / cls / 属性名统计某层图块数量 */
        blockCount(idOrCls: string, floorId?: string): number;
        mapWidth(floorId?: string): number;
        mapHeight(floorId?: string): number;
        floorIndex(floorId?: string): number;
        floorCount(): number;
        floorIdOffset(n: number, floorId?: string): string | null;
        nearStair(floorId?: string): boolean;

        /* 状态 */
        readonly hero: HeroState;
        readonly flags: Record<string, unknown>;
        readonly values: Record<string, unknown>;
        readonly floorId: string;
        readonly floorIds: readonly string[];
        getStatus(name: string): number;
        getBuff(name: string): number;
        getFlag(name: string, defaultValue?: Value): Value;
        setFlag(name: string, value: Value): void;
        get(name: string, prefix?: string): Value;
        set(name: string, value: Value, operator?: string, prefix?: string): void;

        /* 道具与装备 */
        itemName(id: string): string;
        enemyName(id: string): string;
        /** 该 id 是否为怪物（旧 `cls.indexOf('enemy') == 0`） */
        isEnemy(id: string): boolean;
        /** 怪物属性（旧 `core.material.enemys[id].xxx`） */
        enemyAttr(id: string, attr: string): Value;
        itemCount(id: string): number;
        hasItem(id: string): boolean;
        addItem(id: string, count?: number): void;
        removeItem(id: string, count?: number): boolean;
        useItem(id: string): boolean;
        canUseItem(id: string): boolean;
        equip(id: string): boolean;
        unequip(id: string): boolean;

        /* 地图 */
        blockAt(x: number, y: number, floorId?: string): Block | null;
        searchBlocks(idOrCls: string, floorId?: string): Block[];
        removeBlock(x: number, y: number, floorId?: string): boolean;
        setBlock(x: number, y: number, numberOrId: number | string, floorId?: string): void;
        /** 移动图块（旧 `core.moveBlock`）；返回 false 表示起点没有图块 */
        moveBlock(x: number, y: number, steps: unknown, time?: number, keep?: boolean): boolean;

        /* 楼层与剧本 */
        changeFloor(floorId: string | null, loc?: [number, number] | null, direction?: string): void;
        runAction(actions: ScriptAction | ScriptAction[]): void;
        insertAction(actions: ScriptAction | ScriptAction[]): void;
        tip(text: string, icon?: string): void;
        playSound(name: string): void;

        /* 界面 */
        openPanel(panel: PanelName, data?: Record<string, unknown>): void;
        /** UI 定制与快捷商店 */
        readonly ui: {
            register(hooks: UiHooks): void;
            openShop(id?: string): boolean;
        };
    }

    /** 脚本触发时机 */
    export type ScriptTrigger = 'pickUp' | 'use' | 'event' | 'function';

    /** 传给脚本的上下文 */
    export interface ScriptContext {
        api: GameApi;
        /** 道具脚本：当前道具 id */
        itemId?: string;
        trigger: ScriptTrigger;
        /** `function` 动作传入的参数 */
        args?: Value[];
    }

    /** 道具效果脚本：`useItemEffect` / `itemEffect` / `useItemEvent` 都可用它 */
    export type ItemScript = (ctx: ScriptContext) => ScriptAction | ScriptAction[] | void;

    /** 通用塔作者脚本（`function` 动作等） */
    export type TowerScript = ItemScript;
}
