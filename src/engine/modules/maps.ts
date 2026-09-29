/**
 * 图块模型。
 *
 * 迁移自旧 `libs/maps.js` 的 extractBlocks / initBlock。旧引擎把地图数组
 * 展开成 blocks 列表，并把剧本事件（events）、楼层转换（changeFloor）挂到
 * 对应格子上；战斗、开门、拾取物品都作用在 block.event 上。
 */
import type { FloorData, MapElement, Maps } from '../../shared/data/schema';
import { TILESET_START_OFFSET } from '../tiles';

export interface BlockEvent extends MapElement {
    trigger?: string;
    data?: unknown;
    enable?: boolean;
    opacity?: number;
    noPass?: boolean;
    canPass?: boolean;
    [key: string]: unknown;
}

export interface Block {
    x: number;
    y: number;
    id: number;
    event: BlockEvent;
    disable?: boolean;
}

/** 旧约定的空气墙编号：存在但不可见、不可通行 */
const AIRWALL_ID = 17;

/**
 * 与旧 `initBlock` 一致：若无 noPass 则按 canPass 或 cls（items 可通行）推导，
 * 推导后删除 canPass，使 BlockEvent 与旧运行时形状一致。
 */
function finalizeNoPass(event: BlockEvent): BlockEvent {
    if (event.noPass == null) {
        if (event.canPass == null) event.noPass = event.cls !== 'items';
        else event.noPass = !event.canPass;
    }
    delete event.canPass;
    return event;
}

/** 解析地图编号为图块事件；空地（0）返回 null，未知编号回退为 none */
export function resolveEvent(maps: Maps, number: number): BlockEvent | null {
    if (number === 0) return null;
    if (number === AIRWALL_ID) {
        return finalizeNoPass({
            cls: 'terrains',
            id: 'airwall',
            cannotIn: ['up', 'down', 'left', 'right'],
        });
    }
    const element = maps[String(number)];
    if (element) return finalizeNoPass({ ...element });
    if (number >= TILESET_START_OFFSET) return finalizeNoPass({ cls: 'tileset', id: `X${number}` });
    return finalizeNoPass({ cls: 'terrains', id: 'none', noPass: false });
}

/**
 * 旧 `maps.getNumberById`：图块 id → 地图编号。
 * 用于录像里的 `item:<id>` / `equip:<id>` 压缩为编号；未知返回 0（即 none）。
 */
export function numberById(maps: Maps, id: string): number {
    for (const key of Object.keys(maps)) {
        if (maps[key]?.id === id) return parseInt(key, 10) || 0;
    }
    if (/^X\d+$/.test(id)) return parseInt(id.slice(1), 10);
    if (id === 'airwall') return AIRWALL_ID;
    return 0;
}

/**
 * 旧 `_decodeRoute_number2id`：地图编号 → 图块 id。
 * 仅纯数字编号会查表，其余原样返回。
 */
export function idByNumber(maps: Maps, number: string | number): string {
    const key = String(number);
    if (/^\d+$/.test(key)) {
        const element = maps[key];
        if (element) return element.id;
    }
    return key;
}

/** 是否包含某个方向（cannotIn / cannotOut / cannotMove 等数组字段） */
export function includesDirection(value: unknown, direction: string): boolean {
    return Array.isArray(value) && value.includes(direction);
}

const OPPOSITE: Record<string, Direction> = {
    up: 'down',
    down: 'up',
    left: 'right',
    right: 'left',
};

export type Direction = 'up' | 'down' | 'left' | 'right';

/** 位移对应的方向名；非单步位移返回 null */
export function directionOf(dx: number, dy: number): Direction | null {
    if (dx === 0 && dy === -1) return 'up';
    if (dx === 0 && dy === 1) return 'down';
    if (dx === -1 && dy === 0) return 'left';
    if (dx === 1 && dy === 0) return 'right';
    return null;
}

/**
 * 旧 `_canMoveHero_checkPoint` 的方向限制（不含越界与死领域检查）：
 * 当前点 cannotMove、下一点 cannotMoveIn、当前素材 cannotOut、下一素材 cannotIn。
 */
export function canMoveInDirection(
    floor: FloorData,
    x: number,
    y: number,
    dx: number,
    dy: number,
    eventAt: (x: number, y: number) => BlockEvent | undefined,
): boolean {
    const direction = directionOf(dx, dy);
    if (!direction) return false;
    const back = OPPOSITE[direction];
    const nx = x + dx;
    const ny = y + dy;

    const cannotMove = (floor as Record<string, unknown>).cannotMove as
        Record<string, unknown> | undefined;
    if (includesDirection(cannotMove?.[`${x},${y}`], direction)) return false;

    const cannotMoveIn = (floor as Record<string, unknown>).cannotMoveIn as
        Record<string, unknown> | undefined;
    if (includesDirection(cannotMoveIn?.[`${nx},${ny}`], back)) return false;

    if (includesDirection(eventAt(x, y)?.cannotOut, direction)) return false;
    if (includesDirection(eventAt(nx, ny)?.cannotIn, back)) return false;

    return true;
}

/** 图块是否可通行；优先 noPass，其次 canPass，最后等价于旧实现的 cls 推导 */
export function isPassable(event: BlockEvent | null | undefined): boolean {
    if (!event) return true;
    if (event.noPass != null) return !event.noPass;
    if (event.canPass != null) return !!event.canPass;
    return event.cls === 'items';
}

/** 是否为一扇可开启的门（animates/npc48 且带 doorInfo） */
export function isDoor(event: BlockEvent): boolean {
    return event.doorInfo != null && typeof event.doorInfo === 'object';
}

/** 是否为敌人：cls 以 enemy 开头（enemys / enemy48） */
export function isEnemy(event: BlockEvent): boolean {
    return typeof event.cls === 'string' && event.cls.startsWith('enemy');
}

/** 是否为可拾取物品 */
export function isItem(event: BlockEvent): boolean {
    return event.cls === 'items';
}

export interface ExtractOptions {
    /** 判断某格是否已禁用（例如存档中记录的门已被打开）；返回 undefined 表示无信息 */
    isDisabled?: (x: number, y: number) => boolean | undefined;
}

/** 已提醒过的「带 script 字段的图块」，避免同一次游玩里反复刷控制台 */
const scriptWarned = new Set<string>();

/**
 * 旧塔会把一段 JS 存在图块属性里（`block.event.script`），踩上去时 `eval` 执行。
 * 3.0 不做 `eval`，这类图块不会生效（样板的血网 / 毒网 / 衰网 / 咒网 / 光源就是），
 * 这里只提醒一次，避免迁移后惄惄惄地丢功能。
 */
function warnUnsupportedScript(floorId: string, x: number, y: number, id: string): void {
    const key = `${floorId}@${x},${y}`;
    if (scriptWarned.has(key)) return;
    scriptWarned.add(key);
    console.warn(
        `[mota] 图块 ${id}（${floorId} ${x},${y}）带有旧版的 script 字段，3.0 不会执行它` +
            '（无 eval）。请把这段逻辑改写成数据 / 钩子，见 _docs/script3.md 的「图块脚本与 checkBlock」。',
    );
}

/** 剧本事件可写成字符串、事件数组或对象；统一为对象形式 */
function normalizeScriptEvent(raw: unknown): BlockEvent | undefined {
    if (raw == null) return undefined;
    if (typeof raw === 'string') return { data: [raw] } as BlockEvent;
    if (Array.isArray(raw)) return { data: raw } as BlockEvent;
    if (typeof raw === 'object') return raw as BlockEvent;
    return undefined;
}

/**
 * 把一层的地图数组展开为 blocks。与旧实现一致：
 * - 非空格子生成 block；
 * - 空格子若挂了剧本事件/changeFloor 也会生成；
 * - 剧本事件字段覆盖地图项字段；changeFloor 以 trigger 形式追加。
 */
export function extractBlocks(floor: FloorData, maps: Maps, options: ExtractOptions = {}): Block[] {
    const blocks: Block[] = [];
    const rows = floor.map;

    for (let y = 0; y < rows.length; y++) {
        const row = rows[y];
        if (!row) continue;
        for (let x = 0; x < row.length; x++) {
            const number = row[x] ?? 0;
            const base = resolveEvent(maps, number);
            const scriptEvent = normalizeScriptEvent((floor.events ?? {})[`${x},${y}`]);
            const changeFloor = floor.changeFloor?.[`${x},${y}`];

            if (!base && !scriptEvent && !changeFloor) continue;

            const event: BlockEvent = {
                ...(base ?? { cls: 'terrains', id: 'none', noPass: false }),
            };
            // 对等于旧 _addInfo：敌人/物品在无 trigger 时自动获得系统触发器
            if (event.trigger == null) {
                if (isEnemy(event)) event.trigger = 'battle';
                else if (event.cls === 'items') event.trigger = 'getItem';
            }
            if (scriptEvent) {
                // 与旧 _addEvent 一致：只合并非 null 字段，enable/animate/opacity/filter 特殊处理
                const source = scriptEvent as Record<string, unknown>;
                for (const key of Object.keys(source)) {
                    if (
                        key === 'enable' ||
                        key === 'animate' ||
                        key === 'opacity' ||
                        key === 'filter'
                    ) {
                        continue;
                    }
                    const value = source[key];
                    if (value == null) continue;
                    (event as Record<string, unknown>)[key] = value;
                }
                // 有剧本数据且未指定触发方式时，默认为 action
                if (event.trigger == null && scriptEvent.data != null) event.trigger = 'action';
            }
            if (changeFloor) {
                event.trigger = 'changeFloor';
                event.data = changeFloor;
            }

            const disabled =
                options.isDisabled?.(x, y) ??
                (scriptEvent?.enable != null ? !scriptEvent.enable : undefined);
            if (typeof event.script === 'string' && event.script.length > 0) {
                warnUnsupportedScript(floor.floorId, x, y, event.id ?? String(event.cls));
            }
            const block: Block = { x, y, id: number, event };
            if (disabled != null) block.disable = disabled;
            if (scriptEvent?.opacity != null) block.event.opacity = scriptEvent.opacity;

            if (block.id !== 0 || event.trigger) blocks.push(block);
        }
    }

    return blocks;
}

export function blockAt(blocks: readonly Block[], x: number, y: number): Block | undefined {
    return blocks.find((b) => b.x === x && b.y === y);
}

/** 移除图块（标记禁用，保留在列表中以供存档） */
export function removeBlock(blocks: Block[], x: number, y: number): Block | undefined {
    const block = blockAt(blocks, x, y);
    if (block) block.disable = true;
    return block;
}

export function activeBlocks(blocks: readonly Block[]): Block[] {
    return blocks.filter((b) => !b.disable);
}

/** 当前层的敌人图块 id（用于支援、光环等遍历） */
export function enemyBlocks(blocks: readonly Block[]): Block[] {
    return activeBlocks(blocks).filter((b) => isEnemy(b.event));
}

/**
 * 图块属性过滤（`removeBlock` / `openDoor` 的 `filter` 与 `blockCount` 共用）。
 *
 * 值为 `true` 时按「属性为真」匹配（`{ "canBreak": true }`），
 * 否则按「属性相等」匹配（`{ "id": "yellowDoor" }`）。
 */
export function matchesFilter(event: BlockEvent, filter: Record<string, unknown>): boolean {
    return Object.entries(filter).every(([key, value]) =>
        value === true ? Boolean(event[key]) : event[key] === value,
    );
}
