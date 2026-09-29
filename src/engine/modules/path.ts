/**
 * 自动寻路（旧 `maps.automaticRoute` / `maps.canMoveDirectlyArray`）。
 *
 * 两个入口对应旧版两种点击行为：
 *
 * - `findPath`：普通寻路。在「勇士能走的格子」上做带权最短路，代价用来绕开
 *   亮灯、路障、血瓶（`__potionNoRouting__`）与伤害点（旧
 *   `_automaticRoute_deepAdd`），权重用整数，等价于 Dijkstra；
 * - `findDirectPath`：单击瞬移（旧 `canMoveDirectlyArray`）。只在「完全空白、
 *   没有图块也没有触发器」的格子上走，允许拐弯，用来判断能否直接闪过去。
 *
 * 两者都不判断终点是否可站立（旧版允许终点是怪物 / 门，走到那里会触发战斗或开门），
 * 只保证路径中途可通行。
 */
import type { FloorData } from '../../shared/data/schema';
import type { Block, BlockEvent, Direction } from './maps';
import { canMoveInDirection, isPassable } from './maps';

export interface PathStep {
    x: number;
    y: number;
    /** 走到该格所用的方向 */
    direction: Direction;
}

export interface PathOptions {
    /** 额外代价（越大越绕路）；返回 0 表示不额外加价 */
    cost?: (x: number, y: number) => number;
    /** 宽度 / 高度，缺省取楼层地图尺寸 */
    width?: number;
    height?: number;
}

const DIRECTIONS: readonly [Direction, number, number][] = [
    ['left', -1, 0],
    ['down', 0, 1],
    ['up', 0, -1],
    ['right', 1, 0],
];

function floorSize(floor: FloorData, options: PathOptions): [number, number] {
    const rows = floor.map ?? [];
    const height = options.height ?? rows.length;
    const width = options.width ?? rows.reduce((max, row) => Math.max(max, row.length), 0);
    return [width, height];
}

/** 取某格的图块（未启用时返回 undefined，等价于旧版 `disable` 判定） */
function eventAt(blocks: readonly Block[], x: number, y: number): BlockEvent | undefined {
    const block = blocks.find((one) => one.x === x && one.y === y);
    if (block?.disable) return undefined;
    return block?.event;
}

/**
 * 普通寻路：返回从 `from` 走到 `to` 的逐步路径（不含起点），走不到返回空数组。
 *
 * 与旧版一致：终点自身是否可通行不参与判断（终点是怪物 / 门时依然会寻路过去），
 * 中途的格子必须能走（`isPassable`）且不受 `cannotMove` / `cannotIn` / `cannotOut` 限制。
 */
export function findPath(
    floor: FloorData,
    blocks: readonly Block[],
    from: { x: number; y: number },
    to: { x: number; y: number },
    options: PathOptions = {},
): PathStep[] {
    if (from.x === to.x && from.y === to.y) return [];
    const [width, height] = floorSize(floor, options);
    if (width <= 0 || height <= 0) return [];
    const at = (x: number, y: number) => eventAt(blocks, x, y);
    const cost = options.cost;

    // 距离表 + 前驱（记录到达该格的方向）
    const key = (x: number, y: number) => y * width + x;
    const dist = new Map<number, number>();
    /** 目标格 index → 前驱格 index 与到达方向（回溯时用） */
    const prev = new Map<number, { from: number; direction: Direction }>();
    const start = key(from.x, from.y);
    dist.set(start, 0);

    // 简单二叉堆（权重为整数，且地图最大几百格，够用）
    const heap: { key: number; x: number; y: number; depth: number }[] = [];
    const push = (item: { key: number; x: number; y: number; depth: number }) => {
        heap.push(item);
        let index = heap.length - 1;
        while (index > 0) {
            const parent = (index - 1) >> 1;
            if (heap[parent]!.depth <= heap[index]!.depth) break;
            [heap[parent], heap[index]] = [heap[index]!, heap[parent]!];
            index = parent;
        }
    };
    const pop = () => {
        const top = heap[0]!;
        const last = heap.pop()!;
        if (heap.length > 0) {
            heap[0] = last;
            let index = 0;
            for (;;) {
                const left = index * 2 + 1;
                const right = left + 1;
                let min = index;
                if (left < heap.length && heap[left]!.depth < heap[min]!.depth) min = left;
                if (right < heap.length && heap[right]!.depth < heap[min]!.depth) min = right;
                if (min === index) break;
                [heap[min], heap[index]] = [heap[index]!, heap[min]!];
                index = min;
            }
        }
        return top;
    };

    push({ key: start, x: from.x, y: from.y, depth: 0 });
    let found = false;
    while (heap.length > 0) {
        const current = pop();
        if (current.depth > (dist.get(current.key) ?? Infinity)) continue;
        if (current.x === to.x && current.y === to.y) {
            found = true;
            break;
        }
        for (const [direction, dx, dy] of DIRECTIONS) {
            const nx = current.x + dx;
            const ny = current.y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            if (!canMoveInDirection(floor, current.x, current.y, dx, dy, at)) continue;
            // 中途格子必须可通行（旧 `noPass`：门 / 怪物 / 墙都会被绕开）；
            // 终点例外：旧版允许寻路到怪物 / 门 / 物品上，走过去触发对应交互
            const isTarget = nx === to.x && ny === to.y;
            const event = at(nx, ny);
            if (!isTarget && !isPassable(event)) continue;
            const next = (current.depth || 0) + 1 + (cost?.(nx, ny) ?? 0);
            const index = key(nx, ny);
            if (next >= (dist.get(index) ?? Infinity)) continue;
            dist.set(index, next);
            prev.set(index, { from: current.key, direction });
            push({ key: index, x: nx, y: ny, depth: next });
        }
    }

    if (!found) return [];
    return backtrack(prev, key(to.x, to.y), start, width);
}

/** 由前驱表回溯出逐步路径（不含起点） */
function backtrack(
    prev: ReadonlyMap<number, { from: number; direction: Direction }>,
    target: number,
    start: number,
    width: number,
): PathStep[] {
    const steps: PathStep[] = [];
    let cursor = target;
    // 地图最多几百格，加个上限防止意外的环导致死循环
    for (let guard = 0; cursor !== start && guard < 100000; guard++) {
        const step = prev.get(cursor);
        if (!step) return [];
        steps.unshift({
            x: cursor % width,
            y: Math.floor(cursor / width),
            direction: step.direction,
        });
        cursor = step.from;
    }
    return steps;
}

/**
 * 单击瞬移（旧 `canMoveDirectlyArray`）：只在「没有图块、没有触发器」的格子上走。
 *
 * 敌人 / 门 / 物品 / 传送点都不可穿越，因此瞬移不会跳过一个怪物直接到它身后。
 */
export function findDirectPath(
    floor: FloorData,
    blocks: readonly Block[],
    from: { x: number; y: number },
    to: { x: number; y: number },
    options: PathOptions = {},
): PathStep[] {
    if (from.x === to.x && from.y === to.y) return [];
    const [width, height] = floorSize(floor, options);
    if (width <= 0 || height <= 0) return [];
    if (to.x < 0 || to.y < 0 || to.x >= width || to.y >= height) return [];
    const at = (x: number, y: number) => eventAt(blocks, x, y);
    const key = (x: number, y: number) => y * width + x;

    const blocked = (x: number, y: number): boolean => {
        const event = at(x, y);
        if (!event) return false;
        // 不可通行、带脚本、带触发器（战斗 / 拾取 / 传送）的格子都不能穿过
        if (!isPassable(event)) return true;
        if (event.trigger) return true;
        if (event.script != null || event.event != null) return true;
        return false;
    };

    const start = key(from.x, from.y);
    const visited = new Set<number>([start]);
    const prev = new Map<number, { from: number; direction: Direction }>();
    const queue: { x: number; y: number }[] = [{ x: from.x, y: from.y }];

    while (queue.length > 0) {
        const current = queue.shift()!;
        for (const [direction, dx, dy] of DIRECTIONS) {
            const nx = current.x + dx;
            const ny = current.y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            if (!canMoveInDirection(floor, current.x, current.y, dx, dy, at)) continue;
            const index = key(nx, ny);
            if (visited.has(index)) continue;
            const isTarget = nx === to.x && ny === to.y;
            if (!isTarget && blocked(nx, ny)) continue;
            visited.add(index);
            prev.set(index, { from: key(current.x, current.y), direction });
            if (isTarget) return backtrack(prev, index, start, width);
            queue.push({ x: nx, y: ny });
        }
    }
    return [];
}
