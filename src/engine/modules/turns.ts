/**
 * 回合串接：把「输入 → 移动 / 使用道具 / 换装 → 剧本事件 / 战斗 → 记录路线」
 * 收敛到一个接口。
 *
 * 对应旧 `libs/control.js` 的 `registerReplayAction` / `_doReplayAction`。
 * 录像 token 是统一的动作描述，键盘/触屏输入、`ReplayController` 回放、
 * 塔作者脚本都走同一个分发器：每个 token 交给已注册的处理器，返回是否处理成功。
 *
 * 记录录像的责任分工：
 * - `move` / `turn` / `item:` / `saveEquip:` / `loadEquip:` / `fly:` 由底层方法
 *   自行记录（与旧实现一致，脚本直接调用也会记）；
 * - `equip:` / `unEquip:` 由本分发器记录，因为换装的底层 API 不负责录像。
 */
import type { MoveResult } from './control';
import type { Direction } from '../types';

/** 处理器返回 true 表示已消费该 token */
export type TurnHandler = (token: string) => boolean;

/**
 * 一次回合的附加结果，供特效 / 音效层使用。
 * 引擎不依赖任何呈现实现，只把发生过的动作广播出去。
 */
export interface TurnOutcome {
    /** 触发的录像 token */
    token: string;
    /** `direction` 处理器产生的移动结果（含战斗伤害） */
    move?: MoveResult;
}

export type TurnOutcomeListener = (outcome: TurnOutcome) => void;

export interface TurnHandlerEntry {
    name: string;
    run: TurnHandler;
    /** 数值越大越先执行；同名注册会覆盖旧项 */
    priority: number;
}

/** 分发器需要的宿主能力，由 `runtime.ts` 注入 */
export interface TurnHost {
    move(dx: number, dy: number): MoveResult | unknown;
    /** 缺省方向表示顺时针转 90 度 */
    turn(direction?: Direction): unknown;
    canUseItem(id: string): boolean;
    useItem(id: string): boolean;
    equip(id: string): boolean;
    unequip(type: number): boolean;
    saveLoadout(index: number): void;
    loadLoadout(index: number): boolean;
    changeFloorTo(floorId: string): boolean;
    /** 打开全局商店（`noRoute` 为真时不重复记录像，供回放使用） */
    openShop(id: string, noRoute: boolean): boolean;
    record(token: string): void;
}

const DIRECTIONS: Record<string, readonly [number, number]> = {
    up: [0, -1],
    down: [0, 1],
    left: [-1, 0],
    right: [1, 0],
};

/** 解析 `name:1:2` 形式的 token，返回数字参数；非法时返回 null */
function parseNumber(token: string, prefixLength: number): number | null {
    const value = parseInt(token.slice(prefixLength), 10);
    return Number.isInteger(value) ? value : null;
}

/**
 * 回合分发器。
 *
 * 内置处理器覆盖引擎当前支持的 token；塔作者 / 插件可用 `register` 追加
 * （如旧 `core.registerReplayAction`），同名即覆盖内置实现。
 */
export class TurnDispatcher {
    private readonly handlers: TurnHandlerEntry[] = [];
    /** 回合结果监听（特效 / 音效层挂在这里，可多个） */
    private readonly listeners = new Set<TurnOutcomeListener>();

    constructor(private readonly host: TurnHost) {
        this.register('direction', (token) => this.onDirection(token));
        this.register('turn', (token) => this.onTurn(token));
        this.register('item', (token) => this.onItem(token));
        this.register('equip', (token) => this.onEquip(token));
        this.register('unEquip', (token) => this.onUnEquip(token));
        this.register('saveEquip', (token) => this.onSaveEquip(token));
        this.register('loadEquip', (token) => this.onLoadEquip(token));
        this.register('fly', (token) => this.onFly(token));
        this.register('shop', (token) => this.onShop(token));
    }

    /** 注册（或覆盖）一个处理器 */
    register(name: string, run: TurnHandler, priority = 0): void {
        this.unregister(name);
        this.handlers.push({ name, run, priority });
        // 优先级高的先执行；同优先级保持注册顺序（Array#sort 稳定）
        this.handlers.sort((a, b) => b.priority - a.priority);
    }

    unregister(name: string): void {
        const index = this.handlers.findIndex((one) => one.name === name);
        if (index >= 0) this.handlers.splice(index, 1);
    }

    has(name: string): boolean {
        return this.handlers.some((one) => one.name === name);
    }

    /** 订阅回合结果，返回取消订阅函数 */
    onOutcome(listener: TurnOutcomeListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emit(outcome: TurnOutcome): void {
        for (const listener of [...this.listeners]) {
            try {
                listener(outcome);
            } catch (error) {
                console.error('回合结果监听出错：', error);
            }
        }
    }

    /** 已注册处理器名（调试用） */
    names(): string[] {
        return this.handlers.map((one) => one.name);
    }

    /**
     * 执行一个录像 token。返回是否被某个处理器消费。
     * 处理器抛错时自动注销该项（对齐旧 `_doReplayAction`），不影响其它处理。
     */
    run(token: unknown): boolean {
        if (typeof token !== 'string' || token.length === 0) return false;
        // 复制一份再遍历：处理器内部可能注销自身
        for (const handler of [...this.handlers]) {
            try {
                if (handler.run(token)) return true;
            } catch (error) {
                console.error(`回合处理器 ${handler.name} 出错，已注销：`, error);
                this.unregister(handler.name);
            }
        }
        return false;
    }

    /* ------------------------------------------------------------------ *
     * 内置处理器
     * ------------------------------------------------------------------ */

    private onDirection(token: string): boolean {
        const delta = DIRECTIONS[token];
        if (!delta) return false;
        const move = this.host.move(delta[0], delta[1]);
        this.emit({ token, move: move as MoveResult });
        return true;
    }

    private onTurn(token: string): boolean {
        if (token === 'turn') {
            this.host.turn();
            return true;
        }
        if (!token.startsWith('turn:')) return false;
        const direction = token.slice(5);
        if (!(direction in DIRECTIONS)) return false;
        this.host.turn(direction as Direction);
        return true;
    }

    private onItem(token: string): boolean {
        if (!token.startsWith('item:')) return false;
        const id = token.slice(5);
        if (!id || !this.host.canUseItem(id)) return false;
        const used = this.host.useItem(id);
        if (used) this.emit({ token });
        return used;
    }

    private onEquip(token: string): boolean {
        if (!token.startsWith('equip:')) return false;
        const id = token.slice(6);
        if (!id || !this.host.equip(id)) return false;
        this.host.record(token);
        this.emit({ token });
        return true;
    }

    private onUnEquip(token: string): boolean {
        if (!token.startsWith('unEquip:')) return false;
        const type = parseNumber(token, 8);
        if (type == null || !this.host.unequip(type)) return false;
        this.host.record(`unEquip:${type}`);
        this.emit({ token });
        return true;
    }

    private onSaveEquip(token: string): boolean {
        if (!token.startsWith('saveEquip:')) return false;
        const index = parseNumber(token, 10);
        if (index == null) return false;
        this.host.saveLoadout(index);
        this.emit({ token });
        return true;
    }

    private onLoadEquip(token: string): boolean {
        if (!token.startsWith('loadEquip:')) return false;
        const index = parseNumber(token, 10);
        if (index == null) return false;
        if (!this.host.loadLoadout(index)) return false;
        this.emit({ token });
        return true;
    }

    private onFly(token: string): boolean {
        if (!token.startsWith('fly:')) return false;
        const floorId = token.slice(4);
        if (floorId.length === 0 || !this.host.changeFloorTo(floorId)) return false;
        this.emit({ token });
        return true;
    }

    private onShop(token: string): boolean {
        if (!token.startsWith('shop:')) return false;
        const id = token.slice(5);
        // 商店本身会把自己记进录像，这里只负责复现（noRoute）
        if (id.length === 0 || !this.host.openShop(id, true)) return false;
        this.emit({ token });
        return true;
    }
}

export function createTurnDispatcher(host: TurnHost): TurnDispatcher {
    return new TurnDispatcher(host);
}
