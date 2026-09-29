/**
 * 游戏入口的共享上下文。
 *
 * 面板、工具栏、输入层都只依赖这个接口，不直接碰 `runtime` 的内部细节：
 * 所有「改变游戏状态」的操作都经过 `run(token)`（回合分发器），
 * 与录像回放、塔作者脚本共用同一条路径。
 */
import type { MaterialStore } from '../engine/materials';
import type { MotaRuntime } from '../engine/runtime';
import type { AudioPlayer } from './audio';
import type { FxLayer } from './fx';

export interface GameContext {
    runtime: MotaRuntime;
    materials: MaterialStore;
    fx: FxLayer;
    audio: AudioPlayer;
    /** 执行一个录像 token；成功返回 true */
    run(token: string): boolean;
    openPanel(name: string, data?: Record<string, unknown>): void;
    closePanel(): void;
    /** 瞬时提示（旧 `drawTip`） */
    tip(text: string, icon?: string): void;
    /** 点一下 / 空格回车：推进对话（旧 `DialogController.advance`） */
    advance(): void;
    /** 富文本 `\i[id]` 图标 → 图片地址 */
    resolveIcon(id: string): string | undefined;
    playSound(name: string): void;
    save(): void;
    load(): void;
    /** 开局：难度 + 开始文本 + 初始层抵达事件 */
    startGame(levelIndex: number): void;
    /** 在「无皮肤」与「RM 窗口皮肤（重切成九宫格）」之间切换 */
    toggleSkin(): void;
    /** 重绘地图与状态栏（回合之后由宿主调用） */
    refresh(): void;
    /** 地图画布（`#game`），由 `<App>` 挂载时注入 */
    setGameCanvas(canvas: HTMLCanvasElement | null): void;
    /** 特效画布（`#fx`） */
    setFxCanvas(canvas: HTMLCanvasElement | null): void;
}
