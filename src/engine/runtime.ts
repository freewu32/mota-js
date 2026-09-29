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
    MotaEvents,
    createHeadlessPresenter,
    type EventPresenter,
    type ScriptAction,
    turnDirection,
} from './modules/events';
import { extractBlocks, isDoor, isEnemy, isItem, type Block } from './modules/maps';
import { getStatusOrDefault } from './modules/status';
import { formatStatusBar, type StatusBarView } from './modules/ui';
import { applyOperator, evaluateValue, writeValue, type ValueScope } from './modules/values';
import type { Direction, GameState, HeroState, RuntimeData, SaveData } from './types';

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
    /** 录像路线（可编码进存档 / 分享为录像文件） */
    readonly route = new RouteRecorder();
    /** 塔作者脚本注册表（开局前用 `loadScripts` 预加载） */
    readonly scripts = new ScriptRegistry();
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

        const firstData = data.tower.firstData;
        const hero = normalizeHero(firstData.hero);
        this.state = {
            floorId: firstData.floorId,
            hero,
            flags: { ...(data.tower.flags as Record<string, unknown>) },
        };

        const ctx: ControlContext = {
            maps: data.maps,
            values: data.tower.values as Record<string, unknown>,
            flags: this.state.flags,
            enemys: data.enemys,
            items: data.items,
            hero: this.state.hero,
            floorId: this.state.floorId,
            floorIds: this.floorIds,
            getFloor: (id) => this.data.floors[id] as FloorData,
            getBlocks: (id) => this.getBlocks(id),
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
        });
    }

    /**
     * 应用剧本 / 脚本发起的换层：同时更新控制上下文与运行时状态。
     *
     * 旧的 `core.changeFloor` 还负责背景音乐、过场动画与 `firstArrive` 剧本，
     * 这些属于呈现层，留到游戏入口阶段补。
     */
    private applyFloorChange(
        floorId: string | null,
        loc: [number, number] | null,
        direction: string | null,
    ): void {
        const ctx = this.control.ctx;
        if (floorId) {
            ctx.floorId = floorId;
            this.state.floorId = floorId;
        }
        if (loc) {
            ctx.hero.x = loc[0];
            ctx.hero.y = loc[1];
        }
        if (direction) ctx.hero.direction = direction as Direction;
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
     * 值块求值上下文（旧 `core` 里散落的 status/flags/hero 组合）。
     * 事件、状态栏与塔作者脚本共用同一份作用域。
     */
    valueScope(prefix?: string): ValueScope {
        return {
            flags: this.state.flags,
            values: this.data.tower.values as Record<string, unknown>,
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
            values: this.data.tower.values as Record<string, unknown>,
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
            addItem: (id, count) => this.items.add(id, count),
            removeItem: (id, count) => this.items.remove(id, count),
            useItem: (id) => this.items.use(id),
            canUseItem: (id) => this.items.canUse(id),
            equip: (id) => this.items.equip(id),
            unequip: (id) => this.items.unequip(this.items.equipTypeById(id)),
            effect: (type, data) => this.events.host.presenter.effect?.(type, data),
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

        // 剧本事件块（NPC / 告示牌等）：面向目标并执行剧本，勇士不移动
        if (
            block &&
            !block.disable &&
            block.event.trigger === 'action' &&
            block.event.data != null &&
            !isEnemy(block.event) &&
            !isDoor(block.event) &&
            !isItem(block.event)
        ) {
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
        // control 内可能切换楼层，这里同步回运行时状态
        this.state.floorId = this.control.ctx.floorId;
        if (result.moved) this.state.hero.steps += 1;
        // 旧引擎对每次移动尝试都记录方向（含被挡住的情况）
        this.route.record(this.control.ctx.hero.direction);
        // 即捡即用类道具的提示（旧 `drawTip(getItemEffectTip())`）
        if (result.tip) this.events.host.presenter.tip?.(result.tip);
        return result;
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
            };
            this.route.route = decodeRoute(parsed.route, routeCodecFor(this.data.maps));
            this.route.clearFolding();
            // 重新绑定 control 的可变引用
            this.control.ctx.hero = this.state.hero;
            this.control.ctx.floorId = this.state.floorId;
            this.control.ctx.flags = this.state.flags;
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
