/**
 * 换层过场（旧 `#floorMsgGroup`）。
 *
 * 旧引擎切层时先淡入一块黑幕（塔名 / 版本 / 楼层名），换完地图再淡出；
 * 这里由游戏入口在 `changeFloor` 效果里驱动：先整块显示，再切到 `out` 相位淡出。
 */
import { signal } from '@preact/signals';

export interface FloorCurtainState {
    id: number;
    title: string;
    version: string;
    floorName: string;
    phase: 'in' | 'out';
}

export const $floorCurtain = signal<FloorCurtainState | null>(null);

/** 显示换层黑幕，`hold` 毫秒后淡出 */
export function showFloorCurtain(
    info: { title: string; version: string; floorName: string },
    hold = 120,
): void {
    const id = Date.now();
    $floorCurtain.value = { id, ...info, phase: 'in' };
    if (typeof window === 'undefined') return;
    window.setTimeout(() => {
        const current = $floorCurtain.value;
        if (current?.id === id) $floorCurtain.value = { ...current, phase: 'out' };
    }, hold);
    window.setTimeout(() => {
        if ($floorCurtain.value?.id === id) $floorCurtain.value = null;
    }, hold + 120);
}

export function FloorCurtain() {
    const state = $floorCurtain.value;
    if (!state) return null;
    return (
        <div class="mota-floor-curtain" data-phase={state.phase}>
            <div class="mota-floor-curtain-title">{state.title}</div>
            <div class="mota-floor-curtain-version">{state.version}</div>
            <div class="mota-floor-curtain-floor">{state.floorName}</div>
        </div>
    );
}
