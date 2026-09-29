/**
 * 富文本里的 `\i[id]` 图标。
 *
 * 引擎的富文本解析只给出图标 id，不认素材；素材在 `MaterialStore` 的图集里，
 * 这里把图集里的一格画进离屏 canvas，转成 data URL 交给 `<img>`（结果按 id 缓存）。
 */
import type { MaterialStore } from '../engine/materials';
import { TILE } from '../engine/tiles';

/** 图标可能来自的图集类别（按旧引擎的 `icons` 分组顺序） */
const ICON_CLASSES = ['items', 'enemys', 'npc48', 'enemy48', 'npcs', 'terrains', 'animates'];

export function createIconResolver(
    materials: MaterialStore,
): (id: string) => string | undefined {
    const cache = new Map<string, string>();
    return (id: string) => {
        const cached = cache.get(id);
        if (cached) return cached;
        if (typeof document === 'undefined') return undefined;
        for (const cls of ICON_CLASSES) {
            if (materials.rowIndex(cls, id) == null) continue;
            const size = cls === 'npc48' || cls === 'enemy48' ? TILE * 1.5 : TILE;
            const canvas = document.createElement('canvas');
            canvas.width = size;
            canvas.height = size;
            const ctx = canvas.getContext('2d');
            if (!ctx) return undefined;
            ctx.imageSmoothingEnabled = false;
            if (!materials.drawElement(ctx, { cls, id }, 0, 0)) continue;
            const url = canvas.toDataURL();
            cache.set(id, url);
            return url;
        }
        return undefined;
    };
}
