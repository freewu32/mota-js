import { loadTower } from '../engine/loader';
import { MaterialStore } from '../engine/materials';
import { drawScene } from '../engine/renderer';
import { MotaRuntime } from '../engine/runtime';
import { TILE } from '../engine/tiles';
import { getSpecialText } from '../engine/modules/enemys';
import {
    AnimateClock,
    DialogController,
    STATUS_BAR_LABELS,
    createDomDialogView,
    formatMonsterManual,
    parseRichText,
    richTextToPlain,
    type ManualEntry,
    type StatusBarView,
} from '../engine/modules/ui';

const canvas = document.querySelector<HTMLCanvasElement>('#game');
if (!canvas) throw new Error('未找到 #game 画布');
const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('无法获取 2D 上下文');
ctx.imageSmoothingEnabled = false;

const data = await loadTower();
const materials = new MaterialStore(data.icons, data.tower.main.tilesets ?? []);
await materials.load('/project');

// autotile 跨编号连通表：数据里登记的每个 autotile 编号 -> id
const autotileNumbers: Record<number, string> = {};
for (const [number, element] of Object.entries(data.maps)) {
    if (element.cls === 'autotile') autotileNumbers[Number(number)] = element.id;
}
materials.buildAutotileEdges(autotileNumbers);

const runtime = new MotaRuntime(data);

////// 塔作者脚本 //////

// 脚本由宿主加载：数据里写 { script: 'items/bomb' }，这里用动态 import 取模块。
// 引擎本身不做 IO，因此这段加载逻辑留在游戏入口。
runtime.setScriptLoader(async (name) => import(/* @vite-ignore */ `/project/scripts/${name}.ts`));
const failedScripts = await runtime.loadScripts();
if (failedScripts.length > 0) {
    console.error(`以下脚本加载失败，相关道具/事件会退化为无效果：${failedScripts.join('、')}`);
}

////// 对话 / 提示 //////

const dialogRoot = document.querySelector<HTMLElement>('#dialog');
if (!dialogRoot) throw new Error('未找到 #dialog 对话框容器');
const dialogView = createDomDialogView(dialogRoot);
const dialog = new DialogController(dialogView, {
    charInterval: 25,
    onEffect: (type, data) => {
        if (type === 'openPanel') openPanel(String(data.panel ?? ''));
    },
});
runtime.setPresenter(dialog);
// 点击对话框等价于点一下继续
dialogView.onAdvance = () => {
    dialog.advance();
    renderStatus();
};

////// 面板 //////

// 旧引擎的面板画在 canvas 上（`core.ui.drawBook` / `drawFly`），新引擎把面板本体交给
// 呈现层：`openPanel` 动作只上报面板名。这里先把怪物手册接上，楼层传送等待 UI 阶段。

const panelRoot = document.querySelector<HTMLElement>('#panel');

/** 当前层怪物手册条目（旧 `core.ui.drawBook` 的数据部分） */
function monsterManualEntries(): ManualEntry[] {
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
            // `mdef` / `description` 不在数据 schema 的必填字段里，按需取用
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

function closePanel(): void {
    if (panelRoot) panelRoot.hidden = true;
}

function openPanel(panel: string): void {
    if (!panelRoot) return;
    const box = document.createElement('div');
    box.className = 'panel-box';
    const title = document.createElement('h2');
    if (panel === 'monsterManual') {
        title.textContent = `怪物手册 - ${runtime.floor.title}`;
        box.append(title);
        const entries = monsterManualEntries();
        const lines = entries.length > 0 ? formatMonsterManual(entries) : ['本层没有怪物。'];
        for (const line of lines) {
            const row = document.createElement('div');
            row.className = 'panel-line';
            // 富文本标记（`\d` / `\c[]` / `\r[]`）留给后续 UI 阶段，这里先按纯文本展示
            row.textContent = richTextToPlain(parseRichText(line));
            box.append(row);
        }
    } else {
        title.textContent = panel;
        box.append(title);
        const hint = document.createElement('div');
        hint.className = 'panel-hint';
        hint.textContent = '该面板尚未实现（UI 阶段补齐）。';
        box.append(hint);
    }
    const hint = document.createElement('div');
    hint.className = 'panel-hint';
    hint.textContent = '点击任意处关闭';
    box.append(hint);
    panelRoot.replaceChildren(box);
    panelRoot.hidden = false;
}

panelRoot?.addEventListener('click', closePanel);

////// 状态栏 //////

const statusRoot = document.querySelector<HTMLElement>('#status-bar');
const countersRoot = document.querySelector<HTMLElement>('#status-counters');

function slotElement(label: string, value: string): HTMLElement {
    const box = document.createElement('div');
    box.className = 'status-slot';
    const name = document.createElement('span');
    name.className = 'status-label';
    name.textContent = label;
    const text = document.createElement('span');
    text.className = 'status-value';
    text.textContent = value;
    box.append(name, text);
    return box;
}

let statusSignature = '';

/** 状态栏由模型驱动：内容不变时跳过 DOM 重建（主循环每帧都会调用） */
function renderStatus(): void {
    if (!statusRoot || !countersRoot) return;
    const bar: StatusBarView = runtime.statusBarView();
    const signature = JSON.stringify(bar);
    if (signature === statusSignature) return;
    statusSignature = signature;

    statusRoot.replaceChildren(
        ...bar.visibility.slots.map((slot) =>
            slotElement(STATUS_BAR_LABELS[slot], bar.slots[slot]),
        ),
    );

    const counters: string[] = [];
    if (bar.visibility.keys) counters.push(...bar.keys.map((one) => `${one.label} ${one.count}`));
    if (bar.visibility.pzf) counters.push(...bar.tools.map((one) => `${one.label}${one.count}`));
    if (bar.visibility.debuff) counters.push(...bar.debuffs);
    countersRoot.textContent = counters.join('　');
    countersRoot.hidden = counters.length === 0;
}

////// 渲染 //////

/** 动画计数：每约 120ms 推进一步 */
let animate = 0;
const animateClock = new AnimateClock(120);

function resize(): void {
    const width = (runtime.floor.map[0]?.length ?? 13) * TILE;
    const height = runtime.floor.map.length * TILE;
    if (canvas!.width !== width || canvas!.height !== height) {
        canvas!.width = width;
        canvas!.height = height;
        ctx!.imageSmoothingEnabled = false;
    }
}

function render(): void {
    resize();
    drawScene(
        ctx as CanvasRenderingContext2D,
        runtime.floor,
        data.maps,
        runtime.state.hero,
        materials,
        animate,
    );
}

////// 输入 //////

const DIRS: Record<string, [number, number]> = {
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
};

window.addEventListener('keydown', (event) => {
    // 对话框打开时按键交给对话：补全打字机 / 继续脚本
    if (dialog.busy) {
        if (dialog.isTyping || event.key === ' ' || event.key === 'Enter') {
            event.preventDefault();
            dialog.advance();
            renderStatus();
        }
        return;
    }
    const dir = DIRS[event.key];
    if (!dir) return;
    event.preventDefault();
    runtime.move(dir[0], dir[1]);
    render();
    renderStatus();
});

document.querySelector('#save')?.addEventListener('click', () => {
    console.log('存档', runtime.save());
});
document.querySelector('#load')?.addEventListener('click', () => {
    if (runtime.load()) {
        render();
        renderStatus();
    }
});

// 暴露运行时，便于调试与接入脚本 API
Object.assign(globalThis, { mota: runtime, motaApi: runtime.api, motaDialog: dialog });

render();
renderStatus();
animateClock.reset(performance.now());

function loop(now: number): void {
    const steps = animateClock.tick(now);
    if (steps > 0) {
        animate += steps;
        render();
    }
    dialog.tick(now);
    renderStatus();
    requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
