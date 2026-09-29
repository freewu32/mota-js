import type { TargetedPointerEvent } from 'preact';
import type { GameContext } from './context';

export interface MobilePadProps {
    ctx: GameContext;
    visible: boolean;
}

/**
 * 移动端虚拟键盘（方向 + 确认）。
 *
 * 与旧版不同：旧版的 `keyboard` 按钮打开的是「输入文字的虚拟键盘」；3.0 把它做成
 * 可收起的移动键盘，默认收起（旧版移动端靠点地图 / 滑动移动），由工具栏的
 * 「虚拟键盘」按钮切换。
 */
export function MobilePad({ ctx, visible }: MobilePadProps) {
    if (!visible) return null;

    const step = (token: string) => (event: TargetedPointerEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.stopPropagation();
        ctx.run(token);
    };

    return (
        <div class="mota-pad">
            <button type="button" class="mota-pad-button mota-pad-up" onPointerDown={step('up')}>
                ▲
            </button>
            <button
                type="button"
                class="mota-pad-button mota-pad-left"
                onPointerDown={step('left')}
            >
                ◀
            </button>
            <button
                type="button"
                class="mota-pad-button mota-pad-ok"
                onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    ctx.advance();
                }}
            >
                ●
            </button>
            <button
                type="button"
                class="mota-pad-button mota-pad-right"
                onPointerDown={step('right')}
            >
                ▶
            </button>
            <button
                type="button"
                class="mota-pad-button mota-pad-down"
                onPointerDown={step('down')}
            >
                ▼
            </button>
        </div>
    );
}
