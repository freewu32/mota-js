import type { Enemys, FloorData, Icons, Items, Maps, TowerData } from '../shared/data/schema';

export interface RuntimeData {
    tower: TowerData;
    maps: Maps;
    icons: Icons;
    enemys: Enemys;
    items: Items;
    floors: Record<string, FloorData>;
}

export type Direction = 'up' | 'down' | 'left' | 'right';

/** 勇士背包。与旧数据一致，分为常数、道具、装备三类 */
export interface HeroItems {
    constants: Record<string, number>;
    tools: Record<string, number>;
    equips: Record<string, number>;
}

/** 勇士的数值属性（不含坐标） */
export interface HeroStats {
    hp: number;
    atk: number;
    def: number;
    mdef: number;
    money: number;
    exp: number;
    lv: number;
    steps: number;
    items: HeroItems;
    equipment: string[];
}

export interface HeroState extends HeroStats {
    x: number;
    y: number;
    direction: Direction;
}

export interface GameState {
    floorId: string;
    hero: HeroState;
    /**
     * 运行时 flag。塔的全局 flags 是初始值，运行时在其之上叠加：
     * - `__<name>_buff__`：属性增幅（装备、衰弱等）
     * - `poison` / `weak` / `curse`：毒衰咒状态
     * - `__block_<floorId>_<x>_<y>__`：被移除的图块
     */
    flags: Record<string, unknown>;
}
