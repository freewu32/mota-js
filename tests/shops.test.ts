import { describe, expect, test } from 'bun:test';
import {
    buildShopChoices,
    MotaShops,
    SHOP_LEAVE_TEXT,
    type ShopData,
    type ShopsHost,
} from '../src/engine/modules/shops';
import type { ChoiceItem, ScriptAction, ScriptActionObject } from '../src/engine/modules/events';

const shop: ShopData = {
    id: 'shop1',
    text: '金币商店',
    textInList: '1F金币商店',
    choices: [
        { text: '生命+800', need: 'status:money>=20', action: { type: 'tip', text: '买到了' } },
        { text: '隐藏项', condition: 'status:money>=100', action: { type: 'tip', text: '隐藏' } },
    ],
};

function makeHost(overrides: Partial<ShopsHost> = {}) {
    const flags: Record<string, unknown> = { __shops__: {} };
    const opened: ScriptAction[][] = [];
    const recorded: string[] = [];
    const inserted: [string, unknown[]][] = [];
    const base: ShopsHost = {
        all: () => [shop],
        get: (id) => (id === shop.id ? shop : undefined),
        getFlag: (name, fallback) => flags[name] ?? fallback ?? null,
        setFlag: (name, value) => void (flags[name] = value),
        quickShopAllowed: () => true,
        run: (actions) => {
            opened.push(Array.isArray(actions) ? [...actions] : [actions]);
        },
        record: (token) => void recorded.push(token),
        evaluate: () => true,
        insertCommonEvent: (name, args) => void inserted.push([name, args]),
        ...overrides,
    };
    return { host: base, flags, opened, recorded, inserted };
}

/** 从 `buildScript` 的 while(true) 里取出 choices 动作的选项 */
function shopChoices(script: ScriptAction[]): ChoiceItem[] {
    const loop = script[0] as ScriptActionObject;
    const body = loop.data as ScriptActionObject[];
    return body[0]!.choices as ChoiceItem[];
}

describe('buildShopChoices', () => {
    test('正常模式：买得起的选项带「商店」音效，末尾补「离开」', () => {
        const choices = buildShopChoices(shop, { evaluate: () => true });
        expect(choices).toHaveLength(3);
        expect(choices[0]!.text).toBe('生命+800');
        expect(choices[0]!.action).toEqual([
            { type: 'playSound', name: '商店' },
            { type: 'tip', text: '买到了' },
        ]);
        expect(choices[2]!.text).toBe(SHOP_LEAVE_TEXT);
        expect(choices[2]!.action).toEqual([
            { type: 'playSound', name: '取消' },
            { type: 'break' },
        ]);
    });

    test('买不起：灰掉并换成「购买条件不足」提示', () => {
        const choices = buildShopChoices(shop, { evaluate: () => false });
        expect(choices[0]!.color).toEqual([153, 153, 153, 1]);
        expect(choices[0]!.action).toEqual([
            { type: 'playSound', name: '操作失败' },
            { type: 'tip', text: '购买条件不足' },
        ]);
    });

    test('预览模式：所有选项都不可购买', () => {
        const choices = buildShopChoices(shop, { preview: true, evaluate: () => true });
        expect(choices[0]!.action).toEqual([
            { type: 'playSound', name: '操作失败' },
            { type: 'tip', text: '预览模式下不可购买' },
        ]);
    });

    test('condition 不满足的选项直接不显示', () => {
        const evaluated: string[] = [];
        const choices = buildShopChoices(shop, {
            evaluate: (expression) => {
                evaluated.push(expression);
                return expression !== 'status:money>=100';
            },
        });
        expect(choices.map((one: ChoiceItem) => one.text)).toEqual(['生命+800', SHOP_LEAVE_TEXT]);
        expect(evaluated).toContain('status:money>=100');
    });

    test('选项动作写成数组时会被展开', () => {
        const list: ShopData = {
            ...shop,
            choices: [
                {
                    text: '一项',
                    action: [
                        { type: 'tip', text: 'a' },
                        { type: 'tip', text: 'b' },
                    ],
                },
            ],
        };
        const choices = buildShopChoices(list, { evaluate: () => true });
        expect(choices[0]!.action).toEqual([
            { type: 'playSound', name: '商店' },
            { type: 'tip', text: 'a' },
            { type: 'tip', text: 'b' },
        ]);
    });
});

describe('MotaShops', () => {
    test('访问状态记在 flags.__shops__ 里', () => {
        const { host, flags } = makeHost();
        const shops = new MotaShops(host);
        expect(shops.isVisited('shop1')).toBe(false);
        shops.setVisited('shop1', true);
        expect(shops.isVisited('shop1')).toBe(true);
        expect((flags.__shops__ as Record<string, { visited?: boolean }>).shop1?.visited).toBe(
            true,
        );
        shops.setVisited('shop1', false);
        expect(shops.isVisited('shop1')).toBe(false);
    });

    test('未访问且 mustEnable 的商店不可打开', () => {
        const must: ShopData = { ...shop, mustEnable: true };
        const { host } = makeHost({ all: () => [must], get: () => must });
        const shops = new MotaShops(host);
        expect(shops.canOpen('shop1')).toBe(false);
        expect(shops.listIds()).toEqual([]);
        shops.setVisited('shop1', true);
        expect(shops.canOpen('shop1')).toBe(true);
        expect(shops.listIds()).toEqual(['shop1']);
    });

    test('打开会记录像并进入预览模式', () => {
        const { host, opened, recorded } = makeHost();
        const shops = new MotaShops(host);
        expect(shops.open('shop1')).toBe(true);
        expect(recorded).toEqual(['shop:shop1']);
        const script = opened[0]!;
        expect(script).toHaveLength(1);
        expect(script[0]).toMatchObject({ type: 'while', condition: 'true' });
        // 未访问 -> 预览：选项都是「预览模式下不可购买」
        expect(shopChoices(script)[0]!.action).toContainEqual({
            type: 'tip',
            text: '预览模式下不可购买',
        });
    });

    test('访问过之后正常售卖；noRoute 不重复记录像', () => {
        const { host, opened, recorded } = makeHost();
        const shops = new MotaShops(host);
        shops.setVisited('shop1', true);
        expect(shops.open('shop1', true)).toBe(true);
        expect(recorded).toEqual([]);
        expect(shopChoices(opened[0]!)[0]!.action).toContainEqual({
            type: 'playSound',
            name: '商店',
        });
    });

    test('快捷商店受楼层限制', () => {
        const { host } = makeHost({ quickShopAllowed: () => false });
        const shops = new MotaShops(host);
        expect(shops.canUseQuickShop('shop1')).toBe('当前楼层不能使用快捷商店。');
    });

    test('openShop 动作：默认只开启商店，open 为真才弹界面', () => {
        const { host, opened } = makeHost();
        const shops = new MotaShops(host);
        expect(shops.handleScriptAction({ type: 'openShop', id: 'shop1' })).toBe(true);
        expect(shops.isVisited('shop1')).toBe(true);
        expect(opened).toHaveLength(0);

        expect(shops.handleScriptAction({ type: 'openShop', id: 'shop1', open: true })).toBe(true);
        expect(opened).toHaveLength(1);
    });

    test('commonEvent 商店改插公共事件', () => {
        const common: ShopData = { ...shop, commonEvent: 'myShop', args: [1] };
        const { host, inserted } = makeHost({
            all: () => [common],
            get: () => common,
        });
        const shops = new MotaShops(host);
        // commonEvent 商店与旧版一致：必须先访问过（canOpenShop 里 commonEvent 视为未开启）
        expect(shops.open('shop1')).toBe(false);
        shops.setVisited('shop1', true);
        expect(shops.open('shop1', true)).toBe(true);
        expect(inserted).toEqual([['myShop', [1]]]);
    });
});

describe('MotaShops 剧本展示需要的入口', () => {
    test('buildScript 的选项来自宿主求值', () => {
        const { host } = makeHost({ evaluate: (expr: string) => expr === 'status:money>=20' });
        const shops = new MotaShops(host);
        const choices = shopChoices(shops.buildScript('shop1', false));
        // 第一项买得起（need 满足），第二项 condition 不满足被过滤 -> 只剩一项 + 离开
        expect(choices).toHaveLength(2);
        expect(choices[0]!.action).toContainEqual({ type: 'playSound', name: '商店' });
        expect(choices[1]!.text).toBe(SHOP_LEAVE_TEXT);

        // 把 condition 也放行，就能看到「购买条件不足」那一支
        const loose = makeHost({ evaluate: (expr: string) => expr === 'status:money>=100' });
        const choices2 = shopChoices(new MotaShops(loose.host).buildScript('shop1', false));
        expect(choices2[0]!.action).toContainEqual({ type: 'tip', text: '购买条件不足' });
    });
});
