import type { FloorData } from '../shared/data/schema';
import { MotaControl, type ControlContext, type MoveResult } from './modules/control';
import { extractBlocks, type Block } from './modules/maps';
import { getStatusOrDefault } from './modules/status';
import type { GameState, HeroState, RuntimeData } from './types';

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

    return {
        x: num(loc.x, 1),
        y: num(loc.y, 1),
        direction: (loc.direction as HeroState['direction']) ?? 'up',
        hp: num(source.hp),
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
        equipment: Array.isArray(source.equipment) ? [...(source.equipment as string[])] : [],
    };
}

/** 引擎运行时：持有塔数据、游戏状态与存档。 */
export class MotaRuntime {
    readonly data: RuntimeData;
    state: GameState;

    private readonly storage: StorageLike | null;
    private readonly control: MotaControl;
    private readonly blockCache: Record<string, Block[]> = {};

    constructor(data: RuntimeData, storage: StorageLike | null = defaultStorage()) {
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
            getFloor: (id) => this.data.floors[id] as FloorData,
            getBlocks: (id) => this.getBlocks(id),
        };
        this.control = new MotaControl(ctx);
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

    /** 注入给塔作者脚本的 API 骨架 */
    get api() {
        return {
            move: (dx: number, dy: number): void => void this.move(dx, dy),
            save: (): boolean => this.save(),
            load: (): boolean => this.load(),
            getState: (): GameState => structuredClone(this.state),
        };
    }

    /** 该格是否可通行 */
    canPass(x: number, y: number): boolean {
        return this.control.canPass(x, y);
    }

    /** 单步移动/交互；返回动作描述 */
    move(dx: number, dy: number): MoveResult {
        const result = this.control.move(dx, dy);
        // control 内可能切换楼层，这里同步回运行时状态
        this.state.floorId = this.control.ctx.floorId;
        if (result.moved) this.state.hero.steps += 1;
        return result;
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
        this.storage.setItem(SAVE_KEY, JSON.stringify(this.state));
        return true;
    }

    load(): boolean {
        if (!this.storage) return false;
        const raw = this.storage.getItem(SAVE_KEY);
        if (!raw) return false;
        try {
            const parsed = JSON.parse(raw) as GameState;
            this.state = parsed;
            // 重新绑定 control 的可变引用
            this.control.ctx.hero = parsed.hero;
            this.control.ctx.floorId = parsed.floorId;
            this.control.ctx.flags = parsed.flags;
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
