/**
 * 勇士属性、增幅与毒衰咒。
 *
 * 迁移自旧 `libs/control.js` 的 getStatus / getRealStatus / getBuff / triggerDebuff。
 * 这些函数是战斗与状态栏的公共基础，保持纯函数以便单测锁定行为。
 */
import type { HeroStats, HeroState } from '../types';

export type StatusName = 'hp' | 'atk' | 'def' | 'mdef' | 'money' | 'exp' | 'lv' | 'steps' | 'hpmax';

/** 用于临时覆盖勇士属性的部分状态（如临界值计算时假设的攻击力） */
export type HeroOverride = Partial<Record<StatusName, number>>;

/** 旧实现统一向下取整，负属性在伤害计算中另行 clamp */
function floorValue(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) ? Math.floor(n) : 0;
}

export function getStatus(hero: HeroStats, name: StatusName): number {
    return floorValue(hero[name as keyof HeroStats]);
}

/** 优先取覆盖状态，否则取勇士自身属性；结果向下取整 */
export function getStatusOrDefault(
    hero: HeroStats,
    status: HeroOverride | null,
    name: StatusName,
): number {
    if (status && status[name] != null) return floorValue(status[name]);
    return getStatus(hero, name);
}

const BUFF_PREFIX = '__';
const BUFF_SUFFIX = '_buff__';

export function buffKey(name: StatusName): string {
    return `${BUFF_PREFIX}${name}${BUFF_SUFFIX}`;
}

/** 属性增幅，默认 1 */
export function getBuff(flags: Record<string, unknown>, name: StatusName): number {
    const value = flags[buffKey(name)];
    const n = Number(value);
    return value == null || !Number.isFinite(n) ? 1 : n;
}

/** 设置增幅，仅保留三位小数（与旧实现一致） */
export function setBuff(flags: Record<string, unknown>, name: StatusName, value: number): void {
    flags[buffKey(name)] = Number(value.toFixed(3));
}

export function addBuff(flags: Record<string, unknown>, name: StatusName, value: number): void {
    setBuff(flags, name, getBuff(flags, name) + value);
}

/** 增幅后的实际属性 */
export function getRealStatusOrDefault(
    hero: HeroStats,
    flags: Record<string, unknown>,
    status: HeroOverride | null,
    name: StatusName,
): number {
    return floorValue(getStatusOrDefault(hero, status, name) * getBuff(flags, name));
}

export function getRealStatus(
    hero: HeroStats,
    flags: Record<string, unknown>,
    name: StatusName,
): number {
    return getRealStatusOrDefault(hero, flags, null, name);
}

export function addStatus(hero: HeroState, name: StatusName, value: number): void {
    const current = getStatus(hero, name);
    (hero as unknown as Record<string, number>)[name] = current + value;
}

export function hasFlag(flags: Record<string, unknown>, name: string): boolean {
    return flags[name] === true;
}

export function setFlag(flags: Record<string, unknown>, name: string, value: unknown): void {
    flags[name] = value;
}

export type DebuffType = 'poison' | 'weak' | 'curse';

/**
 * 毒衰咒的获得与解除。
 *
 * 衰弱（weak）：weakValue >= 1 时直接扣减攻防数值，否则按比例修正增幅。
 * 与旧 `project/functions.js` 的 triggerDebuff 行为一致。
 */
export function triggerDebuff(
    flags: Record<string, unknown>,
    hero: HeroState,
    values: Record<string, unknown>,
    action: 'get' | 'remove',
    type: DebuffType | DebuffType[],
): boolean {
    const types = Array.isArray(type) ? type : [type];
    const weakValue = Number(values.weakValue) || 0;
    let changed = false;

    const adjustWeak = (sign: 1 | -1): void => {
        if (weakValue >= 1) {
            addStatus(hero, 'atk', sign * weakValue);
            addStatus(hero, 'def', sign * weakValue);
        } else {
            addBuff(flags, 'atk', sign * weakValue);
            addBuff(flags, 'def', sign * weakValue);
        }
    };

    if (action === 'get') {
        if (types.includes('poison') && !hasFlag(flags, 'poison')) {
            setFlag(flags, 'poison', true);
            changed = true;
        }
        if (types.includes('weak') && !hasFlag(flags, 'weak')) {
            setFlag(flags, 'weak', true);
            adjustWeak(-1);
            changed = true;
        }
        if (types.includes('curse') && !hasFlag(flags, 'curse')) {
            setFlag(flags, 'curse', true);
            changed = true;
        }
    } else {
        if (types.includes('poison') && hasFlag(flags, 'poison')) {
            setFlag(flags, 'poison', false);
            changed = true;
        }
        if (types.includes('weak') && hasFlag(flags, 'weak')) {
            setFlag(flags, 'weak', false);
            adjustWeak(1);
            changed = true;
        }
        if (types.includes('curse') && hasFlag(flags, 'curse')) {
            setFlag(flags, 'curse', false);
            changed = true;
        }
    }

    return changed;
}
