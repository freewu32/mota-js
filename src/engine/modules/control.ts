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
    removeBlock,
    type Block,
} from './maps';
import { addStatus, hasFlag, setFlag, triggerDebuff, type DebuffType } from './status';

export interface ItemData {
    cls?: string;
    name?: string;
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
    /** 取得某层数据 */
    getFloor(floorId: string): FloorData;
    /** 取得某层可变的 block 列表 */
    getBlocks(floorId: string): Block[];
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

export function removeItem(hero: HeroState, id: string, count = 1): boolean {
    if (itemCount(hero, id) < count) return false;
    let left = count;
    for (const key of INVENTORY_KEYS) {
        const have = hero.items[key][id] ?? 0;
        if (have === 0) continue;
        const take = Math.min(have, left);
        hero.items[key][id] = have - take;
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
            if (isDoor(block.event)) {
                const opened = this.openDoor(block);
                return { moved: false, action: opened ? 'door' : 'none', x, y };
            }
            if (isEnemy(block.event)) {
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

        const landed = this.blockAt(x, y);
        if (landed && !landed.disable) {
            if (isItem(landed.event)) {
                this.pickUp(landed);
                return { moved: true, action: 'item', x, y };
            }
            if (landed.event.trigger === 'changeFloor') {
                this.changeFloor(landed);
                return { moved: true, action: 'floor', x, y };
            }
        }

        return { moved: true, action: 'move', x, y };
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

    /** 拾取物品，加入背包并移除图块 */
    pickUp(block: Block): void {
        const item = this.ctx.items[block.event.id];
        addItem(this.ctx.hero, block.event.id, 1, item?.cls);
        this.disableBlock(block);
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

        // 战后奖励；诅咒时无金币与经验
        if (!hasFlag(this.ctx.flags, 'curse')) {
            hero.money += enemyInfo.money;
            hero.exp += enemyInfo.exp;
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
        return info.damage;
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

    private disableBlock(block: Block): void {
        removeBlock(this.blocks, block.x, block.y);
        setFlag(this.ctx.flags, `__block_${this.ctx.floorId}_${block.x}_${block.y}__`, true);
    }
}
