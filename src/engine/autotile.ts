/**
 * autotile（自动元件）渲染。
 *
 * 一个 32x32 的 autotile 由 4 个 16x16 象限组成，图集按「3x32 宽（96px）为一组状态」
 * 排列，每组包含 16 种边界形态与 4 种拐角。这里的索引表与切分逻辑对齐旧的
 * maps._drawAutotile / _drawAutotile_render / _drawAutotile_renderCut。
 */

export interface AutotileCommand {
    sx: number;
    sy: number;
    sw: number;
    sh: number;
    ox: number;
    oy: number;
    ow: number;
    oh: number;
}

/** 格子内的四个象限：0 左上，1 右上，2 左下，3 右下 */
type Quadrants = [boolean, boolean, boolean, boolean];

/**
 * 该坐标的图块是否与当前 autotile 连通（越界视为连通）。
 * edges 为「哪些编号可以视作同一自动元件」的连通表，对齐旧 _makeAutotileEdges。
 */
export function autotileAround(
    map: readonly (readonly number[])[],
    edges: Record<number, number[]>,
    currId: number,
    x: number,
    y: number,
): boolean {
    const row = map[y];
    const width = map[0]?.length ?? 0;
    if (!row || x < 0 || y < 0 || x >= width || y >= map.length) return true;
    return (edges[currId] ?? [currId]).includes(row[x] ?? 0);
}

/**
 * 计算某格 autotile 需要绘制的片段。
 * @param status 图集状态组序号（动画帧），图集宽度不足 96 时取 0
 * @param groups 图集内状态组数量，用于对 status 取模
 */
export function autotileCommands(
    map: readonly (readonly number[])[],
    x: number,
    y: number,
    edges: Record<number, number[]>,
    status = 0,
    groups = 1,
): AutotileCommand[] {
    const currId = map[y]?.[x] ?? 0;
    const g = (dx: number, dy: number): number =>
        autotileAround(map, edges, currId, x + dx, y + dy) ? 1 : 0;

    const groupCount = Math.max(1, Math.floor(groups) || 1);
    const base = 96 * (((status % groupCount) + groupCount) % groupCount);
    // 索引 -> [sx, sy, sw, sh, ox, oy, ow, oh]
    const table: number[][][] = [
        [[base, 0, 32, 32, 0, 0, 32, 32]],
        [
            [base, 96, 16, 32, 0, 0, 16, 32],
            [base + 80, 96, 16, 32, 16, 0, 16, 32],
        ],
        [
            [base + 64, 32, 32, 16, 0, 0, 32, 16],
            [base + 64, 112, 32, 16, 0, 16, 32, 16],
        ],
        [[base + 64, 96, 32, 32, 0, 0, 32, 32]],
        [
            [base, 32, 16, 32, 0, 0, 16, 32],
            [base + 80, 32, 16, 32, 16, 0, 16, 32],
        ],
        [
            [base, 64, 16, 32, 0, 0, 16, 32],
            [base + 80, 64, 16, 32, 16, 0, 16, 32],
        ],
        [[base + 64, 32, 32, 32, 0, 0, 32, 32]],
        [[base + 64, 64, 32, 32, 0, 0, 32, 32]],
        [
            [base, 32, 32, 16, 0, 0, 32, 16],
            [base, 112, 32, 16, 0, 16, 32, 16],
        ],
        [[base, 96, 32, 32, 0, 0, 32, 32]],
        [
            [base + 32, 32, 32, 16, 0, 0, 32, 16],
            [base + 32, 112, 32, 16, 0, 16, 32, 16],
        ],
        [[base + 32, 96, 32, 32, 0, 0, 32, 32]],
        [[base, 32, 32, 32, 0, 0, 32, 32]],
        [[base, 64, 32, 32, 0, 0, 32, 32]],
        [[base + 32, 32, 32, 32, 0, 0, 32, 32]],
        [[base + 32, 64, 32, 32, 0, 0, 32, 32]],
        [[base + 64, 0, 16, 16, 0, 0, 16, 16]],
        [[base + 80, 0, 16, 16, 0, 0, 16, 16]],
        [[base + 80, 16, 16, 16, 0, 0, 16, 16]],
        [[base + 64, 16, 16, 16, 0, 0, 16, 16]],
    ];

    const commands: AutotileCommand[] = [];
    const done: Quadrants = [false, false, false, false];

    const emit = (rect: number[], ox: number, oy: number): void => {
        commands.push({
            sx: rect[0] ?? 0,
            sy: rect[1] ?? 0,
            sw: rect[2] ?? 0,
            sh: rect[3] ?? 0,
            ox: ox + (rect[4] ?? 0),
            oy: oy + (rect[5] ?? 0),
            ow: rect[6] ?? 0,
            oh: rect[7] ?? 0,
        });
    };

    /** 非拐角形态需要按「已绘制的象限」切分后绘制 */
    const renderCut = (data: number[][], ox: number, oy: number): void => {
        const cells: (number[] | null)[] = [null, null, null, null];
        if (data.length === 2) {
            let idx: number;
            let cut = 0;
            for (const rect of data) {
                if ((rect[2] ?? 0) % 32) cut = 0;
                else if ((rect[3] ?? 0) % 32) cut = 1;
                idx = (rect[0] ?? 0) % 32 || (rect[1] ?? 0) % 32 ? 1 : 0;
                if (cut) {
                    idx *= 2;
                    if (!done[idx]) cells[idx] = [rect[0] ?? 0, rect[1] ?? 0, 16, 16, 0, 0, 16, 16];
                    if (!done[idx + 1])
                        cells[idx + 1] = [(rect[0] ?? 0) + 16, rect[1] ?? 0, 16, 16, 0, 0, 16, 16];
                } else {
                    if (!done[idx]) cells[idx] = [rect[0] ?? 0, rect[1] ?? 0, 16, 16, 0, 0, 16, 16];
                    if (!done[idx + 2])
                        cells[idx + 2] = [rect[0] ?? 0, (rect[1] ?? 0) + 16, 16, 16, 0, 0, 16, 16];
                }
            }
        } else {
            const rect = data[0] ?? [0, 0, 0, 0];
            for (let i = 0; i < 4; i++) {
                if (done[i]) continue;
                cells[i] = [
                    (rect[0] ?? 0) + (i % 2) * 16,
                    (rect[1] ?? 0) + Math.floor(i / 2) * 16,
                    16,
                    16,
                    0,
                    0,
                    16,
                    16,
                ];
            }
        }
        for (let i = 0; i < 4; i++) {
            const cell = cells[i];
            if (!cell) continue;
            emit(cell, ox + (i % 2) * 16, oy + Math.floor(i / 2) * 16);
        }
    };

    const render = (ox: number, oy: number, index: number): void => {
        const data = table[index] ?? table[0]!;
        if (index >= 16) {
            emit(data[0]!, ox, oy);
        } else {
            renderCut(data, ox, oy);
        }
    };

    // 四个角的特殊形态（只缺对角时的内侧拐角）
    if (g(-1, -1) + g(0, -1) + g(0, 0) + g(-1, 0) === 3 && !g(-1, -1)) {
        render(0, 0, 16);
        done[0] = true;
    }
    if (g(0, -1) + g(1, -1) + g(1, 0) + g(0, 0) === 3 && !g(1, -1)) {
        render(16, 0, 17);
        done[1] = true;
    }
    if (g(0, 0) + g(1, 0) + g(1, 1) + g(0, 1) === 3 && !g(1, 1)) {
        render(16, 16, 18);
        done[3] = true;
    }
    if (g(-1, 0) + g(0, 0) + g(0, 1) + g(-1, 1) === 3 && !g(-1, 1)) {
        render(0, 16, 19);
        done[2] = true;
    }

    // 四方向掩码：上 1、左 2、下 4、右 8
    render(0, 0, g(0, -1) + 2 * g(-1, 0) + 4 * g(0, 1) + 8 * g(1, 0));
    return commands;
}

/**
 * 构建 autotile 连通表：把「左上块像素相同」的编号视为同一自动元件。
 * 对齐旧 maps._makeAutotileEdges（旧实现用 toDataURL 比较，这里由调用方提供键值）。
 */
export function buildAutotileEdges(
    ids: readonly number[],
    blockAt: (id: number, index: 0 | 1) => string | null,
): Record<number, number[]> {
    const first = new Map<number, string>();
    const second = new Map<number, string>();
    for (const id of ids) {
        const a = blockAt(id, 0);
        if (a !== null) first.set(id, a);
        const b = blockAt(id, 1);
        if (b !== null) second.set(id, b);
    }

    const edges: Record<number, number[]> = {};
    for (const [id, key] of first) {
        const list = [id];
        for (const [other, otherKey] of second) {
            if (other !== id && otherKey === key) list.push(other);
        }
        edges[id] = list;
    }
    return edges;
}
