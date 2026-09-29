/**
 * 勇士操作与地图交互。
 *
 * 迁移自旧 `libs/control.js` / `libs/events.js` 的移动、开门、拾取与战斗。
 * 这里只实现引擎内置规则；道具效果、战前/战后剧本等由后续脚本 API 注入。
 */
import type { FloorData, Maps } from '../../shared/data/schema';
import type { HeroState } from '../types';
import {
    getDamageInfo,
    getDamageString,
    getEnemyInfo,
    hasSpecial,
    nextCriticals,
    type BattleContext,
    type EnemyData,
} from './enemys';
import {
    blockAt,
    canMoveInDirection,
    isDoor,
    isEnemy,
    isItem,
    isPassable,
    type Block,
} from './maps';
import { addStatus, hasFlag, setFlag, triggerDebuff, type DebuffType } from './status';
import { updateFollowers } from './followers';
import type { ScriptAction } from './events';

/**
 * 道具数据。
 *
 * 旧数据里的 `itemEffect` 等字段是 JS 字符串（由 `eval` 执行），新格式改为：
 * - 效果为剧本动作列表（`events.ts` 的动作词汇）；
 * - 条件为表达式字符串（`values.ts` 求值）；
 * - 提示文本支持 `${表达式}` 插值。
 */
export interface ItemData {
    cls?: string;
    name?: string;
    text?: string;
    /** 拾取即生效的效果（`cls: 'items'`） */
    itemEffect?: unknown;
    /** 拾取提示文本 */
    itemEffectTip?: string;
    /** 使用时执行的效果 */
    useItemEffect?: unknown;
    /** 使用后追加的剧本 */
    useItemEvent?: unknown;
    /** 能否使用 / 能否装备的条件表达式 */
    canUseItemEffect?: string;
    /** 装备属性 */
    equip?: Record<string, unknown>;
    [key: string]: unknown;
}

export type ItemClass = 'constants' | 'tools' | 'equips';

export interface ControlContext {
    maps: Maps;
    values: Record<string, unknown>;
    flags: Record<string, unknown>;
    enemys: Record<string, EnemyData>;
    items: Record<string, ItemData>;
    hero: HeroState;
    floorId: string;
    /** 楼层顺序（旧 `core.floorIds`）；缺省时视为只有当前一层 */
    floorIds?: string[];
    /** 取得某层数据 */
    getFloor(floorId: string): FloorData;
    /** 取得某层可变的 block 列表 */
    getBlocks(floorId: string): Block[];
    /**
     * 某位置的战前剧本（楼层 `beforeBattle["x,y"]` 与怪物自己的 `beforeBattle`）。
     * 返回**扁平**的动作列表；非空时本次碰怪不会立即开打，
     * 而是先执行这段剧本再执行 `battle` 动作。
     */
    beforeBattleAt?: (x: number, y: number, enemyId: string) => ScriptAction[] | null;
    /**
     * 拾取「即捡即用类」道具的处理（由 `items.ts` 注入）。
     * 返回 true 表示效果已就地生效、道具不进入背包。
     */
    itemEffects?: ItemEffectRunner;
}

/** 交给道具模块处理拾取效果的最小接口，避免 control 反向依赖 items */
export interface ItemEffectRunner {
    /** 即捡即用类道具拾取时的效果；返回是否已就地生效 */
    runPickUpEffect(id: string, count?: number): boolean;
    /** 拾取提示文本（旧 `getItemEffectTip`） */
    effectTip(id: string): string;
}

const INVENTORY_KEYS: ItemClass[] = ['constants', 'tools', 'equips'];

/** 道具类别归一：旧数据的 items 分为 constants/tools/equips */
export function itemBag(cls: string | undefined): ItemClass {
    if (cls === 'constants') return 'constants';
    if (cls === 'equips') return 'equips';
    return 'tools';
}

export function itemCount(hero: HeroState, id: string): number {
    return INVENTORY_KEYS.reduce((sum, key) => sum + (hero.items[key][id] ?? 0), 0);
}

export function addItem(hero: HeroState, id: string, count = 1, cls?: string): void {
    const bag = itemBag(cls);
    hero.items[bag][id] = (hero.items[bag][id] ?? 0) + count;
}

/**
 * 删除道具；数量不足时不做任何改动。
 * 与旧 `removeItem` 一致：减到 0 或以下就从背包里删掉这一项。
 */
export function removeItem(hero: HeroState, id: string, count = 1): boolean {
    if (itemCount(hero, id) < count) return false;
    let left = count;
    for (const key of INVENTORY_KEYS) {
        const have = hero.items[key][id] ?? 0;
        if (have === 0) continue;
        const take = Math.min(have, left);
        const rest = have - take;
        if (rest <= 0) delete hero.items[key][id];
        else hero.items[key][id] = rest;
        left -= take;
        if (left === 0) break;
    }
    return true;
}

export type MoveAction = 'none' | 'move' | 'door' | 'item' | 'battle' | 'floor' | 'event';

export interface MoveResult {
    moved: boolean;
    action: MoveAction;
    x: number;
    y: number;
    /** 战斗伤害（仅 action === 'battle'） */
    damage?: number;
    /** 拾取提示（仅 action === 'item'，如「生命+100」） */
    tip?: string;
    /**
     * 本次碰怪被战前剧本推迟了（`before` 为要先生效的剧本），
     * 由运行时插入「战前剧本 + battle」而不是现在就结算。
     */
    deferred?: boolean;
    before?: ScriptAction[];
}

export class MotaControl {
    constructor(readonly ctx: ControlContext) {}

    get floor(): FloorData {
        return this.ctx.getFloor(this.ctx.floorId);
    }

    get blocks(): Block[] {
        return this.ctx.getBlocks(this.ctx.floorId);
    }

    blockAt(x: number, y: number): Block | undefined {
        return blockAt(this.blocks, x, y);
    }

    battleContext(): BattleContext {
        return {
            hero: this.ctx.hero,
            flags: this.ctx.flags,
            values: this.ctx.values,
            blocks: this.blocks,
            enemyOf: (id) => this.ctx.enemys[id],
            hasItem: (id) => itemCount(this.ctx.hero, id) > 0,
            haloCache: new Map(),
        };
    }

    /** 目标格是否可通行：越界/墙/门/怪不可；空地、物品、显式 canPass 的地形可 */
    canPass(x: number, y: number): boolean {
        const row = this.floor.map[y];
        if (!row || x < 0 || x >= row.length) return false;
        const block = this.blockAt(x, y);
        if (block && !block.disable) return isPassable(block.event);
        return true;
    }

    private facing(dx: number, dy: number): void {
        if (dy < 0) this.ctx.hero.direction = 'up';
        else if (dy > 0) this.ctx.hero.direction = 'down';
        else if (dx < 0) this.ctx.hero.direction = 'left';
        else if (dx > 0) this.ctx.hero.direction = 'right';
    }

    /** 向目标方向移动/交互 */
    move(dx: number, dy: number): MoveResult {
        const x = this.ctx.hero.x + dx;
        const y = this.ctx.hero.y + dy;
        this.facing(dx, dy);

        // 越界不可移动
        const row = this.floor.map[y];
        if (y < 0 || !row || x < 0 || x >= row.length) {
            return { moved: false, action: 'none', x, y };
        }

        // 旧 canMoveHero：cannotMove / cannotMoveIn / cannotIn / cannotOut
        const canStep = canMoveInDirection(
            this.floor,
            this.ctx.hero.x,
            this.ctx.hero.y,
            dx,
            dy,
            (px, py) => {
                const b = this.blockAt(px, py);
                return b && !b.disable ? b.event : undefined;
            },
        );
        if (!canStep) {
            return { moved: false, action: 'none', x, y };
        }

        const block = this.blockAt(x, y);
        if (block && !block.disable) {
            // 只有 `trigger: 'openDoor'` 的门才在碰撞时开启（旧 `core.trigger` →
            // `doSystemEvent('openDoor')`）。墙 / 冰 / 暗墙同样带 `doorInfo`，
            // 但 trigger 为空：它们要靠破墙镐 / 破冰镐的 `useItemEffect`
            // （旧版同样是走进墙里什么都不发生）。
            if (isDoor(block.event) && block.event.trigger === 'openDoor') {
                const opened = this.openDoor(block);
                return {
                    moved: false,
                    action: opened ? 'door' : 'none',
                    x,
                    y,
                    tip: opened ? undefined : this.doorFailureTip(block),
                };
            }
            if (isEnemy(block.event)) {
                // 战前剧本：推迟战斗（旧 `_sys_battle` 里 push beforeBattle + battle）
                const before = this.ctx.beforeBattleAt?.(x, y, block.event.id);
                if (before && before.length > 0) {
                    return { moved: false, action: 'battle', x, y, deferred: true, before };
                }
                const damage = this.battle(block);
                return {
                    moved: false,
                    action: damage == null ? 'none' : 'battle',
                    x,
                    y,
                    damage: damage ?? undefined,
                };
            }
            if (!isPassable(block.event)) {
                return { moved: false, action: 'none', x, y };
            }
        }

        this.ctx.hero.x = x;
        this.ctx.hero.y = y;
        // 跟随者跟着走（旧 `control.moveHero` 末尾的 `updateFollowers`）
        updateFollowers(this.ctx.hero.followers ?? [], this.ctx.hero);

        const landed = this.blockAt(x, y);
        if (landed && !landed.disable) {
            if (isItem(landed.event)) {
                const tip = this.pickUp(landed);
                return { moved: true, action: 'item', x, y, tip: tip || undefined };
            }
            if (landed.event.trigger === 'changeFloor') {
                this.changeFloor(landed);
                return { moved: true, action: 'floor', x, y };
            }
        }

        return { moved: true, action: 'move', x, y };
    }

    /** 开门失败时的提示（旧 `_openDoor_check` 的 `drawTip`） */
    private doorFailureTip(block: Block): string {
        const keys =
            (block.event.doorInfo as { keys?: Record<string, number> } | undefined)?.keys ?? {};
        for (const rawKey of Object.keys(keys)) {
            const keyName = rawKey.endsWith(':o') ? rawKey.slice(0, -2) : rawKey;
            const item = this.ctx.items[keyName];
            // 未定义的道具（如样板里没定义 specialKey）：旧版同样直接判定无法开启
            if (!item) return '无法开启此门';
            if (itemCount(this.ctx.hero, keyName) < (keys[rawKey] ?? 0)) {
                return `你的${item.name ?? '钥匙'}不足！`;
            }
        }
        return '无法开启此门';
    }

    /** 打开门；成功返回 true，并扣钥匙、移除图块 */
    openDoor(block: Block): boolean {
        const doorInfo = block.event.doorInfo as { keys?: Record<string, number> } | undefined;
        if (!doorInfo) return false;
        const keys = doorInfo.keys ?? {};
        const hero = this.ctx.hero;

        // 先检查（`:o` 后缀表示只检查不消耗，键名去掉后缀后查背包，需求值仍取原键）
        for (const rawKey of Object.keys(keys)) {
            const keyName = rawKey.endsWith(':o') ? rawKey.slice(0, -2) : rawKey;
            if (!this.ctx.items[keyName]) return false;
            if (itemCount(hero, keyName) < keys[rawKey]) return false;
        }
        // 再消耗
        for (const keyName of Object.keys(keys)) {
            if (keyName.endsWith(':o')) continue;
            removeItem(hero, keyName, keys[keyName] ?? 0);
        }
        this.disableBlock(block);
        return true;
    }

    /**
     * 拾取物品：即捡即用类就地生效，其余进入背包，最后移除图块。
     * 返回「即捡即用类」的提示文本（旧 `getItemEffectTip`），无提示时为空串。
     */
    pickUp(block: Block): string {
        const id = block.event.id;
        const item = this.ctx.items[id];
        const consumed = this.ctx.itemEffects?.runPickUpEffect(id, 1) ?? false;
        if (!consumed) addItem(this.ctx.hero, id, 1, item?.cls);
        this.disableBlock(block);
        return this.ctx.itemEffects?.effectTip(id) ?? '';
    }

    /**
     * 与怪物战斗。返回伤害值；打不过返回 null。
     * 战后处理毒衰咒、自爆、退化、仇恨与奖励。
     */
    battle(block: Block): number | null {
        const enemy = this.ctx.enemys[block.event.id];
        if (!enemy) return null;
        const ctx = this.battleContext();
        const info = getDamageInfo(enemy, null, block.x, block.y, ctx);
        if (info == null || info.damage >= this.ctx.hero.hp) return null;

        const hero = this.ctx.hero;
        const enemyInfo = getEnemyInfo(enemy, null, block.x, block.y, ctx);
        hero.hp -= info.damage;

        // 战后奖励；诅咒时无金币与经验。支援怪（旧 `guards`）一起结算
        if (!hasFlag(this.ctx.flags, 'curse')) {
            hero.money += enemyInfo.money + this.guardSum(enemyInfo.guards, 'money');
            hero.exp += enemyInfo.exp + this.guardSum(enemyInfo.guards, 'exp');
        }

        // 仇恨：击杀积累，与仇恨怪战斗后释放一半
        const hatredGain = Number(this.ctx.values.hatred) || 0;
        if (hatredGain > 0) {
            this.ctx.flags.hatred = Math.floor((Number(this.ctx.flags.hatred) || 0) + hatredGain);
        }
        if (hasSpecial(enemy.special, 17, ctx.enemyOf)) {
            this.ctx.flags.hatred = Math.floor((Number(this.ctx.flags.hatred) || 0) / 2);
        }

        this.applyAfterBattle(enemy);
        this.disableBlock(block);
        // 支援怪与主怪一起消失（旧 tower 是在 `beforeBattle` 里把支援怪跳到当前位置，
        // 再用 `jump` 的 `keep: false` 抹掉原位置；这里直接移除它们自己的图块）
        for (const [gx, gy] of enemyInfo.guards) {
            const guard = this.blockAt(gx, gy);
            if (guard && !guard.disable && isEnemy(guard.event)) this.disableBlock(guard);
        }
        return info.damage;
    }

    /** 支援怪属性求和（旧 `guards.reduce(...)`） */
    private guardSum(
        guards: readonly [number, number, string][],
        field: 'money' | 'exp',
    ): number {
        let sum = 0;
        for (const [, , id] of guards) {
            const enemy = this.ctx.enemys[id];
            if (!enemy) continue;
            const info = getEnemyInfo(enemy, null, null, null, this.battleContext());
            sum += info[field];
        }
        return sum;
    }

    private applyAfterBattle(enemy: EnemyData): void {
        const special = enemy.special;
        const debuffs: DebuffType[] = [];
        if (hasSpecial(special, 12, (id) => this.ctx.enemys[id])) debuffs.push('poison');
        if (hasSpecial(special, 13, (id) => this.ctx.enemys[id])) debuffs.push('weak');
        if (hasSpecial(special, 14, (id) => this.ctx.enemys[id])) debuffs.push('curse');
        if (debuffs.length > 0) {
            triggerDebuff(this.ctx.flags, this.ctx.hero, this.ctx.values, 'get', debuffs);
        }
        // 自爆
        if (hasSpecial(special, 19, (id) => this.ctx.enemys[id])) this.ctx.hero.hp = 1;
        // 退化
        if (hasSpecial(special, 21, (id) => this.ctx.enemys[id])) {
            addStatus(this.ctx.hero, 'atk', -Number(enemy.atkValue) || 0);
            addStatus(this.ctx.hero, 'def', -Number(enemy.defValue) || 0);
            this.ctx.hero.atk = Math.max(0, this.ctx.hero.atk);
            this.ctx.hero.def = Math.max(0, this.ctx.hero.def);
        }
    }

    /** 切换楼层并落点 */
    changeFloor(block: Block): void {
        const data = block.event.data as
            { floorId: string; loc?: number[]; direction?: string } | undefined;
        if (!data?.floorId) return;
        this.ctx.floorId = data.floorId;
        const [x, y] = data.loc ?? [];
        if (x !== undefined && y !== undefined) {
            this.ctx.hero.x = x;
            this.ctx.hero.y = y;
        }
        if (data.direction) this.ctx.hero.direction = data.direction as HeroState['direction'];
    }

    /** 该格战斗伤害展示（供怪物手册/光标使用） */
    damageString(x: number, y: number): { damage: string; color: string } | null {
        const block = this.blockAt(x, y);
        if (!block || !isEnemy(block.event)) return null;
        const enemy = this.ctx.enemys[block.event.id];
        if (!enemy) return null;
        return getDamageString(enemy, x, y, this.battleContext());
    }

    /**
     * 该格的下一个临界值（旧显伤里的 `displayCritical`）：
     * 还差多少攻击力才能少挨一轮 / 破防，取不到返回 null。
     */
    criticalValue(x: number, y: number): number | null {
        const block = this.blockAt(x, y);
        if (!block || !isEnemy(block.event)) return null;
        const enemy = this.ctx.enemys[block.event.id];
        if (!enemy) return null;
        const list = nextCriticals(enemy, 1, x, y, this.battleContext());
        const first = list[0]?.[0];
        return first == null ? null : first;
    }

    /**
     * 移除 / 显示图块（旧 `core.removeBlock` / `core.showBlock`）。
     *
     * 图块的 disable 状态与存档里的 `__block_<floor>_<x>_<y>__` flag 必须同步，
     * 否则读档后（block 缓存按 flag 重建）会丢掉这一步。塔作者脚本里的
     * `removeBlock` / `hide` / `show` / `openDoor` 都走这里。
     */
    setBlockDisabled(block: Block, disabled = true, floorId = this.ctx.floorId): void {
        block.disable = disabled;
        const name = `__block_${floorId}_${block.x}_${block.y}__`;
        if (disabled) setFlag(this.ctx.flags, name, true);
        else delete this.ctx.flags[name];
    }

    private disableBlock(block: Block): void {
        this.setBlockDisabled(block, true);
    }
}
