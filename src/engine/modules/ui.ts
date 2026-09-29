/**
 * UI 呈现层。
 *
 * 旧 `libs/ui.js` 是 3500 行的 canvas 绘制库（窗口皮肤、逐字打字机、怪物手册、
 * 工具提示、选择光标…）。新方案把对话框 / 状态栏改为 DOM 呈现，因此这里只保留
 * 与"画"无关的部分，并把它拆成两层：
 *
 * 1. 纯函数与数据模型：富文本标记解析（对齐旧 `drawTextContent` 系列）、
 *    状态栏数值模型、怪物手册文本、动画时钟。可脱离 DOM 单测。
 * 2. `DialogView` 抽象 + `DialogController` 状态机：打字机、选择项、确认框、
 *    输入框、提示队列。控制器实现 `EventPresenter`，逻辑用
 *    `createMemoryDialogView()` 在 bun test 中验证；浏览器端由
 *    `createDomDialogView(root)` 提供。
 */

import type { HeroState } from '../types';
import { itemBag, itemCount, type ItemClass, type ItemData } from './control';
import type { ChoiceItem, ScriptActionObject } from './events';
import { getRealStatus, hasFlag } from './status';

////// ---------- 数字格式化（旧 utils.setTwoDigits / formatBigNumber） ---------- //////

/** 旧 `core.setTwoDigits`：0-9 补前导零，其余原样 */
export function setTwoDigits(x: number | string): string {
    const n = parseInt(String(x), 10);
    return n >= 0 && n < 10 ? `0${x}` : String(x);
}

const BIG_NUMBER_UNITS = [
    { val: 1e4, suffix: 'w' },
    { val: 1e8, suffix: 'e' },
    { val: 1e12, suffix: 'z' },
    { val: 1e16, suffix: 'j' },
    { val: 1e20, suffix: 'g' },
];

/** 旧 `core.formatBigNumber`：大数用 w/e/z/j/g 后缀，溢出时转科学记数法 */
export function formatBigNumber(x: number | string, digits?: number | boolean): string {
    let total = digits === true ? 5 : (digits ?? 6); // 兼容旧版 onMap 传 true
    if (!total || total < 5) total = 6;
    let value = Math.trunc(parseFloat(String(x))); // 尝试识别为小数，然后向 0 取整
    if (!Number.isFinite(value)) return '???';
    if (Math.abs(value) > 1e20 * Math.pow(10, total - 2)) return value.toExponential(0);

    const sign = value < 0 ? '-' : '';
    if (sign) total--;
    value = Math.abs(value);
    if (value < Math.pow(10, total)) return sign + value;

    for (const unit of BIG_NUMBER_UNITS) {
        let text = (value / unit.val).toFixed(total).substring(0, total);
        if (!text.includes('.')) continue;
        text = text.substring(0, text[text.length - 2] === '.' ? text.length - 2 : text.length - 1);
        return sign + text + unit.suffix;
    }
    return sign + value.toExponential(0);
}

////// ---------- 富文本标记 ---------- //////

export interface RichTextStyle {
    color?: string;
    bold?: boolean;
    italic?: boolean;
    fontSize?: number;
    font?: string;
}

/**
 * 解析后的行内节点。旧引擎把每个字符画到临时画布再按块拷贝（为了打字机效果），
 * DOM 层不需要这一层，直接产出节点列表。
 */
export type RichNode =
    | ({ type: 'text'; text: string } & RichTextStyle)
    | { type: 'break' }
    | { type: 'space'; count: number }
    | { type: 'icon'; id: string }
    | { type: 'position'; position: string; target: string | null };

function styleOf(node: RichNode): RichTextStyle {
    const { color, bold, italic, fontSize, font } = node as RichTextStyle;
    return { color, bold, italic, fontSize, font };
}

function sameStyle(a: RichNode, b: RichTextStyle): boolean {
    const s = styleOf(a);
    return (
        s.color === b.color &&
        !!s.bold === !!b.bold &&
        !!s.italic === !!b.italic &&
        s.fontSize === b.fontSize &&
        s.font === b.font
    );
}

/**
 * 解析旧版文本标记（对齐 `_drawTextContent_drawChar`）：
 * `\n` 换行、`\r[#RRGGBB]` 变色（`\r[]` 复位）、`\d` 粗体、`\e` 斜体、
 * `\c[16]` 字号、`\g[font]` 字体、`\z[2]` 空位、`\i[item]` 行内图标、
 * `\b[up,x,y]` 文本框位置。`\\` 前缀与单反斜杠写法都支持。
 */
export function parseRichText(text: string, defaults: RichTextStyle = {}): RichNode[] {
    const nodes: RichNode[] = [];
    let style: RichTextStyle = { ...defaults };
    let i = 0;

    const pushText = (ch: string): void => {
        const last = nodes[nodes.length - 1];
        if (last && last.type === 'text' && sameStyle(last, style)) {
            last.text += ch;
            return;
        }
        nodes.push({ type: 'text', text: ch, ...style });
    };
    /** 读取 `[...]` 内容，返回内容并把游标移到 `]` 之后 */
    const readBracket = (): string | null => {
        if (text.charAt(i) !== '[') return null;
        const end = text.indexOf(']', i);
        if (end < 0) return null;
        const inner = text.substring(i + 1, end);
        i = end + 1;
        return inner;
    };

    while (i < text.length) {
        const ch = text.charAt(i++);
        const escaped = ch === '\\' && i < text.length;
        const code = escaped ? text.charAt(i) : ch;

        if (ch === '\n' || (escaped && code === 'n')) {
            if (escaped) i++;
            nodes.push({ type: 'break' });
            continue;
        }
        if (ch === '\r' || (escaped && code === 'r')) {
            if (escaped) i++;
            const inner = readBracket();
            style = { ...style, color: inner ? inner : defaults.color };
            continue;
        }
        if (escaped && (code === 'd' || code === 'e')) {
            i++;
            style =
                code === 'd'
                    ? { ...style, bold: !style.bold }
                    : { ...style, italic: !style.italic };
            continue;
        }
        if (escaped && code === 'c') {
            i++;
            const inner = readBracket();
            const size = inner && /^\d+$/.test(inner) ? parseInt(inner, 10) : defaults.fontSize;
            style = { ...style, fontSize: size };
            continue;
        }
        if (escaped && code === 'g') {
            i++;
            const inner = readBracket();
            style = { ...style, font: inner ? inner : defaults.font };
            continue;
        }
        if (escaped && code === 'z') {
            i++;
            const inner = readBracket();
            const count = inner && /^\d+$/.test(inner) ? parseInt(inner, 10) : 1;
            nodes.push({ type: 'space', count });
            continue;
        }
        if (escaped && code === 'i') {
            i++;
            const inner = readBracket();
            if (inner == null) {
                pushText(ch);
                continue;
            }
            nodes.push({ type: 'icon', id: inner });
            continue;
        }
        // 旧编辑器把 `\b` 写成了 JSON 转义，读出来是退格符 U+0008，两种都要认
        if (ch === '\u0008' || (escaped && code === 'b')) {
            if (escaped) i++;
            const inner = readBracket();
            if (inner == null) {
                pushText(ch);
                continue;
            }
            // 只切第一个逗号：`up,3,4` 的坐标部分要保持完整
            const comma = inner.indexOf(',');
            nodes.push({
                type: 'position',
                position: comma < 0 ? inner : inner.slice(0, comma),
                target: comma < 0 ? null : inner.slice(comma + 1),
            });
            continue;
        }
        pushText(ch);
    }
    return nodes;
}

/** 打字机进度用的可见长度：文字按字数，空位按个数，图标按 1，位置标记与换行不计 */
export function richTextLength(nodes: readonly RichNode[]): number {
    let length = 0;
    for (const node of nodes) {
        if (node.type === 'text') length += node.text.length;
        else if (node.type === 'space') length += node.count;
        else if (node.type === 'icon') length += 1;
    }
    return length;
}

/** 截取前 `length` 个可见单位，用于打字机效果 */
export function sliceRichText(nodes: readonly RichNode[], length: number): RichNode[] {
    const result: RichNode[] = [];
    let used = 0;
    for (const node of nodes) {
        if (used >= length) break;
        if (node.type === 'text') {
            const take = Math.min(node.text.length, length - used);
            if (take > 0) result.push({ ...node, text: node.text.slice(0, take) });
            used += take;
        } else if (node.type === 'space') {
            const take = Math.min(node.count, length - used);
            result.push({ type: 'space', count: take });
            used += take;
        } else if (node.type === 'icon') {
            result.push(node);
            used += 1;
        } else {
            result.push(node);
        }
    }
    return result;
}

/** 丢掉标记后的纯文本，便于测试与日志 */
export function richTextToPlain(nodes: readonly RichNode[]): string {
    let text = '';
    for (const node of nodes) {
        if (node.type === 'text') text += node.text;
        else if (node.type === 'space') text += ' '.repeat(node.count);
        else if (node.type === 'break') text += '\n';
        else if (node.type === 'icon') text += `[${node.id}]`;
    }
    return text;
}

/** 取第一个文本框位置标记（`\b[up,3,4]`） */
export function findPosition(
    nodes: readonly RichNode[],
): { position: string; target: string | null } | null {
    for (const node of nodes) {
        if (node.type === 'position') return { position: node.position, target: node.target };
    }
    return null;
}

export interface TextMarkers {
    /** 去掉标题标记后的正文 */
    text: string;
    title: string | null;
    icon: string | null;
}

/**
 * 旧 `_getTitleAndIcon`：抽取 `\t[图标]` / `\t[标题,图标]` 标记作为对话框标题与头像，
 * 并从正文中去掉。`icon` 为 `hero` 时表示勇士头像。
 */
export function extractTextMarkers(text: string): TextMarkers {
    let title: string | null = null;
    let icon: string | null = null;
    const body = text.replace(
        /(\t|\\t)\[(([^\],]+),)?([^\],]+)\]/g,
        (_all, _tab, _pair, name, id) => {
            if (id === 'hero' || id === 'null') icon = null;
            else icon = id;
            if (name != null) title = name === 'null' ? null : name;
            else if (id !== 'hero' && id !== 'null') title = id;
            return '';
        },
    );
    return { text: body, title, icon };
}

////// ---------- 状态栏模型 ---------- //////

export type StatusBarSlot =
    | 'floor'
    | 'name'
    | 'lv'
    | 'hpmax'
    | 'hp'
    | 'mana'
    | 'atk'
    | 'def'
    | 'mdef'
    | 'money'
    | 'exp'
    | 'up'
    | 'skill'
    | 'hard';

export interface ItemCounter {
    id: string;
    label: string;
    count: string;
}

export interface StatusBarVisibility {
    slots: StatusBarSlot[];
    keys: boolean;
    pzf: boolean;
    debuff: boolean;
}

/** 状态栏各项的显示名（旧版是图片素材） */
export const STATUS_BAR_LABELS: Record<StatusBarSlot, string> = {
    floor: '楼层',
    name: '名字',
    lv: '等级',
    hpmax: '生命上限',
    hp: '生命',
    mana: '魔力',
    atk: '攻击',
    def: '防御',
    mdef: '魔防',
    money: '金币',
    exp: '经验',
    up: '升级',
    skill: '技能',
    hard: '难度',
};

/** 状态栏显示所需的运行时信息 */
export interface StatusBarContext {
    hero: HeroState;
    flags: Record<string, unknown>;
    /** 当前楼层名（旧 `floor` 项） */
    floorName?: string;
    /** 显示难度；默认取 `flag:hard` */
    hard?: string;
    /** 下一级所需经验；`null` 表示满级 */
    nextLvUpNeed?: number | null;
    /** 等级称谓表（旧 `firstData.levelUp[i].title`） */
    levelTitles?: readonly (string | undefined)[];
    /** 旧 `flags.statusBarItems`，缺省视为空数组（只显示默认项） */
    statusBarItems?: readonly string[];
    keyLabels?: Record<string, string>;
    toolLabels?: Record<string, string>;
}

export interface StatusBarView {
    slots: Record<StatusBarSlot, string>;
    visibility: StatusBarVisibility;
    keys: ItemCounter[];
    tools: ItemCounter[];
    /** 毒 / 衰 / 咒 */
    debuffs: string[];
}

const DEFAULT_KEY_LABELS: Record<string, string> = {
    yellowKey: '黄钥匙',
    blueKey: '蓝钥匙',
    redKey: '红钥匙',
    greenKey: '绿钥匙',
};

const TOOL_LABELS: Record<string, string> = {
    pickaxe: '破',
    bomb: '炸',
    centerFly: '飞',
};

const DEBUFF_LABELS = [
    { flag: 'poison', label: '毒' },
    { flag: 'weak', label: '衰' },
    { flag: 'curse', label: '咒' },
];

/** 旧 `_shouldDisplayStatus`：哪些状态栏项要显示 */
export function statusBarVisibility(items: readonly string[] = []): StatusBarVisibility {
    const has = (name: string): boolean => items.includes(name);
    const slots: StatusBarSlot[] = [];
    if (has('enableFloor')) slots.push('floor');
    if (has('enableName')) slots.push('name');
    if (has('enableLv')) slots.push('lv');
    if (has('enableHP')) slots.push('hp');
    if (has('enableHPMax')) slots.push('hpmax');
    if (has('enableMana')) slots.push('mana');
    if (has('enableAtk')) slots.push('atk');
    if (has('enableDef')) slots.push('def');
    if (has('enableMDef')) slots.push('mdef');
    if (has('enableMoney')) slots.push('money');
    if (has('enableExp') && !has('levelUpLeftMode')) slots.push('exp');
    if (has('enableLevelUp')) slots.push('up');
    if (has('enableSkill')) slots.push('skill');
    return { slots, keys: has('enableKeys'), pzf: has('enablePZF'), debuff: has('enableDebuff') };
}

function realStatus(
    ctx: StatusBarContext,
    name: 'hp' | 'atk' | 'def' | 'mdef' | 'money' | 'exp',
): number {
    return getRealStatus(ctx.hero, ctx.flags, name);
}

/**
 * 组装状态栏数值（对齐旧 `controldata.updateStatusBar` 的默认实现）。
 *
 * 与旧实现的差异：旧代码会顺手把 `hp` 夹到 `hpmax`（`enableHPMax`），这里只读不写，
 * 归一化交给运行时。
 */
export function formatStatusBar(ctx: StatusBarContext): StatusBarView {
    const { hero, flags } = ctx;
    const hpmax = hero.hpmax == null ? hero.hp : getRealStatus(hero, flags, 'hpmax');
    const manamax = hero.manamax;
    const showManaMax = manamax != null && getRealStatus(hero, flags, 'manamax') >= 0;
    const hard = ctx.hard ?? (typeof flags.hard === 'string' ? flags.hard : '');
    const skill = typeof flags.skillName === 'string' ? flags.skillName : '无';
    // 旧 `getLvName`：称号为空时退回等级数字
    const lvTitle = ctx.levelTitles?.[hero.lv - 1];

    const slots: Record<StatusBarSlot, string> = {
        floor: ctx.floorName ?? '',
        name: hero.name ?? '',
        lv: String(lvTitle || hero.lv),
        hpmax: formatBigNumber(hpmax),
        hp: formatBigNumber(realStatus(ctx, 'hp')),
        mana: showManaMax
            ? `${formatBigNumber(hero.mana ?? 0)}/${formatBigNumber(getRealStatus(hero, flags, 'manamax'))}`
            : formatBigNumber(hero.mana ?? 0),
        atk: formatBigNumber(realStatus(ctx, 'atk')),
        def: formatBigNumber(realStatus(ctx, 'def')),
        mdef: formatBigNumber(realStatus(ctx, 'mdef')),
        money: formatBigNumber(realStatus(ctx, 'money')),
        exp: formatBigNumber(realStatus(ctx, 'exp')),
        up: ctx.nextLvUpNeed == null ? '' : formatBigNumber(ctx.nextLvUpNeed),
        skill,
        hard,
    };

    const keyLabels = { ...DEFAULT_KEY_LABELS, ...ctx.keyLabels };
    const keys = Object.keys(keyLabels).map((id) => ({
        id,
        label: keyLabels[id] as string,
        count: setTwoDigits(itemCount(hero, id)),
    }));

    const toolLabels = { ...TOOL_LABELS, ...ctx.toolLabels };
    const tools = Object.entries(toolLabels).map(([id, label]) => ({
        id,
        label,
        count: setTwoDigits(itemCount(hero, id)),
    }));

    return {
        slots,
        visibility: statusBarVisibility(ctx.statusBarItems ?? []),
        keys,
        tools,
        debuffs: DEBUFF_LABELS.filter((one) => hasFlag(flags, one.flag)).map((one) => one.label),
    };
}

////// ---------- 怪物手册 ---------- //////

export interface ManualEntry {
    id: string;
    name?: string;
    hp?: number;
    atk?: number;
    def?: number;
    mdef?: number;
    money?: number;
    exp?: number;
    /** 战斗伤害描述，如 `先攻 100`；无解时为空 */
    damage?: string;
    /** 特殊属性名，如 `['先攻', '魔攻']` */
    specials?: readonly string[];
    /** 怪物描述 */
    description?: string;
    /** 当前出现坐标 */
    locs?: readonly (readonly [number, number])[];
}

/** 怪物手册里一条怪物的文本行（旧 `_drawBookDetail_getInfo` 的精简版） */
export function formatMonsterManual(entries: readonly ManualEntry[]): string[] {
    const lines: string[] = [];
    for (const entry of entries) {
        const title = entry.name ?? entry.id;
        lines.push(`\r[#FF6A6A]\\d${title}\\d\\r[]`);
        const stats: string[] = [];
        if (entry.hp != null) stats.push(`生命 ${formatBigNumber(entry.hp)}`);
        if (entry.atk != null) stats.push(`攻击 ${formatBigNumber(entry.atk)}`);
        if (entry.def != null) stats.push(`防御 ${formatBigNumber(entry.def)}`);
        if (entry.mdef != null) stats.push(`魔防 ${formatBigNumber(entry.mdef)}`);
        if (entry.money != null) stats.push(`金币 ${formatBigNumber(entry.money)}`);
        if (entry.exp != null) stats.push(`经验 ${formatBigNumber(entry.exp)}`);
        if (stats.length > 0) lines.push(stats.join('，'));
        if (entry.damage != null) lines.push(`战斗伤害 ${entry.damage}`);
        if (entry.specials && entry.specials.length > 0)
            lines.push(`特殊属性：${entry.specials.join('、')}`);
        else lines.push('该怪物无特殊属性。');
        if (entry.locs && entry.locs.length > 0) {
            lines.push(`怪物坐标：${entry.locs.map(([x, y]) => `(${x},${y})`).join(' ')}`);
        }
        if (entry.description) lines.push(entry.description);
        lines.push('');
    }
    return lines;
}

////// ---------- 背包 / 装备 / 楼层面板 ---------- //////

/** 背包面板里的一件道具 */
export interface ToolboxEntry {
    id: string;
    cls: ItemClass;
    name: string;
    count: number;
    text?: string;
    /** 当前能否使用（旧 `canUseItem`） */
    usable: boolean;
    /** 当前能否换上（仅装备有意义） */
    equippable: boolean;
    /** 是否正穿在身上 */
    equipped: boolean;
}

export interface ToolboxPanelView {
    /** 消耗道具与永久道具分栏（旧 `_drawToolbox`） */
    tools: ToolboxEntry[];
    constants: ToolboxEntry[];
    equips: ToolboxEntry[];
}

export interface ToolboxPanelContext {
    hero: HeroState;
    items: Record<string, ItemData>;
    canUse?(id: string): boolean;
    canEquip?(id: string): boolean;
    /**
     * 排序（塔作者定制入口）：传入背包类型与本类的道具 id，返回显示顺序。
     * 不传则按 id 升序；旧对应 `functions.ui.getToolboxItems`。
     */
    order?(cls: string, ids: readonly string[]): string[];
}

/**
 * 组装道具面板。
 *
 * 对齐旧 `functions.ui.getToolboxItems` 的默认实现：按 `hero.items[bag]` 的
 * 键排序，过滤掉 `hideInToolbox`，并区分「消耗道具 / 永久道具 / 装备」。
 * 排序交给 `ctx.order`（塔作者可用 `firstData.ui.toolboxSort` 或脚本钩子覆盖）。
 */
export function formatToolboxPanel(ctx: ToolboxPanelContext): ToolboxPanelView {
    const view: ToolboxPanelView = { tools: [], constants: [], equips: [] };
    for (const bag of ['tools', 'constants', 'equips'] as const) {
        const owned = ctx.hero.items[bag] ?? {};
        const ids = Object.keys(owned).filter((id) => (owned[id] ?? 0) > 0);
        for (const id of ctx.order?.(bag, ids) ?? ids.sort()) {
            const count = owned[id] ?? 0;
            if (count <= 0) continue;
            const item = ctx.items[id];
            if (item?.hideInToolbox === true) continue;
            view[bag].push({
                id,
                cls: itemBag(item?.cls),
                name: item?.name ?? id,
                count,
                text: typeof item?.text === 'string' ? item.text : undefined,
                usable: ctx.canUse?.(id) ?? false,
                equippable: ctx.canEquip?.(id) ?? false,
                equipped: ctx.hero.equipment.includes(id),
            });
        }
    }
    return view;
}

/** 装备面板里的一件候选装备 */
export interface EquipEntry {
    id: string;
    name: string;
    equipped: boolean;
    equippable: boolean;
    /** 与当前装备相比的数值差 / 百分比差（旧 `compareEquipment`） */
    value: Record<string, number>;
    percentage: Record<string, number>;
}

export interface EquipSlotView {
    /** 槽位下标 */
    type: number;
    /** 槽位名（旧 `globalAttribute.equipName`） */
    label: string;
    current: EquipEntry | null;
    candidates: EquipEntry[];
}

export interface EquipPanelContext {
    hero: HeroState;
    items: Record<string, ItemData>;
    equipNames: readonly string[];
    /** 属性差计算（`MotaItems.compareEquip`） */
    compare(equipId: string, comparedId: string | null): {
        value?: Record<string, number>;
        percentage?: Record<string, number>;
    };
    canEquip?(id: string): boolean;
}

/** 解析装备的槽位下标；字符串按 `equipNames` 查名 */
function equipSlotOf(item: ItemData | undefined, equipNames: readonly string[]): number {
    const equip = item?.equip as { type?: number | string } | undefined;
    if (!equip) return -1;
    if (typeof equip.type === 'number') return equip.type;
    return typeof equip.type === 'string' ? equipNames.indexOf(equip.type) : -1;
}

/**
 * 组装装备面板：每个槽位给出当前装备与可换上的候选，附带换装属性差。
 * 对齐旧 `_drawEquipbox` / `_drawEquipbox_getStatusChanged`。
 */
export function formatEquipPanel(ctx: EquipPanelContext): EquipSlotView[] {
    const slots: EquipSlotView[] = [];
    for (let type = 0; type < ctx.equipNames.length; type += 1) {
        const currentId = ctx.hero.equipment[type] ?? null;
        const makeEntry = (id: string): EquipEntry => {
            const diff = ctx.compare(id, currentId);
            return {
                id,
                name: ctx.items[id]?.name ?? id,
                equipped: id === currentId,
                equippable: ctx.canEquip?.(id) ?? true,
                value: { ...(diff.value ?? {}) },
                percentage: { ...(diff.percentage ?? {}) },
            };
        };
        const candidates: EquipEntry[] = [];
        for (const id of Object.keys(ctx.items).sort()) {
            const item = ctx.items[id];
            if (item?.cls !== 'equips' || id === currentId) continue;
            if (equipSlotOf(item, ctx.equipNames) !== type) continue;
            if (itemCount(ctx.hero, id) <= 0) continue;
            candidates.push(makeEntry(id));
        }
        slots.push({
            type,
            label: ctx.equipNames[type] ?? String(type),
            current: currentId ? makeEntry(currentId) : null,
            candidates,
        });
    }
    return slots;
}

/** 楼层传送面板的一条楼层 */
export interface FloorEntry {
    floorId: string;
    index: number;
    name: string;
    current: boolean;
    /** 是否可传送（旧 `canFlyTo && hasVisitedFloor`） */
    selectable: boolean;
}

export interface FloorPanelContext {
    floorIds: readonly string[];
    currentFloorId: string;
    floorName(floorId: string): string;
    hasVisited(floorId: string): boolean;
    canFlyTo(floorId: string): boolean;
}

/** 组装楼层传送面板（旧 `drawFly` 的数据部分） */
export function formatFloorPanel(ctx: FloorPanelContext): FloorEntry[] {
    return ctx.floorIds.map((floorId, index) => ({
        floorId,
        index,
        name: ctx.floorName(floorId),
        current: floorId === ctx.currentFloorId,
        selectable: ctx.canFlyTo(floorId) && ctx.hasVisited(floorId),
    }));
}

////// ---------- 对话框 ---------- //////

/** 定时器注入：测试里换成假时钟即可确定性地推进打字机与 sleep */
export interface Timers {
    now(): number;
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

export const defaultTimers: Timers = {
    now: () => performance.now(),
    setTimeout: (fn, ms) => setTimeout(fn, Math.max(0, ms)),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface DialogTextExtra {
    title?: string | null;
    icon?: string | null;
    position?: { position: string; target: string | null } | null;
}

export interface ChoiceButton {
    text: string;
    disabled: boolean;
}

/** 对话框/提示的呈现接口；DOM 与内存两种实现，控制器只依赖它 */
export interface DialogView {
    showText?(nodes: readonly RichNode[], extra: DialogTextExtra): void;
    showChoices?(
        nodes: readonly RichNode[],
        choices: readonly ChoiceButton[],
        pick: (index: number) => void,
    ): void;
    showConfirm?(nodes: readonly RichNode[], pick: (ok: boolean) => void): void;
    showInput?(hint: string, isText: boolean, confirm: (value: string) => void): void;
    showTip?(nodes: readonly RichNode[], icon?: string): void;
    hide?(): void;
    hideTip?(): void;
    effect?(type: string, data: ScriptActionObject): void;
}

export interface DialogControllerOptions {
    /** 每个字的显示间隔（毫秒），0 表示不逐字显示 */
    charInterval?: number;
    timers?: Timers;
    /** 额外的视觉/音频动作处理（与 view.effect 同时触发） */
    onEffect?: (type: string, data: ScriptActionObject) => void;
}

interface TypingState {
    nodes: RichNode[];
    total: number;
    shown: number;
    extra: DialogTextExtra;
    done: () => void;
}

interface WaitState {
    done: () => void;
}

/**
 * 对话框状态机，实现 `EventPresenter`。
 *
 * 与旧实现的对应关系：
 * - `text` 逐字显示，`tick()` 按经过的时间推进（由游戏主循环调用），
 *   `advance()` 相当于"点一下/按一下"：先补全当前行，再继续脚本。
 * - `choices` / `confirm` / `input` 直接交给 view 呈现，回调返回后才继续。
 * - `wait` 用一次定时器让出调用栈（旧引擎等勇士停下，新引擎没有这层动画）。
 * - 视觉类动作用 `effect` 转交 view 与宿主回调。
 */
export class DialogController {
    private readonly charInterval: number;
    private readonly timers: Timers;
    private readonly onEffect?: (type: string, data: ScriptActionObject) => void;
    private typing: TypingState | null = null;
    private waiting: WaitState | null = null;
    private modal = false;
    private lastTick: number;
    /** 对话框打开时排队的提示；提示是瞬时状态，后到的覆盖先到的 */
    private pendingTip: { nodes: RichNode[]; icon?: string } | null = null;

    constructor(
        readonly view: DialogView,
        options: DialogControllerOptions = {},
    ) {
        this.charInterval = options.charInterval ?? 0;
        this.timers = options.timers ?? defaultTimers;
        this.onEffect = options.onEffect;
        this.lastTick = this.timers.now();
    }

    /** 是否有对话框/选择项打开（输入层据此忽略按键） */
    get busy(): boolean {
        return this.typing != null || this.waiting != null || this.modal;
    }

    /** 是否正在逐字显示 */
    get isTyping(): boolean {
        return this.typing != null;
    }

    /** 当前正在显示的文本（纯文本），无对话框时为 null */
    get currentText(): string | null {
        return this.typing ? richTextToPlain(this.typing.nodes) : null;
    }

    clear(): void {
        this.typing = null;
        this.waiting = null;
        this.modal = false;
        this.view.hide?.();
        this.view.hideTip?.();
    }

    update(): void {
        /* 旧 update() 用于刷新状态栏；DOM 层由宿主自行处理 */
    }

    //// EventPresenter 实现 ////

    text(text: string, _data: ScriptActionObject, done: () => void): void {
        const markers = extractTextMarkers(text);
        const nodes = parseRichText(markers.text);
        const extra: DialogTextExtra = {
            title: markers.title,
            icon: markers.icon,
            position: findPosition(nodes),
        };
        const total = richTextLength(nodes);
        this.lastTick = this.timers.now();
        this.typing = { nodes, total, shown: 0, extra, done };
        this.waiting = null;
        this.view.showText?.(this.charInterval > 0 ? sliceRichText(nodes, 0) : nodes, extra);
        if (this.charInterval <= 0) this.finishTyping();
    }

    setText(data: ScriptActionObject): void {
        const text = data.text;
        if (typeof text !== 'string') return;
        const markers = extractTextMarkers(text);
        this.view.showText?.(parseRichText(markers.text), {
            title: markers.title,
            icon: markers.icon,
        });
    }

    tip(text: string, icon?: string): void {
        const nodes = parseRichText(text);
        if (this.modal) {
            this.pendingTip = { nodes, icon };
            return;
        }
        this.view.showTip?.(nodes, icon ?? undefined);
    }

    choices(
        text: string,
        choices: ChoiceItem[],
        _data: ScriptActionObject,
        done: (index: number | null) => void,
    ): void {
        const markers = extractTextMarkers(text);
        const nodes = parseRichText(markers.text);
        const buttons: ChoiceButton[] = choices.map((choice) => ({
            text: choice._disabled ? '×' : choice.text,
            disabled: choice._disabled === true,
        }));
        this.modal = true;
        this.view.showChoices?.(nodes, buttons, (index) => {
            this.modal = false;
            const choice = choices[index];
            done(choice?._disabled ? null : index);
            this.flushTip();
        });
    }

    confirm(text: string, _data: ScriptActionObject, done: (ok: boolean | null) => void): void {
        const markers = extractTextMarkers(text);
        this.modal = true;
        this.view.showConfirm?.(parseRichText(markers.text), (ok) => {
            this.modal = false;
            done(ok);
            this.flushTip();
        });
    }

    input(hint: string, isText: boolean, done: (value: string) => void): void {
        this.modal = true;
        this.view.showInput?.(hint, isText, (value) => {
            this.modal = false;
            done(value);
            this.flushTip();
        });
    }

    wait(done: () => void): void {
        this.timers.setTimeout(done, 0);
    }

    sleep(ms: number, done: () => void): void {
        this.timers.setTimeout(done, ms);
    }

    effect(type: string, data: ScriptActionObject): void {
        this.view.effect?.(type, data);
        this.onEffect?.(type, data);
    }

    //// 输入 ////

    /**
     * 推进打字机。返回是否消费了这次调用（消费时输入层不应再处理该按键）。
     * `now` 缺省取注入时钟。
     */
    tick(now: number = this.timers.now()): void {
        const typing = this.typing;
        if (!typing) {
            this.lastTick = now;
            return;
        }
        const elapsed = Math.max(0, now - this.lastTick);
        if (this.charInterval <= 0) {
            this.lastTick = now;
            return;
        }
        const step = Math.floor(elapsed / this.charInterval);
        if (step <= 0) return;
        // 只消费整步时间：60fps 下单帧不足一个字，留到下一帧继续累计
        this.lastTick += step * this.charInterval;
        typing.shown = Math.min(typing.total, typing.shown + step);
        this.view.showText?.(sliceRichText(typing.nodes, typing.shown), typing.extra);
        if (typing.shown >= typing.total) this.finishTyping();
    }

    /** 点击/按键：补全打字机，或结束当前文本继续脚本 */
    advance(): boolean {
        if (this.typing) {
            this.typing.shown = this.typing.total;
            this.view.showText?.(this.typing.nodes, this.typing.extra);
            this.finishTyping();
            return true;
        }
        if (this.waiting) {
            const done = this.waiting.done;
            this.waiting = null;
            this.view.hide?.();
            done();
            return true;
        }
        return false;
    }

    private finishTyping(): void {
        const typing = this.typing;
        if (!typing) return;
        this.typing = null;
        // 文本显示完整，等玩家点一下再继续脚本
        this.waiting = { done: typing.done };
    }

    private flushTip(): void {
        const tip = this.pendingTip;
        if (!tip) return;
        this.pendingTip = null;
        this.view.showTip?.(tip.nodes, tip.icon);
    }
}

////// ---------- 内存 / DOM 实现 ---------- //////

export interface MemoryDialogView extends DialogView {
    log: string[];
    /** 最近一次文本（纯文本，含全部字符） */
    text: string | null;
    texts: string[];
    tips: string[];
    effects: { type: string; data: ScriptActionObject }[];
    pick(index: number): void;
    answer(ok: boolean): void;
    submit(value: string): void;
}

/** 测试用视图：记录调用并保留回调，供测试手动应答 */
export function createMemoryDialogView(): MemoryDialogView {
    let pickFn: ((index: number) => void) | null = null;
    let confirmFn: ((ok: boolean) => void) | null = null;
    let inputFn: ((value: string) => void) | null = null;
    const view: MemoryDialogView = {
        log: [],
        text: null,
        texts: [],
        tips: [],
        effects: [],
        showText(nodes) {
            const plain = richTextToPlain(nodes);
            view.text = plain;
            view.texts.push(plain);
            view.log.push(`text:${plain}`);
        },
        showChoices(nodes, choices, pick) {
            view.log.push(`choices:${choices.map((one) => one.text).join('|')}`);
            view.text = richTextToPlain(nodes);
            pickFn = pick;
        },
        showConfirm(nodes, pick) {
            view.log.push(`confirm:${richTextToPlain(nodes)}`);
            confirmFn = pick;
        },
        showInput(hint, isText, confirm) {
            view.log.push(`input:${hint}:${isText ? 'text' : 'number'}`);
            inputFn = confirm;
        },
        showTip(nodes) {
            view.tips.push(richTextToPlain(nodes));
            view.log.push(`tip:${richTextToPlain(nodes)}`);
        },
        hide() {
            view.log.push('hide');
        },
        hideTip() {
            view.log.push('hideTip');
        },
        effect(type, data) {
            view.effects.push({ type, data });
        },
        pick(index) {
            pickFn?.(index);
            pickFn = null;
        },
        answer(ok) {
            confirmFn?.(ok);
            confirmFn = null;
        },
        submit(value) {
            inputFn?.(value);
            inputFn = null;
        },
    };
    return view;
}

export interface DomDialogOptions {
    /** 图标 id -> 图片地址 */
    resolveIcon?: (id: string) => string | undefined;
    /** 点一下对话框时是否等价于 advance（默认 true） */
    clickToAdvance?: boolean;
}

export interface DomDialogView extends DialogView {
    /** 对话框容器（`#dialog` 之类） */
    readonly root: HTMLElement;
    readonly textElement: HTMLElement;
    readonly choicesElement: HTMLElement;
    readonly titleElement: HTMLElement;
    readonly tipElement: HTMLElement;
    readonly inputElement: HTMLInputElement;
    /** 点击/回车时触发，宿主接到后调用 `DialogController.advance()` */
    onAdvance?: () => void;
}

function renderNodes(
    host: HTMLElement,
    nodes: readonly RichNode[],
    resolveIcon?: (id: string) => string | undefined,
): void {
    host.replaceChildren();
    for (const node of nodes) {
        if (node.type === 'break') {
            host.append(document.createElement('br'));
            continue;
        }
        if (node.type === 'position') continue;
        if (node.type === 'space') {
            host.append(document.createTextNode('\u00a0'.repeat(node.count)));
            continue;
        }
        if (node.type === 'icon') {
            const src = resolveIcon?.(node.id);
            if (src) {
                const img = document.createElement('img');
                img.src = src;
                img.alt = node.id;
                img.className = 'mota-inline-icon';
                host.append(img);
            } else {
                const span = document.createElement('span');
                span.className = 'mota-inline-icon';
                span.dataset.icon = node.id;
                host.append(span);
            }
            continue;
        }
        const span = document.createElement('span');
        span.textContent = node.text;
        if (node.color) span.style.color = node.color;
        if (node.bold) span.style.fontWeight = 'bold';
        if (node.italic) span.style.fontStyle = 'italic';
        if (node.fontSize) span.style.fontSize = `${node.fontSize}px`;
        if (node.font) span.style.fontFamily = node.font;
        host.append(span);
    }
}

/** 浏览器实现：把对话与选择项渲染进给定容器（样式由 `src/game/style.css` 提供） */
export function createDomDialogView(
    root: HTMLElement,
    options: DomDialogOptions = {},
): DomDialogView {
    const make = (tag: keyof HTMLElementTagNameMap, className: string): HTMLElement => {
        const element = document.createElement(tag);
        element.className = className;
        root.append(element);
        return element;
    };
    const view: DomDialogView = {
        root,
        titleElement: make('div', 'dialog-title'),
        textElement: make('div', 'dialog-text'),
        choicesElement: make('div', 'dialog-choices'),
        inputElement: document.createElement('input'),
        tipElement: make('div', 'dialog-tip'),
        showText(nodes, extra) {
            view.choicesElement.replaceChildren();
            view.inputElement.remove();
            view.root.hidden = false;
            if (extra.title) {
                view.titleElement.textContent = extra.title;
                view.titleElement.hidden = false;
            } else {
                view.titleElement.hidden = true;
            }
            renderNodes(view.textElement, nodes, options.resolveIcon);
        },
        showChoices(nodes, choices, pick) {
            view.root.hidden = false;
            view.inputElement.remove();
            renderNodes(view.textElement, nodes, options.resolveIcon);
            view.choicesElement.replaceChildren();
            choices.forEach((choice, index) => {
                const button = document.createElement('button');
                button.textContent = choice.text;
                button.disabled = choice.disabled;
                button.addEventListener('click', () => pick(index));
                view.choicesElement.append(button);
            });
        },
        showConfirm(nodes, pick) {
            renderNodes(view.textElement, nodes, options.resolveIcon);
            view.choicesElement.replaceChildren();
            const yes = document.createElement('button');
            yes.textContent = '确定';
            yes.addEventListener('click', () => pick(true));
            const no = document.createElement('button');
            no.textContent = '取消';
            no.addEventListener('click', () => pick(false));
            view.choicesElement.append(yes, no);
            view.root.hidden = false;
        },
        showInput(hint, isText, confirm) {
            view.textElement.textContent = hint;
            view.choicesElement.replaceChildren();
            view.inputElement.type = isText ? 'text' : 'number';
            view.inputElement.value = '';
            view.inputElement.className = 'dialog-input';
            view.choicesElement.append(view.inputElement);
            view.root.hidden = false;
            view.inputElement.focus();
            const submit = (): void => confirm(view.inputElement.value);
            view.inputElement.onchange = submit;
            view.inputElement.onkeydown = (event) => {
                if (event.key === 'Enter') submit();
            };
        },
        showTip(nodes, icon) {
            renderNodes(view.tipElement, nodes, options.resolveIcon);
            view.tipElement.dataset.icon = icon ?? '';
            view.tipElement.hidden = false;
            view.tipElement.classList.remove('dialog-tip-fade');
            // 强制重排后再加动画类，保证每次都重新播放淡出
            void view.tipElement.offsetWidth;
            view.tipElement.classList.add('dialog-tip-fade');
        },
        hideTip() {
            view.tipElement.hidden = true;
        },
        hide() {
            view.root.hidden = true;
            view.choicesElement.replaceChildren();
            view.inputElement.remove();
        },
        effect() {
            /* 视觉 / 音频动作由 game 层接管 */
        },
    };
    if (options.clickToAdvance !== false) {
        root.addEventListener('click', () => view.onAdvance?.());
    }
    return view;
}

////// ---------- 动画时钟 ---------- //////

/** 按固定间隔推进动画帧（旧 `core.animateFrame` 的计时部分） */
export class AnimateClock {
    private last: number | null = null;

    constructor(readonly interval = 120) {}

    reset(now?: number): void {
        this.last = now ?? null;
    }

    /** 返回本次应推进的动画帧数（0 表示还没到下一帧） */
    tick(now: number): number {
        if (this.last == null) {
            this.last = now;
            return 0;
        }
        if (this.interval <= 0) return 0;
        const steps = Math.floor((now - this.last) / this.interval);
        if (steps <= 0) return 0;
        this.last += steps * this.interval;
        return steps;
    }
}
