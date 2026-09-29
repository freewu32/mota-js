/**
 * 楼层生命周期事件。
 *
 * 旧 towers 把 `firstArrive` / `eachArrive` / `autoEvent` / `afterBattle` 等回调写在
 * `project/functions.js` 的 `eventdata` 里，靠塔作者自己维护、靠 `function` 字符串 eval。
 * 编辑器本来就会把这些字段写进楼层数据，新方案把它们提升为**引擎内建的数据字段**，
 * 直接读取、不再需要 eval：
 *
 * - `firstArrive` / `eachArrive`：抵达楼层时执行（首次 / 每次），对应旧
 *   `functions.js` 的 `afterChangeFloor`；
 * - `afterBattle` / `afterGetItem` / `afterOpenDoor`：按 `"x,y"` 索引的位置事件；
 * - `autoEvent`：自动事件，条件成立即执行一次（或每次），对应旧 `checkAutoEvents`。
 *
 * 本模块只产出「要执行什么」，事件流的执行交给 `events.ts`。
 */
export interface AutoEvent {
    /** 稳定标识，用于「执行中 / 已执行」标记（旧 `floorId@x@y@index`） */
    symbol: string;
    floorId: string;
    x: number | null;
    y: number | null;
    index: number;
    condition: unknown;
    data: unknown;
    /** true 表示只在本层触发 */
    currentFloor: boolean;
    /** true 表示可重复触发 */
    multiExecute: boolean;
    /** true 表示排在当前事件流之后执行 */
    delayExecute: boolean;
    priority: number;
}

export interface FloorEventsHost {
    floorIds: readonly string[];
    /** 当前楼层 id */
    floorId(): string;
    getFloor(floorId: string): Record<string, unknown> | undefined;
    /** 插入一段事件（旧 `insertAction`） */
    insert(actions: unknown, x?: number | null, y?: number | null): void;
    /** 求值 autoEvent 的 condition */
    evaluate(condition: unknown, prefix: string): boolean;
    getFlag(name: string, fallback: unknown): unknown;
    setFlag(name: string, value: unknown): void;
}

/** 位置事件类型 */
export type PositionEventType = 'afterBattle' | 'afterGetItem' | 'afterOpenDoor';

/** 取出楼层的某个动作字段；非数组 / 空数组返回 null */
function actionList(value: unknown): unknown[] | null {
    if (value == null) return null;
    const list = Array.isArray(value) ? value : [value];
    return list.length > 0 ? list : null;
}

/**
 * 抵达楼层的动作列表：`firstArrive` 在 `eachArrive` 之前
 * （旧实现是先 `insertAction(eachArrive)` 再 `insertAction(firstArrive)`，后插入的先执行）。
 */
export function arriveActions(
    floor: Record<string, unknown> | undefined,
    first: boolean,
): unknown[] {
    if (!floor) return [];
    const result: unknown[] = [];
    if (first) result.push(...(actionList(floor.firstArrive) ?? []));
    result.push(...(actionList(floor.eachArrive) ?? []));
    return result;
}

/**
 * 位置事件的动作列表。字段值可以是动作数组，也可以是
 * `{ data: [...], disableOnGentleClick: true }`（旧编辑器的写法）。
 */
export function positionActions(
    floor: Record<string, unknown> | undefined,
    type: PositionEventType,
    x: number,
    y: number,
): unknown[] {
    if (!floor) return [];
    const table = floor[type];
    if (table == null || typeof table !== 'object') return [];
    const value = (table as Record<string, unknown>)[`${x},${y}`];
    if (value == null) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === 'object' && 'data' in (value as Record<string, unknown>)) {
        return actionList((value as Record<string, unknown>).data) ?? [];
    }
    return [value];
}

/** 收集全塔的自动事件（旧 `core.initStatus.autoEvents`），按优先级 / 楼层 / 坐标排序 */
export function collectAutoEvents(
    floorIds: readonly string[],
    getFloor: (floorId: string) => Record<string, unknown> | undefined,
): AutoEvent[] {
    const result: AutoEvent[] = [];
    for (const floorId of floorIds) {
        const floor = getFloor(floorId);
        const table = floor?.autoEvent;
        if (table == null || typeof table !== 'object') continue;
        for (const [loc, entries] of Object.entries(table as Record<string, unknown>)) {
            if (entries == null || typeof entries !== 'object') continue;
            const [rawX, rawY] = loc.split(',');
            const x = Number.parseInt(rawX ?? '', 10);
            const y = Number.parseInt(rawY ?? '', 10);
            for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
                if (value == null || typeof value !== 'object') continue;
                const one = value as Record<string, unknown>;
                if (one.condition == null || one.data == null) continue;
                const index = Number.parseInt(key, 10);
                result.push({
                    symbol: `${floorId}@${x}@${y}@${key}`,
                    floorId,
                    x: Number.isInteger(x) ? x : null,
                    y: Number.isInteger(y) ? y : null,
                    index: Number.isInteger(index) ? index : 0,
                    condition: one.condition,
                    data: one.data,
                    currentFloor: one.currentFloor === true,
                    multiExecute: one.multiExecute === true,
                    delayExecute: one.delayExecute === true,
                    priority: typeof one.priority === 'number' ? one.priority : 0,
                });
            }
        }
    }
    return result.sort((a, b) => {
        if (a.priority !== b.priority) return b.priority - a.priority;
        if (a.floorId !== b.floorId) {
            return floorIds.indexOf(a.floorId) - floorIds.indexOf(b.floorId);
        }
        if (a.x !== b.x) return (a.x ?? 0) - (b.x ?? 0);
        if (a.y !== b.y) return (a.y ?? 0) - (b.y ?? 0);
        return a.index - b.index;
    });
}

/**
 * 楼层生命周期调度。
 *
 * 「执行中 / 已执行」标记沿用旧旗标名（`__aei__` / `__aed__`），
 * 这样存档与旧行为一致，也能被塔作者的脚本读取。
 */
export class FloorEvents {
    readonly autoEvents: AutoEvent[];

    constructor(private readonly host: FloorEventsHost) {
        this.autoEvents = collectAutoEvents(host.floorIds, (id) => host.getFloor(id));
    }

    /** 抵达楼层：执行 firstArrive / eachArrive */
    arrive(floorId: string, first: boolean): void {
        const actions = arriveActions(this.host.getFloor(floorId), first);
        if (actions.length > 0) this.host.insert(actions);
    }

    /** 位置事件：战斗 / 拾取 / 开门后 */
    after(type: PositionEventType, x: number, y: number): void {
        const actions = positionActions(this.host.getFloor(this.host.floorId()), type, x, y);
        if (actions.length > 0) this.host.insert(actions, x, y);
    }

    /** 自动事件检查（旧 `core.checkAutoEvents`），由主循环每帧调用 */
    checkAutoEvents(): void {
        const todos: unknown[] = [];
        const delayed: unknown[] = [];
        for (const autoEvent of this.autoEvents) {
            if (autoEvent.currentFloor && autoEvent.floorId !== this.host.floorId()) continue;
            if (!autoEvent.multiExecute && this.executed(autoEvent.symbol)) continue;
            if (this.executing(autoEvent.symbol)) continue;
            if ((this.host.getFlag('__removed__', []) as string[]).includes(autoEvent.floorId)) {
                continue;
            }
            const prefix = `${autoEvent.floorId}@${autoEvent.x}@${autoEvent.y}`;
            let hit: boolean;
            try {
                hit = this.host.evaluate(autoEvent.condition, prefix);
            } catch {
                hit = false;
            }
            if (!hit) continue;

            this.executing(autoEvent.symbol, true);
            this.executed(autoEvent.symbol, true);

            const reset = { type: 'autoEventReset', symbol: autoEvent.symbol };
            const wrapped: unknown[] = [
                { type: 'dowhile', condition: 'false', data: autoEvent.data },
                reset,
            ];
            if (autoEvent.delayExecute) delayed.push(...wrapped);
            else todos.push(...wrapped);
        }
        const all = [...todos, ...delayed];
        if (all.length > 0) this.host.insert(all);
    }

    /** 清除「执行中」标记（`autoEventReset` 动作调用） */
    clearExecuting(symbol: string): void {
        if (symbol) this.executing(symbol, false);
    }

    private executing(symbol: string, value?: boolean): boolean {
        return this.symbolFlag('__aei__', symbol, value);
    }

    private executed(symbol: string, value?: boolean): boolean {
        return this.symbolFlag('__aed__', symbol, value);
    }

    private symbolFlag(name: string, symbol: string, value?: boolean): boolean {
        const list = [...((this.host.getFlag(name, []) as string[]) ?? [])];
        if (value == null) return list.includes(symbol);
        const filtered = list.filter((one) => one !== symbol);
        if (value) filtered.push(symbol);
        this.host.setFlag(name, filtered);
        return value;
    }
}
