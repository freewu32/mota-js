import type { FloorData } from '../shared/data/schema';
import { createBuiltins } from './modules/builtins';
import {
    createGameApi,
    scriptActions,
    type ApiItemData,
    type GameApi,
    type GameApiHost,
    toValue,
} from './modules/game-api';
import {
    ScriptRegistry,
    collectScriptRefs,
    type ScriptContext,
    type ScriptLoader,
} from './modules/scripts';
import { RouteRecorder, decodeRoute, encodeRoute, routeCodecFor } from './modules/actions';
import { MotaControl, type ControlContext, type MoveResult } from './modules/control';
import { MotaItems } from './modules/items';
import {
    FloorEvents,
    type PositionEventType,
} from './modules/floor-events';
import { createTurnDispatcher, type TurnDispatcher } from './modules/turns';
import { MotaShops, type ShopData, type ShopEntry } from './modules/shops';
import { UiHookRegistry, type UiHooks } from './modules/ui-hooks';
import { orderToolboxItems, parseUiConfig, statisticsIds, type UiConfig } from './modules/ui-config';
import { gatherFollowers, type Follower } from './modules/followers';
import { findDirectPath, findPath, type PathStep } from './modules/path';
import {
    MotaEvents,
    createHeadlessPresenter,
    type EventPresenter,
    type ScriptAction,
    turnDirection,
} from './modules/events';
import { formatBigNumber } from './modules/format';
import { extractBlocks, type Block } from './modules/maps';
import { getStatusOrDefault } from './modules/status';
import {
    formatEquipPanel,
    formatFloorPanel,
    formatStatusBar,
    formatToolboxPanel,
    type EquipSlotView,
    type FloorEntry,
    type StatusBarView,
    type ToolboxPanelView,
} from './modules/ui';
import {
    applyOperator,
    evaluateCondition,
    evaluateValue,
    writeValue,
    type ValueScope,
} from './modules/values';
import type { Direction, GameState, HeroState, RuntimeData, SaveData } from './types';

/** 方向 → 位移（自动寻路逐步行走用） */
const DELTA: Record<string, readonly [number, number]> = {
    up: [0, -1],
    down: [0, 1],
    left: [-1, 0],
    right: [1, 0],
};

export interface StorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

const SAVE_KEY = 'mota-save-v3';

function defaultStorage(): StorageLike | null {
    try {
        return typeof localStorage !== 'undefined' ? localStorage : null;
    } catch {
        return null;
    }
}

/** 从 firstData.hero 构造完整勇士状态，缺失字段回退默认值 */
export function normalizeHero(raw: unknown): HeroState {
    const source = (raw ?? {}) as Record<string, unknown>;
    const loc = (source.loc ?? {}) as Record<string, unknown>;
    const items = (source.items ?? {}) as Record<string, unknown>;
    const num = (v: unknown, fallback = 0): number => {
        const n = Number(v);
        return Number.isFinite(n) ? n : fallback;
    };
    /** 旧数据里缺省与 0 含义不同（如 manamax 为负表示不显示魔力） */
    const optionalNum = (v: unknown): number | undefined => {
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
    };

    return {
        x: num(loc.x, 1),
        y: num(loc.y, 1),
        direction: (loc.direction as HeroState['direction']) ?? 'up',
        hp: num(source.hp),
        hpmax: optionalNum(source.hpmax),
        name: typeof source.name === 'string' ? source.name : undefined,
        mana: optionalNum(source.mana),
        manamax: optionalNum(source.manamax),
        atk: num(source.atk),
        def: num(source.def),
        mdef: num(source.mdef),
        money: num(source.money),
        exp: num(source.exp),
        lv: num(source.lv, 1),
        steps: num(source.steps),
        items: {
            constants: { ...((items.constants as Record<string, number>) ?? {}) },
            tools: { ...((items.tools as Record<string, number>) ?? {}) },
            equips: { ...((items.equips as Record<string, number>) ?? {}) },
        },
        equipment: Array.isArray(source.equipment)
            ? [...(source.equipment as (string | null)[])]
            : [],
        // 旧存档里跟随者可能缺失
        followers: Array.isArray(source.followers)
            ? (source.followers as Follower[]).map((one) => ({ ...one }))
            : [],
        // 旧 `control._initStatistics`：统计字段在旧存档里可能缺失，这里统一补全
        statistics: {
            totalTime: 0,
            currTime: 0,
            hp: 0,
            battle: 0,
            money: 0,
            exp: 0,
            battleDamage: 0,
            poisonDamage: 0,
            extraDamage: 0,
            moveDirectly: 0,
            ignoreSteps: 0,
            ...((source.statistics as Record<string, number>) ?? {}),
        },
    };
}

/** 引擎运行时：持有塔数据、游戏状态与存档。 */
export class MotaRuntime {
    readonly data: RuntimeData;
    state: GameState;

    readonly events: MotaEvents;
    /** 道具与装备（旧 `core.items` / `core.material.items` 的组合） */
    readonly items: MotaItems;
    /** 回合分发器：输入 / 录像 / 脚本共用的动作入口（旧 `replayActions`） */
    readonly turns: TurnDispatcher;
    /** 录像路线（可编码进存档 / 分享为录像文件） */
    readonly route = new RouteRecorder();
    /** 塔作者脚本注册表（开局前用 `loadScripts` 预加载） */
    readonly scripts = new ScriptRegistry();
    /** 楼层生命周期事件（firstArrive / eachArrive / autoEvent / afterBattle…） */
    readonly floorEvents: FloorEvents;
    /** 全局商店（旧 shop 插件） */
    readonly shops: MotaShops;
    /** 塔作者 UI 钩子（`mota.ui.register`） */
    readonly uiHooks = new UiHookRegistry();
    private readonly storage: StorageLike | null;
    private readonly control: MotaControl;
    private readonly globals: Record<string, unknown> = {};
    /** 塔作者脚本注入的函数（`function` 动作与表达式共用） */
    readonly functions: Record<string, (...args: unknown[]) => unknown> = {};
    private readonly blockCache: Record<string, Block[]> = {};
    private scriptLoader: ScriptLoader | null = null;
    constructor(
        data: RuntimeData,
        storage: StorageLike | null = defaultStorage(),
        presenter: EventPresenter = createHeadlessPresenter(),
    ) {
        this.data = data;
        this.storage = storage;

        this.state = this.initialState();

        const ctx: ControlContext = {
            maps: data.maps,
            values: this.state.values,
            flags: this.state.flags,
            enemys: data.enemys,
            items: data.items,
            hero: this.state.hero,
            floorId: this.state.floorId,
            floorIds: this.floorIds,
            getFloor: (id) => this.data.floors[id] as FloorData,
            getBlocks: (id) => this.getBlocks(id),
            beforeBattleAt: (x, y, enemyId) => this.beforeBattleAt(x, y, enemyId),
        };
        this.control = new MotaControl(ctx);
        this.items = new MotaItems({
            get hero() {
                return ctx.hero;
            },
            items: data.items,
            get flags() {
                return ctx.flags;
            },
            values: data.tower.values as Record<string, unknown>,
            equipName: Array.isArray(data.tower.main.equipName)
                ? (data.tower.main.equipName as string[])
                : [],
            // 效果脚本交给剧本解释器执行，保持与事件同一套动作词汇
            runScript: (actions) => void this.events.start(actions as ScriptAction),
            // `{ script: '名字' }` 形式的道具效果：跑塔作者脚本，取其返回的动作
            expandScript: (name, context) => this.runScript(name, context),
            scope: (prefix) => this.valueScope(prefix),
            record: (token) => this.route.record(token),
            tip: (text, icon) => this.events.host.presenter.tip?.(text, icon),
            playSound: (name) =>
                this.events.host.presenter.effect?.('playSound', { type: 'playSound', name }),
        });
        ctx.itemEffects = this.items;
        this.events = new MotaEvents({
            ...ctx,
            control: this.control,
            presenter,
            globals: this.globals,
            functions: this.functions,
            // 剧本换层要让运行时的楼层状态一起走，否则 `runtime.floor` / 存档会落后
            changeFloor: (floorId, loc, direction) =>
                this.applyFloorChange(floorId, loc, direction),
            // 剧本发起的战斗 / 拾取，同样要跑楼层的位置事件
            onAfterBattle: (_enemyId, x, y) => this.floorEvents.after('afterBattle', x, y),
            onAfterGetItem: (_itemId, x, y) => this.floorEvents.after('afterGetItem', x, y),
            beforeBattleAt: (x, y, enemyId) => this.beforeBattleAt(x, y, enemyId),
            onFollowerChange: () => this.events.host.presenter.update?.(),
            // autoEvent 执行完清理「执行中」标记（旧 `eventdata.autoEvent` 的收尾函数）
            actions: {
                autoEventReset: (data) => {
                    this.floorEvents.clearExecuting(String(data.symbol ?? ''));
                },
                // 剧本里的 `openShop` / `disableShop`（旧 `_action_openShop`）
                openShop: (data) => {
                    this.shops.handleScriptAction(data);
                },
                disableShop: (data) => {
                    const id = String(data.id ?? '');
                    if (id) this.shops.setVisited(id, false);
                },
            },
        });
        this.floorEvents = new FloorEvents({
            floorIds: this.floorIds,
            floorId: () => this.state.floorId,
            getFloor: (id) => this.data.floors[id] as Record<string, unknown> | undefined,
            insert: (actions, x, y) => this.events.insert(actions, x, y),
            // 旧 `core.pushEventLoc`：自动事件里没有 loc 的动作以该坐标为基准
            autoEventLoc: (x, y, floorId) => this.events.setEventLoc(x, y, floorId),
            evaluate: (condition, prefix) =>
                evaluateCondition(condition, this.valueScope(prefix), prefix),
            getFlag: (name, fallback) => this.getFlag(name, fallback),
            setFlag: (name, value) => this.setFlag(name, value),
        });
        this.shops = new MotaShops({
            all: () => {
                const list = this.data.tower.firstData.shops;
                return Array.isArray(list) ? (list as ShopData[]) : [];
            },
            get: (id) => {
                const list = this.data.tower.firstData.shops;
                if (!Array.isArray(list)) return undefined;
                return (list as ShopData[]).find((shop) => shop.id === id);
            },
            getFlag: (name, fallback) => this.getFlag(name, fallback),
            setFlag: (name, value) => this.setFlag(name, value),
            quickShopAllowed: () => {
                const floor = this.floor as Record<string, unknown> | undefined;
                return floor?.canUseQuickShop !== false;
            },
            run: (actions) => void this.events.start(actions),
            record: (token) => this.route.record(token),
            evaluate: (expression) => evaluateCondition(expression, this.valueScope(), ''),
            insertCommonEvent: (name, args) => this.events.insertCommonEvent(name, args),
        });
        this.turns = createTurnDispatcher({
            move: (dx, dy) => this.move(dx, dy),
            turn: (direction) => this.turn(direction),
            canUseItem: (id) => this.items.canUse(id),
            useItem: (id) => this.items.use(id),
            equip: (id) => this.items.equip(id),
            unequip: (type) => this.items.unequip(type),
            saveLoadout: (index) => this.items.saveLoadout(index),
            loadLoadout: (index) => this.items.loadLoadout(index),
            changeFloorTo: (floorId) => this.flyTo(floorId),
            openShop: (id, noRoute) => this.shops.open(id, noRoute),
            record: (token) => this.route.record(token),
        });
    }

    /**
     * 开局：把初始楼层当作一次抵达（旧 `startGame` → `changeFloor`），
     * 触发 `eachArrive` / `firstArrive` 与呈现层的换层通知。
     */
    start(): void {
        this.applyFloorChange(this.state.floorId, null, null, 'start');
    }

    /** 每帧驱动：检查自动事件（旧 `core.checkAutoEvents`） */
    update(): void {
        this.floorEvents.checkAutoEvents();
    }

    /**
     * 战前剧本：楼层 `beforeBattle["x,y"]` 与怪物自己的 `beforeBattle`（旧
     * `_sys_battle` 会把它们与随后的 `battle` 动作一起插入事件队列）。
     */
    private beforeBattleAt(x: number, y: number, enemyId: string): ScriptAction[] | null {
        const floor = this.data.floors[this.state.floorId] as Record<string, unknown> | undefined;
        const list: ScriptAction[] = [];
        const position = (floor?.beforeBattle ?? {}) as Record<string, unknown>;
        const fromEnemy = (this.data.enemys[enemyId] as Record<string, unknown> | undefined)
            ?.beforeBattle;
        // 旧 `_sys_battle` 是 `core.push(list, ...)`：数组展开一层，其余原样
        for (const source of [position[`${x},${y}`], fromEnemy]) {
            if (source == null) continue;
            if (Array.isArray(source)) list.push(...(source as ScriptAction[]));
            else list.push(source as ScriptAction);
        }
        return list.length > 0 ? list : null;
    }

    private getFlag(name: string, fallback: unknown = null): unknown {
        return this.state.flags[name] ?? fallback;
    }

    private setFlag(name: string, value: unknown): void {
        this.state.flags[name] = value;
    }

    /**
     * 抵达楼层：触发 `eachArrive` / `firstArrive` 剧本，并通知呈现层
     * （背景音乐 / 天气 / 画面色调 / 过场动画由游戏入口接管）。
     */
    private arrive(floorId: string, from: string | null, reason: string): void {
        const first = !this.hasVisited(floorId);
        this.visitFloor(floorId);
        this.floorEvents.arrive(floorId, first);
        this.events.host.presenter.effect?.('changeFloor', {
            floorId,
            from,
            first,
            reason,
        });
    }

    /**
     * 应用剧本 / 脚本发起的换层：同时更新控制上下文与运行时状态，
     * 并触发抵达事件与呈现层通知。
     */
    private applyFloorChange(
        floorId: string | null,
        loc: [number, number] | null,
        direction: string | null,
        reason = 'script',
    ): void {
        const ctx = this.control.ctx;
        const from = this.state.floorId;
        if (floorId) {
            ctx.floorId = floorId;
            this.state.floorId = floorId;
        }
        if (loc) {
            ctx.hero.x = loc[0];
            ctx.hero.y = loc[1];
        }
        if (direction) ctx.hero.direction = direction as Direction;
        // 换层后跟随者聚拢到新位置（旧 `changeFloor` 里的 `gatherFollowers`）
        gatherFollowers(ctx.hero.followers ?? [], ctx.hero);
        this.arrive(this.state.floorId, from, reason);
    }

    /** 替换事件呈现器（如接入 DOM 状态栏 / 对话框） */
    setPresenter(presenter: EventPresenter): void {
        this.events.host.presenter = presenter;
    }

    get floor(): FloorData {
        return this.data.floors[this.state.floorId] as FloorData;
    }

    /** 取得某层的 block 列表（懒加载并缓存） */
    getBlocks(floorId: string): Block[] {
        if (this.blockCache[floorId]) return this.blockCache[floorId];
        const floor = this.data.floors[floorId];
        if (!floor) return [];
        const blocks = extractBlocks(floor, this.data.maps, {
            isDisabled: (x, y) =>
                this.state.flags[`__block_${floorId}_${x}_${y}__`] ? true : undefined,
        });
        this.blockCache[floorId] = blocks;
        return blocks;
    }

    /**
     * 把 block 缓存绑定到当前 `state.flags`。
     *
     * 缓存里的 `Block.disable` 是**建缓存时**从 flags 读的，所以凡是整体替换
     * `state` 的操作（读档 / 重开）都必须重建，否则地图会停留在上一局的
     * 「已吃掉的物品 / 已打开的门」上。
     */
    private clearBlockCache(): void {
        for (const key of Object.keys(this.blockCache)) delete this.blockCache[key];
    }

    /** 开局状态（旧 `resetGame`）：初始楼层 + 初始勇士 + 塔的 flags / values 克隆 */
    private initialState(): GameState {
        const firstData = this.data.tower.firstData;
        return {
            floorId: firstData.floorId,
            hero: normalizeHero(firstData.hero),
            flags: { ...(this.data.tower.flags as Record<string, unknown>) },
            values: { ...(this.data.tower.values as Record<string, unknown>) },
        };
    }

    /**
     * 重开一局（旧 `core.resetGame`）：状态回到初始值，录像清空。
     * 开局流程是 `reset()` + `start()`；`start()` 单独调用只重跑初始楼层的
     * 抵达事件，不会重置进度。
     */
    reset(): void {
        this.state = this.initialState();
        this.clearBlockCache();
        this.route.route = [];
        this.route.clearFolding();
        this.control.ctx.hero = this.state.hero;
        this.control.ctx.floorId = this.state.floorId;
        this.control.ctx.flags = this.state.flags;
        this.control.ctx.values = this.state.values;
    }

    /**
     * 值块求值上下文（旧 `core` 里散落的 status/flags/hero 组合）。
     * 事件、状态栏与塔作者脚本共用同一份作用域。
     */
    valueScope(prefix?: string): ValueScope {
        return {
            flags: this.state.flags,
            values: this.state.values,
            globals: this.globals,
            hero: this.state.hero,
            enemys: this.data.enemys as Record<string, unknown>,
            functions: { ...this.builtinFunctions(), ...this.functions },
            prefix,
            getBlock: (x, y) => this.control.blockAt(x, y),
            // SAFETY: FloorData 的字段（ratio/width/canFlyFrom…）本就是按名字取值的
            // 字典，`floor:属性` 只做只读查表，不会写入未知字段。
            floor: this.floor as unknown as Record<string, unknown>,
        };
    }

    /** 值块内建函数（旧 core 的 nextX / getBlockId / bigmap / nearStair 等） */
    private builtinFunctions(): Record<string, (...args: unknown[]) => unknown> {
        return createBuiltins({
            hero: this.state.hero,
            floorId: this.state.floorId,
            floorIds: this.floorIds,
            getFloor: (id) => this.data.floors[id] as FloorData,
            getBlocks: (id) => this.getBlocks(id),
            enemys: this.data.enemys as Record<string, unknown>,
        });
    }

    /** 楼层顺序（旧 `core.floorIds`）：以塔数据为准，缺失时退回楼层表的键顺序 */
    get floorIds(): string[] {
        const declared = this.data.tower.main.floorIds;
        return declared.length > 0 ? declared : Object.keys(this.data.floors);
    }

    /** 塔的等级表（旧 `firstData.levelUp`） */
    get levelUp(): { need?: unknown; title?: string }[] {
        const list = this.data.tower.firstData.levelUp;
        return Array.isArray(list) ? (list as { need?: unknown; title?: string }[]) : [];
    }

    /** 旧 `core.getNextLvUpNeed`：下一级所需经验；满级返回 null */
    nextLvUpNeed(): number | null {
        const levelUp = this.levelUp;
        const hero = this.state.hero;
        if (levelUp.length === 0 || hero.lv >= levelUp.length) return null;
        const need = Number(evaluateValue(levelUp[hero.lv]?.need, this.valueScope()));
        if (!Number.isFinite(need)) return null;
        const items = this.state.flags.statusBarItems;
        if (Array.isArray(items) && items.includes('levelUpLeftMode')) {
            return Math.max(need - hero.exp, 0);
        }
        return need;
    }

    /** 状态栏数值（旧 `controldata.updateStatusBar` 的默认实现） */
    statusBarView(): StatusBarView {
        const flags = this.state.flags;
        return formatStatusBar({
            hero: this.state.hero,
            flags,
            floorName: this.floor?.name ?? this.floor?.title ?? '',
            hard: typeof flags.hard === 'string' ? flags.hard : '',
            nextLvUpNeed: this.nextLvUpNeed(),
            levelTitles: this.levelUp.map((one) => one.title),
            statusBarItems: Array.isArray(flags.statusBarItems)
                ? (flags.statusBarItems as string[])
                : [],
        });
    }

    /**
     * 塔作者脚本 API（`ScriptContext.api`）。
     *
     * 只读查询与值块内建函数同源；写操作转交各模块；视觉/音频/面板转给呈现层。
     * 宿主调试用的 `move` / `save` / `load` / `getState` 也挂在这里，方便控制台驱动。
     */
    get gameApi(): GameApi & {
        move(dx: number, dy: number): void;
        save(): boolean;
        load(): boolean;
        getState(): GameState;
    } {
        return {
            ...createGameApi(this.apiHost()),
            move: (dx: number, dy: number): void => void this.move(dx, dy),
            save: (): boolean => this.save(),
            load: (): boolean => this.load(),
            getState: (): GameState => structuredClone(this.state),
        };
    }

    /** 兼容旧调用点：`runtime.api` 即 `gameApi` */
    get api() {
        return this.gameApi;
    }

    /** 组装塔作者 API 需要的宿主能力 */
    private apiHost(): GameApiHost {
        // gameApi 每次访问都会重建，因此 hero / flags / floorId 取当前快照即可；
        // hero 与 flags 是稳定引用，floorId 变化后下次取用即为新值。
        return {
            hero: this.state.hero,
            flags: this.state.flags,
            values: this.state.values,
            items: this.data.items as Record<string, ApiItemData>,
            enemys: this.data.enemys as Record<string, unknown>,
            floorId: this.state.floorId,
            floorIds: this.floorIds,
            getFloor: (id) => this.data.floors[id] as FloorData,
            getBlocks: (id) => this.getBlocks(id),
            evaluate: (expr, prefix) =>
                toValue(evaluateValue(expr, this.valueScope(prefix), prefix)),
            // 与 `setValue` 动作一致：先读原值再按运算符合并
            writeValue: (name, value, operator, prefix) => {
                const scope = this.valueScope(prefix);
                const origin = evaluateValue(name, scope, prefix);
                const next = applyOperator(operator, origin, toValue(value));
                writeValue(scope, name, next, prefix);
            },
            runAction: (actions) => this.events.start(actions),
            insertAction: (actions) => this.events.insert(actions),
            // 换层与改图块都走剧本动作，复用其中的楼层存在性检查与表达式解析
            changeFloor: (floorId, loc = null, direction) =>
                void this.events.start([{ type: 'changeFloor', floorId, loc, direction }]),
            setBlock: (floorId, x, y, numberOrId) =>
                void this.events.start([
                    { type: 'setBlock', number: numberOrId, loc: [[x, y]], floorId },
                ]),
            setBlockDisabled: (floorId, x, y, disabled) => {
                const block = this.getBlocks(floorId).find((one) => one.x === x && one.y === y);
                if (!block) return false;
                this.control.setBlockDisabled(block, disabled, floorId);
                return true;
            },
            addItem: (id, count) => this.items.add(id, count),
            removeItem: (id, count) => this.items.remove(id, count),
            useItem: (id) => this.items.use(id),
            canUseItem: (id) => this.items.canUse(id),
            equip: (id) => this.items.equip(id),
            unequip: (id) => this.items.unequip(this.items.equipTypeById(id)),
            effect: (type, data) => this.events.host.presenter.effect?.(type, data),
            registerUiHooks: (hooks) => this.registerUiHooks(hooks),
            openQuickShop: (id) => this.openQuickShop(id),
        };
    }

    /**
     * 运行一个塔作者脚本，返回它给出的剧本动作。
     *
     * 脚本必须已注册（开局由 `loadScripts` 预加载）；未注册时记录错误并返回空动作，
     * 不让一次脚本缺失炸掉整个回合。
     */
    runScript(name: string, context: Partial<ScriptContext> = {}): ScriptAction[] {
        const script = this.scripts.get(name);
        if (!script) {
            console.error(`未注册的脚本：${name}（请确认已调用 loadScripts）`);
            return [];
        }
        try {
            return scriptActions(script({ api: this.gameApi, trigger: 'event', ...context }));
        } catch (error) {
            console.error(`脚本 ${name} 执行失败：`, error);
            return [];
        }
    }

    /** 注入脚本加载器（浏览器用动态 `import()`；测试可直接注册） */
    setScriptLoader(loader: ScriptLoader): void {
        this.scriptLoader = loader;
    }

    /**
     * 预加载塔数据里引用到的全部脚本。
     *
     * 引擎执行效果是同步的，所以脚本要在开局前一次性加载完；返回加载失败的脚本名。
     * 未注入加载器时只加载已注册的脚本（测试 / 内嵌场景）。
     */
    async loadScripts(names?: readonly string[]): Promise<string[]> {
        const targets = names ?? collectScriptRefs(this.data);
        const missing = targets.filter((name) => !this.scripts.has(name));
        if (missing.length === 0) return [];
        const loader = this.scriptLoader;
        if (!loader) return missing;
        return this.scripts.loadAll(missing, loader);
    }

    /**
     * 加载并立即执行一个「UI 脚本」（`firstData.ui.script`）。
     *
     * UI 钩子（`mota.ui.register`）与道具脚本不同：它不需要等某个道具被使用，
     * 加载后就要跑一遍把钩子注册进去。返回是否成功。
     */
    async setupUiScript(name: string | null | undefined): Promise<boolean> {
        if (!name) return false;
        const failed = await this.loadScripts([name]);
        if (failed.length > 0) return false;
        const actions = this.runScript(name, { trigger: 'function' });
        if (actions.length > 0) this.events.start(actions);
        return true;
    }

    /** 该格是否可通行 */
    canPass(x: number, y: number): boolean {
        return this.control.canPass(x, y);
    }

    /** 单步移动/交互；返回动作描述 */
    move(dx: number, dy: number): MoveResult {
        const ctx = this.control.ctx;
        const targetX = ctx.hero.x + dx;
        const targetY = ctx.hero.y + dy;
        const block = this.control.blockAt(targetX, targetY);

        // 剧本事件块（NPC / 告示牌 / 挂了事件的怪物图块等）：面向目标并执行剧本，勇士不移动。
        // 与旧 `events.trigger` 一致：只要图块的 trigger 是 action（`extractBlocks` 在挂上剧本
        // 数据时设为 action），就优先跑事件，哪怕它的 cls 是敌人 / 门 / 道具
        // （样板里的「事件编辑器」演示就在 enemy48 图块上挂了 action 事件）。
        if (block && !block.disable && block.event.trigger === 'action' && block.event.data != null) {
            if (dy < 0) ctx.hero.direction = 'up';
            else if (dy > 0) ctx.hero.direction = 'down';
            else if (dx < 0) ctx.hero.direction = 'left';
            else if (dx > 0) ctx.hero.direction = 'right';
            this.events.start(block.event.data as ScriptAction, { x: targetX, y: targetY });
            this.state.floorId = ctx.floorId;
            this.route.record(ctx.hero.direction);
            return { moved: false, action: 'event', x: targetX, y: targetY };
        }

        const result = this.control.move(dx, dy);
        // control 内可能切换楼层，这里同步回运行时状态并触发抵达事件
        const current = this.control.ctx.floorId;
        if (current !== this.state.floorId) {
            const from = this.state.floorId;
            this.state.floorId = current;
            this.arrive(current, from, 'move');
        } else {
            this.visitFloor(current);
            if (result.deferred && result.before) {
                // 战前剧本：先跑剧本，最后重新触发本次战斗（旧 `_sys_battle`）
                this.events.start([
                    ...result.before,
                    {
                        type: 'battle',
                        loc: [result.x, result.y],
                        skipBeforeBattle: true,
                    },
                ]);
            } else {
                this.runPositionEvent(result);
            }
        }
        if (result.moved) this.state.hero.steps += 1;
        // 旧引擎对每次移动尝试都记录方向（含被挡住的情况）
        this.route.record(this.control.ctx.hero.direction);
        // 即捡即用类道具的提示（旧 `drawTip(getItemEffectTip())`）
        if (result.tip) {
            this.events.host.presenter.tip?.(result.tip);
            // 开门失败（钥匙不足 / 未定义钥匙）时旧版会响“操作失败”
            if (result.action === 'none') {
                this.events.host.presenter.effect?.('playSound', {
                    type: 'playSound',
                    name: '操作失败',
                });
            }
        }
        return result;
    }

    /** 战斗 / 拾取 / 开门后执行楼层的位置事件（旧 `afterBattle` 等） */
    private runPositionEvent(result: MoveResult): void {
        const type: PositionEventType | null =
            result.action === 'battle'
                ? 'afterBattle'
                : result.action === 'item'
                  ? 'afterGetItem'
                  : result.action === 'door'
                    ? 'afterOpenDoor'
                    : null;
        if (type) this.floorEvents.after(type, result.x, result.y);
    }

    /**
     * 旧 `turnHero`：原地转向。不给方向时按 `:right` 顺时针转 90 度，
     * 并把 `turn:<方向>` / `turn` 记入录像。
     */
    turn(direction?: Direction): Direction {
        const ctx = this.control.ctx;
        if (direction) {
            ctx.hero.direction = direction;
            this.route.record(`turn:${direction}`);
        } else {
            ctx.hero.direction = turnDirection(':right', ctx.hero.direction);
            this.route.record('turn');
        }
        return ctx.hero.direction;
    }

    /** 当前楼层的怪物列表（按伤害排序），供怪物手册使用 */
    listEnemies(): { x: number; y: number; id: string; damage: string; color: string }[] {
        const result: { x: number; y: number; id: string; damage: string; color: string }[] = [];
        for (const block of this.getBlocks(this.state.floorId)) {
            if (block.disable || block.event.cls !== 'enemys') continue;
            const info = this.control.damageString(block.x, block.y);
            if (!info) continue;
            result.push({ x: block.x, y: block.y, id: block.event.id, ...info });
        }
        return result;
    }

    /** 该格的下一个临界值文本（旧显伤的第二行，白色），`displayCritical` 关掉时返回 null */
    criticalAt(x: number, y: number): string | null {
        const block = this.control.blockAt(x, y);
        if (block?.event.displayDamage === false) return null;
        const value = this.control.criticalValue(x, y);
        if (value == null) return null;
        const text = formatBigNumber(value, true);
        return text === '???' ? '?' : text;
    }

    /* ---------------- 面板数据 ---------------- */

    /** 背包面板数据 */
    toolboxView(): ToolboxPanelView {
        return formatToolboxPanel({
            hero: this.state.hero,
            items: this.data.items,
            canUse: (id) => this.items.canUse(id),
            canEquip: (id) => this.items.canEquip(id),
            order: (cls, ids) =>
                orderToolboxItems(cls, ids, {
                    config: this.uiConfig,
                    hooks: this.uiHooks,
                    nameOf: (id) => this.data.items[id]?.name ?? id,
                }),
        });
    }

    /* ---------------- 塔作者 UI 定制 ---------------- */

    /** `firstData.ui`（旧 `functions.ui` 的声明式部分） */
    get uiConfig(): UiConfig {
        return parseUiConfig((this.data.tower.firstData as Record<string, unknown>).ui);
    }

    /** 注册 UI 钩子（`mota.ui.register`） */
    registerUiHooks(hooks: UiHooks): void {
        this.uiHooks.register(hooks);
    }

    /** 帮助 / 关于文本：脚本钩子 → `firstData.ui.about` → 空 */
    aboutText(): string {
        return this.uiHooks.about() ?? this.uiConfig.about ?? '';
    }

    /**
     * 地图浏览 / 统计面板的剩余图块统计（旧 `drawStatistics`）。
     *
     * 统计项由 `firstData.ui.statistics` 或脚本钩子给出；只统计当前楼层还没被
     * 拿走的图块（与旧 `_drawViewMaps` 一致）。
     */
    statisticsView(): { id: string; name: string; count: number }[] {
        const ids = statisticsIds({ config: this.uiConfig, hooks: this.uiHooks });
        if (ids.length === 0) return [];
        const blocks = this.getBlocks(this.state.floorId);
        return ids.map((id) => ({
            id,
            name: this.data.items[id]?.name ?? id,
            count: blocks.filter((block) => !block.disable && block.event.id === id).length,
        }));
    }

    /** 装备面板数据 */
    equipView(): EquipSlotView[] {
        return formatEquipPanel({
            hero: this.state.hero,
            items: this.data.items,
            equipNames: Array.isArray(this.data.tower.main.equipName)
                ? (this.data.tower.main.equipName as string[])
                : [],
            compare: (equipId, comparedId) => this.items.compareEquip(equipId, comparedId),
            canEquip: (id) => this.items.canEquip(id),
        });
    }

    /** 楼层传送面板数据 */
    floorView(): FloorEntry[] {
        return formatFloorPanel({
            floorIds: this.floorIds,
            currentFloorId: this.state.floorId,
            floorName: (floorId) => {
                const floor = this.data.floors[floorId] as FloorData | undefined;
                return floor?.title ?? floor?.name ?? floorId;
            },
            hasVisited: (floorId) => this.hasVisited(floorId),
            canFlyTo: (floorId) => this.data.floors[floorId]?.canFlyTo === true,
        });
    }

    /* ---------------- 商店 ---------------- */

    /** 快捷商店列表（旧 `_drawQuickShop`）：只列当前可选的商店 */
    shopView(): ShopEntry[] {
        return this.shops.listIds().map((id) => {
            const shop = this.shops.get(id);
            return {
                id,
                text: shop?.textInList ?? id,
                visited: this.shops.isVisited(id),
                canOpen: this.shops.canOpen(id),
            };
        });
    }

    /**
     * 打开快捷商店（旧 `events.openQuickShop`）：
     * 没有商店 / 商店未开启 / 当前楼层不允许时给出提示音与提示，返回 false。
     */
    openQuickShop(id?: string): boolean {
        const ids = this.shops.listIds();
        if (ids.length === 0) {
            this.tip('本游戏没有快捷商店！', undefined, true);
            return false;
        }
        const target = id ?? ids[0];
        if (!target || !this.shops.canOpen(target)) {
            this.tip('当前无法打开快捷商店！', undefined, true);
            return false;
        }
        const message = this.shops.canUseQuickShop(target);
        if (message != null) {
            this.tip(message, undefined, true);
            return false;
        }
        return this.shops.open(target, false);
    }

    /** 失败提示的音效 + 气泡（旧 `playSound('操作失败')` + `drawTip`） */
    private tip(text: string, icon?: string, failSound = false): void {
        if (failSound) {
            this.events.host.presenter.effect?.('playSound', { type: 'playSound', name: '操作失败' });
        }
        this.events.host.presenter.tip?.(text, icon);
    }

    /* ---------------- 自动寻路 ---------------- */

    /** 自动寻路：勇士当前位置到 `(x, y)` 的逐步路径（旧 `maps.automaticRoute`） */
    findPath(x: number, y: number): PathStep[] {
        const floor = this.floor;
        if (!floor) return [];
        return findPath(
            floor,
            this.getBlocks(this.state.floorId),
            { x: this.state.hero.x, y: this.state.hero.y },
            { x, y },
            { cost: (cx, cy) => this.pathCost(cx, cy) },
        );
    }

    /** 单击瞬移用的「透明路径」（旧 `canMoveDirectlyArray`） */
    findDirectPath(x: number, y: number): PathStep[] {
        const floor = this.floor;
        if (!floor) return [];
        return findDirectPath(
            floor,
            this.getBlocks(this.state.floorId),
            { x: this.state.hero.x, y: this.state.hero.y },
            { x, y },
        );
    }

    /**
     * 旧 `_automaticRoute_deepAdd`：给格子加额外代价，让寻路绕开亮灯 / 路障，
     * 开启 `__potionNoRouting__` 时也绕开血瓶与绿宝石。
     *
     * 旧版还会按「领域 / 阻击 / 捕捉」伤害加价，新引擎尚未实现这些地图技能（见文档）。
     */
    private pathCost(x: number, y: number): number {
        const block = this.control.blockAt(x, y);
        if (!block || block.disable) return 0;
        const id = block.event.id;
        let cost = 0;
        if (id === 'light') cost += 100;
        if (id.endsWith('Net') && this.getFlag(id.slice(0, -3)) == null) cost += 100;
        if (
            this.getFlag('__potionNoRouting__') === true &&
            (id.endsWith('Potion') || id === 'greenGem')
        ) {
            cost += 100;
        }
        return cost;
    }

    /**
     * 单击瞬移（旧 `control.tryMoveDirectly`）：沿「完全没有图块」的通道瞬移过去。
     *
     * 实现上仍然逐步走，因此录像里与手动行走完全一致；通道上没有图块，
     * 因此不会触发拾取 / 战斗。
     */
    tryMoveDirectly(x: number, y: number): boolean {
        const path = this.findDirectPath(x, y);
        if (path.length === 0) return false;
        for (const step of path) {
            const delta = DELTA[step.direction];
            this.move(delta[0], delta[1]);
        }
        return true;
    }

    /** 是否到达过某楼层（旧 `hasVisitedFloor`） */
    hasVisited(floorId: string): boolean {
        const visited = this.state.flags.__visited__ as Record<string, unknown> | undefined;
        return visited?.[floorId] === true;
    }

    /** 标记楼层已到达（旧 `visitFloor`） */
    visitFloor(floorId: string): void {
        if (this.hasVisited(floorId)) return;
        const visited = (this.state.flags.__visited__ as Record<string, unknown> | undefined) ?? {};
        visited[floorId] = true;
        this.state.flags.__visited__ = visited;
    }

    /**
     * 楼层传送（旧 `flyTo` 的默认实现）：检查能否起飞 / 降落 / 是否到过，
     * 记录 `fly:<floorId>` 后换层，落点取 `flyPoint`。
     */
    flyTo(floorId: string): boolean {
        const from = this.data.floors[this.state.floorId] as FloorData | undefined;
        const to = this.data.floors[floorId] as FloorData | undefined;
        if (!from || !to) return false;
        if (from.canFlyFrom !== true || to.canFlyTo !== true || !this.hasVisited(floorId)) {
            this.events.host.presenter.effect?.('playSound', {
                type: 'playSound',
                name: '操作失败',
            });
            this.events.host.presenter.tip?.(`无法飞往${to.title}！`, 'fly');
            return false;
        }
        this.route.record(`fly:${floorId}`);
        const point = to.flyPoint;
        const loc =
            Array.isArray(point) && point.length === 2
                ? ([Number(point[0]), Number(point[1])] as [number, number])
                : null;
        this.applyFloorChange(floorId, loc, null, 'fly');
        return true;
    }

    save(): boolean {
        if (!this.storage) return false;
        const payload: SaveData = {
            ...this.state,
            route: encodeRoute(this.route.route, routeCodecFor(this.data.maps)),
        };
        this.storage.setItem(SAVE_KEY, JSON.stringify(payload));
        return true;
    }

    load(): boolean {
        if (!this.storage) return false;
        const raw = this.storage.getItem(SAVE_KEY);
        if (!raw) return false;
        try {
            const parsed = JSON.parse(raw) as SaveData;
            this.state = {
                floorId: parsed.floorId,
                hero: parsed.hero,
                flags: parsed.flags,
                // 旧存档没有 values：退回塔的初始值，而不是 undefined
                values: parsed.values ?? { ...(this.data.tower.values as Record<string, unknown>) },
            };
            this.route.route = decodeRoute(parsed.route, routeCodecFor(this.data.maps));
            this.route.clearFolding();
            // block 缓存里存着上一局的 disable 状态，换 state 后必须重建
            this.clearBlockCache();
            // 重新绑定 control 的可变引用
            this.control.ctx.hero = this.state.hero;
            this.control.ctx.floorId = this.state.floorId;
            this.control.ctx.flags = this.state.flags;
            this.control.ctx.values = this.state.values;
            // 读档不重跑 firstArrive / eachArrive（旧 `__fromLoad__` 分支），
            // 但要让呈现层把 BGM / 天气 / 色调切到读档后的楼层
            this.events.host.presenter.effect?.('changeFloor', {
                floorId: this.state.floorId,
                from: null,
                first: false,
                reason: 'load',
            });
            return true;
        } catch {
            return false;
        }
    }

    /** 当前勇士生命是否大于 0 */
    get alive(): boolean {
        return getStatusOrDefault(this.state.hero, null, 'hp') > 0;
    }
}
