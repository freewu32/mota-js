import { useEffect, useRef, useState } from 'preact/hooks';
import type { CSSProperties } from 'preact';
import { Dialog, $dialogBusy, StatusBar } from '../ui';
import type { GameContext } from './context';
import { bindKeyboard, bindTouch } from './input';
import { MobilePad } from './mobile';
import { PanelOutlet } from './panels';
import { FloorCurtain } from './curtain';
import { StartOverlay, type StartLevel, type StartStyles } from './start';
import { $layout, $padVisible } from './store';

/**
 * 工具栏（旧 `#toolBar` 的 `img-book` / `img-fly` / …）。
 *
 * 图标格号取自旧 `main.statusBar.icons`（单列 `icons.png`，32px 一格）；
 * 竖屏多出「虚拟键盘」「商店」两个按钮（旧版也只在竖屏显示这两项）。
 */
interface ToolButton {
    id: string;
    label: string;
    icon: number;
    /** 打开的面板；与 `action` 二选一 */
    panel?: string;
    /** 特殊动作 */
    action?: 'pad';
    /** 只在竖屏显示（旧 `keyboard` / `shop`） */
    verticalOnly?: boolean;
}

const TOOLBAR: ToolButton[] = [
    { id: 'book', label: '怪物手册', icon: 10, panel: 'monsterManual' },
    { id: 'fly', label: '楼层传送', icon: 11, panel: 'floorMap' },
    { id: 'toolbox', label: '道具', icon: 12, panel: 'items' },
    { id: 'equipbox', label: '装备', icon: 24, panel: 'equips' },
    { id: 'keyboard', label: '虚拟键盘', icon: 13, action: 'pad', verticalOnly: true },
    { id: 'shop', label: '商店', icon: 14, panel: 'shops', verticalOnly: true },
    { id: 'save', label: '存读档', icon: 15, panel: 'save' },
    { id: 'settings', label: '设置', icon: 17, panel: 'settings' },
];

function Toolbar({ ctx, vertical }: { ctx: GameContext; vertical: boolean }) {
    const buttons = TOOLBAR.filter((one) => vertical || !one.verticalOnly);
    // 旧 `#hard`：工具栏末尾显示当前难度名（`main.levelChoose[i].name`，如 Easy）
    const levels = Array.isArray(ctx.runtime.data.tower.main.levelChoose)
        ? (ctx.runtime.data.tower.main.levelChoose as StartLevel[])
        : [];
    const hardName = levels.find((one) => one.hard === ctx.runtime.state.flags.hard)?.name ?? '';
    return (
        <div class="mota-toolbar">
            {buttons.map((button) => (
                <button
                    key={button.id}
                    id={button.id}
                    type="button"
                    class="mota-tool-button"
                    title={button.label}
                    aria-label={button.label}
                    onClick={() => {
                        if (button.action === 'pad') $padVisible.value = !$padVisible.value;
                        else if (button.panel) ctx.openPanel(button.panel);
                    }}
                >
                    <span
                        class="mota-tool-icon"
                        style={{
                            backgroundPositionY: `calc(var(--mota-tool-height) * ${-button.icon})`,
                        }}
                    />
                    <span class="mota-tool-label">{button.label}</span>
                </button>
            ))}
            {hardName && <span class="mota-hard">{hardName}</span>}
        </div>
    );
}

export function App({ ctx }: { ctx: GameContext }) {
    const [started, setStarted] = useState(false);
    const stage = useRef<HTMLDivElement>(null);
    const layout = $layout.value;
    const vertical = layout?.vertical ?? true;

    useEffect(() => {
        const element = stage.current;
        const hooks = { busy: () => $dialogBusy.value, advance: () => ctx.advance() };
        const unbindKeyboard = bindKeyboard(ctx, hooks);
        const unbindTouch = element ? bindTouch(element, ctx, hooks) : () => {};
        return () => {
            unbindKeyboard();
            unbindTouch();
        };
    }, [ctx]);

    const firstData = ctx.runtime.data.tower.firstData;
    const levels = Array.isArray(ctx.runtime.data.tower.main.levelChoose)
        ? (ctx.runtime.data.tower.main.levelChoose as StartLevel[])
        : [];
    // 开始界面外观：`main.styles` 的 startBackground / startLogoStyle / startButtonsStyle
    const towerStyles = (ctx.runtime.data.tower.main.styles ?? {}) as Record<string, unknown>;
    const startStyles: StartStyles = {
        background: String(
            (vertical
                ? (towerStyles.startVerticalBackground ?? towerStyles.startBackground)
                : towerStyles.startBackground) ?? '',
        ),
        logoStyle:
            typeof towerStyles.startLogoStyle === 'string' ? towerStyles.startLogoStyle : undefined,
        buttonsStyle:
            typeof towerStyles.startButtonsStyle === 'string'
                ? towerStyles.startButtonsStyle
                : undefined,
    };

    // 排版参数以 CSS 变量下沉到样式表（旧版是直接写到每个元素的行内样式）
    const style: CSSProperties = layout
        ? {
              '--mota-map-w': `${layout.displayWidth}px`,
              '--mota-map-h': `${layout.displayHeight}px`,
              '--mota-outer-w': `${layout.outerWidth}px`,
              '--mota-outer-h': `${layout.outerHeight}px`,
              '--mota-bar-w': `${layout.barWidth * layout.scale}px`,
              '--mota-status-h': `${layout.statusBarHeight}px`,
              '--mota-toolbar-h': `${layout.toolbarHeight}px`,
              '--mota-status-item-h': `${layout.statusItemHeight}px`,
              '--mota-status-font': `${layout.statusFontSize}px`,
              '--mota-tool-height': `${layout.toolbarItemHeight}px`,
              '--mota-font-size': `${layout.fontSize}px`,
              '--mota-border': `${layout.border}px`,
          }
        : {};

    return (
        <div
            class="mota-app"
            data-vertical={vertical ? 'true' : 'false'}
            data-toolbar-extend={
                ctx.runtime.data.tower.flags.extendToolbar === true ? 'true' : 'false'
            }
            data-hide-status={
                ctx.runtime.data.tower.flags.hideLeftStatusBar === true ? 'true' : 'false'
            }
            style={style}
        >
            <StatusBar onSlotClick={(panel) => ctx.openPanel(panel)} />
            <div
                class="mota-stage"
                ref={stage}
                onClick={(event) => ctx.onStageClick(event as MouseEvent)}
            >
                <canvas id="game" class="mota-map" ref={(element) => ctx.setGameCanvas(element)} />
                <canvas id="fx" class="mota-fx" ref={(element) => ctx.setFxCanvas(element)} />
                {/* 对话框与换层黑幕都画在地图区域内（旧版画在 `ui` 画布 / `#floorMsgGroup`） */}
                <Dialog onAdvance={() => ctx.advance()} resolveIcon={(id) => ctx.resolveIcon(id)} />
                <FloorCurtain />
            </div>
            <Toolbar ctx={ctx} vertical={vertical} />
            {$padVisible.value && <MobilePad ctx={ctx} visible />}
            <PanelOutlet ctx={ctx} />
            {!started && (
                <StartOverlay
                    title={firstData.title}
                    version={firstData.version}
                    levels={levels}
                    styles={startStyles}
                    onStart={(index) => {
                        setStarted(true);
                        ctx.startGame(index);
                    }}
                    onLoad={() => {
                        setStarted(true);
                        ctx.load();
                    }}
                />
            )}
        </div>
    );
}
