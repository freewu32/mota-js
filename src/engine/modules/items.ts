/**
 * 道具与装备。
 *
 * 迁移自旧 `libs/items.js`。旧实现把道具效果写成 JS 字符串再用 `eval` 执行，
 * 新实现把效果改为**剧本动作列表**（与 `events.ts` 同一套词汇），条件改为
 * **表达式字符串**（交给 `values.ts` 求值），因此这里不再有 `eval`。
 *
 * 效果字段：
 * - `itemEffect`：即捡即用类（`cls: 'items'`）拾取时的效果，按数量执行多次；
 * - `useItemEffect` / `useItemEvent`：从背包使用时的效果与后续剧本；
 * - `canUseItemEffect`：能否使用 / 能否装备的条件表达式；
 * - `itemEffectTip` / `useItemTip`：拾取 / 使用提示文本（支持 `${表达式}`）。
 */
import type { ScriptAction } from './events';
import { isScriptRef } from './scripts';
import type { HeroState } from '../types';
import {
    addItem as bagAddItem,
    itemBag,
    itemCount as bagItemCount,
    removeItem as bagRemoveItem,
    type ItemData,
} from './control';
import { addBuff, type StatusName } from './status';
import {
    applyOperator,
    evaluateCondition,
    evaluateValue,
    replaceText,
    type ValueScope,
} from './values';

/** 道具效果脚本：单个动作或动作列表 */
export type ItemScript = ScriptAction | ScriptAction[];

/** 装备属性：按「数值 / 百分比」两组存放，键为勇士属性名 */
export interface EquipValue {
    value?: Record<string, number>;
    percentage?: Record<string, number>;
}

export interface EquipInfo extends EquipValue {
    /** 装备类型：数字为槽位下标，字符串按 `equipName` 解析 */
    type?: number | string;
    [key: string]: unknown;
}

/** 道具模块要用到的宿主能力 */
export interface ItemsHost {
    hero: HeroState;
    items: Record<string, ItemData>;
    flags: Record<string, unknown>;
    values: Record<string, unknown>;
    /** 装备槽名（旧 `globalAttribute.equipName`） */
    equipName?: string[];
    /**
     * 展开 `{ script: '名字' }` 形式的效果：调用塔作者脚本并取其返回的动作。
     * 缺省时脚本引用视为无效果（并报错）。
     */
    expandScript?(name: string, context: { itemId: string; trigger: 'pickUp' | 'use' }): ItemScript;
    /** 交给剧本解释器执行效果脚本 */
    runScript(actions: ItemScript): void;
    /** 表达式求值作用域 */
    scope(prefix?: string): ValueScope;
    /** 记录录像路线（旧 `route.push`） */
    record?(token: string): void;
    /** 提示气泡（旧 `drawTip`） */
    tip?(text: string, icon?: string): void;
    /** 音效（旧 `playSound`），缺省时忽略 */
    playSound?(name: string): void;
}

/** 道具类别：旧数据的 `cls` 分为 constants / tools / equips / items */
export type ItemCls = 'constants' | 'tools' | 'equips' | 'items';

function itemCls(item: ItemData | undefined): ItemCls {
    return (item?.cls as ItemCls | undefined) ?? 'tools';
}

function equipInfo(item: ItemData | undefined): EquipInfo | undefined {
    return item?.equip as EquipInfo | undefined;
}

export class MotaItems {
    constructor(readonly host: ItemsHost) {}

    private get hero(): HeroState {
        return this.host.hero;
    }

    private item(id: string): ItemData | undefined {
        return this.host.items[id];
    }

    /* ------------------------------------------------------------------ *
     * 背包
     * ------------------------------------------------------------------ */

    count(id: string): number {
        return bagItemCount(this.hero, id);
    }

    has(id: string): boolean {
        return this.count(id) > 0;
    }

    /** 旧 `setItem`：设置为指定数量（0 表示删除） */
    set(id: string, num = 0): void {
        if (itemCls(this.item(id)) === 'items') return;
        const bag = itemBag(this.item(id)?.cls);
        this.hero.items[bag][id] = num;
        if (this.hero.items[bag][id] <= 0) delete this.hero.items[bag][id];
    }

    /** 旧 `addItem`：增减数量，永久道具只能有一个 */
    add(id: string, num = 1): void {
        const cls = itemCls(this.item(id));
        if (cls === 'items') return;
        bagAddItem(this.hero, id, num, this.item(id)?.cls);
        const bag = this.hero.items[itemBag(this.item(id)?.cls)];
        if ((bag[id] ?? 0) <= 0) delete bag[id];
        if (cls === 'constants' && (bag[id] ?? 0) > 1) bag[id] = 1;
    }

    remove(id: string, num = 1): boolean {
        return bagRemoveItem(this.hero, id, num);
    }

    /** 旧 `getItems`：道具表 + `flag:equipInfo` 上的装备改动（编辑器用） */
    list(): Record<string, ItemData> {
        const result: Record<string, ItemData> = {};
        for (const [id, item] of Object.entries(this.host.items)) {
            result[id] = { ...item, id } as ItemData;
        }
        const equipInfos = this.host.flags.equipInfo as Record<string, EquipInfo> | undefined;
        if (equipInfos) {
            for (const [id, info] of Object.entries(equipInfos)) {
                if (result[id]) result[id] = { ...result[id], equip: { ...info } };
            }
        }
        return result;
    }

    /* ------------------------------------------------------------------ *
     * 效果
     * ------------------------------------------------------------------ */

    /**
     * 执行效果。
     *
     * 效果既可以是剧本动作列表（数据驱动），也可以是 `{ script: '名字' }`
     * 引用塔作者脚本（脚本仅兜底）；脚本返回的动作同样由剧本解释器执行。
     */
    private runEffect(
        script: unknown,
        times = 1,
        context?: { itemId: string; trigger: 'pickUp' | 'use' },
    ): void {
        if (script == null) return;
        try {
            let actions = script as ItemScript;
            if (isScriptRef(script)) {
                if (!context || !this.host.expandScript) {
                    console.error(`脚本 ${script.script} 缺少执行上下文，已跳过`);
                    return;
                }
                actions = this.host.expandScript(script.script, context);
            }
            for (let i = 0; i < times; i += 1) this.host.runScript(actions);
        } catch (error) {
            console.error('道具效果执行失败：', error);
        }
    }

    /**
     * 拾取「即捡即用类」道具的效果。
     * 返回 true 表示已就地生效（不进入背包），与旧 `getItemEffect` 一致。
     */
    runPickUpEffect(id: string, count = 1): boolean {
        const item = this.item(id);
        if (itemCls(item) !== 'items') return false;
        const before = this.hero.hp;
        this.runEffect(item?.itemEffect, count, { itemId: id, trigger: 'pickUp' });
        const statistics = this.hero.statistics;
        if (statistics) statistics.hp += this.hero.hp - before;
        this.runEffect(item?.useItemEvent, 1, { itemId: id, trigger: 'pickUp' });
        return true;
    }

    /** 旧 `getItemEffectTip`：拾取提示文本 */
    effectTip(id: string): string {
        const item = this.item(id);
        if (itemCls(item) !== 'items') return '';
        const tip = item?.itemEffectTip;
        if (tip == null) return '';
        try {
            return replaceText(tip, this.host.scope()) || '';
        } catch (error) {
            console.error('道具提示求值失败：', error);
            return '';
        }
    }

    /** 旧 `canUseItem`：没有 `canUseItemEffect` 时视为不可用 */
    canUse(id: string): boolean {
        if (!this.has(id)) return false;
        const condition = this.item(id)?.canUseItemEffect;
        if (condition == null) return false;
        return evaluateCondition(condition, this.host.scope());
    }

    /**
     * 旧 `useItem`：从背包使用道具。
     * 返回是否真正使用（`canUseItemEffect` 不通过时什么都不做）。
     */
    use(id: string, noRoute = false): boolean {
        if (!this.canUse(id)) return false;
        const item = this.item(id);
        this.runEffect(item?.useItemEffect, 1, { itemId: id, trigger: 'use' });
        this.runEffect(item?.useItemEvent, 1, { itemId: id, trigger: 'use' });
        if (itemCls(item) === 'tools') this.remove(id, 1);
        if (!noRoute) this.host.record?.(`item:${id}`);
        return true;
    }

    /* ------------------------------------------------------------------ *
     * 装备
     * ------------------------------------------------------------------ */

    hasEquip(id: string): boolean {
        if (!equipInfo(this.item(id))) return false;
        return this.hero.equipment.includes(id);
    }

    currentEquip(type: number): string | null {
        return this.hero.equipment[type] ?? null;
    }

    /** 旧 `getEquipTypeByName`：同名的多个槽位里优先返回空槽，歧义时返回 -1 */
    equipTypeByName(name: string): number {
        const names = this.host.equipName ?? [];
        const types: number[] = [];
        for (let i = 0; i < names.length; i += 1) {
            if (names[i] !== name) continue;
            types.push(i);
            if (!this.hero.equipment[i]) return i;
        }
        return types.length === 1 ? types[0]! : -1;
    }

    equipTypeById(id: string): number {
        const type = equipInfo(this.item(id))?.type;
        if (typeof type === 'string') return this.equipTypeByName(type);
        return typeof type === 'number' ? type : -1;
    }

    /** 旧 `canEquip`：装备合法性 + 拥有 + `canUseItemEffect` 条件 */
    canEquip(id: string, hint = false): boolean {
        const item = this.item(id);
        const equip = equipInfo(item);
        if (!equip) {
            if (hint) {
                this.host.playSound?.('操作失败');
                this.host.tip?.('不合法的装备！');
            }
            return false;
        }
        if (!this.has(id) && !this.hasEquip(id)) {
            if (hint) {
                this.host.playSound?.('操作失败');
                this.host.tip?.(`你当前没有${item?.name ?? id}，无法换装`);
            }
            return false;
        }
        const condition = item?.canUseItemEffect;
        if (condition == null) return true;
        try {
            if (!evaluateCondition(condition, this.host.scope())) {
                if (hint) {
                    this.host.playSound?.('操作失败');
                    this.host.tip?.(`当前不可换上${item?.name ?? id}`);
                }
                return false;
            }
        } catch (error) {
            console.error(error);
            return false;
        }
        return true;
    }

    /**
     * 旧 `compareEquipment`：比较两件装备的属性差。
     * `value` 为数值差，`percentage` 为百分比差（换装时按加法叠加到增幅）。
     */
    compareEquip(equipId: string, comparedId: string | null): EquipValue {
        const result: Required<EquipValue> = { value: {}, percentage: {} };
        const first = equipInfo(this.item(equipId));
        const second = comparedId ? equipInfo(this.item(comparedId)) : undefined;
        for (const group of ['value', 'percentage'] as const) {
            for (const name of Object.keys(this.hero)) {
                if (typeof (this.hero as unknown as Record<string, unknown>)[name] !== 'number') {
                    continue;
                }
                const diff = (first?.[group]?.[name] ?? 0) - (second?.[group]?.[name] ?? 0);
                if (diff !== 0) result[group][name] = diff;
            }
        }
        return result;
    }

    /** 旧 `_loadEquipEffect`：把属性差应用到勇士身上 */
    applyEquipEffect(equipId: string | null, unloadId: string | null): void {
        const diff = this.compareEquip(equipId ?? '', unloadId);
        for (const [name, percent] of Object.entries(diff.percentage ?? {})) {
            addBuff(this.host.flags, name as StatusName, percent / 100);
        }
        for (const [name, value] of Object.entries(diff.value ?? {})) {
            const hero = this.hero as unknown as Record<string, number>;
            hero[name] = (hero[name] ?? 0) + value;
        }
    }

    /** 旧 `_realLoadEquip`：实际换装（不改动录像） */
    private realLoadEquip(
        type: number,
        loadId: string | null,
        unloadId: string | null,
        useSound = true,
    ): void {
        if (useSound) this.playEquipSound();
        this.applyEquipEffect(loadId, unloadId);
        if (loadId) this.remove(loadId, 1);
        if (unloadId) this.add(unloadId, 1);
        if (type >= 0) this.hero.equipment[type] = loadId ?? null;

        if (loadId) this.host.tip?.(`已装备上${this.item(loadId)?.name ?? loadId}`, loadId);
        else if (unloadId) {
            this.host.tip?.(`已卸下${this.item(unloadId)?.name ?? unloadId}`, unloadId);
        }
    }

    private playEquipSound(): void {
        if (this.host.flags.__quickLoadEquip__ === true) return;
        this.host.playSound?.('穿脱装备');
    }

    /** 旧 `loadEquip`：换上装备；返回是否成功 */
    equip(id: string): boolean {
        if (!this.canEquip(id, true)) return false;
        const type = this.equipTypeById(id);
        if (type < 0) {
            this.host.playSound?.('操作失败');
            this.host.tip?.(`当前没有${String(equipInfo(this.item(id))?.type)}的空位！`);
            return false;
        }
        this.realLoadEquip(type, id, this.hero.equipment[type] ?? null);
        return true;
    }

    /** 旧 `unloadEquip`：卸下某槽位 */
    unequip(type: number): boolean {
        const current = this.hero.equipment[type];
        if (!current) return false;
        this.realLoadEquip(type, null, current);
        return true;
    }

    /** 旧 `quickSaveEquip`：保存套装，并记入录像 */
    saveLoadout(index: number): void {
        const saves = (this.host.flags.saveEquips as ((string | null)[] | undefined)[]) ?? [];
        saves[index] = [...this.hero.equipment];
        this.host.flags.saveEquips = saves;
        this.host.record?.(`saveEquip:${index}`);
        this.host.tip?.(`已保存${index}号套装`);
    }

    /**
     * 旧 `quickLoadEquip`：读取套装。
     * 任一装备不满足条件时整体放弃；成功时记入录像并只播一次换装音效。
     */
    loadLoadout(index: number): boolean {
        const current = ((this.host.flags.saveEquips as
            ((string | null)[] | undefined)[] | undefined) ?? [])[index];
        if (!current) {
            this.host.playSound?.('操作失败');
            this.host.tip?.(`${index}号套装不存在`);
            return false;
        }
        const size = (this.host.equipName ?? []).length;
        for (let i = 0; i < size; i += 1) {
            const id = current[i];
            if (id && !this.canEquip(id, true)) return false;
        }
        this.host.record?.(`loadEquip:${index}`);
        this.host.flags.__quickLoadEquip__ = true;
        const toEquip: (string | null)[] = [];
        for (let i = 0; i < size; i += 1) {
            const now = this.hero.equipment[i];
            const to = current[i];
            if (now !== to) {
                toEquip.push(to ?? null);
                if (now) this.unequip(i);
            }
        }
        for (const id of toEquip) {
            if (id) this.equip(id);
        }
        delete this.host.flags.__quickLoadEquip__;
        this.playEquipSound();
        this.host.tip?.(`成功换上${index}号套装`);
        return true;
    }

    /** 旧 `setEquip`：修改装备属性；穿戴中则同步修正当前数值 */
    setEquip(
        id: string,
        valueType: 'value' | 'percentage',
        name: string,
        value: unknown,
        operator?: string,
        prefix?: string,
    ): void {
        const item = this.item(id);
        if (!item || item.cls !== 'equips') return;
        const equip = (item.equip as EquipInfo | undefined) ?? {};
        const group = (equip[valueType] as Record<string, number> | undefined) ?? {};
        const next: EquipInfo = {
            ...equip,
            [valueType]: {
                ...group,
                [name]: applyOperator(
                    operator,
                    group[name],
                    evaluateValue(value, this.host.scope(), prefix),
                ) as number,
            },
        };
        if (this.hasEquip(id)) {
            // 用一件临时装备模拟「改属性后重新穿上」的差值
            const tempId = `temp:${id}`;
            this.host.items[tempId] = { cls: 'equips', equip: next, name: item.name };
            this.applyEquipEffect(tempId, id);
            delete this.host.items[tempId];
        }
        item.equip = next;
        const infos = (this.host.flags.equipInfo as Record<string, EquipInfo> | undefined) ?? {};
        infos[id] = next;
        this.host.flags.equipInfo = infos;
    }
}
