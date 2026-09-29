import type { TargetedPointerEvent } from 'preact';
import type { GameContext } from './context';

export interface MobilePadProps {
    ctx: GameContext;
    visible: boolean;
}

/** 移动端虚拟键盘（旧 `ui._drawKeyBoard`）：方向 + 确认 */
export function MobilePad({ ctx, visible }: MobilePadProps) {
    if (!visible) return null;

    const step = (token: string) => (event: TargetedPointerEvent<HTMLButtonElement>) => {
        event.preventDefault();
        ctx.run(token);
    };

    return (
        <div class="mota-mobile-pad">
            <button type="button" class="mota-pad-button mota-pad-up" onPointerDown={step('up')}>
                ▲
            </button>
            <button type="button" class="mota-pad-button mota-pad-left" onPointerDown={step('left')}>
                ◀
            </button>
            <button
                type="button"
                class="mota-pad-button mota-pad-ok"
                onPointerDown={(event) => {
                    event.preventDefault();
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
            <button type="button" class="mota-pad-button mota-pad-down" onPointerDown={step('down')}>
                ▼
            </button>
        </div>
    );
}
