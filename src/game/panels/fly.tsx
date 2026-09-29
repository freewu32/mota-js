import type { FloorData } from '../../shared/data/schema';
import { drawScene } from '../../engine/renderer';
import { TILE } from '../../engine/tiles';
import { Panel } from '../../ui';
import type { GameContext } from '../context';
import type { GamePanelProps } from './shared';

/** 楼层传送：只列出「已到达且允许传送」的楼层（旧 `drawFly`） */
export function FlyPanel({ ctx, close }: GamePanelProps) {
    const floors = ctx.runtime.floorView();
    return (
        <Panel
            title="楼层传送"
            onClose={close}
            footer="只能传送到已经到达且允许传送的楼层"
        >
            <div class="mota-grid">
                {floors.map((entry) => {
                    const disabled = !entry.selectable && !entry.current;
                    return (
                        <button
                            key={entry.floorId}
                            type="button"
                            class={entry.current ? 'mota-entry is-current' : 'mota-entry'}
                            disabled={disabled}
                            onClick={() => {
                                if (entry.current || ctx.run(`fly:${entry.floorId}`)) close();
                            }}
                        >
                            <span class="mota-entry-name">{entry.name}</span>
                            {entry.current && <span class="mota-entry-count">当前</span>}
                        </button>
                    );
                })}
            </div>
        </Panel>
    );
}

function drawFloor(canvas: HTMLCanvasElement, ctx: GameContext, floorId: string): void {
    const context = canvas.getContext('2d');
    if (!context) return;
    context.imageSmoothingEnabled = false;
    const floor = ctx.runtime.data.floors[floorId] as FloorData | undefined;
    if (!floor) return;
    const hero =
        floorId === ctx.runtime.state.floorId
            ? { x: ctx.runtime.state.hero.x, y: ctx.runtime.state.hero.y }
            : { x: -1, y: -1 };
    drawScene(context, floor, ctx.runtime.data.maps, hero, ctx.materials, 0);
}

function FloorThumb({ ctx, floorId }: { ctx: GameContext; floorId: string }) {
    const floor = ctx.runtime.data.floors[floorId] as FloorData | undefined;
    if (!floor) return null;
    const width = (floor.map[0]?.length ?? 13) * TILE;
    const height = floor.map.length * TILE;
    return (
        <div class="mota-view">
            <div class="mota-section">
                {floor.title}
                {floorId === ctx.runtime.state.floorId ? '（当前）' : ''}
            </div>
            <canvas
                class="mota-view-map"
                width={width}
                height={height}
                ref={(element) => {
                    if (element) drawFloor(element, ctx, floorId);
                }}
            />
        </div>
    );
}

/** 地图浏览：把已到达楼层的地图并排画出来（旧 `viewMaps` 面板） */
export function ViewMapPanel({ ctx, close }: GamePanelProps) {
    const visited = ctx.runtime.floorIds.filter(
        (id) =>
            ctx.runtime.hasVisited(id) &&
            (ctx.runtime.data.floors[id] as FloorData | undefined)?.cannotViewMap !== true,
    );
    const hidden = ctx.runtime.floorIds.filter(
        (id) =>
            ctx.runtime.hasVisited(id) &&
            (ctx.runtime.data.floors[id] as FloorData | undefined)?.cannotViewMap === true,
    );
    return (
        <Panel
            title="地图浏览"
            class="mota-panel-wide"
            onClose={close}
            footer={
                hidden.length > 0
                    ? `${hidden.length} 层禁止查看（cannotViewMap）`
                    : '只显示已经到达过的楼层'
            }
        >
            {visited.length === 0 && <div class="mota-muted">还没有到过任何楼层。</div>}
            <div class="mota-views">
                {visited.map((id) => (
                    <FloorThumb key={id} ctx={ctx} floorId={id} />
                ))}
            </div>
        </Panel>
    );
}
