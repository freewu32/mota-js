import { describe, expect, test } from 'bun:test';
import {
    addBuff,
    addStatus,
    getBuff,
    getRealStatusOrDefault,
    getStatus,
    getStatusOrDefault,
    setBuff,
    triggerDebuff,
} from '../src/engine/modules/status';
import type { HeroState } from '../src/engine/types';

function hero(): HeroState {
    return {
        x: 0,
        y: 0,
        direction: 'up',
        hp: 100,
        atk: 20,
        def: 10,
        mdef: 4,
        money: 0,
        exp: 0,
        lv: 1,
        steps: 0,
        items: { constants: {}, tools: {}, equips: {} },
        equipment: [],
    };
}

describe('status', () => {
    test('getStatus / getStatusOrDefault 向下取整', () => {
        const h = hero();
        h.atk = 20.9;
        expect(getStatus(h, 'atk')).toBe(20);
        expect(getStatusOrDefault(h, { atk: 7.8 }, 'atk')).toBe(7);
        expect(getStatusOrDefault(h, null, 'atk')).toBe(20);
    });

    test('增幅默认 1，setBuff 保留三位小数', () => {
        const flags: Record<string, unknown> = {};
        expect(getBuff(flags, 'atk')).toBe(1);
        setBuff(flags, 'atk', 1.23456);
        expect(getBuff(flags, 'atk')).toBe(1.235);
        addBuff(flags, 'atk', 0.5);
        expect(getBuff(flags, 'atk')).toBe(1.735);
    });

    test('getRealStatusOrDefault 叠加增幅', () => {
        const flags: Record<string, unknown> = {};
        setBuff(flags, 'atk', 1.5);
        expect(getRealStatusOrDefault(hero(), flags, null, 'atk')).toBe(30);
        expect(getRealStatusOrDefault(hero(), flags, { atk: 10 }, 'atk')).toBe(15);
    });

    test('addStatus 修改勇士属性', () => {
        const h = hero();
        addStatus(h, 'def', 5);
        expect(h.def).toBe(15);
        addStatus(h, 'def', -3);
        expect(h.def).toBe(12);
    });

    test('衰弱 weakValue>=1 时直接扣攻防，解除时恢复', () => {
        const flags: Record<string, unknown> = {};
        const h = hero();
        triggerDebuff(flags, h, { weakValue: 5 }, 'get', 'weak');
        expect(h.atk).toBe(15);
        expect(h.def).toBe(5);
        expect(flags.weak).toBe(true);
        triggerDebuff(flags, h, { weakValue: 5 }, 'remove', 'weak');
        expect(h.atk).toBe(20);
        expect(h.def).toBe(10);
    });

    test('衰弱 weakValue<1 时按比例，重复获得不叠加', () => {
        const flags: Record<string, unknown> = {};
        const h = hero();
        triggerDebuff(flags, h, { weakValue: 0.5 }, 'get', 'weak');
        expect(getBuff(flags, 'atk')).toBe(0.5);
        triggerDebuff(flags, h, { weakValue: 0.5 }, 'get', 'weak');
        expect(getBuff(flags, 'atk')).toBe(0.5); // 已衰弱，不再扣
        expect(h.atk).toBe(20); // 数值未变
    });

    test('毒 / 咒获得与解除', () => {
        const flags: Record<string, unknown> = {};
        const h = hero();
        triggerDebuff(flags, h, {}, 'get', ['poison', 'curse']);
        expect(flags.poison).toBe(true);
        expect(flags.curse).toBe(true);
        triggerDebuff(flags, h, {}, 'remove', ['poison']);
        expect(flags.poison).toBe(false);
        expect(flags.curse).toBe(true);
    });
});
