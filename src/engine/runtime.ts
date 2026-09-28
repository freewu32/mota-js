import type { FloorData } from '../shared/data/schema';
import type { GameState, RuntimeData } from './types';

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

/** 引擎运行时。垂直切片只包含楼层、位置与存档，后续阶段逐步扩展。 */
export class MotaRuntime {
    readonly data: RuntimeData;
    state: GameState;

    private readonly storage: StorageLike | null;

    constructor(data: RuntimeData, storage: StorageLike | null = defaultStorage()) {
        this.data = data;
        this.storage = storage;
        const loc = data.tower.firstData.hero?.loc;
        this.state = {
            floorId: data.tower.firstData.floorId,
            hero: { x: loc?.x ?? 1, y: loc?.y ?? 1 },
        };
    }

    get floor(): FloorData {
        return this.data.floors[this.state.floorId] as FloorData;
    }

    /** 注入给塔作者脚本的 API 骨架 */
    get api() {
        return {
            move: (dx: number, dy: number): void => this.move(dx, dy),
            save: (): boolean => this.save(),
            load: (): boolean => this.load(),
            getState: (): GameState => structuredClone(this.state),
        };
    }

    /** 该格是否可通行：空地、地面与自动元件可走，墙/门/道具/怪物等不可走 */
    canPass(x: number, y: number): boolean {
        const row = this.floor.map[y];
        if (!row || x < 0 || x >= row.length) return false;
        const tileId = row[x] ?? 0;
        if (tileId === 0) return true;
        const element = this.data.maps[String(tileId)];
        if (!element) return false;
        return element.cls === 'terrains' || element.cls === 'autotile';
    }

    move(dx: number, dy: number): void {
        const nx = this.state.hero.x + dx;
        const ny = this.state.hero.y + dy;
        if (!this.canPass(nx, ny)) return;
        if (dy < 0) this.state.direction = 'up';
        else if (dy > 0) this.state.direction = 'down';
        else if (dx < 0) this.state.direction = 'left';
        else if (dx > 0) this.state.direction = 'right';
        this.state.hero.x = nx;
        this.state.hero.y = ny;
        this.tryChangeFloor();
    }

    /** 若当前格配置了楼层切换（楼梯/传送门），则切换到目标楼层与坐标 */
    private tryChangeFloor(): void {
        const key = `${this.state.hero.x},${this.state.hero.y}`;
        const entry = this.floor.changeFloor?.[key];
        if (!entry) return;
        this.state.floorId = entry.floorId;
        const [x, y] = entry.loc ?? [];
        if (x !== undefined && y !== undefined) {
            this.state.hero.x = x;
            this.state.hero.y = y;
        }
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
            this.state = JSON.parse(raw) as GameState;
            return true;
        } catch {
            return false;
        }
    }
}
