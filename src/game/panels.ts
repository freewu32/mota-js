/**
 * 游戏内面板（怪物手册 / 道具栏 / 装备栏 / 楼层传送）。
 *
 * 这是阶段 4 的临时 DOM 实现：面板数据全部来自 `runtime` 的纯模型
 * （`listEnemies` / `toolboxView` / `equipView` / `floorView`），这里只负责
 * 组装 DOM 与把点击翻译成录像 token（`runtime.turns.run`）。
 *
 * 阶段 5 会把这层换成 `src/ui/` 的 Preact 组件，届时模型与交互保持不变。
 */
import type { MaterialStore } from '../engine/materials';
import type { MotaRuntime } from '../engine/runtime';
import { TILE } from '../engine/tiles';
import { getSpecialText } from '../engine/modules/enemys';
import {
    STATUS_BAR_LABELS,
    formatMonsterManual,
    parseRichText,
    richTextToPlain,
    type EquipEntry,
    type ManualEntry,
    type ToolboxEntry,
} from '../engine/modules/ui';

/** 面板与游戏入口的交互接口 */
export interface PanelHost {
    runtime: MotaRuntime;
    materials?: MaterialStore;
    /** 关闭当前面板 */
    close(): void;
    /** 执行一个录像 token；成功后宿主会刷新画面、状态栏与面板 */
    run(token: string): boolean;
    /** 重新渲染当前面板 */
    refresh(): void;
    /** 提示文本（旧 `drawTip`） */
    tip?(text: string): void;
}

function hint(text: string): HTMLElement {
    const element = document.createElement('div');
    element.className = 'panel-hint';
    element.textContent = text;
    return element;
}

function sectionTitle(text: string): HTMLElement {
    const element = document.createElement('div');
    element.className = 'panel-section';
    element.textContent = text;
    return element;
}

/** 道具缩略图；素材缺失时退化为空位 */
function iconCanvas(materials: MaterialStore | undefined, id: string): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = TILE;
    canvas.height = TILE;
    canvas.className = 'panel-icon';
    const ctx = canvas.getContext('2d');
    if (ctx && materials) {
        ctx.imageSmoothingEnabled = false;
        materials.drawElement(ctx, { cls: 'items', id }, 0, 0);
    }
    return canvas;
}

function buttonFor(
    materials: MaterialStore | undefined,
    id: string,
    label: string,
    extra: string,
): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = 'panel-entry';
    button.append(iconCanvas(materials, id));
    const name = document.createElement('span');
    name.className = 'panel-entry-name';
    name.textContent = label;
    button.append(name);
    if (extra) {
        const count = document.createElement('span');
        count.className = 'panel-entry-count';
        count.textContent = extra;
        button.append(count);
    }
    return button;
}

function statLabel(name: string): string {
    return (STATUS_BAR_LABELS as Record<string, string>)[name] ?? name;
}

/** 换装属性差文本（旧 `_drawEquipbox_getStatusChanged`） */
function diffText(entry: EquipEntry): string {
    const parts: string[] = [];
    for (const [name, value] of Object.entries(entry.value)) {
        if (value) parts.push(`${statLabel(name)} ${value > 0 ? '+' : ''}${value}`);
    }
    for (const [name, value] of Object.entries(entry.percentage)) {
        if (value) parts.push(`${statLabel(name)} ${value > 0 ? '+' : ''}${value}%`);
    }
    return parts.length > 0 ? parts.join('，') : '无属性变化';
}

////// 怪物手册 //////

/** 当前层怪物手册条目（旧 `core.ui.drawBook` 的数据部分） */
function monsterManualEntries(runtime: MotaRuntime): ManualEntry[] {
    const grouped = new Map<string, { locs: [number, number][]; damage?: string }>();
    for (const one of runtime.listEnemies()) {
        const found = grouped.get(one.id);
        if (found) found.locs.push([one.x, one.y]);
        else grouped.set(one.id, { locs: [[one.x, one.y]], damage: one.damage });
    }
    const asNumber = (value: unknown): number | undefined =>
        typeof value === 'number' ? value : undefined;
    const asText = (value: unknown): string | undefined =>
        typeof value === 'string' ? value : undefined;
    const entries: ManualEntry[] = [];
    for (const [id, { locs, damage }] of grouped) {
        const enemy = runtime.data.enemys[id];
        entries.push({
            id,
            name: enemy?.name ?? id,
            hp: enemy?.hp,
            atk: enemy?.atk,
            def: enemy?.def,
            mdef: asNumber(enemy?.mdef),
            money: enemy?.money,
            exp: enemy?.exp,
            damage,
            specials: enemy ? getSpecialText(enemy) : [],
            description: asText(enemy?.description),
            locs,
        });
    }
    return entries;
}

function renderMonsterManual(body: HTMLElement, host: PanelHost): void {
    const entries = monsterManualEntries(host.runtime);
    const lines = entries.length > 0 ? formatMonsterManual(entries) : ['本层没有怪物。'];
    for (const line of lines) {
        const row = document.createElement('div');
        row.className = 'panel-line';
        // 富文本标记（`\d` / `\c[]` / `\r[]`）的着色留到 Preact 组件
        row.textContent = richTextToPlain(parseRichText(line));
        body.append(row);
    }
}

////// 道具栏 //////

function renderToolbox(body: HTMLElement, host: PanelHost): void {
    const view = host.runtime.toolboxView();
    const sections: [string, readonly ToolboxEntry[]][] = [
        ['消耗道具', view.tools],
        ['永久道具', view.constants],
        ['装备', view.equips],
    ];
    let total = 0;
    for (const [label, entries] of sections) {
        if (entries.length === 0) continue;
        body.append(sectionTitle(label));
        const grid = document.createElement('div');
        grid.className = 'panel-grid';
        for (const entry of entries) {
            total += 1;
            const isEquip = entry.cls === 'equips';
            const button = buttonFor(host.materials, entry.id, entry.name, `x${entry.count}`);
            button.disabled = isEquip ? !entry.equippable : !entry.usable;
            if (entry.text) button.title = richTextToPlain(parseRichText(entry.text));
            button.addEventListener('click', () => {
                if (isEquip) host.run(`equip:${entry.id}`);
                else host.run(`item:${entry.id}`);
            });
            grid.append(button);
        }
        body.append(grid);
    }
    if (total === 0) body.append(hint('背包里没有道具。'));
}

////// 装备栏 //////

function renderEquip(body: HTMLElement, host: PanelHost): void {
    const slots = host.runtime.equipView();
    if (slots.length === 0) {
        body.append(hint('当前塔没有装备槽。'));
        return;
    }
    for (const slot of slots) {
        body.append(sectionTitle(slot.label));
        const grid = document.createElement('div');
        grid.className = 'panel-grid';
        if (slot.current) {
            const button = buttonFor(host.materials, slot.current.id, slot.current.name, '已装备');
            button.title = '点击卸下';
            button.addEventListener('click', () => host.run(`unEquip:${slot.type}`));
            grid.append(button);
        } else {
            grid.append(hint('（空）'));
        }
        for (const candidate of slot.candidates) {
            const button = buttonFor(host.materials, candidate.id, candidate.name, '');
            button.title = diffText(candidate);
            button.disabled = !candidate.equippable;
            button.addEventListener('click', () => host.run(`equip:${candidate.id}`));
            grid.append(button);
        }
        body.append(grid);
    }
}

////// 楼层传送 //////

function renderFloorMap(body: HTMLElement, host: PanelHost): void {
    const floors = host.runtime.floorView();
    const grid = document.createElement('div');
    grid.className = 'panel-grid';
    for (const entry of floors) {
        const button = document.createElement('button');
        button.className = 'panel-entry';
        button.textContent = entry.name;
        if (entry.current) button.classList.add('current');
        button.disabled = !entry.selectable && !entry.current;
        button.addEventListener('click', () => {
            if (entry.current || host.run(`fly:${entry.floorId}`)) host.close();
        });
        grid.append(button);
    }
    body.append(grid);
    body.append(hint('只能传送到已经到达且允许传送的楼层。'));
}

////// 入口 //////

export function renderPanel(panel: string, root: HTMLElement, host: PanelHost): void {
    const box = document.createElement('div');
    box.className = 'panel-box';
    // 面板内部点击不应触发遮罩的关闭
    box.addEventListener('click', (event) => event.stopPropagation());

    const title = document.createElement('h2');
    const body = document.createElement('div');
    body.className = 'panel-body';
    box.append(title, body);

    switch (panel) {
        case 'monsterManual':
            title.textContent = `怪物手册 - ${host.runtime.floor.title}`;
            renderMonsterManual(body, host);
            break;
        case 'items':
            title.textContent = '道具栏';
            renderToolbox(body, host);
            break;
        case 'equips':
            title.textContent = '装备栏';
            renderEquip(body, host);
            break;
        case 'floorMap':
            title.textContent = '楼层传送';
            renderFloorMap(body, host);
            break;
        default:
            title.textContent = panel;
            body.append(hint('该面板尚未实现（UI 阶段补齐）。'));
    }

    box.append(hint('点击面板外关闭'));
    root.replaceChildren(box);
    root.hidden = false;
}
