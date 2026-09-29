/**
 * 面板共用件：道具图标、订阅辅助、面板 props。
 */
import type { MaterialStore } from '../../engine/materials';
import { TILE } from '../../engine/tiles';
import { $revision } from '../../ui';
import type { GameContext } from '../context';

export interface GamePanelProps {
    ctx: GameContext;
    close: () => void;
    data: Record<string, unknown>;
}

/** 读一次 `$revision`：面板据此订阅「回合之后刷新」 */
export function useRevision(): number {
    return $revision.value;
}

/** 把道具画进一个小 canvas（图集里 item 一律在 `items.png`） */
export function drawItemIcon(
    canvas: HTMLCanvasElement,
    materials: MaterialStore,
    id: string,
): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    materials.drawElement(ctx, { cls: 'items', id }, 0, 0);
}

export interface ItemIconProps {
    materials: MaterialStore;
    id: string;
}

export function ItemIcon({ materials, id }: ItemIconProps) {
    return (
        <canvas
            class="mota-entry-icon"
            width={TILE}
            height={TILE}
            ref={(element) => {
                if (element) drawItemIcon(element, materials, id);
            }}
        />
    );
}
