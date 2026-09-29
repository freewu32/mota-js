/**
 * 跟随者（旧 `core.status.hero.followers`）。
 *
 * 塔作者用剧本动作 `follow` / `unfollow` 增加或移除跟随者；跟随者只保存名字，
 * 真正的动画与精灵绘制由游戏层负责（`project/images/<name>` 的 4x4 图集）。
 *
 * 位置更新逐帧跟着勇士走：每次勇士移动后，每个跟随者先沿自己当前朝向前进一格
 * （制造连续移动的观感），再按顺序重新判断「相对前一个实体」的方向，形成队列。
 * 这段逻辑与旧 `control.updateFollowers` / `gatherFollowers` 等价。
 */
import type { Direction } from './maps';
import type { HeroState } from '../types';

export interface Follower {
    /** 图片名（`project/images/<name>`） */
    name: string;
    x: number;
    y: number;
    direction: Direction;
    /** 原地不动（身位已跟上，只是朝向不同） */
    stop: boolean;
}

const SCAN: Record<Direction, readonly [number, number]> = {
    up: [0, -1],
    down: [0, 1],
    left: [-1, 0],
    right: [1, 0],
};

/** 由位移反推方向；非单步位移返回 null */
function directionOf(dx: number, dy: number): Direction | null {
    for (const [name, [sx, sy]] of Object.entries(SCAN) as [
        Direction,
        readonly [number, number],
    ][]) {
        if (sx === dx && sy === dy) return name;
    }
    return null;
}

/** 创建跟随者，坐标对齐到勇士（旧 `follow` 里的 `gatherFollowers`） */
export function createFollower(name: string, hero: HeroState): Follower {
    return { name, x: hero.x, y: hero.y, direction: hero.direction, stop: true };
}

/** 旧 `gatherFollowers`：所有人瞬间聚拢到勇士位置（换层 / 瞬移时用） */
export function gatherFollowers(followers: readonly Follower[], hero: HeroState): void {
    for (const follower of followers) {
        follower.x = hero.x;
        follower.y = hero.y;
        follower.direction = hero.direction;
        follower.stop = true;
    }
}

/**
 * 旧 `updateFollowers`：勇士移动后更新跟随者队列。
 * 必须在勇士坐标已经改好之后调用。
 */
export function updateFollowers(followers: readonly Follower[], hero: HeroState): void {
    // 1. 谁在动，就先沿当前朝向走一格
    for (const follower of followers) {
        if (follower.stop) continue;
        const [dx, dy] = SCAN[follower.direction];
        follower.x += dx;
        follower.y += dy;
    }
    // 2. 沿着「勇士 → 跟随者1 → 跟随者2 …」的顺序，逐个把朝向对准前一个实体
    let nowX = hero.x;
    let nowY = hero.y;
    for (const follower of followers) {
        follower.stop = true;
        const direction = directionOf(nowX - follower.x, nowY - follower.y);
        if (direction) {
            follower.stop = false;
            follower.direction = direction;
        }
        nowX = follower.x;
        nowY = follower.y;
    }
}
