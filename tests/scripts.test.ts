import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
    ScriptRegistry,
    collectScriptRefs,
    isScriptRef,
    toTowerScript,
    type ScriptContext,
} from '../src/engine/modules/scripts';
import { createGameApi, type GameApiHost } from '../src/engine/modules/game-api';
import { extractBlocks, type Block } from '../src/engine/modules/maps';
import type { FloorData, Maps } from '../src/shared/data/schema';
import type { HeroState } from '../src/engine/types';

describe('scripts 脚本引用', () => {
    test('isScriptRef 只认单键 { script }', () => {
        expect(isScriptRef({ script: 'items/bomb' })).toBe(true);
        expect(isScriptRef({ script: 1 })).toBe(false);
        expect(isScriptRef({ script: 'a', extra: 1 })).toBe(false);
        expect(isScriptRef('items/bomb')).toBe(false);
        expect(isScriptRef(null)).toBe(false);
        expect(isScriptRef([{ script: 'a' }])).toBe(false);
    });

    test('collectScriptRefs 递归收集数据里的脚本引用', () => {
        const data = {
            items: {
                bomb: { useItemEffect: { script: 'items/bomb' } },
                pickaxe: { useItemEffect: [{ type: 'tip', text: 'x' }] },
                skill: { useItemEvent: { script: 'items/skill' } },
            },
            floors: { f1: { events: { '0,0': [{ type: 'tip', text: 'y' }] } } },
            nested: [{ deep: { script: 'items/bomb' } }],
        };
        expect(collectScriptRefs(data).sort()).toEqual(['items/bomb', 'items/skill']);
    });
});

describe('scripts 注册表', () => {
    test('注册、查询与清空', () => {
        const registry = new ScriptRegistry();
        const script = (): void => {};
        registry.register('a', script);
        expect(registry.has('a')).toBe(true);
        expect(registry.get('a')).toBe(script);
        expect(registry.size).toBe(1);
        expect(registry.names).toEqual(['a']);
        registry.clear();
        expect(registry.size).toBe(0);
    });

    test('toTowerScript 支持函数与模块默认导出', () => {
        const fn = (): void => {};
        expect(toTowerScript(fn)).toBe(fn);
        expect(toTowerScript({ default: fn })).toBe(fn);
        expect(toTowerScript({ default: 1 })).toBeNull();
        expect(toTowerScript('a')).toBeNull();
        expect(toTowerScript(null)).toBeNull();
    });

    test('loadAll 加载模块默认导出', async () => {
        const registry = new ScriptRegistry();
        const failed = await registry.loadAll(['items/bomb'], () => ({
            default: () => [{ type: 'tip', text: 'boom' }],
        }));
        expect(failed).toEqual([]);
        expect(registry.has('items/bomb')).toBe(true);
        const script = registry.get('items/bomb')!;
        expect(script({ api: {} as never, trigger: 'use' })).toEqual([
            { type: 'tip', text: 'boom' },
        ]);
    });

    test('loadAll 报告加载失败与无默认导出', async () => {
        const registry = new ScriptRegistry();
        const failed = await registry.loadAll(['a', 'b', 'c'], (name) => {
            if (name === 'a') throw new Error('模块不存在');
            if (name === 'b') return { nope: 1 };
            return () => {};
        });
        expect(failed).toEqual(['a', 'b']);
        expect(registry.has('c')).toBe(true);
    });

    test('loadAll 跳过已注册的脚本', async () => {
        const registry = new ScriptRegistry();
        registry.register('a', () => {});
        let calls = 0;
        await registry.loadAll(['a'], () => {
            calls += 1;
            return () => {};
        });
        expect(calls).toBe(0);
    });
});

/* ---------------- GameApi ---------------- */

const maps: Maps = {
    '0': { cls: 'terrains', id: 'ground' },
    '2': { cls: 'animates', id: 'wall' },
    '3': { cls: 'terrains', id: 'upFloor', canPass: true },
    '10': { cls: 'items', id: 'redPotion' },
    '12': { cls: 'animates', id: 'yellowDoor' },
};

const floors: Record<string, FloorData> = {
    f1: {
        floorId: 'f1',
        title: '一层',
        name: '1',
        map: [
            [10, 2],
            [0, 12],
        ],
        width: 2,
        height: 2,
    } as FloorData,
    f2: {
        floorId: 'f2',
        title: '二层',
        name: '2',
        map: [
            [0, 0],
            [0, 0],
        ],
        width: 2,
        height: 2,
    } as FloorData,
};

interface ApiHarness {
    api: ReturnType<typeof createGameApi>;
    hero: HeroState;
    flags: Record<string, unknown>;
    actions: unknown[];
    effects: { type: string; data: Record<string, unknown> }[];
    inserted: unknown[];
    cache: Record<string, Block[]>;
    removed: string[];
}

function makeApi(): ApiHarness {
    const hero: HeroState = {
        x: 0,
        y: 1,
        direction: 'up',
        hp: 100,
        atk: 50,
        def: 10,
        mdef: 0,
        money: 0,
        exp: 0,
        lv: 1,
        steps: 0,
        items: { constants: {}, tools: { redPotion: 2 }, equips: {} },
        equipment: [],
    };
    const flags: Record<string, unknown> = { skill: 0 };
    const cache: Record<string, Block[]> = {};
    const effects: ApiHarness['effects'] = [];
    const actions: unknown[] = [];
    const inserted: unknown[] = [];
    const removed: string[] = [];
    const host: GameApiHost = {
        hero,
        flags,
        values: { hatred: 2 },
        items: { redPotion: { name: '红血瓶', cls: 'tools' } },
        enemys: { slime: { name: '史莱姆' } },
        floorId: 'f1',
        floorIds: ['f1', 'f2'],
        getFloor: (id) => floors[id],
        getBlocks: (id) => (cache[id] ??= extractBlocks(floors[id] as FloorData, maps, {})),
        evaluate: () => 0,
        writeValue: (name, value) => {
            if (name.startsWith('flag:')) flags[name.slice(5)] = value;
        },
        runAction: (value) => void actions.push(value),
        insertAction: (value) => void inserted.push(value),
        changeFloor: (floorId, loc) => {
            removed.push(`changeFloor:${floorId}:${loc?.join(',')}`);
        },
        setBlock: (floorId, x, y, numberOrId) =>
            void removed.push(`setBlock:${floorId}:${x},${y}:${numberOrId}`),
        setBlockDisabled: (floorId, x, y, disabled) => {
            removed.push(`setBlockDisabled:${floorId}:${x},${y}:${disabled}`);
            const block = host.getBlocks(floorId).find((one) => one.x === x && one.y === y);
            if (block) block.disable = disabled;
            return true;
        },
        addItem: () => {},
        moveBlock: (x, y, steps, time, keep) => {
            removed.push(`moveBlock:${x},${y}:${JSON.stringify(steps)}:${time}:${keep}`);
            return true;
        },
        removeItem: () => true,
        useItem: () => true,
        canUseItem: () => true,
        equip: () => true,
        unequip: () => true,
        effect: (type, data) => void effects.push({ type, data }),
    };
    return { api: createGameApi(host), hero, flags, actions, effects, inserted, cache, removed };
}

describe('GameApi 只读查询', () => {
    test('方位与地图尺寸', () => {
        const { api } = makeApi();
        expect(api.nextX()).toBe(0);
        expect(api.nextY()).toBe(0);
        expect(api.mapWidth()).toBe(2);
        expect(api.mapHeight('f2')).toBe(2);
    });

    test('图块查询与统计', () => {
        const { api } = makeApi();
        expect(api.blockId(0, 0)).toBe('redPotion');
        expect(api.blockNumber(0, 0)).toBe(10);
        expect(api.blockCls(1, 0)).toBe('animates');
        expect(api.blockAt(1, 1)?.event.id).toBe('yellowDoor');
        expect(api.blockAt(1, 0)?.event.id).toBe('wall');
        expect(api.blockCount('yellowDoor')).toBe(1);
        expect(api.searchBlocks('animates').map((b) => b.event.id)).toEqual(['wall', 'yellowDoor']);
        expect(api.blockAt(0, 0, 'f2')).toBeNull();
    });

    test('楼层顺序与楼梯', () => {
        const { api } = makeApi();
        expect(api.floorId).toBe('f1');
        expect(api.floorIds).toEqual(['f1', 'f2']);
        expect(api.floorIndex()).toBe(0);
        expect(api.floorCount()).toBe(2);
        expect(api.floorIdOffset(1)).toBe('f2');
        expect(api.floorIdOffset(-1)).toBeNull();
        // (0,1) 与 upFloor 不相邻
        expect(api.nearStair()).toBe(false);
    });

    test('状态与值块读写', () => {
        const { api, flags } = makeApi();
        expect(api.hero.hp).toBe(100);
        expect(api.getStatus('atk')).toBe(50);
        expect(api.getFlag('skill')).toBe(0);
        expect(api.getFlag('none', 7)).toBe(7);
        api.setFlag('skill', 1);
        expect(flags['skill']).toBe(1);
        api.set('flag:skill', 2);
        expect(flags['skill']).toBe(2);
    });

    test('道具与装备操作转交模块', () => {
        const { api } = makeApi();
        expect(api.itemName('redPotion')).toBe('红血瓶');
        expect(api.enemyName('slime')).toBe('史莱姆');
        expect(api.itemCount('redPotion')).toBe(2);
        expect(api.hasItem('redPotion')).toBe(true);
        expect(api.hasItem('yellowKey')).toBe(false);
    });

    test('移除图块返回是否成功', () => {
        const { api } = makeApi();
        expect(api.removeBlock(1, 0)).toBe(true);
        expect(api.blockId(1, 0)).toBeNull();
        expect(api.removeBlock(1, 0)).toBe(false);
        expect(api.removeBlock(9, 9)).toBe(false);
    });
});

describe('GameApi 写操作与呈现', () => {
    test('剧本动作注入', () => {
        const { api, actions, inserted } = makeApi();
        api.runAction({ type: 'tip', text: 'x' });
        api.insertAction([{ type: 'tip', text: 'y' }]);
        expect(actions).toHaveLength(1);
        expect(inserted).toHaveLength(1);
    });

    test('换层与改图块转交宿主', () => {
        const { api, removed } = makeApi();
        api.changeFloor('f2', [1, 1]);
        api.changeFloor(null);
        api.setBlock(0, 0, 'yellowDoor');
        expect(removed).toEqual([
            'changeFloor:f2:1,1',
            'changeFloor:null:undefined',
            'setBlock:f1:0,0:yellowDoor',
        ]);
    });

    test('提示、音效与面板都走呈现层', () => {
        const { api, effects } = makeApi();
        api.tip('获得 红血瓶', 'redPotion');
        api.playSound('炸弹');
        api.openPanel('monsterManual');
        expect(effects).toEqual([
            { type: 'tip', data: { text: '获得 红血瓶', icon: 'redPotion' } },
            { type: 'playSound', data: { name: '炸弹' } },
            { type: 'openPanel', data: { panel: 'monsterManual' } },
        ]);
    });
});

describe('脚本上下文', () => {
    test('脚本可通过 api 改状态并返回动作', () => {
        const { api, flags } = makeApi();
        const context: ScriptContext = { api, itemId: 'redPotion', trigger: 'use' };
        const script = (ctx: ScriptContext): unknown[] => {
            ctx.api.setFlag('used', ctx.itemId ?? '');
            return [{ type: 'tip', text: `${ctx.api.itemName(ctx.itemId ?? '')}使用成功` }];
        };
        expect(script(context)).toEqual([{ type: 'tip', text: '红血瓶使用成功' }]);
        expect(flags['used']).toBe('redPotion');
    });
});

describe('mota.d.ts 类型声明', () => {
    test('GameApi 声明与实现字段一一对应', () => {
        const text = readFileSync(new URL('../mota.d.ts', import.meta.url), 'utf8');
        const start = text.indexOf('export interface GameApi {');
        expect(start).toBeGreaterThan(-1);
        const body = text.slice(start, text.indexOf('\n    }', start));
        const declared = [...body.matchAll(/^ {8}(?:readonly )?([A-Za-z_$][\w$]*)\s*[(:<]/gm)].map(
            (match) => match[1] as string,
        );
        expect(declared.length).toBeGreaterThan(20);
        expect(declared.sort()).toEqual(Object.keys(makeApi().api).sort());
    });
});
