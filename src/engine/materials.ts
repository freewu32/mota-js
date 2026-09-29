import type { Icons, MapElement } from '../shared/data/schema';
import { buildAutotileEdges, autotileCommands } from './autotile';
import { TILE, atlasTileCommand, autotileIds, getTilesetOffset, type TilesetSize } from './tiles';

/** 图块类别 -> 图集文件（每行一个 id，每列一帧） */
const ATLAS_FILES: Record<string, string> = {
    terrains: 'materials/terrains.png',
    animates: 'materials/animates.png',
    enemys: 'materials/enemys.png',
    items: 'materials/items.png',
    npcs: 'materials/npcs.png',
    npc48: 'materials/npc48.png',
    enemy48: 'materials/enemy48.png',
};

function loadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`素材加载失败: ${url}`));
        img.src = url;
    });
}

async function tryLoadImage(url: string): Promise<HTMLImageElement | null> {
    try {
        return await loadImage(url);
    } catch {
        return null; // 缺失素材时由调用方回退为色块
    }
}

/**
 * 素材仓库：按图块类别加载图集，并按图块数据（icons / tilesets / autotiles）
 * 计算裁剪区域后绘制。图块绘制逻辑本身在 tiles.ts / autotile.ts 中保持纯函数。
 */
export class MaterialStore {
    /** cls -> 图集 */
    private readonly atlases = new Map<string, HTMLImageElement>();
    /** autotile id -> 图集 */
    private readonly autotiles = new Map<string, HTMLImageElement>();
    /** tileset 文件名 -> 图集 */
    private readonly tilesets = new Map<string, HTMLImageElement>();
    private readonly tilesetSizes: TilesetSize[] = [];

    /** 哪些编号可视为同一 autotile（跨图块连通） */
    autotileEdges: Record<number, number[]> = {};

    constructor(
        private readonly icons: Icons,
        private readonly tilesetNames: readonly string[] = [],
    ) {}

    async load(base = ''): Promise<void> {
        await Promise.all([
            ...Object.entries(ATLAS_FILES).map(async ([cls, file]) => {
                const img = await tryLoadImage(`${base}/${file}`);
                if (img) this.atlases.set(cls, img);
            }),
            ...autotileIds(this.icons).map(async (id) => {
                const img = await tryLoadImage(`${base}/autotiles/${id}.png`);
                if (img) this.autotiles.set(id, img);
            }),
            ...this.tilesetNames.map(async (name) => {
                const img = await tryLoadImage(`${base}/tilesets/${name}`);
                if (!img) return;
                this.tilesets.set(name, img);
                this.tilesetSizes.push({
                    name,
                    width: img.naturalWidth,
                    height: img.naturalHeight,
                });
            }),
        ]);
    }

    get(cls: string): HTMLImageElement | undefined {
        return this.atlases.get(cls);
    }

    /** 图块行号（icons[cls][id]），无定义返回 null */
    rowIndex(cls: string, id: string): number | null {
        const record = (this.icons as Record<string, unknown>)[cls];
        if (!record || typeof record !== 'object') return null;
        const index = (record as Record<string, unknown>)[id];
        return typeof index === 'number' ? index : null;
    }

    /** autotile 的动画状态组序号 */
    autotileStatus(id: string, animate: number): number {
        const img = this.autotiles.get(id);
        if (!img) return 0;
        const groups = Math.max(1, Math.floor(img.width / 96));
        return ((animate % groups) + groups) % groups;
    }

    /** 绘制普通图块（含 tileset）；缺素材或未登记返回 false，由调用方回退 */
    drawElement(
        ctx: CanvasRenderingContext2D,
        element: MapElement,
        x: number,
        y: number,
        animate = 0,
    ): boolean {
        if (element.cls === 'tileset') {
            const offset = getTilesetOffset(element.id, this.tilesetSizes);
            if (!offset) return false;
            const image = this.tilesets.get(offset.name);
            if (!image || image.width === 0) return false;
            ctx.drawImage(
                image,
                offset.x * TILE,
                offset.y * TILE,
                TILE,
                TILE,
                x * TILE,
                y * TILE,
                TILE,
                TILE,
            );
            return true;
        }

        const command = atlasTileCommand(element, this.icons, animate);
        const image = this.atlases.get(element.cls);
        if (!command || !image || image.width === 0) return false;
        ctx.drawImage(
            image,
            command.sx,
            command.sy,
            command.sw,
            command.sh,
            x * TILE + command.ox,
            y * TILE + command.oy,
            command.ow,
            command.oh,
        );
        return true;
    }

    /** 绘制 autotile：按周围连通情况选取 16x16 象限 */
    drawAutotile(
        ctx: CanvasRenderingContext2D,
        element: MapElement,
        x: number,
        y: number,
        map: readonly (readonly number[])[],
        animate = 0,
    ): boolean {
        const image = this.autotiles.get(element.id);
        if (!image || image.width === 0) return false;
        const groups = Math.max(1, Math.floor(image.width / 96));
        const status = this.autotileStatus(element.id, animate);
        const commands = autotileCommands(map, x, y, this.autotileEdges, status, groups);
        if (commands.length === 0) return false;
        for (const command of commands) {
            ctx.drawImage(
                image,
                command.sx,
                command.sy,
                command.sw,
                command.sh,
                x * TILE + command.ox,
                y * TILE + command.oy,
                command.ow,
                command.oh,
            );
        }
        return true;
    }

    /**
     * 绘制脱离地图的图块（旧 `_initDetachedBlock` 的脱离画布）：
     * 图块移动动画途中用，`px / py` 是像素坐标（可以为小数）。
     *
     * autotile 不再看地图连通（找不到邻居，按孤立图块画）。
     */
    drawDetached(
        ctx: CanvasRenderingContext2D,
        element: MapElement,
        px: number,
        py: number,
        animate = 0,
    ): boolean {
        if (element.cls === 'autotile') {
            return this.drawAutotile(ctx, element, px / TILE, py / TILE, [[0]], animate);
        }
        return this.drawElement(ctx, element, px / TILE, py / TILE, animate);
    }

    /**
     * 构建 autotile 连通表：像素完全相同的图块视为同一自动元件。
     * 需要 canvas 采样，非浏览器环境（如测试）跳过，退化为仅自身连通。
     */
    buildAutotileEdges(idByNumber: Record<number, string>): void {
        if (typeof document === 'undefined') return;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = TILE;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.imageSmoothingEnabled = false;

        const numbers = Object.keys(idByNumber).map(Number);
        this.autotileEdges = buildAutotileEdges(numbers, (id, index) => {
            const image = this.autotiles.get(idByNumber[id] ?? '');
            if (!image || image.width === 0) return null;
            ctx.clearRect(0, 0, TILE, TILE);
            ctx.drawImage(image, index * TILE, 0, TILE, TILE, 0, 0, TILE, TILE);
            return canvas.toDataURL('image/png');
        });
    }
}
