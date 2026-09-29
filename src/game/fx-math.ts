/**
 * 特效层的纯计算：补间、抛物线、上浮。
 * 与 DOM / canvas 无关，可在 `bun test` 里直接验证。
 */
export interface Point {
    x: number;
    y: number;
}

export function clamp01(value: number): number {
    return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function lerp(from: number, to: number, t: number): number {
    return from + (to - from) * t;
}

/** 平滑起止（旧引擎跳跃动画的缓动是线性的，这里用二次缓动更耐看） */
export function easeInOutQuad(t: number): number {
    const x = clamp01(t);
    return x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x);
}

/**
 * 抛物线插值：`arcHeight` 为弧顶高度（单位与坐标一致）。
 * `progress` 为 0..1 的归一化时间。
 */
export function pointAt(progress: number, from: Point, to: Point, arcHeight = 0): Point {
    const t = easeInOutQuad(progress);
    return {
        x: lerp(from.x, to.x, t),
        y: lerp(from.y, to.y, t) - arcHeight * 4 * t * (1 - t),
    };
}

/** 显伤上浮：0..1 的进度 → 向上偏移（像素）与不透明度 */
export function damageMotion(progress: number, rise = 26): { offsetY: number; alpha: number } {
    const t = clamp01(progress);
    return {
        offsetY: -rise * easeInOutQuad(Math.min(1, t * 1.6)),
        alpha: t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3,
    };
}

/** 简单的种子随机数（天气粒子用，保证每帧一致） */
export function seeded(seed: number): () => number {
    let state = seed >>> 0 || 1;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}
