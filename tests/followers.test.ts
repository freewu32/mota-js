import { describe, expect, test } from 'bun:test';
import {
    createFollower,
    gatherFollowers,
    updateFollowers,
    type Follower,
} from '../src/engine/modules/followers';
import type { HeroState } from '../src/engine/types';

function heroAt(x: number, y: number, direction: HeroState['direction'] = 'down'): HeroState {
    return {
        x,
        y,
        direction,
        hp: 100,
        atk: 10,
        def: 0,
        mdef: 0,
        money: 0,
        exp: 0,
        lv: 1,
        steps: 0,
        items: { constants: {}, tools: {}, equips: {} },
        equipment: [],
        followers: [],
    };
}

describe('跟随者', () => {
    test('createFollower / gatherFollowers 对齐勇士位置', () => {
        const hero = heroAt(3, 4, 'left');
        const follower = createFollower('bear.png', hero);
        expect(follower).toEqual({
            name: 'bear.png',
            x: 3,
            y: 4,
            direction: 'left',
            stop: true,
        });
        hero.x = 6;
        hero.y = 7;
        hero.direction = 'up';
        gatherFollowers([follower], hero);
        expect([follower.x, follower.y, follower.direction]).toEqual([6, 7, 'up']);
    });

    test('勇士移动后跟随者补位并转向', () => {
        const hero = heroAt(1, 1);
        const followers: Follower[] = [createFollower('a.png', hero)];
        // 勇士向右走一步
        hero.x = 2;
        updateFollowers(followers, hero);
        expect(followers[0]).toMatchObject({ x: 1, y: 1, direction: 'right', stop: false });

        // 再走一步：跟随者继续跟上
        hero.x = 3;
        updateFollowers(followers, hero);
        expect(followers[0]).toMatchObject({ x: 2, y: 1, direction: 'right' });
        expect(followers[0]!.stop).toBe(false);
    });

    test('队列里的第二个跟随者跟着第一个', () => {
        const hero = heroAt(0, 0);
        const first = createFollower('a.png', hero);
        const second = createFollower('b.png', hero);
        const followers = [first, second];
        gatherFollowers(followers, hero);
        hero.x = 1;
        updateFollowers(followers, hero);
        // 第一个已经跟上到 (0,0)，第二个还在 (1,0) 之外：先把第一个挪到勇士旧位置
        expect(first).toMatchObject({ x: 0, y: 0 });
        hero.x = 2;
        updateFollowers(followers, hero);
        expect(first).toMatchObject({ x: 1, y: 0 });
        expect(second).toMatchObject({ x: 0, y: 0 });
    });

    test('原地不动时 stop 为真，不会越位', () => {
        const hero = heroAt(5, 5);
        const follower = createFollower('a.png', hero);
        const followers = [follower];
        updateFollowers(followers, hero);
        expect(follower.stop).toBe(true);
        expect([follower.x, follower.y]).toEqual([5, 5]);
    });
});
