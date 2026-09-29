/**
 * 输入：键盘 + 触屏手势。
 *
 * 所有方向输入都翻译成录像 token 走 `ctx.run()`（回合分发器），
 * 键盘、触屏虚拟键盘、滑动、录像回放因此共用同一条路径。
 */
import type { GameContext } from './context';

export interface InputHooks {
    /** 对话框是否打开（打开时方向键交给对话） */
    busy(): boolean;
    /** 点一下 / 空格回车：等价 `DialogController.advance()` */
    advance(): void;
}

const DIRECTION_KEYS: Record<string, string> = {
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
};

/** 旧状态栏图标对应的快捷键 */
const PANEL_KEYS: Record<string, string> = {
    x: 'monsterManual',
    t: 'items',
    q: 'equips',
    f: 'floorMap',
    m: 'viewMap',
    s: 'save',
    b: 'statistics',
    h: 'help',
};

export function bindKeyboard(ctx: GameContext, hooks: InputHooks): () => void {
    const onKeyDown = (event: KeyboardEvent): void => {
        // 输入框 / 滑杆里不要抢键（对话框的 input 自己处理回车）
        const target = event.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

        if (event.key === 'Escape') {
            ctx.closePanel();
            return;
        }
        if (hooks.busy()) {
            if (event.key === ' ' || event.key === 'Enter' || event.key === 'c' || event.key === 'C') {
                event.preventDefault();
                hooks.advance();
            }
            return;
        }
        const token = DIRECTION_KEYS[event.key];
        if (token) {
            event.preventDefault();
            ctx.run(token);
            return;
        }
        if (event.key === ' ' || event.key === 'Enter') {
            event.preventDefault();
            return;
        }
        const panel = PANEL_KEYS[event.key.toLowerCase()];
        if (panel) {
            event.preventDefault();
            ctx.openPanel(panel);
        }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
}

/** 触屏：滑动一步走一格，轻点等价于「继续对话」 */
export function bindTouch(target: HTMLElement, ctx: GameContext, hooks: InputHooks): () => void {
    const threshold = 24;
    let start: { x: number; y: number } | null = null;

    const onDown = (event: PointerEvent): void => {
        ctx.audio.unlock();
        start = { x: event.clientX, y: event.clientY };
    };
    const onUp = (event: PointerEvent): void => {
        const origin = start;
        start = null;
        if (!origin) return;
        const dx = event.clientX - origin.x;
        const dy = event.clientY - origin.y;
        if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) {
            if (hooks.busy()) hooks.advance();
            return;
        }
        if (Math.abs(dx) > Math.abs(dy)) ctx.run(dx > 0 ? 'right' : 'left');
        else ctx.run(dy > 0 ? 'down' : 'up');
    };
    const onCancel = (): void => {
        start = null;
    };

    target.addEventListener('pointerdown', onDown);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onCancel);
    return () => {
        target.removeEventListener('pointerdown', onDown);
        target.removeEventListener('pointerup', onUp);
        target.removeEventListener('pointercancel', onCancel);
    };
}
