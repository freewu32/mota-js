/**
 * 图块移动动画（旧 `core.moveBlock` / `libs/maps.js` 的 `moveBlock`）。
 *
 * 剧本里的 `{ type: 'move', loc: [x, y], steps: ['right:2', 'down:1'], time: 750 }`
 * 走的就是这里：起点图块**立刻**从地图上消失，随后按 `steps` 逐格移动（每格 `time`
 * 毫秒），结束时 `keep` 为真就落在终点，否则淡出消失（样板里的小偷就是淡出跑掉）。
 *
 * 本模块只维护「正在移动的图块」与计时，绘制交给呈现层；`update` 由运行时每帧驱动，
 * 因此不依赖 DOM，可以无头测试。
 */
import type { MapElement } from '../../shared/data/schema';
import { TILE } from '../tiles';

/** 旧 `utils.scan2` 里图块移动支持的方向 */
export type MoveDirection =
    'up' | 'down' | 'left' | 'right' | 'leftup' | 'leftdown' | 'rightup' | 'rightdown';

const MOVE_OFFSETS: Record<MoveDirection, readonly [number, number]> = {
    up: [0, -1],
    down: [0, 1],
    left: [-1, 0],
    right: [1, 0],
    leftup: [-1, -1],
    leftdown: [-1, 1],
    rightup: [1, -1],
    rightdown: [1, 1],
};

/** 每格分 16 个小步，每个小步走 2 像素（旧 `moveInfo.step` / `px += 2`） */
const SUB_STEPS = 16;
const SUB_PIXELS = 2;
/** 淡出速度（旧 `_moveJumpBlock_finished` 每个小步 -0.06） */
const FADE_STEP = 0.06;
/** 单帧最多补算多少个已过去的小步（长时间掉帧时避免卡死） */
const MAX_TICKS_PER_FRAME = 600;
/** `time` 缺省值（旧 `time = time || 500`） */
const DEFAULT_TIME = 500;

/** 解析后的一个步伐令牌 */
export type MoveToken =
    { kind: 'move'; direction: MoveDirection; count: number } | { kind: 'speed'; count: number };

export interface MovingBlock {
    /** 所属楼层（`keep` 落地时用） */
    floorId: string;
    /** 绘制用的图块元素 */
    element: MapElement;
    /** 结束时重建图块用的地图编号（`keep`） */
    number: number;
    /** 起点（旧 `sx / sy`） */
    from: { x: number; y: number };
    /** 当前像素位置（旧 `px / py`） */
    px: number;
    py: number;
    /** 剩余步伐 */
    steps: MoveToken[];
    /** 当前格内已完成的小步数（0..16） */
    step: number;
    /** 每个小步的毫秒数（旧 `per_time` = `time / 16`） */
    perStep: number;
    opacity: number;
    keep: boolean;
    /** 尚未消耗的时间（毫秒） */
    elapsed: number;
    /** 动画结束后回调：非 `async` 的 `move` 动作据此让事件流继续 */
    done?: () => void;
}

export interface MovingBlockHost {
    /** 取起点图块；已被移除 / 不存在时返回 null（旧 `_getAndRemoveBlock`） */
    takeBlock(
        x: number,
        y: number,
        floorId: string,
    ): { element: MapElement; number: number } | null;
    /** 立刻把起点图块从地图上移除（旧 `core.removeBlock`） */
    removeBlock(x: number, y: number, floorId: string): void;
    /** `keep` 时在终点落地（旧 `setBlock` + `showBlock`） */
    placeBlock(number: number, x: number, y: number, floorId: string): void;
}

/**
 * 解析 `steps`：`'right:2'` → 右移两格；未知方向（含 `forward` / `backward`，
 * 旧版没有 `faceIds` 时同样会被丢掉）忽略；`speed:16` 改变每格用时。
 */
export function parseMoveSteps(steps: unknown): MoveToken[] {
    if (!Array.isArray(steps)) return [];
    const out: MoveToken[] = [];
    for (const raw of steps) {
        const [name, countText] = String(raw).split(':');
        if (name === 'speed') {
            const count = Number.parseInt(countText ?? '0', 10);
            // 旧版只接受不小于 16ms 的速度令牌
            if (Number.isFinite(count) && count >= 16) out.push({ kind: 'speed', count });
            continue;
        }
        if (name == null || !(name in MOVE_OFFSETS)) continue;
        const parsed = countText == null || countText === '' ? 1 : Number.parseInt(countText, 10);
        out.push({
            kind: 'move',
            direction: name as MoveDirection,
            count: Number.isFinite(parsed) ? parsed : 1,
        });
    }
    return out;
}

/** 正在移动的图块集合 */
export class MovingBlocks {
    private items: MovingBlock[] = [];

    constructor(private readonly host: MovingBlockHost) {}

    /** 绘制用列表（只含尚未结束的图块） */
    get list(): readonly MovingBlock[] {
        return this.items;
    }

    get size(): number {
        return this.items.length;
    }

    /**
     * 开始移动（旧 `core.moveBlock`）。起点没有图块时直接回调并返回 false。
     *
     * `steps` 里只有 `speed` 或不含可行步伐时，图块会原地淡出（与旧版一致）。
     */
    start(
        x: number,
        y: number,
        steps: unknown,
        time = DEFAULT_TIME,
        keep = false,
        floorId = '',
        done?: () => void,
    ): boolean {
        const taken = this.host.takeBlock(x, y, floorId);
        if (!taken) {
            done?.();
            return false;
        }
        this.host.removeBlock(x, y, floorId);
        const duration = Number(time);
        const perStep = Math.max(
            1,
            (Number.isFinite(duration) && duration > 0 ? duration : DEFAULT_TIME) / SUB_STEPS,
        );
        this.items.push({
            floorId,
            element: taken.element,
            number: taken.number,
            from: { x, y },
            px: x * TILE,
            py: y * TILE,
            steps: parseMoveSteps(steps),
            step: 0,
            perStep,
            opacity: 1,
            keep,
            elapsed: 0,
            done,
        });
        return true;
    }

    /** 每帧推进；返回这一帧是否有变化（需要重绘） */
    update(dt: number): boolean {
        if (this.items.length === 0) return false;
        if (!(dt > 0)) return true;
        const remaining: MovingBlock[] = [];
        let changed = false;
        for (const move of this.items) {
            move.elapsed += dt;
            let finished = false;
            let guard = 0;
            while (!finished && move.elapsed >= move.perStep && guard < MAX_TICKS_PER_FRAME) {
                guard += 1;
                move.elapsed -= move.perStep;
                finished = this.tick(move);
            }
            changed = true;
            if (finished) this.finish(move);
            else remaining.push(move);
        }
        this.items = remaining;
        return changed;
    }

    /** 换层 / 读档 / 重开：丢弃进行中的移动；`resume` 为真时让等待中的事件流继续 */
    clear(resume = true): void {
        const dropped = this.items;
        this.items = [];
        if (!resume) return;
        for (const move of dropped) move.done?.();
    }

    /** 一个小步（旧 `setInterval(per_time)` 的回调）；返回 true 表示动画结束 */
    private tick(move: MovingBlock): boolean {
        const first = move.steps[0];
        // `speed` 令牌只在整格开始时生效（旧 `_moveBlock_updateSpeed`）
        if (first?.kind === 'speed') {
            move.steps.shift();
            if (move.step === 0) move.perStep = Math.max(1, first.count / SUB_STEPS);
            return false;
        }
        if (move.steps.length === 0) {
            // 走完：`keep` 直接落地，否则淡出（旧 `_moveJumpBlock_finished`）
            move.opacity = move.keep ? 0 : move.opacity - FADE_STEP;
            return move.opacity <= 0;
        }
        if (move.step === 0) {
            const token = move.steps[0]!;
            // `left:0` 这类只转向不移动的令牌（3.0 没有朝向帧，直接跳过）
            if (token.count <= 0) {
                move.steps.shift();
                return false;
            }
        }
        const token = move.steps[0]!;
        if (token.kind !== 'move') return false;
        const [dx, dy] = MOVE_OFFSETS[token.direction];
        move.step += 1;
        move.px += dx * SUB_PIXELS;
        move.py += dy * SUB_PIXELS;
        if (move.step >= SUB_STEPS) {
            move.step = 0;
            token.count -= 1;
            if (token.count <= 0) move.steps.shift();
        }
        return false;
    }

    private finish(move: MovingBlock): void {
        if (move.keep) {
            // 终点取像素位置的最近格（旧版按 `moveInfo.x / y` 累加同一结果）
            const x = Math.round(move.px / TILE);
            const y = Math.round(move.py / TILE);
            this.host.placeBlock(move.number, x, y, move.floorId);
        }
        move.done?.();
    }
}
