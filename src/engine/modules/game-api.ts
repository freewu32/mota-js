/**
 * 塔作者脚本能看到的游戏 API。
 *
 * 旧引擎把一切都挂在全局 `core` 上，脚本里写 `core.getBlockId(x, y)`、
 * `core.status.hero.hp += 10`。新引擎不再暴露全局对象，改为把这份能力做成
 * 一个显式的 `api` 对象注入脚本上下文（`ScriptContext.api`）：
 *
 * - 只读查询与值块内建函数同源（`createBuiltins`），保证「表达式能写的，脚本也能读」；
 * - 写操作走引擎已有的模块（道具、地图、楼层、剧本），不直接改内部状态；
 * - 视觉/音频/面板统一转给呈现层（`presenter.effect`），引擎不认识 DOM。
 *
 * 具体实现由 `runtime.ts` 提供宿主对象，本模块只负责组装与补默认值。
 */
import type { ScriptAction } from './events';
import { activeBlocks, blockAt, type Block } from './maps';
import { createBuiltins } from './builtins';
import { getBuff, getStatus, type StatusName } from './status';
import { itemCount } from './control';
import { evaluateValue, type ValueScope } from './values';
import type { FloorData } from '../../shared/data/schema';
import type { HeroState } from '../types';
import type { UiHooks } from './ui-hooks';

/**
 * 值块 / 标记的取值结果。
 *
 * 值块能返回数字（`status:hp`）、字符串（`blockId:1,2`）、布尔与空值，
 * 塔作者也常把数组或对象存进 `flag:`（如 `__itemHint__`），因此值域取这个并集。
 */
export type Value =
    number | string | boolean | null | undefined | Record<string, unknown> | unknown[];

/** 面板类型（旧 `core.ui.drawBook` / `drawFly` / 道具栏等） */
export type PanelName =
    | 'monsterManual'
    | 'floorMap'
    | 'items'
    | 'equips'
    | 'help'
    | 'statistics'
    | 'shops'
    | 'shop';

/** 道具脚本需要知道的道具信息 */
export interface ApiItemData {
    name?: string;
    cls?: string;
    [key: string]: unknown;
}

/** 组装 API 需要的宿主能力 */
export interface GameApiHost {
    hero: HeroState;
    flags: Record<string, unknown>;
    values: Record<string, unknown>;
    items: Record<string, ApiItemData>;
    enemys: Record<string, unknown>;
    floorId: string;
    floorIds: string[];
    getFloor(floorId: string): FloorData | undefined;
    getBlocks(floorId: string): Block[];
    /** 求值一个值块表达式（与剧本共用同一作用域） */
    evaluate(expr: unknown, prefix?: string): Value;
    /** 写一个值块（`status:hp` / `flag:x` / `item:redPotion` …） */
    writeValue(name: string, value: unknown, operator?: string, prefix?: string): void;
    /** 立即执行一段剧本动作 */
    runAction(actions: ScriptAction | ScriptAction[]): void;
    /** 把动作追加到当前剧本之后执行（旧 `core.insertAction`） */
    insertAction(actions: ScriptAction | ScriptAction[]): void;
    /** 换层（`floorId` 为 null 表示留在本层） */
    changeFloor(floorId: string | null, loc?: [number, number] | null, direction?: string): void;
    /** 标记某格图块已移除 / 恢复（同时写入存档 flag），返回该格是否原本有图块 */
    setBlockDisabled(floorId: string, x: number, y: number, disabled: boolean): boolean;
    setBlock(floorId: string, x: number, y: number, numberOrId: number | string): void;
    /**
     * 移动图块（旧 `core.moveBlock`）：起点图块立刻消失，沿 `steps` 逐格移动，
     * `keep` 为真时落在终点、否则淡出。返回 false 表示起点没有图块。
     */
    moveBlock(
        x: number,
        y: number,
        steps: unknown,
        time?: number,
        keep?: boolean,
        done?: () => void,
    ): boolean;
    addItem(id: string, count?: number): void;
    removeItem(id: string, count?: number): boolean;
    useItem(id: string): boolean;
    canUseItem(id: string): boolean;
    equip(id: string): boolean;
    unequip(id: string): boolean;
    /** 播放音效 / 弹提示 / 打开面板，交给呈现层 */
    effect(type: string, data: Record<string, unknown>): void;
    /** 注册 UI 钩子（旧 `functions.ui` 的脚本版） */
    registerUiHooks?(hooks: UiHooks): void;
    /** 打开快捷商店（旧 `events.openQuickShop`） */
    openQuickShop?(id?: string): boolean;
}

/**
 * 塔作者脚本 API。
 *
 * 类型声明同时抄送一份给塔作者（根目录 `mota.d.ts` 的 `mota:types` 模块），
 * 两边字段必须一致——`runtime.ts` 的返回值受本接口约束，tsc 会挡住漏项。
 */
export interface GameApi {
    /* —— 只读查询（与值块内建函数同源） —— */
    /** 勇士前方第 n 格坐标 */
    nextX(n?: number): number;
    nextY(n?: number): number;
    /** 某点的图块（禁用视为不存在，缺省当前层） */
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
    /** 相对当前层第 n 层（越界为 null） */
    floorIdOffset(n: number, floorId?: string): string | null;
    /** 是否与楼梯 / 传送点相邻 */
    nearStair(floorId?: string): boolean;

    /* —— 状态 —— */
    readonly hero: HeroState;
    readonly flags: Record<string, unknown>;
    readonly values: Record<string, unknown>;
    readonly floorId: string;
    readonly floorIds: readonly string[];
    /** 勇士属性（含增幅，旧 `core.getStatus`） */
    getStatus(name: string): number;
    /** 增幅倍率（旧 `core.getBuff`） */
    getBuff(name: string): number;
    getFlag(name: string, defaultValue?: Value): Value;
    setFlag(name: string, value: Value): void;
    /** 读取任意值块，如 `api.get('flag:skill')` */
    get(name: string, prefix?: string): Value;
    /** 写入任意值块，如 `api.set('flag:skill', 1)` */
    set(name: string, value: Value, operator?: string, prefix?: string): void;

    /* —— 道具与装备 —— */
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

    /* —— 地图 —— */
    blockAt(x: number, y: number, floorId?: string): Block | null;
    searchBlocks(idOrCls: string, floorId?: string): Block[];
    /** 移除某点图块（旧 `core.removeBlock`）；返回是否真的移除了 */
    removeBlock(x: number, y: number, floorId?: string): boolean;
    setBlock(x: number, y: number, numberOrId: number | string, floorId?: string): void;
    /** 移动图块（旧 `core.moveBlock`）；返回 false 表示起点没有图块 */
    moveBlock(x: number, y: number, steps: unknown, time?: number, keep?: boolean): boolean;

    /* —— 楼层与剧本 —— */
    changeFloor(floorId: string | null, loc?: [number, number] | null, direction?: string): void;
    /** 立即执行一段剧本 */
    runAction(actions: ScriptAction | ScriptAction[]): void;
    /** 在当前剧本之后插入动作（旧 `core.insertAction`） */
    insertAction(actions: ScriptAction | ScriptAction[]): void;
    tip(text: string, icon?: string): void;
    playSound(name: string): void;

    /* —— 界面 —— */
    /** 打开面板（怪物手册、楼层传送、道具栏…）；具体呈现交给 UI 层 */
    openPanel(panel: PanelName, data?: Record<string, unknown>): void;
    /**
     * 塔作者 UI 定制（旧 `functions.ui`）：`mota.ui.register({ getToolboxItems, statistics, about })`。
     * 钩子只返回数据，不接触 DOM；未提供时回退到 `firstData.ui`。
     */
    readonly ui: {
        register(hooks: UiHooks): void;
        /** 打开快捷商店；不给 id 时按旧规则选第一个可用商店 */
        openShop(id?: string): boolean;
    };
}

function toActions(value: ScriptAction | ScriptAction[] | void): ScriptAction[] {
    if (value == null) return [];
    return Array.isArray(value) ? value : [value];
}

/**
 * 值块求值结果是 `unknown`（求值器不认识值的用途），这里收窄成脚本 API 的值域。
 * SAFETY: 值块只从 status/flag/item/block 等已知来源取值，必然是这些类型之一。
 */
export function toValue(raw: unknown): Value {
    return raw as Value;
}

export function createGameApi(host: GameApiHost): GameApi {
    const builtins = createBuiltins({
        hero: host.hero,
        floorId: host.floorId,
        floorIds: host.floorIds,
        getFloor: host.getFloor,
        getBlocks: host.getBlocks,
        enemys: host.enemys,
    });
    const asNumber = (name: string, ...args: unknown[]): number =>
        Number(builtins[name]?.(...args) ?? 0);
    const scope = (prefix?: string): ValueScope => ({
        flags: host.flags,
        values: host.values,
        hero: host.hero,
        enemys: host.enemys,
        functions: builtins,
        prefix,
        getBlock: (x, y) => blockAt(host.getBlocks(host.floorId), x, y),
        // SAFETY: 楼层数据本就是按名字取值的字典，值块只读查表，不会写入未知字段。
        floor: host.getFloor(host.floorId) as unknown as Record<string, unknown>,
    });
    const findBlock = (x: number, y: number, floorId?: string): Block | undefined => {
        const id = floorId ?? host.floorId;
        const block = blockAt(host.getBlocks(id), x, y);
        return block && !block.disable ? block : undefined;
    };

    return {
        nextX: (n?: number) => asNumber('nextX', n ?? 1),
        nextY: (n?: number) => asNumber('nextY', n ?? 1),
        blockId: (x, y, floorId) => (builtins.blockId!(x, y, floorId) as string | null) ?? null,
        blockNumber: (x, y, floorId) =>
            (builtins.blockNumber!(x, y, floorId) as number | null) ?? null,
        blockCls: (x, y, floorId) => (builtins.blockCls!(x, y, floorId) as string | null) ?? null,
        blockAttr: (x, y, attr, floorId) =>
            toValue(builtins.blockAttr!(x, y, attr, floorId) ?? null),
        blockCount: (idOrCls, floorId) => asNumber('blockCount', idOrCls, floorId),
        mapWidth: (floorId?: string) => asNumber('mapWidth', floorId),
        mapHeight: (floorId?: string) => asNumber('mapHeight', floorId),
        floorIndex: (floorId?: string) => asNumber('floorIndex', floorId),
        floorCount: () => asNumber('floorCount'),
        floorIdOffset: (n, floorId) =>
            (builtins.floorIdOffset!(n, floorId) as string | null) ?? null,
        nearStair: (floorId?: string) => Boolean(builtins.nearStair!(floorId)),

        get hero() {
            return host.hero;
        },
        get flags() {
            return host.flags;
        },
        get values() {
            return host.values;
        },
        get floorId() {
            return host.floorId;
        },
        get floorIds() {
            return host.floorIds;
        },
        getStatus: (name) => getStatus(host.hero, name as StatusName),
        getBuff: (name) => getBuff(host.flags, name as StatusName),
        getFlag: (name, defaultValue = 0) => toValue(host.flags[name] ?? defaultValue),
        setFlag: (name, value) => {
            host.flags[name] = value;
        },
        get: (name, prefix) => toValue(evaluateValue(name, scope(prefix), prefix)),
        set: (name, value, operator, prefix) => host.writeValue(name, value, operator, prefix),

        itemName: (id) => String(host.items[id]?.name ?? id),
        enemyName: (id) => String((host.enemys[id] as { name?: string } | undefined)?.name ?? id),
        isEnemy: (id) => Boolean(builtins.isEnemy!(id)),
        enemyAttr: (id, attr) => toValue(builtins.enemyAttr!(id, attr) ?? null),
        itemCount: (id) => itemCount(host.hero, id),
        hasItem: (id) => itemCount(host.hero, id) > 0,
        addItem: (id, count = 1) => host.addItem(id, count),
        removeItem: (id, count = 1) => host.removeItem(id, count),
        useItem: (id) => host.useItem(id),
        canUseItem: (id) => host.canUseItem(id),
        equip: (id) => host.equip(id),
        unequip: (id) => host.unequip(id),

        blockAt: (x, y, floorId) => findBlock(x, y, floorId) ?? null,
        searchBlocks: (idOrCls, floorId) =>
            activeBlocks(host.getBlocks(floorId ?? host.floorId)).filter(
                (block) => block.event.id === idOrCls || block.event.cls === idOrCls,
            ),
        removeBlock: (x, y, floorId) => {
            // 该格原本没有图块（已被移除）时返回 false（旧 `core.removeBlock` 的返回值）
            const block = findBlock(x, y, floorId);
            if (!block || block.disable) return false;
            return host.setBlockDisabled(floorId ?? host.floorId, x, y, true);
        },
        setBlock: (x, y, numberOrId, floorId) =>
            host.setBlock(floorId ?? host.floorId, x, y, numberOrId),
        moveBlock: (x, y, steps, time, keep) => host.moveBlock(x, y, steps, time, keep),

        changeFloor: (floorId, loc = null, direction) => host.changeFloor(floorId, loc, direction),
        runAction: (actions) => host.runAction(actions),
        insertAction: (actions) => host.insertAction(actions),
        tip: (text, icon) => host.effect('tip', { text, icon }),
        playSound: (name) => host.effect('playSound', { name }),

        openPanel: (panel, data = {}) => host.effect('openPanel', { panel, ...data }),
        ui: {
            register: (hooks) => host.registerUiHooks?.(hooks),
            openShop: (id) => Boolean(host.openQuickShop?.(id)),
        },
    };
}

/** 脚本返回的动作列表（供 `items.ts` / `events.ts` 统一取用） */
export function scriptActions(value: ScriptAction | ScriptAction[] | void): ScriptAction[] {
    return toActions(value);
}
