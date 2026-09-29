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
import { drawFollowers, drawHeroSprite, drawScene } from '../engine/renderer';
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
    $panel,
    setStatus,
    setTheme,
} from '../ui';
import { App } from './app';
import { AutoRoute, tileAt } from './autopath';
import { loadImage } from './assets';
import { AudioPlayer } from './audio';
import type { GameContext } from './context';
import { showFloorCurtain } from './curtain';
import { FxLayer, type OverlayDamage } from './fx';
import { createIconResolver } from './icons';
import { computeGameLayout, viewportSize, type GameLayout } from './layout';
import { buildWindowSkinDataUrl, resolveThemeSkin } from './skin';
import { $layout } from './store';
import { $displayCritical, $displayEnemyDamage, $scaleOverride } from './settings';

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

// UI 钩子脚本（旧 `functions.ui`）：塔作者在 `firstData.ui.script` 里登记
const uiScript = (data.tower.firstData as Record<string, unknown>).ui as
    | { script?: string }
    | undefined;
if (uiScript?.script) {
    const ok = await runtime.setupUiScript(uiScript.script);
    if (!ok) console.error(`UI 脚本加载失败：${uiScript.script}`);
}

////// 画面 //////

let gameCanvas: HTMLCanvasElement | null = null;
let gameCtx: CanvasRenderingContext2D | null = null;
let animate = 0;
/** 最近一次成功移动的时间（决定勇士用走路的哪一帧） */
let movedAt = 0;
/** 当前排版参数（旧 `core.domStyle.scale` / `isVertical` 等） */
let layout: GameLayout = computeGameLayout({
    clientWidth: viewportSizeFallback().width,
    clientHeight: viewportSizeFallback().height,
    mapWidth: TILE * 13,
    mapHeight: TILE * 13,
    statusRows: 1,
    statusCount: 1,
});
const animateClock = new AnimateClock(120);

/** 高清画布倍率（旧 `core.domStyle.ratio = max(devicePixelRatio, scale)`） */
function pixelRatio(): number {
    const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
    return Math.max(dpr, 1);
}

// 勇士精灵：`firstData.hero.image` 指向 project/images 下的图（旧 `material.images.hero`）
const heroImage = await loadImage(
    `/project/images/${String(data.tower.firstData.hero?.image ?? 'hero.png')}`,
);
const heroIcons = (data.icons as Record<string, unknown>).hero as
    | import('../engine/renderer').HeroIcons
    | undefined;

/**
 * 跟随者用的图片（旧 `material.images.images`）：`main.images` 里的文件按文件名索引，
 * 剧本 `follow` 传的就是这个文件名（如 `bear.png`）。懒加载，缺图时该跟随者不绘制。
 */
const followerImages: Record<string, HTMLImageElement | undefined> = {};
const loadingFollowers = new Set<string>();

function ensureFollowerImage(name: string): void {
    if (followerImages[name] || loadingFollowers.has(name)) return;
    loadingFollowers.add(name);
    void loadImage(`/project/images/${name}`).then((image) => {
        loadingFollowers.delete(name);
        if (image) {
            followerImages[name] = image;
            render();
        }
    });
}

/** 跟随者精灵：按名字取图，缺图的先发起加载（加载完重绘） */
function followerSprites(): import('../engine/renderer').FollowerSprite[] {
    const followers = runtime.state.hero.followers ?? [];
    for (const follower of followers) ensureFollowerImage(follower.name);
    return followers;
}

function render(): void {
    if (!gameCanvas || !gameCtx) return;
    const width = (runtime.floor.map[0]?.length ?? 13) * TILE;
    const height = runtime.floor.map.length * TILE;
    // 背板按「高清倍率」放大，变换设成倍率 -> 之后都按地图像素绘制（旧 `_setHDCanvasSize`）
    const ratio = pixelRatio();
    const backingWidth = Math.max(1, Math.round(width * ratio));
    const backingHeight = Math.max(1, Math.round(height * ratio));
    if (gameCanvas.width !== backingWidth || gameCanvas.height !== backingHeight) {
        gameCanvas.width = backingWidth;
        gameCanvas.height = backingHeight;
    }
    gameCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
    gameCtx.imageSmoothingEnabled = false;
    fx.resize(width, height, ratio);
    const override = fx.heroOverride;
    const hero = override ? { x: override.x, y: override.y } : runtime.state.hero;
    drawScene(
        gameCtx,
        runtime.floor,
        data.maps,
        hero,
        materials,
        animate,
        heroImage == null,
        runtime.getBlocks(runtime.state.floorId),
    );
    if (heroImage) {
        // 跟随者画在勇士之前，保证勇士在最上层（旧版按 y 排序，这里简化）
        const followers = followerSprites();
        if (followers.length > 0) {
            drawFollowers(gameCtx, followerImages, heroIcons, followers, animate);
        }
        drawHeroSprite(
            gameCtx,
            heroImage,
            heroIcons,
            { ...hero, direction: runtime.state.hero.direction },
            animate,
            performance.now() - movedAt < 220,
        );
    }
    renderDamage();
}

/**
 * 地图显伤（旧 `control.updateDamage` / `drawDamage`）。
 *
 * 旧版需要持有怪物手册（`book`）才显示。算一层显伤要扫一遍光环 / 支援，很贵，
 * 所以先用一个廉价指纹（楼层 / 勇士关键属性 / 位置 / 图块数 / flag 数）挡住
 * 主循环的每帧调用，指纹变了才重算。
 */
let damageKey = '';

function renderDamage(): void {
    if (!runtime.items.has('book') || !$displayEnemyDamage.value) {
        if (damageKey !== '') {
            damageKey = '';
            fx.setDamageOverlay(null);
        }
        return;
    }
    const hero = runtime.state.hero;
    const key = [
        runtime.state.floorId,
        hero.x,
        hero.y,
        hero.atk,
        hero.def,
        hero.mdef,
        hero.hp,
        runtime.getBlocks(runtime.state.floorId).length,
        Object.keys(runtime.state.flags).length,
        $displayCritical.value ? 'c' : '-',
    ].join(':');
    if (key === damageKey) return;
    damageKey = key;

    const list: OverlayDamage[] = [];
    for (const enemy of runtime.listEnemies()) {
        list.push({ x: enemy.x, y: enemy.y, text: enemy.damage, color: enemy.color });
        if (!$displayCritical.value) continue;
        const critical = runtime.criticalAt(enemy.x, enemy.y);
        if (critical == null) continue;
        // 临界值画在伤害上方（旧版 `py = 32*(y+1)-11`）
        list.push({ x: enemy.x, y: enemy.y, text: critical, color: '#FFFFFF', dy: 10 });
    }
    fx.setDamageOverlay(list);
}

function renderStatus(): void {
    setStatus(runtime.statusBarView());
}

////// 排版（旧 `control.resize`）与塔作者外观 //////

/** 当前楼层地图的逻辑尺寸 */
function mapSize(): { width: number; height: number } {
    return {
        width: (runtime.floor.map[0]?.length ?? 13) * TILE,
        height: runtime.floor.map.length * TILE,
    };
}

/** 排版参数是否没变（避免每回合都写 signal 触发重渲染） */
function sameLayout(a: GameLayout, b: GameLayout): boolean {
    return (
        a.vertical === b.vertical &&
        a.scale === b.scale &&
        a.outerWidth === b.outerWidth &&
        a.outerHeight === b.outerHeight &&
        a.barWidth === b.barWidth &&
        a.statusBarHeight === b.statusBarHeight &&
        a.toolbarHeight === b.toolbarHeight &&
        a.statusItemHeight === b.statusItemHeight &&
        a.statusFontSize === b.statusFontSize &&
        a.toolbarItemHeight === b.toolbarItemHeight &&
        a.extendToolbar === b.extendToolbar
    );
}

/** 旧 `control.resize`：算出排版参数，写进 `$layout`（CSS 变量在 `app.tsx` 里下发） */
function updateLayout(): void {
    const { width, height } = viewportSize();
    const map = mapSize();
    const status = runtime.statusBarView();
    const count = status.visibility.slots.length +
        (status.visibility.keys ? 1 : 0) +
        (status.visibility.pzf ? 1 : 0) +
        (status.visibility.debuff ? 1 : 0);
    const next = computeGameLayout({
        clientWidth: width,
        clientHeight: height,
        mapWidth: map.width,
        mapHeight: map.height,
        statusRows: Math.max(1, Math.ceil(count / 3)),
        statusCount: Math.max(1, count),
        // 旧 `core.domStyle.scale`：玩家手动选过档位就用它（放缩设置）
        scale: $scaleOverride.value ?? layout.scale,
        extendToolbar: data.tower.flags.extendToolbar === true,
        hideLeftStatusBar: data.tower.flags.hideLeftStatusBar === true,
    });
    const changed = !sameLayout(layout, next);
    layout = next;
    applyGameStyles();
    if (changed) $layout.value = layout;
    // 显伤要跟着换层 / 放缩重算
    damageKey = '';
    renderDamage();
}

/** 单次排版尺寸（在拿到真实楼层之前先用 13x13） */
function viewportSizeFallback(): { width: number; height: number } {
    return typeof document === 'undefined' ? { width: 0, height: 0 } : viewportSize();
}

function rgba(color: unknown, fallback = 'transparent'): string {
    if (typeof color === 'string') return color;
    if (Array.isArray(color) && color.length >= 3) {
        const [r, g, b, a] = color.map((one) => Number(one) || 0);
        return `rgba(${r},${g},${b},${a == null ? 1 : a})`;
    }
    return fallback;
}

/**
 * 把 `main.styles` 里的 `url(project/...)` 改成站内绝对路径。
 *
 * 旧版的样式表在仓库根目录，`project/materials/ground.png` 能直接解析；
 * 3.0 的样式表被打包到 `/_bun/asset/*.css`，相对路径会解析错，所以得转成 `/project/...`。
 */
function rewriteStyleUrls(value: string): string {
    return value.replace(/url\((\s*['"]?)project\//g, 'url($1/project/');
}

/** 把 `main.styles` 里的外观下沉为 CSS 变量（旧 `globalAttribute`） */
function applyGameStyles(): void {
    if (typeof document === 'undefined') return;
    const styles = (data.tower.main.styles ?? {}) as Record<string, unknown>;
    const root = document.documentElement.style;
    const vertical = layout.vertical;
    const statusBackground = vertical
        ? (styles.statusTopBackground ?? styles.statusLeftBackground)
        : (styles.statusLeftBackground ?? styles.statusTopBackground);
    root.setProperty('--mota-status-bg', typeof statusBackground === 'string' ? rewriteStyleUrls(statusBackground) : '#000');
    root.setProperty('--mota-tools-bg', typeof styles.toolsBackground === 'string' ? rewriteStyleUrls(styles.toolsBackground) : 'transparent');
    root.setProperty('--mota-border-color', rgba(styles.borderColor, '#000'));
    root.setProperty('--mota-status-color', rgba(styles.statusBarColor, '#fff'));
    // 换层黑幕（旧 `globalAttribute.floorChangingStyle` = `background-color: black; color: white`）
    root.setProperty('--mota-floor-curtain-bg', rgba(styles.floorChangingColor, '#000'));
    root.setProperty('--mota-floor-curtain-color', rgba(styles.floorChangingTextColor, '#fff'));
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
    if (reason !== 'load') {
        // 换层过场（旧 `#floorMsgGroup`：塔名 / 版本 / 楼层名）
        showFloorCurtain({
            title: String(data.tower.firstData.title ?? ''),
            version: String(data.tower.firstData.version ?? ''),
            floorName: String(floor?.title ?? floorId),
        });
    }
    if (reason !== 'load' && reason !== 'start') fx.flash('#000000', 160);

    updateLayout();
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

/** 自动寻路：点地图走 / 单击瞬移 / 点自己转向（旧 `setAutomaticRoute`） */
const autoRoute = new AutoRoute({
    runtime,
    setRoute: (steps) => fx.setRoute(steps),
    step: (direction) => runtime.turns.run(direction),
    blocked: () => dialog.busy || $dialogBusy.value || $panel.value != null,
    refresh: () => {
        bumpRevision();
        render();
        renderStatus();
    },
});

/** 地图点击：命中格子交给自动寻路；没有命中就当作「继续对话」 */
function onStageClick(event: MouseEvent): void {
    if (dialog.busy) {
        dialog.advance();
        render();
        renderStatus();
        return;
    }
    if ($panel.value != null) return;
    const canvas = gameCanvas;
    if (!canvas) return;
    const tile = tileAt(canvas, event.clientX, event.clientY, TILE * layout.scale);
    if (!tile) return;
    autoRoute.click(tile.x, tile.y);
}

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
            // 存档可能在别的楼层（地图尺寸不同），排版要重算
            updateLayout();
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
        // 新开一局：先回到初始状态（旧 `core.resetGame`），再跑难度的开局剧本
        runtime.reset();
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
        updateLayout();
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
        fx.resize(gameCanvas?.width ?? 0, gameCanvas?.height ?? 0, pixelRatio());
    },
    onStageClick,
    autoRoute,
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
    if (outcome.token.startsWith('shop:')) audio.playSound('商店');
    if (outcome.token.startsWith('fly:')) audio.playSound('飞行器');
});

////// 主循环 //////

function detectMobile(): void {
    const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    $mobile.value = coarse || window.innerWidth < 720;
}

/** 加载状态栏/工具栏的图标图集（`project/materials/icons.png`，单列 32px） */
function loadStatusIcons(): void {
    if (typeof document === 'undefined') return;
    const image = new Image();
    image.onload = () => {
        document.documentElement.style.setProperty(
            '--mota-status-sheet',
            "url('/project/materials/icons.png')",
        );
        document.documentElement.dataset.statusIcons = 'true';
    };
    image.src = '/project/materials/icons.png';
}

window.addEventListener('resize', () => {
    detectMobile();
    updateLayout();
    render();
    renderStatus();
});
detectMobile();
loadStatusIcons();

// 旧 `core._init_flags`：标题 / 版本（`firstData.version` 自带 “Ver”，不再加前缀）
document.title = `${String(data.tower.firstData.title ?? '魔塔')} - HTML5魔塔`;

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('未找到 #app 容器');
renderApp(<App ctx={ctx} />, root);

updateLayout();
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
    autoRoute.update();
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
// 调试用全局。`motaApi` 用 getter：API 是每次访问重建的快照，直接取值会把
// `floorId` 冻结在页面加载时的楼层上。
Object.assign(globalThis, { mota: runtime, motaDialog: dialog, motaFx: fx });
Object.defineProperty(globalThis, 'motaApi', {
    configurable: true,
    get: () => runtime.api,
});
