/**
 * 玩家本地设置（旧 `core.getLocalStorage` / `setLocalStorage`）。
 *
 * 旧版把「怪物显伤 / 临界显伤 / 自动放缩」这类开关放在 localStorage，而不是存档
 * （`flags`），这样改开关不会写进录像与存档。3.0 沿用同样的做法，并把值放进
 * signal，界面改动后立刻重绘显伤层。
 */
import { signal } from '@preact/signals';

const PREFIX = 'mota3.';

function read(key: string, fallback: boolean): boolean {
    if (typeof localStorage === 'undefined') return fallback;
    try {
        const value = localStorage.getItem(PREFIX + key);
        return value == null ? fallback : value === 'true';
    } catch {
        return fallback;
    }
}

function write(key: string, value: boolean | number | null): void {
    if (typeof localStorage === 'undefined') return;
    try {
        if (value == null) localStorage.removeItem(PREFIX + key);
        else localStorage.setItem(PREFIX + key, String(value));
    } catch {
        /* 忽略隐私模式等写入失败 */
    }
}

/** 怪物显伤（旧 `flags.displayEnemyDamage`，默认开） */
export const $displayEnemyDamage = signal(read('enemyDamage', true));
/** 临界显伤（旧 `flags.displayCritical`，默认开） */
export const $displayCritical = signal(read('critical', true));
/** 手动放缩档位（旧 `core.domStyle.scale` 的手动覆盖）；null 表示自动 */
export const $scaleOverride = signal<number | null>(readScale());

function readScale(): number | null {
    if (typeof localStorage === 'undefined') return null;
    try {
        const value = Number(localStorage.getItem(PREFIX + 'scale'));
        return Number.isFinite(value) && value > 0 ? value : null;
    } catch {
        return null;
    }
}

export function setDisplayEnemyDamage(value: boolean): void {
    $displayEnemyDamage.value = value;
    write('enemyDamage', value);
}

export function setDisplayCritical(value: boolean): void {
    $displayCritical.value = value;
    write('critical', value);
}

export function setScaleOverride(value: number | null): void {
    $scaleOverride.value = value;
    write('scale', value);
}
