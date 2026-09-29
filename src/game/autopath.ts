/**
 * 自动寻路控制器（旧 `control.setAutomaticRoute` / `stopAutomaticRoute`）。
 *
 * 行为对齐旧版：
 * - 点地图上的格子：先试**单击瞬移**（只穿空白格的通道，旧
 *   `canMoveDirectlyArray`），可行就直接闪过去；否则 BFS 找路，然后自动逐格走；
 * - 点勇士脚下那一格：原地转向（旧 `turnHero`，延迟 250ms 才转，避免误触）；
 * - 已经在走时再点同一个目标：停下去并尝试瞬移（旧「双击瞬移」）；
 * - 走到目标 / 走不通 / 弹出对话框或面板 / 换层，路线自动取消；
 * - 每一步都走 `turns` 的 `direction` token，因此录像与手动操作完全一致
 *   （旧版也是这么记的：自动寻路不写额外 token，只记方向）。
 */
import { TILE } from '../engine/tiles';
import type { MotaRuntime } from '../engine/runtime';
import type { Direction } from '../engine/modules/maps';

export interface AutoRouteHost {
    runtime: MotaRuntime;
    /** 画 / 清路线预览（`#fx` 图层） */
    setRoute(steps: readonly { x: number; y: number }[] | null): void;
    /** 执行一个方向 token（走回合分发器，保证进录像） */
    step(direction: Direction): boolean;
    /** 当前是否处于「不能接管」的状态：对话框打开 / 面板打开 / 读档中 */
    blocked(): boolean;
    /** 走完一步后刷新画面 */
    refresh(): void;
}

export interface AutoRouteOptions {
    /** 每步间隔（毫秒）；缺省读 `values.moveSpeed` */
    interval?: number;
    /** 转向的延迟（毫秒），避免点击与移动冲突 */
    turnDelay?: number;
    /** 现在的时间（毫秒），测试可替换 */
    now?: () => number;
}

export class AutoRoute {
    private destination: { x: number; y: number } | null = null;
    private nextStepAt = 0;
    private pendingTurn: { at: number; x: number; y: number } | null = null;

    constructor(
        private readonly host: AutoRouteHost,
        private readonly options: AutoRouteOptions = {},
    ) {}

    /** 是否正在自动寻路 */
    get active(): boolean {
        return this.destination != null;
    }

    get target(): { x: number; y: number } | null {
        return this.destination;
    }

    private now(): number {
        return this.options.now?.() ?? performance.now();
    }

    private interval(): number {
        const configured = Number(this.host.runtime.data.tower.values.moveSpeed);
        const base = this.options.interval ?? (Number.isFinite(configured) ? configured : 100);
        return Math.max(1, base);
    }

    /**
     * 处理一次地图点击。`tx, ty` 为图块坐标。
     *
     * 返回是否消费了这次点击（消费了就不用再走「点一下继续对话」的默认行为）。
     */
    click(tx: number, ty: number): boolean {
        if (this.host.blocked()) return false;
        const hero = this.host.runtime.state.hero;
        const now = this.now();

        // 点自己：转向（旧 `_setAutomaticRoute_isTurning`，延迟 250ms 判定）
        if (tx === hero.x && ty === hero.y) {
            this.cancel();
            this.pendingTurn = { at: now + (this.options.turnDelay ?? 250), x: tx, y: ty };
            return true;
        }
        this.pendingTurn = null;

        // 已在走向同一目标：停下 + 尝试瞬移（旧「双击瞬移」）
        if (this.destination && this.destination.x === tx && this.destination.y === ty) {
            this.cancel();
            if (this.canMoveDirectly() && this.host.runtime.tryMoveDirectly(tx, ty)) {
                this.host.refresh();
                return true;
            }
            return true;
        }

        // 单击瞬移：路径全是空白格时直接闪过去
        if (this.canMoveDirectly() && this.host.runtime.tryMoveDirectly(tx, ty)) {
            this.cancel();
            this.host.refresh();
            return true;
        }

        // 普通寻路：找路并立即走第一步
        this.destination = { x: tx, y: ty };
        this.nextStepAt = now;
        if (!this.drawRoute()) {
            this.cancel();
            return true;
        }
        return true;
    }

    /** 主循环驱动：到点就走一步 */
    update(): void {
        const now = this.now();
        if (this.pendingTurn && now >= this.pendingTurn.at) {
            this.pendingTurn = null;
            this.host.runtime.turn();
            this.host.refresh();
            return;
        }
        if (!this.destination) return;
        if (this.host.blocked()) {
            // 对话框 / 面板接管时，路线作废（旧版由事件系统 stopAutomaticRoute）
            this.cancel();
            return;
        }
        if (now < this.nextStepAt) return;

        const path = this.host.runtime.findPath(this.destination.x, this.destination.y);
        if (path.length === 0) {
            this.cancel();
            return;
        }
        this.host.setRoute(path);
        const direction = path[0]!.direction;
        this.nextStepAt = now + this.interval();
        if (!this.host.step(direction)) {
            this.cancel();
            return;
        }
        this.host.refresh();
        // 走到目标就收工（下一步的 BFS 会返回空，这里提前清掉预览更跟手）
        const hero = this.host.runtime.state.hero;
        if (hero.x === this.destination.x && hero.y === this.destination.y) this.cancel();
    }

    /** 取消自动寻路并清掉路线预览 */
    cancel(): void {
        this.destination = null;
        this.pendingTurn = null;
        this.host.setRoute(null);
    }

    /** 重画路线预览；走不通时返回 false */
    private drawRoute(): boolean {
        if (!this.destination) return false;
        const path = this.host.runtime.findPath(this.destination.x, this.destination.y);
        if (path.length === 0) return false;
        this.host.setRoute(path);
        return true;
    }

    /** 旧 `_canMoveDirectly_checkGlobal`：是否允许单击瞬移 */
    private canMoveDirectly(): boolean {
        const flags = this.host.runtime.state.flags;
        if (flags.enableMoveDirectly === false || flags.enableMoveDirectly == null) return false;
        if (flags.cannotMoveDirectly === true) return false;
        if (flags.__noClickMove__ === true) return false;
        const floor = this.host.runtime.floor as Record<string, unknown> | undefined;
        return floor?.cannotMoveDirectly !== true;
    }
}

/**
 * 把画布坐标换算成图块坐标；越界返回 null。
 *
 * `displayTile` 是**显示后**的格子边长（`TILE * scale`，见 `layout.ts`）：画布背板
 * 会因为高清缩放而变大，但 CSS 尺寸才是玩家看到的，所以用 CSS 坐标除以显示边长。
 */
export function tileAt(
    canvas: HTMLCanvasElement,
    clientX: number,
    clientY: number,
    displayTile = TILE,
): { x: number; y: number } | null {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    if (clientX < rect.left || clientY < rect.top) return null;
    if (clientX >= rect.left + rect.width || clientY >= rect.top + rect.height) return null;
    const size = displayTile > 0 ? displayTile : TILE;
    const x = Math.floor((clientX - rect.left) / size);
    const y = Math.floor((clientY - rect.top) / size);
    if (x < 0 || y < 0) return null;
    return { x, y };
}
