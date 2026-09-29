/**
 * UI 状态桥。
 *
 * 引擎只产出纯数据（`statusBarView()` / `toolboxView()` / …），本文件把它们放进
 * signal，组件订阅 signal：只有绑定了变化节点的组件会重渲染，不需要手工 diff，
 * 也不做每帧 vdom 比对。
 *
 * 约定：
 * - 帧级数据（勇士坐标、动画帧、显伤）**不进 signal**，直接画在 `#fx` canvas 上；
 * - 只在内容真的变了才写 signal（`setStatus` 内置去重），避免主循环每帧触发渲染。
 */
import { signal } from '@preact/signals';
import type { StatusBarView } from '../engine/modules/ui';
import { defaultTheme, type UiTheme } from './theme';

/** 打开面板的请求；`data` 供面板自己解释 */
export interface PanelRequest {
    name: string;
    data: Record<string, unknown>;
}

/** 状态栏模型（`runtime.statusBarView()` 的结果） */
export const $status = signal<StatusBarView | null>(null);
/** 当前打开的面板；null 表示没有面板 */
export const $panel = signal<PanelRequest | null>(null);
/** 当前主题 */
export const $theme = signal<UiTheme>(defaultTheme);
/** 数据结构变化计数：面板读它来订阅「回合之后刷新」 */
export const $revision = signal(0);
/** 是否触屏 / 窄屏布局 */
export const $mobile = signal(false);
/** 对话框是否打开（输入层据此忽略方向键） */
export const $dialogBusy = signal(false);

let statusSignature = '';

/** 写入状态栏模型；内容不变时什么都不做 */
export function setStatus(view: StatusBarView | null): void {
    const signature = view == null ? '' : JSON.stringify(view);
    if (signature === statusSignature) return;
    statusSignature = signature;
    $status.value = view;
}

/** 标记「数据结构变了」，让订阅面板重渲染 */
export function bumpRevision(): void {
    $revision.value += 1;
}

export function openPanel(name: string, data: Record<string, unknown> = {}): void {
    $panel.value = { name, data };
}

export function closePanel(): void {
    $panel.value = null;
}

export function togglePanel(name: string, data: Record<string, unknown> = {}): void {
    if ($panel.value?.name === name) closePanel();
    else openPanel(name, data);
}

export function setTheme(theme: UiTheme): void {
    $theme.value = theme;
}
