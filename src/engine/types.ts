import type { FloorData, Icons, Maps, TowerData } from '../shared/data/schema';

export interface RuntimeData {
    tower: TowerData;
    maps: Maps;
    icons: Icons;
    floors: Record<string, FloorData>;
}

export interface HeroState {
    x: number;
    y: number;
}

export type Direction = 'up' | 'down' | 'left' | 'right';

export interface GameState {
    floorId: string;
    hero: HeroState;
    direction?: Direction;
}
