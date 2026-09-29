/**
 * 值块表达式的内建函数。
 *
 * 旧引擎里这些能力都是 `core` 上的方法（`core.nextX()`、`core.getBlockId(x,y,floorId)`、
 * `core.bigmap.width`、`core.nearStair()` …），塔作者在道具效果/条件里直接调用。
 * 新引擎不再暴露全局 `core`，改为把这批函数注入表达式的求值作用域，
 * 于是「勇士前方一格的图块」这类判断可以纯数据表达：
 *
 * ```json
 * { "canUseItemEffect": "blockCls(nextX(), nextY()) == 'lava'" }
 * ```
 *
 * 只读、无副作用；写操作仍走剧本动作（`removeBlock` / `jumpHero` …）。
 * 宿主注入的同名函数优先（如塔自定义的 `rand`）。
 */
import type { HeroState } from '../types';
import { activeBlocks, blockAt, matchesFilter, type Block } from './maps';
import type { FloorData } from '../../shared/data/schema';

/** 四方向位移（旧 `core.utils.scan`） */
export const DIRECTION_DELTA: Record<string, { x: number; y: number }> = {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
};

/** 视为「楼梯」的图块（旧 `maps.stairExists`） */
const STAIR_IDS = [
    'upFloor',
    'downFloor',
    'leftPortal',
    'rightPortal',
    'upPortal',
    'downPortal',
    'portal',
    'starPortal',
];

export type BuiltinFunction = (...args: unknown[]) => unknown;

/** 内建函数需要的宿主能力 */
export interface BuiltinHost {
    hero: HeroState;
    /** 当前层 id */
    floorId: string;
    /** 楼层顺序（旧 `core.floorIds`） */
    floorIds: string[];
    /** 取某层数据 */
    getFloor(floorId: string): FloorData | undefined;
    /** 怪物数据（供 `enemyAttr` 读取，旧 `core.material.enemys`） */
    enemys: Record<string, unknown>;
    /** 取某层图块（含禁用图块，内部自行过滤） */
    getBlocks(floorId: string): Block[];
}

function toInt(value: unknown, fallback = 0): number {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/**
 * 解析楼层参数。
 *
 * 支持 `:now` / `:before` / `:after`（`:next` 为旧写法，等同 `:after`）与显式楼层 id；
 * 缺省为当前层。与旧 `_changeFloor_getInfo` 一致：相对楼层越界时**停在当前层**，
 * 而不是返回空值。
 */
export function resolveFloorId(
    floorIds: readonly string[],
    current: string,
    value?: unknown,
): string {
    if (value == null || value === '') return current;
    const text = String(value);
    const index = floorIds.indexOf(current);
    if (text === ':now') return current;
    if (text === ':before') return floorIds[index - 1] ?? current;
    if (text === ':after' || text === ':next') return floorIds[index + 1] ?? current;
    return text;
}

export function createBuiltins(host: BuiltinHost): Record<string, BuiltinFunction> {
    /**
     * 解析楼层参数并取出楼层数据；楼层不存在时返回 undefined。
     *
     * 显式传 `null`（如 `floorIdOffset(9)` 越界）一律视为「没有这一层」，
     * 而不是退回当前层，这样 `blockId(x, y, floorIdOffset(1))` 在顶层也安全。
     */
    const floorOf = (floorId?: unknown): FloorData | undefined => {
        if (floorId === null) return undefined;
        return host.getFloor(resolveFloorId(host.floorIds, host.floorId, floorId));
    };

    const blockOn = (x: number, y: number, floorId?: unknown): Block | undefined => {
        const floor = floorOf(floorId);
        if (!floor) return undefined;
        const block = blockAt(host.getBlocks(floor.floorId), x, y);
        return block && !block.disable ? block : undefined;
    };
    const delta = (): { x: number; y: number } =>
        DIRECTION_DELTA[host.hero.direction] ?? { x: 0, y: 0 };

    return {
        // 勇士前方第 n 格（旧 `core.nextX` / `core.nextY`）
        nextX: (n?: unknown) => host.hero.x + delta().x * toInt(n, 1),
        nextY: (n?: unknown) => host.hero.y + delta().y * toInt(n, 1),

        // 地图尺寸（旧 `core.bigmap.width` / `height`）
        mapWidth: (floorId?: unknown) => floorOf(floorId)?.width ?? 0,
        mapHeight: (floorId?: unknown) => floorOf(floorId)?.height ?? 0,

        // 某点的图块（旧 `core.getBlockId` / `getBlockNumber` / `getBlockCls`）
        blockId: (x: unknown, y: unknown, floorId?: unknown) =>
            blockOn(toInt(x), toInt(y), floorId)?.event.id ?? null,
        blockNumber: (x: unknown, y: unknown, floorId?: unknown) =>
            blockOn(toInt(x), toInt(y), floorId)?.id ?? null,
        blockCls: (x: unknown, y: unknown, floorId?: unknown) =>
            blockOn(toInt(x), toInt(y), floorId)?.event.cls ?? null,

        // 某点图块的属性（旧 `core.getBlock(x, y).event.xxx`）
        blockAttr: (x: unknown, y: unknown, attr: unknown, floorId?: unknown) => {
            const block = blockOn(toInt(x), toInt(y), floorId);
            return block?.event[String(attr)] ?? null;
        },

        // 按 id / cls / 属性名统计某层图块数量（旧 `core.searchBlock(...).length`）
        blockCount: (idOrCls: unknown, floorId?: unknown) => {
            const target = String(idOrCls);
            const floor = floorOf(floorId);
            if (!floor) return 0;
            return activeBlocks(host.getBlocks(floor.floorId)).filter(
                (block) =>
                    block.event.id === target ||
                    block.event.cls === target ||
                    matchesFilter(block.event, { [target]: true }),
            ).length;
        },

        // 怪物判定与属性（旧 `block.event.cls.indexOf('enemy') == 0`、`core.material.enemys[id].xxx`）
        isEnemy: (id: unknown) => host.enemys[String(id)] != null,
        enemyAttr: (id: unknown, attr: unknown) => {
            const enemy = host.enemys[String(id)] as Record<string, unknown> | undefined;
            return enemy?.[String(attr)] ?? null;
        },

        // 楼层顺序（旧 `core.floorIds` / `core.status.floorId`）
        floorId: () => host.floorId,
        floorCount: () => host.floorIds.length,
        floorIndex: (floorId?: unknown) => {
            const floor = floorOf(floorId);
            return floor ? host.floorIds.indexOf(floor.floorId) : -1;
        },
        floorIdOffset: (n: unknown, floorId?: unknown) => {
            const floor = floorOf(floorId);
            const index = floor ? host.floorIds.indexOf(floor.floorId) : -1;
            if (index < 0) return null;
            return host.floorIds[index + toInt(n)] ?? null;
        },

        // 是否与楼梯相邻（旧 `core.nearStair`）
        nearStair: (floorId?: unknown) => {
            if (!floorOf(floorId)) return false;
            const stairs = new Set(STAIR_IDS);
            const { x, y } = host.hero;
            return [
                [x, y],
                [x - 1, y],
                [x, y - 1],
                [x + 1, y],
                [x, y + 1],
            ].some(([bx, by]) => {
                const block = blockOn(bx as number, by as number, floorId);
                return block != null && stairs.has(block.event.id);
            });
        },
    };
}
