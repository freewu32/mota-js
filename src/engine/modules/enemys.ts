/**
 * 怪物战斗计算。
 *
 * 迁移自旧 `libs/enemys.js` 与 `project/functions.js` 的
 * getEnemyInfo / getDamageInfo / nextCriticals / getDamageString。
 *
 * 约定：函数不读全局状态，所有依赖（勇士属性、flags、values、图块列表、
 * 敌人查询）都从 `BattleContext` 传入，因此可以脱离浏览器在 bun test 中锁定行为。
 */
import type { HeroStats } from '../types';
import { enemyBlocks, type Block } from './maps';
import {
    getBuff,
    getRealStatusOrDefault,
    getStatusOrDefault,
    type HeroOverride,
    type StatusName,
} from './status';

export interface EnemyData {
    id?: string;
    [key: string]: unknown;
}

export type SpecialContent = string | ((enemy: EnemyData) => string);

export interface SpecialDefinition {
    id: number;
    /** 名称，可为常量或依怪物计算的函数 */
    name: SpecialContent;
    /** 说明，可为常量或依怪物计算的函数 */
    describe: SpecialContent;
    color?: string;
    /** 第五位标记：1 表示需要遍历全图的地图类技能（光环/支援等） */
    flag?: number;
}

/** 旧版特殊属性表（数字 id 与名称）。说明文案可被用户脚本覆盖。 */
export const DEFAULT_SPECIALS: SpecialDefinition[] = [
    { id: 1, name: '先攻', describe: '怪物首先攻击' },
    { id: 2, name: '魔攻', describe: '怪物无视角色的防御' },
    { id: 3, name: '坚固', describe: '怪物防御不小于角色攻击-1' },
    { id: 4, name: '2连击', describe: '怪物每回合攻击2次' },
    { id: 5, name: '3连击', describe: '怪物每回合攻击3次' },
    { id: 6, name: '连击', describe: '怪物每回合攻击多次' },
    { id: 7, name: '破甲', describe: '战斗前附加角色防御的一定比例作为伤害' },
    { id: 8, name: '反击', describe: '战斗时附加角色攻击的一定比例作为伤害' },
    { id: 9, name: '净化', describe: '战斗前附加角色护盾的若干倍作为伤害' },
    { id: 10, name: '模仿', describe: '怪物的攻防和角色攻防相等' },
    { id: 11, name: '吸血', describe: '战斗前吸取角色一定比例生命作为伤害' },
    { id: 12, name: '中毒', describe: '战斗后角色每步损失生命' },
    { id: 13, name: '衰弱', describe: '战斗后角色攻防暂时下降' },
    { id: 14, name: '诅咒', describe: '战斗后角色战斗无法获得金币和经验' },
    { id: 15, name: '领域', describe: '经过怪物周围时自动减生命' },
    { id: 16, name: '夹击', describe: '经过两只相同的怪物中间，生命变成一半' },
    { id: 17, name: '仇恨', describe: '战斗前附加积累的仇恨值作为伤害' },
    { id: 18, name: '阻击', describe: '经过怪物周围时自动减生命并后退一格' },
    { id: 19, name: '自爆', describe: '战斗后角色生命值变成1' },
    { id: 20, name: '无敌', describe: '除非拥有十字架，否则无法击败' },
    { id: 21, name: '退化', describe: '战斗后角色永久下降攻防' },
    { id: 22, name: '固伤', describe: '战斗前造成固定伤害，无视护盾' },
    { id: 23, name: '重生', describe: '转换楼层后怪物再次出现' },
    { id: 24, name: '激光', describe: '经过同行或同列时自动减生命' },
    { id: 25, name: '光环', describe: '范围内怪物属性提升', flag: 1 },
    { id: 26, name: '支援', describe: '受攻击时周围怪物支援战斗', flag: 1 },
    { id: 27, name: '捕捉', describe: '走到怪物周围时强制战斗' },
];

export interface HaloInfo {
    hp_buff: number;
    atk_buff: number;
    def_buff: number;
    guards: [number, number, string][];
}

export interface BattleContext {
    /** 勇士原始属性（不含增幅） */
    hero: HeroStats;
    flags: Record<string, unknown>;
    values: Record<string, unknown>;
    /** 怪物在某点的属性覆盖（enemyOnPoint） */
    getEnemyValue?: (enemy: EnemyData, name: string, x?: number, y?: number) => unknown;
    hasItem?: (id: string) => boolean;
    /** 当前楼层图块，用于光环与支援 */
    blocks?: readonly Block[];
    /** 通过 id 查怪物，用于 special 引用其他怪物的情况 */
    enemyOf?: (id: string) => EnemyData | undefined;
    /** 光环/支援缓存，按点或楼层复用 */
    haloCache?: Map<string, HaloInfo>;
    specials?: SpecialDefinition[];
}

export interface EnemyInfo {
    hp: number;
    atk: number;
    def: number;
    money: number;
    exp: number;
    point: number;
    special: unknown;
    guards: [number, number, string][];
}

export interface DamageInfo {
    mon_hp: number;
    mon_atk: number;
    mon_def: number;
    init_damage: number;
    per_damage: number;
    hero_per_damage: number;
    turn: number;
    damage: number;
    /** 未破防时二分得到的额外攻击需求（仅 nextCriticals 内部使用） */
    __over__?: boolean;
    __overAtk__?: number;
}

export interface DamageInfoResult {
    damage: string;
    color: string;
}

function num(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

/** special 是否包含某个数字技能；支持数组、数字、怪物 id、嵌套 special */
export function hasSpecial(
    special: unknown,
    test: number,
    enemyOf?: (id: string) => EnemyData | undefined,
): boolean {
    if (special == null) return false;
    if (Array.isArray(special)) return special.includes(test);
    if (typeof special === 'number') return special === test;
    if (typeof special === 'string') {
        const enemy = enemyOf?.(special);
        return enemy ? hasSpecial(enemy.special, test, enemyOf) : false;
    }
    if (typeof special === 'object' && 'special' in (special as Record<string, unknown>)) {
        return hasSpecial((special as Record<string, unknown>).special, test, enemyOf);
    }
    return false;
}

function specialContent(content: SpecialContent, enemy: EnemyData): string {
    return typeof content === 'function' ? content(enemy) : content;
}

export function getSpecialText(enemy: EnemyData, specials = DEFAULT_SPECIALS): string[] {
    const special = enemy.special;
    return specials
        .filter((def) => hasSpecial(special, def.id))
        .map((def) => specialContent(def.name, enemy));
}

export function getSpecialColor(enemy: EnemyData, specials = DEFAULT_SPECIALS): (string | null)[] {
    const special = enemy.special;
    return specials.filter((def) => hasSpecial(special, def.id)).map((def) => def.color ?? null);
}

export function getSpecialFlag(enemy: EnemyData, specials = DEFAULT_SPECIALS): number {
    const special = enemy.special;
    return specials
        .filter((def) => hasSpecial(special, def.id))
        .reduce((flag, def) => flag | (def.flag ?? 0), 0);
}

/** 需要遍历全图的特殊技能（第五位标记为 1） */
export function needsGlobalScan(enemy: EnemyData, specials = DEFAULT_SPECIALS): boolean {
    return (getSpecialFlag(enemy, specials) & 1) !== 0;
}

/**
 * 扫描整层图块，统计光环加成与支援怪。
 * 光环：范围外/无范围表示全层；不可叠加的按怪物 id 去重。
 * 支援：九宫格内的其他怪物。
 */
export function scanHalo(
    blocks: readonly Block[],
    x: number | null,
    y: number | null,
    ctx: BattleContext,
): HaloInfo {
    const key = x != null && y != null ? `${x},${y}` : 'all';
    const cached = ctx.haloCache?.get(key);
    if (cached) return cached;

    let hp_buff = 0;
    let atk_buff = 0;
    let def_buff = 0;
    const guards: [number, number, string][] = [];
    const usedEnemyIds: Record<string, boolean> = {};

    for (const block of enemyBlocks(blocks)) {
        const id = block.event.id;
        const enemy = ctx.enemyOf?.(id);
        if (!enemy) continue;

        if (hasSpecial(enemy.special, 25, ctx.enemyOf)) {
            let inRange = num(enemy.haloRange) === 0 || enemy.haloRange == null;
            if (!inRange && x != null && y != null) {
                const dx = Math.abs(block.x - x);
                const dy = Math.abs(block.y - y);
                const range = num(enemy.haloRange);
                if (dx + dy <= range) inRange = true;
                if (enemy.haloSquare && dx <= range && dy <= range) inRange = true;
            }
            if (inRange && (enemy.haloAdd || !usedEnemyIds[id])) {
                hp_buff += num(enemy.hpBuff);
                atk_buff += num(enemy.atkBuff);
                def_buff += num(enemy.defBuff);
                usedEnemyIds[id] = true;
            }
        }

        if (
            hasSpecial(enemy.special, 26, ctx.enemyOf) &&
            x != null &&
            y != null &&
            Math.abs(block.x - x) <= 1 &&
            Math.abs(block.y - y) <= 1 &&
            !(x === block.x && y === block.y)
        ) {
            guards.push([block.x, block.y, id]);
        }
    }

    const info: HaloInfo = { hp_buff, atk_buff, def_buff, guards };
    ctx.haloCache?.set(key, info);
    return info;
}

/** 怪物变化后的属性：模仿、坚固、光环、支援 */
export function getEnemyInfo(
    enemy: EnemyData,
    hero: HeroOverride | null,
    x: number | null,
    y: number | null,
    ctx: BattleContext,
): EnemyInfo {
    const hero_hp = getRealStatusOrDefault(ctx.hero, ctx.flags, hero, 'hp');
    const hero_atk = getRealStatusOrDefault(ctx.hero, ctx.flags, hero, 'atk');
    const hero_def = getRealStatusOrDefault(ctx.hero, ctx.flags, hero, 'def');

    const value = (name: string): unknown =>
        ctx.getEnemyValue
            ? ctx.getEnemyValue(enemy, name, x ?? undefined, y ?? undefined)
            : enemy[name];

    let mon_hp = num(value('hp'));
    let mon_atk = num(value('atk'));
    let mon_def = num(value('def'));
    const mon_money = num(value('money'));
    const mon_exp = num(value('exp'));
    const mon_point = num(value('point'));
    const mon_special = value('special');

    // 模仿
    if (hasSpecial(mon_special, 10, ctx.enemyOf)) {
        mon_atk = hero_atk;
        mon_def = hero_def;
    }
    // 坚固
    if (hasSpecial(mon_special, 3, ctx.enemyOf) && mon_def < hero_atk - 1) {
        mon_def = hero_atk - 1;
    }

    let guards: [number, number, string][] = [];
    if (ctx.blocks && ctx.blocks.length > 0) {
        const halo = scanHalo(ctx.blocks, x, y, ctx);
        mon_hp *= 1 + halo.hp_buff / 100;
        mon_atk *= 1 + halo.atk_buff / 100;
        mon_def *= 1 + halo.def_buff / 100;
        guards = halo.guards;
    }

    void hero_hp;
    return {
        hp: Math.floor(mon_hp),
        atk: Math.floor(mon_atk),
        def: Math.floor(mon_def),
        money: Math.floor(mon_money),
        exp: Math.floor(mon_exp),
        point: Math.floor(mon_point),
        special: mon_special,
        guards,
    };
}

/**
 * 实际伤害计算。返回 null 表示不可战斗（未破防或无敌且无十字架）。
 *
 * 支援怪递归时使用勇士原始属性和 0 护盾，护盾只结算一次；当前怪先打，
 * 因此支援怪只累加其伤害，不改变当前怪的回合数（与旧实现一致）。
 */
export function getDamageInfo(
    enemy: EnemyData,
    hero: HeroOverride | null,
    x: number | null,
    y: number | null,
    ctx: BattleContext,
): DamageInfo | null {
    const originRaw = {
        hp: getStatusOrDefault(ctx.hero, hero, 'hp'),
        atk: getStatusOrDefault(ctx.hero, hero, 'atk'),
        def: getStatusOrDefault(ctx.hero, hero, 'def'),
    };

    let hero_hp = getRealStatusOrDefault(ctx.hero, ctx.flags, hero, 'hp');
    let hero_atk = getRealStatusOrDefault(ctx.hero, ctx.flags, hero, 'atk');
    let hero_def = getRealStatusOrDefault(ctx.hero, ctx.flags, hero, 'def');
    const hero_mdef = getRealStatusOrDefault(ctx.hero, ctx.flags, hero, 'mdef');

    // 勇士的负属性按 0 计算
    hero_hp = Math.max(0, hero_hp);
    hero_atk = Math.max(0, hero_atk);
    hero_def = Math.max(0, hero_def);

    const enemyInfo = getEnemyInfo(enemy, hero, x, y, ctx);
    let mon_hp = enemyInfo.hp;
    const mon_atk = enemyInfo.atk;
    const mon_def = enemyInfo.def;
    const mon_special = enemyInfo.special;

    // 技能 1：二倍斩
    if (num(ctx.flags.skill) === 1) hero_atk *= 2;

    // 无敌且未持有十字架
    if (hasSpecial(mon_special, 20, ctx.enemyOf) && !ctx.hasItem?.('cross')) return null;

    let init_damage = 0;

    // 吸血
    if (hasSpecial(mon_special, 11, ctx.enemyOf)) {
        const vampire = Math.floor(hero_hp * num(enemy.vampire)) || 0;
        if (enemy.add) mon_hp += vampire;
        init_damage += vampire;
    }

    let per_damage = mon_atk - hero_def;
    if (hasSpecial(mon_special, 2, ctx.enemyOf)) per_damage = mon_atk;
    if (per_damage < 0) per_damage = 0;
    if (hasSpecial(mon_special, 4, ctx.enemyOf)) per_damage *= 2;
    if (hasSpecial(mon_special, 5, ctx.enemyOf)) per_damage *= 3;
    if (hasSpecial(mon_special, 6, ctx.enemyOf)) per_damage *= num(enemy.n) || 4;

    let counterDamage = 0;
    if (hasSpecial(mon_special, 8, ctx.enemyOf)) {
        counterDamage += Math.floor(
            num(enemy.counterAttack || ctx.values.counterAttack) * hero_atk,
        );
    }

    if (hasSpecial(mon_special, 1, ctx.enemyOf)) init_damage += per_damage;
    if (hasSpecial(mon_special, 7, ctx.enemyOf)) {
        init_damage += Math.floor(num(enemy.breakArmor || ctx.values.breakArmor) * hero_def);
    }
    if (hasSpecial(mon_special, 9, ctx.enemyOf)) {
        init_damage += Math.floor(num(enemy.purify || ctx.values.purify) * hero_mdef);
    }

    const hero_per_damage = Math.max(hero_atk - mon_def, 0);
    if (hero_per_damage <= 0) return null;

    const turn = Math.ceil(mon_hp / hero_per_damage);

    // 支援：当前怪先打，只累加支援怪伤害
    if (enemyInfo.guards.length > 0) {
        for (const [gx, gy, gid] of enemyInfo.guards) {
            const guard = ctx.enemyOf?.(gid);
            if (!guard) continue;
            const guardInfo = getDamageInfo(
                guard,
                { hp: originRaw.hp, atk: originRaw.atk, def: originRaw.def, mdef: 0 },
                null,
                null,
                ctx,
            );
            if (guardInfo == null) return null;
            init_damage += guardInfo.damage;
            void gx;
            void gy;
        }
    }

    let damage = init_damage + (turn - 1) * per_damage + turn * counterDamage;
    damage -= hero_mdef;

    if (!ctx.flags.enableNegativeDamage) damage = Math.max(0, damage);

    if (hasSpecial(mon_special, 17, ctx.enemyOf)) damage += num(ctx.flags.hatred);
    if (hasSpecial(mon_special, 22, ctx.enemyOf)) damage += num(enemy.damage);

    return {
        mon_hp: Math.floor(mon_hp),
        mon_atk: Math.floor(mon_atk),
        mon_def: Math.floor(mon_def),
        init_damage: Math.floor(init_damage),
        per_damage: Math.floor(per_damage),
        hero_per_damage: Math.floor(hero_per_damage),
        turn: Math.floor(turn),
        damage: Math.floor(damage),
    };
}

export function getDamage(
    enemy: EnemyData,
    x: number | null,
    y: number | null,
    ctx: BattleContext,
): number | null {
    const info = getDamageInfo(enemy, null, x, y, ctx);
    if (info == null) return null;
    return info.damage;
}

export function canBattle(
    enemy: EnemyData,
    x: number | null,
    y: number | null,
    ctx: BattleContext,
): boolean {
    const damage = getDamage(enemy, x, y, ctx);
    return damage != null && damage < getStatusOrDefault(ctx.hero, null, 'hp');
}

/** 伤害展示：数值与颜色；未破防显示 ??? */
export function getDamageString(
    enemy: EnemyData,
    x: number | null,
    y: number | null,
    ctx: BattleContext,
): DamageInfoResult {
    const damage = getDamage(enemy, x, y, ctx);
    if (damage == null) return { damage: '???', color: '#FF2222' };

    const hp = getStatusOrDefault(ctx.hero, null, 'hp');
    let color: string;
    if (damage <= 0) color = '#11FF11';
    else if (damage < hp / 3) color = '#FFFFFF';
    else if (damage < (hp * 2) / 3) color = '#FFFF00';
    else if (damage < hp) color = '#FF9933';
    else color = '#FF2222';

    let text = String(damage);
    if (hasSpecial(enemy.special, 19, ctx.enemyOf)) text += '+';
    if (hasSpecial(enemy.special, 21, ctx.enemyOf)) text += '-';
    if (hasSpecial(enemy.special, 11, ctx.enemyOf)) text += '^';
    return { damage: text, color };
}

/** N 防减伤：提升 k 点防御后减少的伤害 */
export function getDefDamage(
    enemy: EnemyData,
    k: number,
    x: number | null,
    y: number | null,
    ctx: BattleContext,
): number | '???' {
    const nowDamage = getDamage(enemy, x, y, ctx);
    const nextDamage = getDamage(enemy, x, y, {
        ...ctx,
        hero: { ...ctx.hero, def: getStatusOrDefault(ctx.hero, null, 'def') + k },
    });
    if (nowDamage == null || nextDamage == null) return '???';
    return nowDamage - nextDamage;
}

// ---------- 临界值 ----------

type Critical = [number, number];

function critEnabled(ctx: BattleContext): boolean {
    return !!ctx.flags.enableNegativeDamage;
}

/** 未破防时，二分求最少需要提升多少攻击才能破防 */
function nextCriticalsOverAtk(
    enemy: EnemyData,
    x: number | null,
    y: number | null,
    ctx: BattleContext,
): [number, DamageInfo] | null {
    const hero = ctx.hero;
    const baseAtk = getStatusOrDefault(hero, null, 'atk');
    const max = num(enemy.hp) + num(enemy.def);
    let start = baseAtk + 1;
    let end = Math.max(baseAtk, max);
    if (start > end) return null;

    while (start < end) {
        let mid = Math.floor((start + end) / 2);
        if (mid - start > end - mid) mid--;
        const info = getDamageInfo(enemy, { atk: mid }, x, y, ctx);
        if (info != null) end = mid;
        else start = mid + 1;
    }
    const info = getDamageInfo(enemy, { atk: start }, x, y, ctx);
    return info == null ? null : [start - baseAtk, info];
}

/** 回合制临界值：t 回合解决需要的攻击力 */
function nextCriticalsUseTurn(
    enemy: EnemyData,
    info: DamageInfo,
    number: number,
    x: number | null,
    y: number | null,
    ctx: BattleContext,
): Critical[] {
    if (info.turn >= 1e6) {
        return nextCriticalsBinary(enemy, info, number, x, y, ctx);
    }
    const hero = ctx.hero;
    const baseAtk = getStatusOrDefault(hero, null, 'atk');
    const list: Critical[] = [];
    let pre: number | null = null;
    let startAtk = baseAtk;
    if (info.__over__) {
        startAtk += info.__overAtk__ ?? 0;
        list.push([info.__overAtk__ ?? 0, -info.damage]);
    }
    for (let t = info.turn - 1; t >= 1; t--) {
        let nextAtk = Math.ceil(info.mon_hp / t) + info.mon_def;
        nextAtk = Math.ceil(nextAtk / getBuff(ctx.flags, 'atk' as StatusName));
        if (nextAtk <= startAtk) break;
        if (nextAtk !== pre) {
            const nextInfo = getDamageInfo(enemy, { atk: nextAtk }, x, y, ctx);
            if (nextInfo == null) break;
            list.push([nextAtk - baseAtk, Math.floor(info.damage - nextInfo.damage)]);
            if (nextInfo.damage <= 0 && !critEnabled(ctx)) break;
            pre = nextAtk;
        }
        if (list.length >= number) break;
    }
    if (list.length === 0) list.push([0, 0]);
    return list;
}

/** 二分临界值：攻防极大、回合过多时使用 */
function nextCriticalsBinary(
    enemy: EnemyData,
    info: DamageInfo,
    number: number,
    x: number | null,
    y: number | null,
    ctx: BattleContext,
): Critical[] {
    const hero = ctx.hero;
    const baseAtk = getStatusOrDefault(hero, null, 'atk');
    const list: Critical[] = [];
    let pre = info.damage;
    let current = baseAtk;
    if (info.__over__) {
        current += info.__overAtk__ ?? 0;
        list.push([info.__overAtk__ ?? 0, -info.damage]);
    }
    const max = info.mon_hp + info.mon_def;

    const calNext = (currAtk: number, maxAtk: number): [number, number] | null => {
        let start = Math.floor(currAtk);
        let end = Math.floor(maxAtk);
        if (start > end) return null;
        while (start < end) {
            let mid = Math.floor((start + end) / 2);
            if (mid - start > end - mid) mid--;
            const nextInfo = getDamageInfo(enemy, { atk: mid }, x, y, ctx);
            if (nextInfo == null) return null;
            if (pre > nextInfo.damage) end = mid;
            else start = mid + 1;
        }
        const nextInfo = getDamageInfo(enemy, { atk: start }, x, y, ctx);
        if (nextInfo == null || nextInfo.damage >= pre) return null;
        return [start, nextInfo.damage];
    };

    for (;;) {
        const next = calNext(current + 1, max);
        if (next == null) break;
        current = next[0];
        pre = next[1];
        list.push([current - baseAtk, info.damage - pre]);
        if (pre <= 0 && !critEnabled(ctx)) break;
        if (list.length >= number) break;
    }
    if (list.length === 0) list.push([0, 0]);
    return list;
}

/** 接下来 N 个临界值；[攻击增量, 减伤] 列表 */
export function nextCriticals(
    enemy: EnemyData,
    number: number,
    x: number | null,
    y: number | null,
    ctx: BattleContext,
): Critical[] {
    number = number || 1;

    // 模仿/坚固：临界值无意义
    if (hasSpecial(enemy.special, 10, ctx.enemyOf) || hasSpecial(enemy.special, 3, ctx.enemyOf)) {
        return [];
    }

    let info = getDamageInfo(enemy, null, x, y, ctx);
    if (info == null) {
        const overAtk = nextCriticalsOverAtk(enemy, x, y, ctx);
        if (overAtk == null) return [];
        const [, breakInfo] = overAtk;
        info = breakInfo;
        info.__over__ = true;
        info.__overAtk__ = overAtk[0];
    }

    if (info.damage <= 0 && !critEnabled(ctx)) {
        return [[info.__overAtk__ ?? 0, 0]];
    }

    if (ctx.flags.useLoop) {
        if (getStatusOrDefault(ctx.hero, null, 'atk') <= num(ctx.flags.criticalUseLoop || 1)) {
            // useLoop 时使用二分实现（结果一致，避免大回合数线性循环）
            return nextCriticalsBinary(enemy, info, number, x, y, ctx);
        }
        return nextCriticalsBinary(enemy, info, number, x, y, ctx);
    }
    return nextCriticalsUseTurn(enemy, info, number, x, y, ctx);
}
