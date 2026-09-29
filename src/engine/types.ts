import type { Enemys, FloorData, Icons, Items, Maps, TowerData } from '../shared/data/schema';
import type { Follower } from './modules/followers';

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

/** 旧 `hero.statistics`：游戏过程中的累计统计 */
export interface HeroStatistics {
    /** 总游戏时长（毫秒，含未游玩时间） */
    totalTime: number;
    /** 当前游戏时长（毫秒） */
    currTime: number;
    /** 上次开始计时的时间戳 */
    start?: number;
    /** 累计回血数值 */
    hp: number;
    /** 累计击杀怪物数 */
    battle: number;
    /** 累计获得金币 / 经验 */
    money: number;
    exp: number;
    /** 累计伤害：战斗 / 中毒 / 额外 */
    battleDamage: number;
    poisonDamage: number;
    extraDamage: number;
    /** 瞬间移动次数与少走的步数 */
    moveDirectly: number;
    ignoreSteps: number;
}

/** 勇士的数值属性（不含坐标） */
export interface HeroStats {
    hp: number;
    /** 生命上限；缺省时状态栏按当前生命显示 */
    hpmax?: number;
    /** 勇士名（状态栏显示） */
    name?: string;
    /** 魔力与魔力上限（旧 hero.mana / manamax） */
    mana?: number;
    manamax?: number;
    atk: number;
    def: number;
    mdef: number;
    money: number;
    exp: number;
    lv: number;
    steps: number;
    /** 游戏统计（旧 hero.statistics，供统计面板与回血统计使用） */
    statistics?: HeroStatistics;
    items: HeroItems;
    /** 已穿装备，按槽位下标存放；空槽为 null（旧 `hero.equipment`） */
    equipment: (string | null)[];
}

export interface HeroState extends HeroStats {
    x: number;
    y: number;
    direction: Direction;
    /** 跟随者（旧 `hero.followers`）：剧本 `follow` / `unfollow` 增删；normalizeHero 总会补上 */
    followers?: Follower[];
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

/**
 * 存档内容：运行时状态 + 编码后的录像路线。
 * 路线与状态分开存放，便于单独分享 / 播放录像。
 */
export interface SaveData extends GameState {
    route: string;
}
