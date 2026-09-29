/**
 * 游戏入口。
 *
 * 职责划分（详见 `docs/现代化重写方案.md` 的「六、UI 层方案」）：
 * - 引擎（`src/engine/**`）只有纯模型与事件解释，不认 DOM；
 * - 这里把引擎接上浏览器：加载素材、建运行时、订阅 `presenter.effect`，
 *   再把 `src/ui` 的 Preact 组件挂到 `#app`；
 * - 帧级数据（勇士动画帧、显伤、光标）走 `#fx` canvas，不进 signal。
 */
import '../ui/styles.css';
import './styles.css';
import { render as renderApp } from 'preact';
import { loadTower } from '../engine/loader';
import { MaterialStore } from '../engine/materials';
import { drawHeroSprite, drawScene } from '../engine/renderer';
import { MotaRuntime } from '../engine/runtime';
import { TILE } from '../engine/tiles';
import { AnimateClock, DialogController } from '../engine/modules/ui';
import {
    applyTheme,
    bumpRevision,
    closePanel,
    createSignalDialogView,
    defaultTheme,
    $dialogBusy,
    $mobile,
    $theme,
    openPanel,
    parseTheme,
    setStatus,
    setTheme,
} from '../ui';
import { App } from './app';
import { loadImage } from './assets';
import { AudioPlayer } from './audio';
import type { GameContext } from './context';
import { FxLayer } from './fx';
import { createIconResolver } from './icons';
import { buildWindowSkinDataUrl, resolveThemeSkin } from './skin';

////// 数据与素材 //////

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
const audio = new AudioPlayer({
    nameMap: (data.tower.main.nameMap ?? {}) as Record<string, string>,
    base: '/project',
});
const fx = new FxLayer();
const resolveIcon = createIconResolver(materials);

const theme = await resolveThemeSkin(
    parseTheme((data.tower.main as Record<string, unknown>).theme),
);
setTheme(theme);
applyTheme(theme);

let skinDataUrl: string | null = null;
let skinLoading: Promise<string | null> | null = null;

/** 懒加载并把 RM 窗口皮肤（`winskin.png`）重切成标准九宫格 */
async function loadSkin(): Promise<string | null> {
    if (skinDataUrl) return skinDataUrl;
    skinLoading ??= buildWindowSkinDataUrl('/project/images/winskin.png');
    skinDataUrl = await skinLoading;
    return skinDataUrl;
}

////// 塔作者脚本 //////

// 脚本由宿主加载：数据里写 `{ script: 'items/bomb' }`，这里用动态 import 取模块。
runtime.setScriptLoader(async (name) => import(/* @vite-ignore */ `/project/scripts/${name}.ts`));
const failedScripts = await runtime.loadScripts();
if (failedScripts.length > 0) {
    console.error(`以下脚本加载失败，相关道具/事件会退化为无效果：${failedScripts.join('、')}`);
}

////// 画面 //////

let gameCanvas: HTMLCanvasElement | null = null;
let gameCtx: CanvasRenderingContext2D | null = null;
let animate = 0;
/** 最近一次成功移动的时间（决定勇士用走路的哪一帧） */
let movedAt = 0;
const animateClock = new AnimateClock(120);

// 勇士精灵：`firstData.hero.image` 指向 project/images 下的图（旧 `material.images.hero`）
const heroImage = await loadImage(
    `/project/images/${String(data.tower.firstData.hero?.image ?? 'hero.png')}`,
);
const heroIcons = (data.icons as Record<string, unknown>).hero as
    | import('../engine/renderer').HeroIcons
    | undefined;

function render(): void {
    if (!gameCanvas || !gameCtx) return;
    const width = (runtime.floor.map[0]?.length ?? 13) * TILE;
    const height = runtime.floor.map.length * TILE;
    if (gameCanvas.width !== width || gameCanvas.height !== height) {
        gameCanvas.width = width;
        gameCanvas.height = height;
        gameCtx.imageSmoothingEnabled = false;
    }
    fx.resize(width, height);
    const override = fx.heroOverride;
    const hero = override ? { x: override.x, y: override.y } : runtime.state.hero;
    drawScene(gameCtx, runtime.floor, data.maps, hero, materials, animate, heroImage == null);
    if (heroImage) {
        drawHeroSprite(
            gameCtx,
            heroImage,
            heroIcons,
            { ...hero, direction: runtime.state.hero.direction },
            animate,
            performance.now() - movedAt < 220,
        );
    }
}

function renderStatus(): void {
    setStatus(runtime.statusBarView());
}

////// 呈现层接到引擎 //////

const dialogView = createSignalDialogView();
const dialog = new DialogController(dialogView, { charInterval: 25, onEffect });

/** 换层：背景音乐 / 天气 / 画面色调 / 过场（旧 `functions.js` 的 `changingFloor`） */
function onFloorChange(payload: Record<string, unknown>): void {
    const floorId = String(payload.floorId ?? runtime.state.floorId);
    const reason = String(payload.reason ?? 'script');
    const floor = data.floors[floorId] as Record<string, unknown> | undefined;

    if (reason === 'fly') audio.playSound('飞行器');
    else if (reason === 'load') audio.playSound('读档');
    else if (reason !== 'start') audio.playSound('上下楼');

    const bgm = floor?.bgm;
    if (typeof bgm === 'string') audio.playBgm(bgm);
    else if (Array.isArray(bgm) && bgm.length > 0) {
        audio.playBgm(String(bgm[Math.floor(Math.random() * bgm.length)]));
    } else if (reason === 'load') audio.pauseBgm();

    const weather = floor?.weather;
    if (Array.isArray(weather) && weather.length > 0) {
        fx.setWeather(String(weather[0]), Number(weather[1] ?? 1));
    } else {
        fx.setWeather(null);
    }

    const color = floor?.color;
    fx.setCurtain(Array.isArray(color) ? `rgba(${color.join(',')})` : null);
    if (reason !== 'load' && reason !== 'start') fx.flash('#000000', 160);

    render();
    renderStatus();
}

function onEffect(type: string, payload: Record<string, unknown>): void {
    switch (type) {
        case 'openPanel':
            openPanel(String(payload.panel ?? ''), payload);
            return;
        case 'playSound':
            audio.playSound(String(payload.name ?? ''));
            return;
        case 'changeFloor':
            onFloorChange(payload);
            return;
        case 'tip':
            // `tip` 走 JSON 动作时可能只带文本；统一走对话框 tip
            dialog.tip(String(payload.text ?? ''), payload.icon as string | undefined);
            return;
        default:
            fx.execute(type, payload);
    }
}
runtime.setPresenter(dialog);

////// 上下文 //////

const ctx: GameContext = {
    runtime,
    materials,
    fx,
    audio,
    run(token) {
        const ok = runtime.turns.run(token);
        if (ok) bumpRevision();
        render();
        renderStatus();
        return ok;
    },
    openPanel(name, extra) {
        openPanel(name, extra);
        audio.playSound('打开界面');
    },
    closePanel() {
        closePanel();
        audio.playSound('取消');
    },
    tip(text, icon) {
        dialog.tip(text, icon);
    },
    advance() {
        if (dialog.advance()) {
            render();
            renderStatus();
        }
    },
    resolveIcon,
    playSound(name) {
        audio.playSound(name);
    },
    save() {
        audio.playSound('存档');
        if (runtime.save()) dialog.tip('已存档。');
        else dialog.tip('存档失败。');
    },
    load() {
        audio.playSound('读档');
        if (runtime.load()) {
            render();
            renderStatus();
            dialog.tip('已读档。');
        } else {
            dialog.tip('没有找到存档。');
        }
    },
    startGame(levelIndex) {
        const levels = Array.isArray(data.tower.main.levelChoose)
            ? (data.tower.main.levelChoose as { hard?: number; action?: unknown }[])
            : [];
        const level = levels[levelIndex];
        const actions: unknown[] = [];
        if (level) {
            if (typeof level.hard === 'number') runtime.state.flags.hard = level.hard;
            if (Array.isArray(level.action)) actions.push(...level.action);
        }
        const startText = (data.tower.firstData as Record<string, unknown>).startText;
        if (Array.isArray(startText)) actions.push(...startText);

        if (actions.length > 0) {
            runtime.events.start(actions, {
                callback: () => runtime.start(),
            });
        } else {
            runtime.start();
        }
        render();
        renderStatus();
    },
    refresh() {
        bumpRevision();
        render();
        renderStatus();
    },
    toggleSkin() {
        if ($theme.value.skin) {
            setTheme(defaultTheme);
            applyTheme(defaultTheme);
            return;
        }
        void loadSkin().then((url) => {
            if (!url) {
                dialog.tip('窗口皮肤加载失败。');
                return;
            }
            const next = parseTheme({
                id: 'winskin',
                name: '默认皮肤',
                skin: url,
                skinSlice: 16,
            });
            setTheme(next);
            applyTheme(next);
        });
    },
    setGameCanvas(canvas) {
        gameCanvas = canvas;
        gameCtx = canvas?.getContext('2d') ?? null;
        if (gameCtx) gameCtx.imageSmoothingEnabled = false;
        render();
    },
    setFxCanvas(canvas) {
        if (canvas) fx.attach(canvas);
        fx.resize(gameCanvas?.width ?? 0, gameCanvas?.height ?? 0);
    },
};

////// 回合反馈：显伤与音效 //////

runtime.turns.onOutcome((outcome) => {
    const move = outcome.move;
    if (move) {
        if (move.moved) movedAt = performance.now();
        if (move.action === 'battle' && typeof move.damage === 'number') {
            fx.damagePopup(move.x, move.y, `-${move.damage}`, '#ff8080');
            audio.playSound('攻击');
        } else if (move.action === 'door') {
            audio.playSound('开关门');
        } else if (move.action === 'item') {
            audio.playSound('获得道具');
        }
    }
    if (outcome.token.startsWith('item:')) audio.playSound('确定');
    if (outcome.token.startsWith('fly:')) audio.playSound('飞行器');
});

////// 主循环 //////

function detectMobile(): void {
    const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    $mobile.value = coarse || window.innerWidth < 720;
}

window.addEventListener('resize', () => {
    detectMobile();
    render();
});
detectMobile();

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('未找到 #app 容器');
renderApp(<App ctx={ctx} />, root);

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
    const fxAnimating = fx.update(now);
    if (fxAnimating) render();
    fx.draw();
    // 自动事件（旧 `core.checkAutoEvents`）
    runtime.update();
    renderStatus();
    $dialogBusy.value = dialog.busy;
    requestAnimationFrame(loop);
}

requestAnimationFrame(loop);

// 暴露运行时，便于调试与接入脚本 API
Object.assign(globalThis, { mota: runtime, motaApi: runtime.api, motaDialog: dialog, motaFx: fx });
