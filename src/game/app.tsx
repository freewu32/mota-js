import { useEffect, useRef, useState } from 'preact/hooks';
import { Dialog, $dialogBusy, $mobile, StatusBar } from '../ui';
import type { GameContext } from './context';
import { bindKeyboard, bindTouch } from './input';
import { MobilePad } from './mobile';
import { PanelOutlet } from './panels';
import { StartOverlay, type StartLevel } from './start';

/** 状态栏图标：旧版是画在 canvas 上的按钮，这里变成普通按钮 */
const TOOLBAR: [string, string, string][] = [
    ['book', '怪物手册', 'monsterManual'],
    ['toolbox', '道具', 'items'],
    ['equipbox', '装备', 'equips'],
    ['fly', '楼层传送', 'floorMap'],
    ['viewmap', '地图浏览', 'viewMap'],
    ['statistics', '统计', 'statistics'],
    ['save', '存读档', 'save'],
    ['settings', '设置', 'settings'],
    ['help', '帮助', 'help'],
];

function Toolbar({ ctx }: { ctx: GameContext }) {
    return (
        <div class="mota-toolbar">
            {TOOLBAR.map(([id, label, panel]) => (
                <button
                    key={id}
                    id={id}
                    type="button"
                    class="mota-button"
                    onClick={() => ctx.openPanel(panel)}
                >
                    {label}
                </button>
            ))}
        </div>
    );
}

export function App({ ctx }: { ctx: GameContext }) {
    const [started, setStarted] = useState(false);
    const stage = useRef<HTMLDivElement>(null);

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

    return (
        <div class="mota-app">
            <div class="mota-header">
                <span class="mota-title">{firstData.title}</span>
                <span class="mota-muted">v{firstData.version}</span>
            </div>
            <StatusBar />
            <Toolbar ctx={ctx} />
            <div class="mota-stage" ref={stage}>
                <canvas
                    id="game"
                    class="mota-map"
                    ref={(element) => ctx.setGameCanvas(element)}
                />
                <canvas id="fx" class="mota-fx" ref={(element) => ctx.setFxCanvas(element)} />
            </div>
            <MobilePad ctx={ctx} visible={$mobile.value} />
            <Dialog onAdvance={() => ctx.advance()} resolveIcon={(id) => ctx.resolveIcon(id)} />
            <PanelOutlet ctx={ctx} />
            {!started && (
                <StartOverlay
                    title={firstData.title}
                    version={firstData.version}
                    levels={levels}
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
