import type { FloorData, Icons, Maps, TowerData } from '../shared/data/schema';
import type { RuntimeData } from './types';

async function fetchJson<T>(url: string): Promise<T> {
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`加载失败: ${url} (${res.status})`);
    }
    return (await res.json()) as T;
}

/** 从服务端加载整座塔的数据（tower + maps + icons + 全部楼层） */
export async function loadTower(base = ''): Promise<RuntimeData> {
    const [tower, maps, icons, floorList] = await Promise.all([
        fetchJson<TowerData>(`${base}/api/data/tower`),
        fetchJson<Maps>(`${base}/api/data/maps`),
        fetchJson<Icons>(`${base}/api/data/icons`),
        fetchJson<{ floors: string[] }>(`${base}/api/floors`),
    ]);

    const floors: Record<string, FloorData> = {};
    await Promise.all(
        floorList.floors.map(async (id) => {
            floors[id] = await fetchJson<FloorData>(`${base}/api/floors/${id}`);
        }),
    );

    return { tower, maps, icons, floors };
}
