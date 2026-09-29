/**
 * 剧本事件解释器。
 *
 * 迁移自旧 `libs/events.js` 的事件流执行部分（`doAction` / `setEvents` /
 * `insertAction` / `_action_*`）。旧实现用 `core.status.event.data` 保存一个
 * 「帧栈」：每帧是一段待执行的事件列表，执行完按 `condition` 决定是否重来，
 * 从而实现 while / for / dowhile 等循环。
 *
 * 新实现保留同样的执行模型，但：
 * - 纯逻辑，不依赖 DOM；对话、选择项、确认框、输入框、休眠全部走 `EventPresenter`；
 * - 条件与文本表达式交给 `values.ts` 的安全求值器，不再 `eval`；
 * - `function` 动作不再 eval 字符串，改为查找宿主注册的函数（塔作者 API 的接入点）。
 */
import type { Direction } from '../types';
import { MotaControl, addItem, type ControlContext } from './control';
import { triggerDebuff, type DebuffType } from './status';
import { blockAt, isDoor, isEnemy, isItem, matchesFilter, resolveEvent, type Block } from './maps';
import { createBuiltins, resolveFloorId } from './builtins';
import { createFollower, gatherFollowers } from './followers';
import {
    applyOperator,
    evaluateCondition,
    evaluateValue,
    replaceText,
    truthy,
    writeValue,
    type ValueScope,
} from './values';

export type ScriptAction = string | ScriptActionObject;

/** 事件列表：旧格式里一个动作位也可以直接写数组，等价于顺序执行 */
export type ScriptActionList = ScriptAction | ScriptAction[];

export interface ScriptActionObject {
    type: string;
    [key: string]: unknown;
}

export interface ChoiceItem {
    text: string;
    action?: ScriptActionList;
    condition?: string;
    need?: string;
    _disabled?: boolean;
    [key: string]: unknown;
}

/** 事件列表中的一帧：`todo` 为剩余事件，`total` 为循环体模板 */
export interface EventFrame {
    todo: ScriptAction[];
    total: ScriptAction[];
    /** 字符串为条件表达式，函数用于 for / forEach 这类带内部状态的循环 */
    repeat: string | (() => boolean);
}

/** UI 适配层：引擎只负责推进事件流，具体呈现交给宿主实现 */
export interface EventPresenter {
    clear?(): void;
    text?(text: string, data: ScriptActionObject, done: () => void): void;
    setText?(data: ScriptActionObject): void;
    tip?(text: string, icon?: string): void;
    choices?(
        text: string,
        choices: ChoiceItem[],
        data: ScriptActionObject,
        done: (index: number | null) => void,
    ): void;
    confirm?(text: string, data: ScriptActionObject, done: (ok: boolean | null) => void): void;
    input?(hint: string, isText: boolean, done: (value: string) => void): void;
    wait?(done: () => void): void;
    sleep?(ms: number, done: () => void): void;
    /** 其余视觉 / 音频 / UI 动作的落点，由 ui.ts 阶段实现 */
    effect?(type: string, data: ScriptActionObject | Record<string, unknown>): void;
    update?(): void;
}

export type HostFunction = (...args: unknown[]) => unknown;

export type ActionHandler = (
    this: MotaEvents,
    data: ScriptActionObject,
    x: number | null,
    y: number | null,
    prefix: string,
) => void | 'pause';

export interface EventsHost extends ControlContext {
    /** 复用已有的 control（保证事件与移动共享同一 floorId / block 缓存） */
    control?: MotaControl;
    presenter: EventPresenter;
    /** 跨存档全局存储（`global:`） */
    globals?: Record<string, unknown>;
    /** 公共事件表（原 project/events.js 的 commonEvent） */
    commonEvents?: Record<string, ScriptAction[]>;
    /** 宿主注入的函数（脚本 API，供 `function` 动作与表达式调用） */
    functions?: Record<string, HostFunction>;
    /** 额外 / 覆盖的事件处理器 */
    actions?: Record<string, ActionHandler>;
    /** 覆盖图块设置（默认直接修改 block 缓存） */
    setBlock?: (floorId: string, x: number, y: number, numberOrId: number | string) => void;
    /** 覆盖楼层切换（默认直接改 control 上下文） */
    changeFloor?: (
        floorId: string | null,
        loc: [number, number] | null,
        direction: string | null,
    ) => void;
    onWin?(reason: string, norank: boolean, noexit: boolean): void;
    onLose?(reason: string): void;
    onRestart?(): void;
    onExit?(): void;
    onAfterBattle?(enemyId: string, x: number, y: number): void;
    onAfterGetItem?(itemId: string, x: number, y: number): void;
    onStatusChange?(): void;
    /** 跟随者增减（旧 `gatherFollowers` 后重绘） */
    onFollowerChange?(): void;
    /**
     * 某位置的战前剧本（扁平动作列表）：楼层 `beforeBattle["x,y"]` 与怪物自己的
     * `beforeBattle`。返回非空时战斗会被推迟，先跑这段剧本再执行 `battle` 动作。
     */
    beforeBattleAt?(x: number, y: number, enemyId: string): ScriptAction[] | null;
}

export interface StartOptions {
    x?: number | null;
    y?: number | null;
    floorId?: string | null;
    callback?: () => void;
}

/** 旧 `utils.turnDirection`：支持 `:left` / `:right` / `:back` 等相对转向 */
export function turnDirection(turn: string, direction: Direction): Direction {
    const full = ['left', 'up', 'right', 'down'];
    if (full.includes(turn)) return turn as Direction;
    let steps = 0;
    if (turn === ':hero') return direction;
    if (turn === ':left') steps = 3;
    else if (turn === ':right') steps = 1;
    else if (turn === ':back') steps = 2;
    const index = full.indexOf(direction);
    if (index < 0) return direction;
    return full[(index + steps) % full.length] as Direction;
}

function normalizeList(actions: unknown): ScriptAction[] {
    if (actions == null) return [];
    if (Array.isArray(actions)) return actions as ScriptAction[];
    return [actions as ScriptAction];
}

/**
 * 默认（无 UI）呈现器：文本直接继续、确认框不选任何分支。
 *
 * 选择项取**最后一项**而不是「不选」：`while(true)` + 选择项的商店 / 菜单
 * （如全局商店的「离开」固定在最后）因此能自然退出，不会空转。
 */
export function createHeadlessPresenter(): EventPresenter {
    return {
        sleep: (ms, done) => {
            setTimeout(done, Math.max(0, ms));
        },
        choices: (_text, choices, _data, done) => {
            done(choices.length > 0 ? choices.length - 1 : null);
        },
        confirm: (_text, _data, done) => {
            done(null);
        },
        input: (_hint, _isText, done) => {
            done('');
        },
    };
}

/** 同步循环（无 UI 的对话 / 选择项自动应答）的轮数上限，防止塔作者写出死循环卡死页面 */
const MAX_SYNC_ROUNDS = 2000;

/** 已知由 UI / 音频层处理的视觉类动作，未实现时静默交给 presenter.effect */
const VISUAL_ACTIONS = new Set([
    'move',
    'moveAction',
    'moveHero',
    'jump',
    'jumpHero',
    'moveTextBox',
    'clearTextBox',
    'autoTextScroll',
    'animate',
    'stopAnimate',
    'setViewport',
    'lockViewport',
    'showImage',
    'showTextImage',
    'hideImage',
    'showGif',
    'moveImage',
    'rotateImage',
    'scaleImage',
    'setCurtain',
    'screenFlash',
    'setWeather',
    'fillText',
    'fillBoldText',
    'fillRect',
    'fillPolygon',
    'strokeRect',
    'strokePolygon',
    'fillEllipse',
    'strokeEllipse',
    'fillArc',
    'strokeArc',
    'drawLine',
    'drawArrow',
    'setAttribute',
    'setFilter',
    'drawImage',
    'drawIcon',
    'drawSelector',
    'drawBackground',
    'drawTextContent',
    'clearMap',
    'showFloorImg',
    'hideFloorImg',
    'showBgFgMap',
    'hideBgFgMap',
    'setBgFgBlock',
    'playBgm',
    'pauseBgm',
    'resumeBgm',
    'loadBgm',
    'freeBgm',
    'playSound',
    'stopSound',
    'setVolume',
    'setBgmSpeed',
    'vibrate',
    'previewUI',
]);

export class MotaEvents {
    readonly control: MotaControl;
    readonly globals: Record<string, unknown>;
    readonly commonEvents: Record<string, ScriptAction[]>;
    readonly actions: Record<string, ActionHandler> = {};

    private list: EventFrame[] = [];
    private x: number | null = null;
    private y: number | null = null;
    private floorId: string | null = null;
    private callback?: () => void;
    private appendingEvents: ScriptAction[][] = [];
    private running = false;
    private resumeRequested = false;
    private finished = true;
    private selection = 0;

    private readonly resumeFn = (): void => this.resume();

    constructor(readonly host: EventsHost) {
        this.control = host.control ?? new MotaControl(host);
        this.globals = host.globals ?? {};
        this.commonEvents = host.commonEvents ?? {};

        this.actions = {
            text: this.actionText,
            autoText: this.actionAutoText,
            scrollText: this.actionScrollText,
            tip: this.actionTip,
            setText: this.actionSetText,
            comment: this.actionNoop,
            _label: this.actionNoop,
            if: this.actionIf,
            switch: this.actionSwitch,
            choices: this.actionChoices,
            confirm: this.actionConfirm,
            input: this.actionInput,
            input2: this.actionInput2,
            for: this.actionFor,
            forEach: this.actionForEach,
            while: this.actionWhile,
            dowhile: this.actionDowhile,
            break: this.actionBreak,
            continue: this.actionContinue,
            setValue: this.actionSetValue,
            addValue: this.actionAddValue,
            setBlock: this.actionSetBlock,
            hide: this.actionHide,
            show: this.actionShow,
            removeBlock: this.actionRemoveBlock,
            jumpHero: this.actionJumpHero,
            changeFloor: this.actionChangeFloor,
            changePos: this.actionChangePos,
            battle: this.actionBattle,
            openDoor: this.actionOpenDoor,
            openPanel: this.actionOpenPanel,
            trigger: this.actionTrigger,
            insert: this.actionInsert,
            sleep: this.actionSleep,
            wait: this.actionWait,
            function: this.actionFunction,
            update: this.actionUpdate,
            follow: this.actionFollow,
            unfollow: this.actionUnfollow,
            win: this.actionWin,
            lose: this.actionLose,
            restart: this.actionRestart,
            exit: this.actionExit,
            setGlobalValue: this.actionSetGlobalValue,
            triggerDebuff: this.actionTriggerDebuff,
            ...(host.actions ?? {}),
        };
    }

    /* ---------------- 状态 ---------------- */

    get isRunning(): boolean {
        return this.running || this.list.length > 0;
    }

    get currentSelection(): number {
        return this.selection;
    }

    get frames(): readonly EventFrame[] {
        return this.list;
    }

    private get flags(): Record<string, unknown> {
        return this.control.ctx.flags;
    }

    /** 构造求值作用域；`getBlock` 绑定到指定楼层 */
    private scope(floorId: string | null = this.floorId): ValueScope {
        const ctx = this.control.ctx;
        const targetFloor = floorId ?? ctx.floorId;
        return {
            flags: ctx.flags,
            values: ctx.values,
            globals: this.globals,
            hero: ctx.hero,
            enemys: this.host.enemys,
            prefix: this.prefixFor(targetFloor),
            // 内建函数（nextX / blockId(x,y) / floorIdOffset …）在前，塔作者注入的优先
            functions: { ...this.builtins(targetFloor), ...this.host.functions },
            getBlock: (x, y) => blockAt(ctx.getBlocks(targetFloor), x, y),
            // SAFETY: 楼层数据本就是按名字取值的字典，`floor:属性` 只读查表，
            // 不会写入未知字段。
            floor: ctx.getFloor(targetFloor) as unknown as Record<string, unknown>,
        };
    }

    /** 值块内建函数（旧 core 的 nextX / getBlockId / bigmap / nearStair 等） */
    private builtins(floorId: string): Record<string, (...args: unknown[]) => unknown> {
        const ctx = this.control.ctx;
        return createBuiltins({
            hero: ctx.hero,
            floorId,
            floorIds: ctx.floorIds ?? [ctx.floorId],
            getFloor: (id) => ctx.getFloor(id),
            getBlocks: (id) => ctx.getBlocks(id),
            enemys: this.host.enemys,
        });
    }

    private prefixFor(
        floorId: string | null,
        x: number | null = this.x,
        y: number | null = this.y,
    ): string {
        return `${floorId ?? ':f'}@${x ?? 'x'}@${y ?? 'y'}`;
    }

    private setFlag(name: string, value: unknown): void {
        this.flags[name] = value;
    }

    /* ---------------- 事件流控制 ---------------- */

    /**
     * 设定「当前事件坐标」（旧 `core.pushEventLoc`）：
     * 后续没有 `loc` 的动作（如 `openDoor` / `removeBlock`）以它为准。
     */
    setEventLoc(x: number | null, y: number | null, floorId?: string | null): void {
        if (x != null) this.x = x;
        if (y != null) this.y = y;
        if (floorId != null) this.floorId = floorId;
    }

    /** 开始执行一段事件列表 */
    start(list: unknown, options: StartOptions = {}): void {
        this.setEvents(list, options.x, options.y, options.callback, options.floorId);
        this.run();
    }

    /** 设置当前事件流（不立即执行） */
    setEvents(
        list: unknown,
        x?: number | null,
        y?: number | null,
        callback?: () => void,
        floorId?: string | null,
    ): void {
        if (list != null) {
            const actions = normalizeList(list).slice();
            actions.push({ type: '_label' });
            this.list = [{ todo: actions.slice(), total: actions.slice(), repeat: 'false' }];
        }
        if (x != null) this.x = x;
        if (y != null) this.y = y;
        if (floorId != null) this.floorId = floorId;
        if (callback) this.callback = callback;
        this.finished = false;
        this.resumeRequested = false;
    }

    /** 向当前事件流之前插入一段事件（等价旧 `insertAction`） */
    insert(action: unknown, x?: number | null, y?: number | null, callback?: () => void): void {
        if (action == null) return;
        if (x != null) this.x = x;
        if (y != null) this.y = y;
        if (callback) this.callback = callback;

        const actions = normalizeList(action);
        if (!this.isRunning) {
            this.start(actions, { x, y, callback });
            return;
        }
        const frame = this.list[0];
        if (!frame) {
            this.start(actions, { x, y, callback });
            return;
        }
        frame.todo.unshift(...actions);
        this.finished = false;
    }

    /** 插入公共事件（原 `insertCommonEvent`） */
    insertCommonEvent(name: string, args: unknown[] = []): void {
        const common = this.commonEvents[name];
        if (!common) return;
        this.setFlag('arg0', name);
        args.forEach((value, index) => {
            if (value != null) this.setFlag(`arg${index + 1}`, value);
        });
        this.insert({ type: 'dowhile', condition: 'false', data: common });
    }

    /** 继续执行；可在任意异步回调中调用 */
    resume(): void {
        this.resumeRequested = true;
        if (!this.running) this.run();
    }

    /** 立即结束当前事件流 */
    stop(): void {
        this.list = [];
        this.appendingEvents = [];
        this.checkFinished();
    }

    private run(): void {
        if (this.running) {
            this.resumeRequested = true;
            return;
        }
        this.running = true;
        try {
            let rounds = 0;
            do {
                this.resumeRequested = false;
                this.loop();
                rounds += 1;
                // 对话 / 选择项被「同步应答」（无 UI 的呈现器，或塔作者脚本自己应答）时，
                // `while(true)` 会在这里空转。达到上限就停下来，别把标签页卡死。
                if (rounds > MAX_SYNC_ROUNDS) {
                    console.error(
                        '事件同步循环次数过多，已中止：请检查是否存在 while(true) + 无交互动作。',
                    );
                    this.stop();
                    break;
                }
            } while (this.resumeRequested && !this.finished);
        } finally {
            this.running = false;
        }
    }

    private loop(): void {
        for (;;) {
            if (this.checkFinished()) return;
            const presenter = this.host.presenter;
            presenter.clear?.();
            const frame = this.list[0];
            if (!frame) return;

            if (frame.todo.length === 0) {
                if (this.evalRepeat(frame, this.prefixFor(this.floorId))) {
                    frame.todo = frame.total.slice();
                } else {
                    this.list.shift();
                }
                continue;
            }

            const raw = frame.todo.shift() as ScriptAction;
            const data: ScriptActionObject =
                typeof raw === 'string' ? { type: 'text', text: raw } : raw;
            if (data._disabled) continue;

            const prefix = this.prefixFor(this.floorId);
            const handler = this.actions[data.type];
            if (!handler) {
                const output = this.runFallback(data, prefix);
                if (output === 'pause') return;
                continue;
            }
            let output: void | 'pause';
            try {
                output = handler.call(this, data, this.x, this.y, prefix);
            } catch (error) {
                console.error('事件执行出错：', data, error);
                this.insert(`事件执行出错：${String(error)}`);
                continue;
            }
            if (output === 'pause') return;
        }
    }

    private checkFinished(): boolean {
        if (this.list.length > 0) return false;
        if (this.appendingEvents.length > 0) {
            this.setEvents(this.appendingEvents.shift());
            return false;
        }
        if (this.finished) return true;
        this.finished = true;
        const callback = this.callback;
        this.callback = undefined;
        this.host.presenter.clear?.();
        if (callback) callback();
        return true;
    }

    private evalRepeat(frame: EventFrame, prefix: string): boolean {
        if (typeof frame.repeat === 'function') return truthy(frame.repeat());
        return evaluateCondition(frame.repeat, this.scope(), prefix);
    }

    private runFallback(data: ScriptActionObject, prefix: string): void | 'pause' {
        const custom = this.host.actions?.[data.type];
        if (custom && this.actions[data.type] !== custom) {
            return custom.call(this, data, this.x, this.y, prefix);
        }
        if (VISUAL_ACTIONS.has(data.type)) {
            this.host.presenter.effect?.(data.type, data);
            return;
        }
        this.insert(`未知的事件类型：${data.type}！`);
    }

    /* ---------------- 位置换算 ---------------- */

    private evalCoord(value: unknown, scope: ValueScope, prefix: string): number {
        if (typeof value === 'number') return value;
        if (value == null) return 0;
        const result = evaluateValue(value, scope, prefix);
        const n = Number(result);
        return Number.isFinite(n) ? n : 0;
    }

    private resolveLoc(
        loc: unknown,
        x: number | null,
        y: number | null,
        prefix: string,
    ): [number, number] {
        const scope = this.scope();
        if (Array.isArray(loc) && loc.length >= 2) {
            return [this.evalCoord(loc[0], scope, prefix), this.evalCoord(loc[1], scope, prefix)];
        }
        return [x ?? 0, y ?? 0];
    }

    private resolveLoc2D(
        loc: unknown,
        x: number | null,
        y: number | null,
        prefix: string,
    ): [number, number][] {
        if (Array.isArray(loc) && loc.length > 0 && Array.isArray(loc[0])) {
            return (loc as unknown[][]).map((one) => this.resolveLoc(one, x, y, prefix));
        }
        return [this.resolveLoc(loc, x, y, prefix)];
    }

    private resolveHeroLoc(loc: unknown, prefix: string): [number, number] {
        if (!loc) return [this.control.ctx.hero.x, this.control.ctx.hero.y];
        return this.resolveLoc(loc, this.control.ctx.hero.x, this.control.ctx.hero.y, prefix);
    }

    /* ---------------- 文本类 ---------------- */

    private actionText(data: ScriptActionObject): void | 'pause' {
        const scope = this.scope();
        data.text = replaceText(data.text, scope, this.prefixFor(this.floorId));
        const presenter = this.host.presenter;
        if (!presenter.text) return;
        presenter.text(String(data.text), data, this.resumeFn);
        return 'pause';
    }

    private actionAutoText(data: ScriptActionObject): void | 'pause' {
        data.text = replaceText(data.text, this.scope(), this.prefixFor(this.floorId));
        this.host.presenter.text?.(String(data.text), data, () => undefined);
        this.scheduleResume(Number(data.time) || 3000);
        return 'pause';
    }

    private actionScrollText(data: ScriptActionObject): void | 'pause' {
        data.text = replaceText(data.text, this.scope(), this.prefixFor(this.floorId));
        this.host.presenter.text?.(String(data.text), data, () => undefined);
        this.scheduleResume(Number(data.time) || 5000);
        return 'pause';
    }

    private actionTip(data: ScriptActionObject): void {
        const text = replaceText(data.text, this.scope(), this.prefixFor(this.floorId));
        this.host.presenter.tip?.(text, data.icon == null ? undefined : String(data.icon));
    }

    private actionSetText(data: ScriptActionObject): void {
        this.host.presenter.setText?.(data);
    }

    private actionNoop(): void {
        // 注释 / 标签等空操作
    }

    private scheduleResume(ms: number): void {
        const presenter = this.host.presenter;
        if (presenter.sleep) {
            presenter.sleep(ms, this.resumeFn);
            return;
        }
        setTimeout(this.resumeFn, Math.max(0, ms));
    }

    /* ---------------- 条件分支 ---------------- */

    private actionIf(
        data: ScriptActionObject,
        _x: number | null,
        _y: number | null,
        prefix: string,
    ): void {
        const condition = evaluateCondition(data.condition, this.scope(), prefix);
        this.insert(condition ? data['true'] : data['false']);
    }

    private actionSwitch(
        data: ScriptActionObject,
        _x: number | null,
        _y: number | null,
        prefix: string,
    ): void {
        const scope = this.scope();
        const key = evaluateValue(data.condition, scope, prefix);
        const cases = (data.caseList ?? []) as ScriptActionObject[];
        const actions: ScriptAction[] = [];
        for (const item of cases) {
            if (item._disabled) continue;
            const label = item.case;
            if (label === 'default' || evaluateValue(label, scope, prefix) === key) {
                actions.push(...normalizeList(item.action));
                if (!item.nobreak) break;
            }
        }
        this.insert(actions);
    }

    private actionChoices(
        data: ScriptActionObject,
        _x: number | null,
        _y: number | null,
        prefix: string,
    ): void | 'pause' {
        const scope = this.scope();
        const raw = (data.choices ?? []) as ChoiceItem[];
        const choices: ChoiceItem[] = [];
        for (const item of raw) {
            if (item._disabled) continue;
            const condition = item.condition;
            if (
                condition != null &&
                condition !== '' &&
                !evaluateCondition(condition, scope, prefix)
            ) {
                continue;
            }
            choices.push({ ...item, text: replaceText(item.text, scope, prefix) });
        }
        if (choices.length === 0) return;
        const presenter = this.host.presenter;
        if (!presenter.choices) return;

        presenter.choices(replaceText(data.text, scope, prefix), choices, data, (index) => {
            if (index == null) {
                this.setFlag('timeout', 0);
                this.resume();
                return;
            }
            this.setFlag('timeout', 0);
            this.selection = index;
            const choice = choices[index];
            if (choice) this.insert(choice.action);
            this.resume();
        });
        return 'pause';
    }

    private actionConfirm(
        data: ScriptActionObject,
        _x: number | null,
        _y: number | null,
        prefix: string,
    ): void | 'pause' {
        const presenter = this.host.presenter;
        if (!presenter.confirm) return;
        presenter.confirm(replaceText(data.text, this.scope(), prefix), data, (ok) => {
            if (ok === true) this.insert(data.yes);
            else if (ok === false) this.insert(data.no);
            this.resume();
        });
        return 'pause';
    }

    private actionInput(
        data: ScriptActionObject,
        _x: number | null,
        _y: number | null,
        prefix: string,
    ): void | 'pause' {
        const presenter = this.host.presenter;
        if (!presenter.input) return;
        presenter.input(replaceText(data.text, this.scope(), prefix), false, (value) => {
            const parsed = Number.parseInt(value, 10);
            this.setFlag('input', Number.isNaN(parsed) ? 0 : parsed);
            this.resume();
        });
        return 'pause';
    }

    private actionInput2(
        data: ScriptActionObject,
        _x: number | null,
        _y: number | null,
        prefix: string,
    ): void | 'pause' {
        const presenter = this.host.presenter;
        if (!presenter.input) return;
        presenter.input(replaceText(data.text, this.scope(), prefix), true, (value) => {
            this.setFlag('input', value ?? '');
            this.resume();
        });
        return 'pause';
    }

    /* ---------------- 循环 ---------------- */

    private pushLoop(actions: unknown, repeat: string | (() => boolean)): void {
        const list = normalizeList(actions).slice();
        list.push({ type: '_label' });
        this.list.unshift({ todo: list.slice(), total: list.slice(), repeat });
    }

    private actionFor(
        data: ScriptActionObject,
        _x: number | null,
        _y: number | null,
        prefix: string,
    ): void {
        const name = String(data.name ?? '');
        if (!/^temp:[A-Z]$/.test(name)) {
            this.insert('循环遍历事件只支持临时变量！');
            return;
        }
        const scope = this.scope();
        const from = Number(evaluateValue(data.from, scope, prefix));
        const to = Number(evaluateValue(data.to, scope, prefix));
        const step = Number(evaluateValue(data.step, scope, prefix));
        if (![from, to, step].every((n) => Number.isFinite(n))) {
            this.insert('循环遍历事件要求【起始点】【终止点】【每步】仅能是数字！');
            return;
        }
        if ((step > 0 && from > to) || (step < 0 && from < to)) return;

        const letter = name.slice(5);
        const key = `@temp@${letter}`;
        this.flags[key] = from;
        this.pushLoop(data.data, () => {
            const toValue = Number(evaluateValue(data.to, scope, prefix));
            const stepValue = Number(evaluateValue(data.step, scope, prefix));
            if (stepValue === 0) return true;
            const current = Number(this.flags[key]) + stepValue;
            this.flags[key] = current;
            return stepValue > 0 ? current <= toValue : current >= toValue;
        });
    }

    private actionForEach(data: ScriptActionObject): void {
        const name = String(data.name ?? '');
        if (!/^temp:[A-Z]$/.test(name)) {
            this.insert('循环遍历事件只支持临时变量！');
            return;
        }
        const letter = name.slice(5);
        const listKey = `@temp@forEach@${letter}`;
        this.flags[listKey] = structuredClone(data.list ?? []);
        this.pushLoop(data.data, () => {
            const list = this.flags[listKey];
            if (!Array.isArray(list) || list.length === 0) return false;
            this.flags[`@temp@${letter}`] = list.shift();
            return true;
        });
    }

    private actionWhile(data: ScriptActionObject): void {
        if (evaluateCondition(data.condition, this.scope(), this.prefixFor(this.floorId))) {
            this.pushLoop(data.data, String(data.condition ?? 'false'));
        }
    }

    private actionDowhile(data: ScriptActionObject): void {
        this.pushLoop(data.data, String(data.condition ?? 'false'));
    }

    private actionBreak(data: ScriptActionObject): void {
        let n = Number(data.n) || 1;
        while (n-- > 0) {
            if (this.list.length > 1) this.list.shift();
        }
    }

    private actionContinue(
        data: ScriptActionObject,
        _x: number | null,
        _y: number | null,
        prefix: string,
    ): void {
        let n = Number(data.n) || 1;
        while (n-- > 1) {
            if (this.list.length > 1) this.list.shift();
        }
        if (this.list.length > 1) {
            const frame = this.list[0];
            if (this.evalRepeat(frame, prefix)) frame.todo = frame.total.slice();
            else this.list.shift();
        }
    }

    /* ---------------- 数值与图块 ---------------- */

    private actionSetValue(
        data: ScriptActionObject,
        _x: number | null,
        _y: number | null,
        prefix: string,
    ): void {
        const scope = this.scope();
        const origin = evaluateValue(data.name, scope, prefix);
        const value = applyOperator(
            typeof data.operator === 'string' ? data.operator : undefined,
            origin,
            evaluateValue(data.value, scope, prefix),
        );
        writeValue(scope, String(data.name), value, prefix);
        this.afterValueChange(data);
    }

    private actionAddValue(
        data: ScriptActionObject,
        x: number | null,
        y: number | null,
        prefix: string,
    ): void {
        this.actionSetValue({ ...data, operator: '+=' }, x, y, prefix);
    }

    private afterValueChange(data: ScriptActionObject): void {
        if (data.norefresh) return;
        const hero = this.control.ctx.hero;
        if (hero.hp <= 0) {
            hero.hp = 0;
            this.host.onLose?.('');
            return;
        }
        this.host.presenter.update?.();
        this.host.onStatusChange?.();
    }

    private actionSetGlobalValue(data: ScriptActionObject): void {
        this.control.ctx.values[String(data.name)] = data.value;
    }

    /**
     * 毒衰咒的获得与解除（旧 `core.triggerDebuff`）。
     * `kind` 支持单个或数组，`action` 缺省为 `get`。
     */
    private actionTriggerDebuff(data: ScriptActionObject): void {
        const raw = data.kind ?? data.type;
        const kinds = (Array.isArray(raw) ? raw : [raw]) as DebuffType[];
        const action = data.action === 'remove' ? 'remove' : 'get';
        const changed = triggerDebuff(
            this.control.ctx.flags,
            this.control.ctx.hero,
            this.control.ctx.values,
            action,
            kinds,
        );
        if (changed) this.afterValueChange(data);
    }

    private numberById(id: string): number | null {
        for (const [number, element] of Object.entries(this.host.maps)) {
            if (element.id === id) return Number(number);
        }
        return null;
    }

    private setBlockAt(floorId: string, x: number, y: number, raw: unknown): void {
        if (this.host.setBlock) {
            this.host.setBlock(floorId, x, y, raw as number | string);
            return;
        }
        // 与旧 setBlock 一致：字符串要么是纯数字编号，要么是图块 id
        let number: number;
        if (typeof raw === 'string') {
            number = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : (this.numberById(raw) ?? 0);
        } else {
            number = Number(raw) || 0;
        }

        const blocks = this.control.ctx.getBlocks(floorId);
        const event = resolveEvent(this.host.maps, number);
        if (!event) {
            const existing = blockAt(blocks, x, y);
            if (existing) this.control.setBlockDisabled(existing, true, floorId);
            return;
        }
        const block = blockAt(blocks, x, y);
        if (block) {
            block.id = number;
            block.event = event;
            this.control.setBlockDisabled(block, false, floorId);
        } else {
            blocks.push({ x, y, id: number, event });
        }
    }

    private actionSetBlock(
        data: ScriptActionObject,
        x: number | null,
        y: number | null,
        prefix: string,
    ): void {
        const floorId = data.floorId == null ? this.control.ctx.floorId : String(data.floorId);
        for (const [lx, ly] of this.resolveLoc2D(data.loc, x, y, prefix)) {
            this.setBlockAt(floorId, lx, ly, data.number);
        }
    }

    private actionHide(
        data: ScriptActionObject,
        x: number | null,
        y: number | null,
        prefix: string,
    ): void {
        const floorId = data.floorId == null ? this.control.ctx.floorId : String(data.floorId);
        const blocks = this.control.ctx.getBlocks(floorId);
        for (const [lx, ly] of this.resolveLoc2D(data.loc, x, y, prefix)) {
            const block = blockAt(blocks, lx, ly);
            if (block) this.control.setBlockDisabled(block, true, floorId);
        }
    }

    private actionShow(
        data: ScriptActionObject,
        x: number | null,
        y: number | null,
        prefix: string,
    ): void {
        const floorId = data.floorId == null ? this.control.ctx.floorId : String(data.floorId);
        const blocks = this.control.ctx.getBlocks(floorId);
        for (const [lx, ly] of this.resolveLoc2D(data.loc, x, y, prefix)) {
            const block = blockAt(blocks, lx, ly);
            if (block) this.control.setBlockDisabled(block, false, floorId);
        }
    }

    /**
     * 移除图块（旧 `core.removeBlock` / `core.removeBlockByIndexes`）。
     *
     * - `loc`：指定坐标（支持表达式，如 `["nextX()", "nextY()"]`）；
     * - `filter`：按图块属性批量移除，如 `{ "canBreak": true }`（地震卷轴）。
     */
    private actionRemoveBlock(
        data: ScriptActionObject,
        x: number | null,
        y: number | null,
        prefix: string,
    ): void {
        const floorId = data.floorId == null ? this.control.ctx.floorId : String(data.floorId);
        const blocks = this.control.ctx.getBlocks(floorId);
        if (data.filter != null) {
            const filter = (data.filter ?? {}) as Record<string, unknown>;
            for (const block of blocks) {
                if (block.disable) continue;
                if (matchesFilter(block.event, filter)) {
                    this.control.setBlockDisabled(block, true, floorId);
                }
            }
            return;
        }
        for (const [lx, ly] of this.resolveLoc2D(data.loc, x, y, prefix)) {
            const block = blockAt(blocks, lx, ly);
            if (block) this.control.setBlockDisabled(block, true, floorId);
        }
    }

    /**
     * 勇士跳跃到指定位置（旧 `core.jumpHero`）：忽略途中阻挡，动画交给呈现层。
     * 支持 `loc` 绝对坐标与 `dxy` 相对位移。
     */
    private actionJumpHero(
        data: ScriptActionObject,
        _x: number | null,
        _y: number | null,
        prefix: string,
    ): void {
        const hero = this.control.ctx.hero;
        const from: [number, number] = [hero.x, hero.y];
        let to: [number, number];
        if (Array.isArray(data.dxy)) {
            const scope = this.scope();
            to = [
                hero.x + this.evalCoord((data.dxy as unknown[])[0], scope, prefix),
                hero.y + this.evalCoord((data.dxy as unknown[])[1], scope, prefix),
            ];
        } else {
            to = this.resolveHeroLoc(data.loc, prefix);
        }
        hero.x = to[0];
        hero.y = to[1];
        this.host.presenter.effect?.('jumpHero', {
            ...data,
            from,
            to,
            time: data.time ?? 500,
        });
    }

    /* ---------------- 楼层与勇士 ---------------- */

    private changeFloorTo(
        floorId: string | null,
        loc: [number, number] | null,
        direction: string | null,
    ): void {
        // 与旧 `_changeFloor_getInfo` 一致：楼层不存在时整条动作作废（连坐标也不改）
        if (floorId != null && !this.control.ctx.getFloor(floorId)) {
            console.error(`不存在的楼层：${floorId}`);
            return;
        }
        if (this.host.changeFloor) {
            this.host.changeFloor(floorId, loc, direction);
            return;
        }
        const ctx = this.control.ctx;
        if (floorId) ctx.floorId = floorId;
        if (loc) {
            ctx.hero.x = loc[0];
            ctx.hero.y = loc[1];
        }
        if (direction) ctx.hero.direction = direction as Direction;
        this.floorId = ctx.floorId;
    }

    private actionChangeFloor(
        data: ScriptActionObject,
        _x: number | null,
        _y: number | null,
        prefix: string,
    ): void {
        const loc = this.resolveHeroLoc(data.loc, prefix);
        this.changeFloorTo(
            this.resolveFloorRef(data.floorId),
            loc,
            data.direction == null ? null : String(data.direction),
        );
    }

    /**
     * 解析楼层引用：`:now` / `:before` / `:after`（`:next` 同 `:after`）相对当前层，
     * 其余按楼层 id 原样返回；取不到时返回 null（保持原地）。
     */
    private resolveFloorRef(value: unknown): string | null {
        if (value == null) return null;
        const ctx = this.control.ctx;
        const floorIds = ctx.floorIds ?? [ctx.floorId];
        const resolved = resolveFloorId(floorIds, this.floorId ?? ctx.floorId, String(value));
        return resolved;
    }

    private actionChangePos(
        data: ScriptActionObject,
        _x: number | null,
        _y: number | null,
        prefix: string,
    ): void {
        const hero = this.control.ctx.hero;
        if (!data.loc && data.direction) {
            hero.direction = turnDirection(String(data.direction), hero.direction);
            return;
        }
        const [x, y] = this.resolveHeroLoc(data.loc, prefix);
        hero.x = x;
        hero.y = y;
        if (data.direction) hero.direction = turnDirection(String(data.direction), hero.direction);
    }

    /* ---------------- 战斗与交互 ---------------- */

    private actionBattle(
        data: ScriptActionObject,
        x: number | null,
        y: number | null,
        prefix: string,
    ): void {
        if (data.floorId != null && String(data.floorId) !== this.control.ctx.floorId) return;
        let block: Block | undefined;
        if (data.id != null) {
            const id = String(data.id);
            block = this.control.ctx
                .getBlocks(this.control.ctx.floorId)
                .find((one) => one.event.cls.startsWith('enemy') && one.event.id === id);
        } else {
            const [lx, ly] = this.resolveLoc(data.loc, x, y, prefix);
            block = this.control.blockAt(lx, ly);
        }
        if (!block || block.disable || !isEnemy(block.event)) return;
        // 战前剧本：先跑 beforeBattle，再回来打（`skipBeforeBattle` 防止死循环）
        if (!data.skipBeforeBattle) {
            const before = this.host.beforeBattleAt?.(block.x, block.y, block.event.id);
            if (before && before.length > 0) {
                this.insert([
                    ...before,
                    { ...data, skipBeforeBattle: true, loc: [block.x, block.y] },
                ]);
                return;
            }
        }
        const damage = this.control.battle(block);
        if (damage != null) this.host.onAfterBattle?.(block.event.id, block.x, block.y);
        this.host.presenter.update?.();
    }

    /**
     * 开门（旧 `core.openDoor` / `core.removeBlock`）。
     *
     * - `loc`：指定坐标（支持表达式，如 `["nextX()", "nextY()"]`）；
     * - `filter`：批量开门，如 `{ "id": "yellowDoor" }`（大黄门钥匙）；
     * - `needKey`：是否检查并扣除 `doorInfo.keys`。与旧引擎一致，**剧本里的开门默认不扣钥匙**
     *   （旧 `_action_openDoor` 只在 `data.needKey` 为真时扣），勇士撞门触发的那次才扣。
     */
    private actionOpenDoor(
        data: ScriptActionObject,
        x: number | null,
        y: number | null,
        prefix: string,
    ): void {
        const floorId = data.floorId == null ? this.control.ctx.floorId : String(data.floorId);
        const needKey = truthy(data.needKey);
        const sameFloor = floorId === this.control.ctx.floorId;
        for (const block of this.matchedDoors(data, x, y, prefix, floorId)) {
            // 非本层只能标记禁用（本层才谈得上扣钥匙与动画）
            if (needKey && sameFloor) this.control.openDoor(block);
            else this.control.setBlockDisabled(block, true, floorId);
        }
    }

    /** 取 `loc` / `filter` 指定的、可开启的门图块 */
    private matchedDoors(
        data: ScriptActionObject,
        x: number | null,
        y: number | null,
        prefix: string,
        floorId: string,
    ): Block[] {
        const blocks = this.control.ctx.getBlocks(floorId);
        const candidates =
            data.filter != null
                ? blocks.filter((block) =>
                      matchesFilter(block.event, data.filter as Record<string, unknown>),
                  )
                : this.resolveLoc2D(data.loc, x, y, prefix)
                      .map(([lx, ly]) => blockAt(blocks, lx, ly))
                      .filter((block): block is Block => block != null);
        return candidates.filter((block) => !block.disable && isDoor(block.event));
    }

    /** 打开面板（怪物手册 / 楼层传送 / 背包…）；面板本体属于呈现层 */
    private actionOpenPanel(data: ScriptActionObject): void {
        const panel = data.panel ?? data.name;
        if (panel == null) return;
        this.host.presenter.effect?.('openPanel', { ...data, panel: String(panel) });
    }

    /** 触发某个点的系统事件（战斗 / 开门 / 拾取 / 剧本） */
    triggerAt(x: number, y: number): void {
        const block = this.control.blockAt(x, y);
        if (!block || block.disable) return;
        const event = block.event;
        if (isEnemy(event)) {
            const damage = this.control.battle(block);
            if (damage != null) this.host.onAfterBattle?.(event.id, x, y);
            return;
        }
        if (isDoor(event)) {
            this.control.openDoor(block);
            return;
        }
        if (isItem(event)) {
            this.pickUp(block);
            return;
        }
        if (event.trigger === 'changeFloor' && event.data) {
            this.control.changeFloor(block);
            return;
        }
        if (event.data != null) this.insert(event.data as ScriptAction, x, y);
    }

    private actionTrigger(
        data: ScriptActionObject,
        x: number | null,
        y: number | null,
        prefix: string,
    ): void {
        const [lx, ly] = this.resolveLoc(data.loc, x, y, prefix);
        this.triggerAt(lx, ly);
    }

    private pickUp(block: Block): void {
        const item = this.host.items[block.event.id];
        const num = Number(block.event.num) || 1;
        this.control.pickUp(block);
        if (num > 1) addItem(this.control.ctx.hero, block.event.id, num - 1, item?.cls);
        const name = item?.name ?? block.event.id;
        this.host.presenter.tip?.(`获得 ${name}${num > 1 ? `x${num}` : ''}`, block.event.id);
        this.host.onAfterGetItem?.(block.event.id, block.x, block.y);
    }

    /* ---------------- 插入与异步 ---------------- */

    private actionInsert(
        data: ScriptActionObject,
        x: number | null,
        y: number | null,
        prefix: string,
    ): void {
        if (data.name) {
            this.insertCommonEvent(String(data.name), (data.args as unknown[]) ?? []);
            return;
        }
        if (Array.isArray(data.args)) {
            data.args.forEach((value, index) => {
                if (value != null) this.setFlag(`arg${index + 1}`, value);
            });
        }
        const [lx, ly] = this.resolveLoc(data.loc, x, y, prefix);
        this.setFlag('arg0', [lx, ly]);
        const floorId = data.floorId == null ? this.control.ctx.floorId : String(data.floorId);
        const which = String(data.which ?? 'events');
        const floor = this.control.ctx.getFloor(floorId) as unknown as Record<string, unknown>;
        const table = floor[which] as Record<string, unknown> | undefined;
        const event = table?.[`${lx},${ly}`];
        if (event == null) return;
        const payload =
            typeof event === 'object' && event !== null && 'data' in event
                ? ((event as { data?: unknown }).data ?? event)
                : event;
        this.insert(payload as ScriptAction, lx, ly);
    }

    private actionSleep(data: ScriptActionObject): void | 'pause' {
        this.scheduleResume(Number(data.time) || 0);
        return 'pause';
    }

    private actionWait(): void | 'pause' {
        const presenter = this.host.presenter;
        if (!presenter.wait) return;
        presenter.wait(this.resumeFn);
        return 'pause';
    }

    private actionFunction(data: ScriptActionObject): void | 'pause' {
        const fn = data.function;
        const name = typeof fn === 'string' ? fn : null;
        let called: HostFunction | undefined;
        if (typeof fn === 'function') called = fn as HostFunction;
        else if (name) called = this.host.functions?.[name];
        if (called) {
            called.call(this, this);
        } else if (name) {
            console.warn(
                '新引擎不再 eval 剧本里的函数字符串，请在宿主注册函数后使用函数名：',
                name.slice(0, 40),
            );
            this.host.presenter.effect?.('function', data);
        }
        if (!data.async) return;
        return 'pause';
    }

    private actionUpdate(): void {
        this.host.presenter.update?.();
        this.host.onStatusChange?.();
    }

    /* ---------------- 跟随者 ---------------- */

    /**
     * 旧 `events.follow`：增加一个跟随者（图片名）。
     * 没加载过这张图片时不生效（与旧实现一致）。
     */
    private actionFollow(
        data: ScriptActionObject,
        _x: number | null,
        _y: number | null,
        prefix: string,
    ): void {
        const name = replaceText(data.name, this.scope(), prefix);
        if (!name) return;
        const hero = this.control.ctx.hero;
        const followers = (hero.followers ??= []);
        if (followers.some((one) => one.name === name)) return;
        followers.push(createFollower(name, hero));
        gatherFollowers(followers, hero);
        this.host.onFollowerChange?.();
    }

    /** 旧 `events.unfollow`：给名字去掉一个，不给名字则清空全部 */
    private actionUnfollow(
        data: ScriptActionObject,
        _x: number | null,
        _y: number | null,
        prefix: string,
    ): void {
        const hero = this.control.ctx.hero;
        const followers = (hero.followers ??= []);
        if (data.name == null || data.name === '') {
            followers.length = 0;
        } else {
            const name = replaceText(data.name, this.scope(), prefix);
            const index = followers.findIndex((one) => one.name === name);
            if (index >= 0) followers.splice(index, 1);
        }
        gatherFollowers(followers, hero);
        this.host.onFollowerChange?.();
    }

    /* ---------------- 结局 ---------------- */

    private actionWin(
        data: ScriptActionObject,
        _x: number | null,
        _y: number | null,
        prefix: string,
    ): void {
        this.host.onWin?.(
            replaceText(data.reason, this.scope(), prefix),
            Boolean(data.norank),
            Boolean(data.noexit),
        );
        this.stop();
    }

    private actionLose(
        data: ScriptActionObject,
        _x: number | null,
        _y: number | null,
        prefix: string,
    ): void {
        this.host.onLose?.(replaceText(data.reason, this.scope(), prefix));
        this.stop();
    }

    private actionRestart(): void {
        this.host.onRestart?.();
        this.stop();
    }

    private actionExit(): void {
        this.host.onExit?.();
        this.stop();
    }
}
