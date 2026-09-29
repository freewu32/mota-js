/**
 * 游戏入口自己的一点点状态（不进 `src/ui`，避免编辑器依赖游戏排版）。
 */
import { signal } from '@preact/signals';
import type { GameLayout } from './layout';

/** 当前排版参数；`resize` / 换层时重算 */
export const $layout = signal<GameLayout | null>(null);

/** 移动端虚拟键盘（旧 `openKeyBoard`）是否展开，默认收起 */
export const $padVisible = signal(false);
