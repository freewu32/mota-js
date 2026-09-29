/**
 * 动作、路线与录像模块。
 *
 * 迁移自旧引擎的三块逻辑：
 * - `libs/utils.js` 的 `encodeRoute` / `decodeRoute`：录像路线序列化；
 * - `libs/control.js` 的录像播放状态机（`startReplay` / `replay` /
 *   `pauseReplay` / `speedUpReplay` / `rewindReplay` …）；
 * - `libs/actions.js` 的 `registerAction` 交互扩展点。
 *
 * 旧实现把状态挂在全局 `core.status.replay` / `core.status.route` 上，
 * 新引擎改为显式的 `ReplayController` / `RouteRecorder`，图块 id ↔ 编号
 * 映射通过选项注入（见 `routeCodecFor`）。交互回调不再绑定全局单例。
 */

import type { Maps } from '../../shared/data/schema';
import { idByNumber, numberById } from './maps';

/** 录像路线的每一步：`up` / `item:yellowKey` / `choices:0` / `move:3:4` … */
export type RouteToken = string;
export type Route = RouteToken[];

////// 交互行为注册 //////

export type RegisteredActionFunc = (...args: unknown[]) => unknown;

interface RegisteredActionEntry {
    action: string;
    name: string;
    func: RegisteredActionFunc;
    priority: number;
}

/**
 * 旧 `libs/actions.js` 的 `registerAction` / `unregisterAction` /
 * `doRegisteredAction`：插件注册鼠标 / 键盘交互的扩展点。
 * 同名重复注册时后者覆盖前者，优先级高的先执行，返回 true 则中止后续。
 */
export class RegisteredActions {
    private table: Record<string, RegisteredActionEntry[]> = {};

    register(action: string, name: string, func: RegisteredActionFunc, priority = 0): void {
        if (!name || !func) return;
        const key = action === 'onclick' ? 'ondown' : action;
        this.unregister(key, name);
        const list = (this.table[key] ??= []);
        list.push({ action: key, name, func, priority });
        list.sort((a, b) => b.priority - a.priority);
    }

    unregister(action: string, name: string): void {
        const key = action === 'onclick' ? 'ondown' : action;
        const list = this.table[key];
        if (!list) return;
        this.table[key] = list.filter((entry) => entry.name !== name);
    }

    /** 依次调用注册的函数，任一返回真值即中止并返回 true */
    do(action: string, ...args: unknown[]): boolean {
        const list = this.table[action];
        if (!list) return false;
        for (const entry of list) {
            try {
                if (entry.func(...args)) return true;
            } catch (error) {
                console.error(error);
                console.error(`ERROR in actions[${entry.name}].`);
            }
        }
        return false;
    }
}

////// 录像折叠与路线记录 //////

/** 旧 `_bindRoutePush` 中被忽略的（不打断折叠的）操作 */
const FOLDING_IGNORED: ReadonlySet<RouteToken> = new Set(['up', 'down', 'left', 'right', 'turn']);

export interface FoldingEntry {
    /** 勇士数值属性的稳定序列化 */
    hero: string;
    length: number;
}

function heroFingerprint(hero: Record<string, number>): string {
    return Object.keys(hero)
        .sort()
        .map((key) => `${key}=${hero[key]}`)
        .join(',');
}

/**
 * 旧 `core.status.route` 的替代。录像折叠（`checkRouteFolding`）会回到
 * 勇士状态相同的更早节点并截断录像，是长录像体积优化的关键。
 */
export class RouteRecorder {
    route: Route = [];
    folding: Record<string, FoldingEntry> = {};

    /** 记录一步；非移动/转向操作会清空折叠信息 */
    record(token: RouteToken): void {
        if (!FOLDING_IGNORED.has(token) && !token.startsWith('move:')) this.clearFolding();
        this.route.push(token);
    }

    get length(): number {
        return this.route.length;
    }

    /** 旧 `route.pop()`：撤销最后一步（用于取消操作） */
    undo(): RouteToken | undefined {
        return this.route.pop();
    }

    replaceLast(token: RouteToken): void {
        this.route[this.route.length - 1] = token;
    }

    last(): RouteToken {
        return this.route[this.route.length - 1] ?? '';
    }

    clearFolding(): void {
        this.folding = {};
    }

    /**
     * 旧 `checkRouteFolding`：若回到「同名同坐标同朝向且数值一致」的更早
     * 节点，则把录像截断回该长度。`enabled` 对应 `flags.enableRouteFolding`。
     */
    checkFolding(
        hero: Record<string, number>,
        x: number,
        y: number,
        direction: string,
        enabled: boolean,
    ): void {
        if (!enabled) {
            this.clearFolding();
            return;
        }
        const fingerprint = heroFingerprint(hero);
        const index = `${x},${y},${direction.charAt(0)}`;
        const one = this.folding[index];
        if (one && one.hero === fingerprint && one.length < this.route.length) {
            for (const key of Object.keys(this.folding)) {
                const entry = this.folding[key] as FoldingEntry;
                if (entry.length >= one.length) delete this.folding[key];
            }
            this.route = this.route.slice(0, one.length);
        }
        this.folding[index] = { hero: fingerprint, length: this.route.length };
    }
}

////// 录像路线序列化 //////

export interface RouteCodecOptions {
    /** 图块 id → 地图编号（旧 `maps.getNumberById`），未知返回 0 */
    idToNumber?: (id: string) => number;
    /** 地图编号 → 图块 id（旧 `_decodeRoute_number2id`） */
    numberToId?: (number: string | number) => string;
    /** 压缩路线文本，默认 base64(UTF-8) */
    compress?: (text: string) => string;
    /** 解压路线文本，默认 base64(UTF-8) */
    decompress?: (text: string) => string;
}

/** 用某张地图的图块表构造编解码选项 */
export function routeCodecFor(maps: Maps): RouteCodecOptions {
    return {
        idToNumber: (id) => numberById(maps, id),
        numberToId: (number) => idByNumber(maps, number),
    };
}

/** 压缩后的路线文本前缀，用于把「已压缩」与「明文路线」区分开 */
export const ROUTE_CODEC_TAG = 'mota-route-v1:';

export function base64Encode(text: string): string {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

export function base64Decode(text: string): string {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
}

function defaultCompress(text: string): string {
    return ROUTE_CODEC_TAG + base64Encode(text);
}

function defaultDecompress(text: string): string {
    if (!text.startsWith(ROUTE_CODEC_TAG)) throw new Error('not a compressed route');
    return base64Decode(text.slice(ROUTE_CODEC_TAG.length));
}

const DIRECTION_CODES: Record<string, string> = { up: 'U', down: 'D', left: 'L', right: 'R' };
const CODE_DIRECTIONS: Record<string, string> = { U: 'up', D: 'down', L: 'left', R: 'right' };

/** 旧 `_encodeRoute_id2number`：编号为 0 时退回 id 本身 */
function idToCode(id: string, options: RouteCodecOptions): string {
    const number = options.idToNumber?.(id) ?? 0;
    return number === 0 ? id : String(number);
}

function encodeRouteToken(token: string, options: RouteCodecOptions): string {
    if (token.startsWith('item:')) return `I${idToCode(token.slice(5), options)}:`;
    if (token.startsWith('unEquip:')) return `u${token.slice(8)}`;
    if (token.startsWith('equip:')) return `e${idToCode(token.slice(6), options)}:`;
    if (token.startsWith('saveEquip:')) return `s${token.slice(10)}`;
    if (token.startsWith('loadEquip:')) return `l${token.slice(10)}`;
    if (token.startsWith('fly:')) return `F${token.slice(4)}:`;
    if (token === 'choices:none') return 'c';
    if (token.startsWith('choices:')) return `C${token.slice(8)}`;
    if (token.startsWith('shop:')) return `S${token.slice(5)}:`;
    if (token === 'turn') return 'T';
    if (token.startsWith('turn:')) {
        return `t${token.slice(5).charAt(0).toUpperCase()}:`;
    }
    if (token === 'getNext') return 'G';
    if (token === 'input:none') return 'p';
    if (token.startsWith('input:')) return `P${token.slice(6)}`;
    if (token.startsWith('input2:')) return `Q${token.slice(7)}:`;
    if (token === 'no') return 'N';
    if (token.startsWith('move:')) return `M${token.slice(5)}`;
    if (token.startsWith('key:')) return `K${token.slice(4)}`;
    if (token.startsWith('click:')) return `k${token.slice(6)}`;
    if (token.startsWith('random:')) return `X${token.slice(7)}`;
    return `(${token})`;
}

/** 旧 `encodeRoute`：连续同向移动合并为 `U3` 形式，再整体压缩 */
export function encodeRoute(route: readonly RouteToken[], options: RouteCodecOptions = {}): string {
    const compress = options.compress ?? defaultCompress;
    let ans = '';
    let lastMove = '';
    let count = 0;

    const flush = (): void => {
        if (count === 0) return;
        ans += DIRECTION_CODES[lastMove];
        if (count > 1) ans += count;
        count = 0;
    };

    for (const token of route) {
        if (DIRECTION_CODES[token]) {
            if (token !== lastMove && count > 0) flush();
            lastMove = token;
            count++;
        } else {
            flush();
            ans += encodeRouteToken(token, options);
        }
    }
    flush();

    return compress(ans);
}

interface DecodeState {
    route: string;
    index: number;
    ans: Route;
}

/** 旧 `_decodeRoute_getNumber`：无数字时默认 1 */
function decodeGetNumber(state: DecodeState): number {
    let num = '';
    let first = true;
    for (;;) {
        const ch = state.route.charAt(state.index);
        if (ch >= '0' && ch <= '9') num += ch;
        else if (ch === '-' && first) num += ch;
        else break;
        first = false;
        state.index++;
    }
    if (num.length === 0) num = '1';
    return parseInt(num, 10);
}

/** 旧 `_decodeRoute_getString`：读到 `:` 为止并跳过该分隔符 */
function decodeGetString(state: DecodeState): string {
    let str = '';
    while (state.index < state.route.length && state.route.charAt(state.index) !== ':') {
        str += state.route.charAt(state.index);
        state.index++;
    }
    state.index++;
    return str;
}

/** `I` / `e` / `F` / `S` / `Q` / `t` 的参数是字符串，其余是数字 */
const STRING_CODES: ReadonlySet<string> = new Set(['I', 'e', 'F', 'S', 'Q', 't']);

function decodeRouteToken(state: DecodeState, code: string, options: RouteCodecOptions): void {
    // 自定义项：原样保留括号内内容
    if (code === '(') {
        const end = state.route.indexOf(')', state.index);
        if (end >= 0) {
            state.ans.push(state.route.substring(state.index, end));
            state.index = end + 1;
            return;
        }
    }

    const numberToId = options.numberToId ?? ((number: string | number) => String(number));
    const nxt: string | number = STRING_CODES.has(code)
        ? decodeGetString(state)
        : decodeGetNumber(state);

    switch (code) {
        case 'U':
        case 'D':
        case 'L':
        case 'R': {
            const direction = CODE_DIRECTIONS[code] as string;
            for (let i = 0; i < (nxt as number); i++) state.ans.push(direction);
            break;
        }
        case 'I':
            state.ans.push(`item:${numberToId(nxt as string)}`);
            break;
        case 'u':
            state.ans.push(`unEquip:${nxt}`);
            break;
        case 'e':
            state.ans.push(`equip:${numberToId(nxt as string)}`);
            break;
        case 's':
            state.ans.push(`saveEquip:${nxt}`);
            break;
        case 'l':
            state.ans.push(`loadEquip:${nxt}`);
            break;
        case 'F':
            state.ans.push(`fly:${nxt}`);
            break;
        case 'c':
            state.ans.push('choices:none');
            break;
        case 'C':
            state.ans.push(`choices:${nxt}`);
            break;
        case 'S':
            state.ans.push(`shop:${nxt}`);
            break;
        case 'T':
            state.ans.push('turn');
            break;
        case 't':
            state.ans.push(`turn:${CODE_DIRECTIONS[String(nxt).toUpperCase()]}`);
            break;
        case 'G':
            state.ans.push('getNext');
            break;
        case 'p':
            state.ans.push('input:none');
            break;
        case 'P':
            state.ans.push(`input:${nxt}`);
            break;
        case 'Q':
            state.ans.push(`input2:${nxt}`);
            break;
        case 'N':
            state.ans.push('no');
            break;
        case 'M':
            state.index++;
            state.ans.push(`move:${nxt}:${decodeGetNumber(state)}`);
            break;
        case 'K':
            state.ans.push(`key:${nxt}`);
            break;
        case 'k': {
            state.index++;
            const px = decodeGetNumber(state);
            state.index++;
            const py = decodeGetNumber(state);
            state.ans.push(`click:${nxt}:${px}:${py}`);
            break;
        }
        case 'X':
            state.ans.push(`random:${nxt}`);
            break;
    }
}

/**
 * 旧 `decodeRoute`：先尝试解压（带 `ROUTE_CODEC_TAG` 标记），再逐字符
 * 解析；解压失败时按明文路线处理。旧 LZString 压缩的录像不再支持。
 */
export function decodeRoute(
    route: string | null | undefined,
    options: RouteCodecOptions = {},
): Route {
    if (!route) return [];

    const decompress = options.decompress ?? defaultDecompress;
    let payload = route;
    try {
        const value = decompress(route);
        payload = value;
    } catch {
        // 非压缩文本：按原文解析
    }

    const state: DecodeState = { route: payload, index: 0, ans: [] };
    while (state.index < state.route.length) {
        // 先消费当前字符，参数从下一个位置开始读（对齐旧实现）
        const code = state.route.charAt(state.index);
        state.index++;
        decodeRouteToken(state, code, options);
    }
    return state.ans;
}

/** 旧 `utils.subarray`：`b` 是 `a` 的前缀时返回剩余部分，否则 null */
export function subarray<T>(a: readonly T[], b: readonly T[]): T[] | null {
    if (!(a instanceof Array) || !(b instanceof Array) || a.length < b.length) return null;
    for (let i = 0; i < b.length; i++) {
        if (a[i] !== b[i]) return null;
    }
    return a.slice(b.length);
}

////// 录像播放 //////

/** 旧 `setHeroMoveInterval` 中使用的播放倍速档位 */
export const REPLAY_SPEEDS = [0.2, 0.5, 1, 2, 3, 6, 12, 24];

export interface ReplaySnapshot<T = unknown> {
    data: T;
    totalList: Route;
    toReplay: Route;
    steps: number;
}

export interface ReplayState<T = unknown> {
    replaying: boolean;
    pausing: boolean;
    failed: boolean;
    speed: number;
    toReplay: Route;
    totalList: Route;
    steps: number;
    save: ReplaySnapshot<T>[];
}

export interface ReplayHost<T = unknown> {
    /** 游戏是否进行中（未结算）；默认 true */
    isPlaying?(): boolean;
    /** 是否正在移动或处理事件（此时不能恢复 / 回退）；默认 false */
    isBusy?(): boolean;
    /** 取当前存档快照，用于回退节点 */
    snapshot?(): T;
    /** 提示文本（原 `drawTip`） */
    onTip?(text: string): void;
}

export function createReplayState<T = unknown>(): ReplayState<T> {
    return {
        replaying: false,
        pausing: false,
        failed: false,
        speed: 1,
        toReplay: [],
        totalList: [],
        steps: 0,
        save: [],
    };
}

/** 旧 `__replay_getTimeout`：播放帧间隔毫秒数，24 倍速立即执行 */
export function replayTimeout(speed: number): number {
    if (speed === 24) return 0;
    return 750 / Math.max(1, speed);
}

/**
 * 旧 `setHeroMoveInterval`：移动动画的 tick 间隔与每次推进量。
 * 累计推进到 8 即走完一格（24 倍速时直接到位，由调用方特殊处理）。
 */
export function replayMoveTiming(
    speed: number,
    moveSpeed: number,
): { interval: number; step: number } {
    let step = 1;
    if (speed > 3) step = 2;
    if (speed > 6) step = 4;
    if (speed > 12) step = 8;
    return { interval: ((moveSpeed / 8) * step) / Math.max(speed, 1), step };
}

/**
 * 录像播放状态机。动作的实际执行由调用方完成：
 * `next()` 取出下一个待播放操作，执行成功后再调用 `next()`；
 * 失败调用 `fail()`，播放完毕调用 `finish(route)`。
 */
export class ReplayController<T = unknown> {
    readonly state: ReplayState<T> = createReplayState<T>();

    constructor(private readonly host: ReplayHost<T> = {}) {}

    get replaying(): boolean {
        return this.state.replaying;
    }

    get pending(): number {
        return this.state.toReplay.length;
    }

    get total(): number {
        return this.state.totalList.length;
    }

    /** 旧 `startReplay`：以当前路线为前缀，开始播放剩余操作 */
    start(list: readonly RouteToken[], route: readonly RouteToken[] = []): boolean {
        if (!this.isPlaying()) return false;
        this.state.replaying = true;
        this.state.pausing = true;
        this.state.failed = false;
        this.state.speed = 1;
        this.state.toReplay = [...list];
        this.state.totalList = [...route, ...list];
        this.state.steps = 0;
        this.state.save = [];
        this.host.onTip?.('开始播放');
        return true;
    }

    /** 旧 `triggerReplay`：在暂停与恢复之间切换 */
    toggle(): boolean {
        return this.state.pausing ? this.resume() : this.pause();
    }

    /** 旧 `pauseReplay` */
    pause(): boolean {
        if (!this.replaying) return false;
        this.state.pausing = true;
        this.host.onTip?.('暂停播放');
        return true;
    }

    /** 旧 `resumeReplay` */
    resume(): boolean {
        if (!this.replaying) return false;
        if (this.isBusy()) {
            this.host.onTip?.('请等待当前事件的处理结束');
            return false;
        }
        this.state.pausing = false;
        this.host.onTip?.('恢复播放');
        return true;
    }

    /** 旧 `setReplaySpeed` */
    setSpeed(speed: number): boolean {
        if (!this.replaying) return false;
        this.state.speed = speed;
        this.host.onTip?.(`x${speed}倍`);
        return true;
    }

    /** 旧 `speedUpReplay`：返回新的倍速 */
    speedUp(): number {
        for (let i = REPLAY_SPEEDS.length - 2; i >= 0; i--) {
            const current = REPLAY_SPEEDS[i] as number;
            if (current <= this.state.speed) {
                this.state.speed = REPLAY_SPEEDS[i + 1] as number;
                break;
            }
        }
        this.host.onTip?.(`x${this.state.speed}倍`);
        return this.state.speed;
    }

    /** 旧 `speedDownReplay`：返回新的倍速 */
    speedDown(): number {
        for (let i = 1; i < REPLAY_SPEEDS.length; i++) {
            const current = REPLAY_SPEEDS[i] as number;
            if (current >= this.state.speed) {
                this.state.speed = REPLAY_SPEEDS[i - 1] as number;
                break;
            }
        }
        this.host.onTip?.(`x${this.state.speed}倍`);
        return this.state.speed;
    }

    /** 旧 `stopReplay` */
    stop(force = false): boolean {
        if (!this.replaying && !force) return false;
        Object.assign(this.state, createReplayState<T>());
        return true;
    }

    /**
     * 旧 `replay`：取出下一个待播放操作。返回 null 表示当前不可播放；
     * `force` 对应旧实现的单步播放（忽略暂停）。
     */
    next(force = false): RouteToken | null {
        if (!this.isPlaying() || !this.replaying || this.state.failed || this.isBusy()) return null;
        if (this.state.pausing && !force) return null;
        if (this.state.toReplay.length === 0) {
            this.finish();
            return null;
        }
        this.saveNode();
        return this.state.toReplay.shift() ?? null;
    }

    /** 旧 `_replay_error`：操作无法执行 */
    fail(): void {
        this.state.replaying = false;
        this.state.failed = true;
    }

    /** 旧 `_replay_finished`：播放结束，返回路线记录是否一致 */
    finish(currentRoute: readonly RouteToken[] = []): boolean {
        const consistent = this.isConsistent(currentRoute);
        this.state.replaying = false;
        this.state.failed = false;
        return consistent;
    }

    /** 旧 `_replay_finished` 里的一致性判断 */
    isConsistent(currentRoute: readonly RouteToken[]): boolean {
        if (currentRoute.length !== this.state.totalList.length) return false;
        return subarray(currentRoute, this.state.totalList) != null;
    }

    progress(): { done: number; total: number; percent: number } {
        const total = this.state.totalList.length;
        const done = total - this.state.toReplay.length;
        return { done, total, percent: total === 0 ? 0 : (done / total) * 100 };
    }

    /** 旧 `rewindReplay`：回到上一个节点，返回该节点快照 */
    rewind(): ReplaySnapshot<T> | null {
        if (!this.replaying || !this.state.pausing || this.isBusy()) return null;
        const node = this.state.save.pop();
        if (!node) return null;
        this.state.toReplay = [...node.toReplay];
        this.state.totalList = [...node.totalList];
        this.state.steps = node.steps;
        return node;
    }

    /** 旧 `_replay_save`：每 40 步保存一个回退节点，最多保留 30 个 */
    private saveNode(): void {
        this.state.steps++;
        if (this.state.steps % 40 !== 1) return;
        if (this.state.save.length === 30) this.state.save.shift();
        this.state.save.push({
            data: this.host.snapshot?.() as T,
            totalList: [...this.state.totalList],
            toReplay: [...this.state.toReplay],
            steps: this.state.steps,
        });
    }

    private isPlaying(): boolean {
        return this.host.isPlaying?.() ?? true;
    }

    private isBusy(): boolean {
        return this.host.isBusy?.() ?? false;
    }
}
