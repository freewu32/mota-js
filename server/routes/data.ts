import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** 允许通过 API 读取的数据文件名（不含扩展名） */
const DATA_NAMES = ['tower', 'enemys', 'items', 'maps', 'icons', 'events'] as const;
type DataName = (typeof DATA_NAMES)[number];

const ID_PATTERN = /^[\w-]+$/;

export interface DataHandlers {
    /** GET /api/data/:name */
    data: (req: Bun.BunRequest) => Promise<Response>;
    /** GET /api/floors */
    floorList: () => Promise<Response>;
    /** GET /api/floors/:id */
    floor: (req: Bun.BunRequest) => Promise<Response>;
}

export function createDataHandlers(projectRoot: string): DataHandlers {
    const readJson = async (rel: string): Promise<unknown> =>
        JSON.parse(await readFile(join(projectRoot, rel), 'utf8'));

    return {
        data: async (req) => {
            const name = req.params.name as DataName;
            if (!DATA_NAMES.includes(name)) {
                return Response.json({ error: `未知数据: ${name}` }, { status: 404 });
            }
            return Response.json(await readJson(`${name}.json`));
        },

        floorList: async () => {
            const entries = await readdir(join(projectRoot, 'floors'));
            const floors = entries
                .filter((f) => f.endsWith('.json'))
                .map((f) => f.slice(0, -'.json'.length));
            return Response.json({ floors });
        },

        floor: async (req) => {
            const id = req.params.id;
            if (!ID_PATTERN.test(id)) {
                return Response.json({ error: `非法楼层 id: ${id}` }, { status: 400 });
            }
            return Response.json(await readJson(join('floors', `${id}.json`)));
        },
    };
}
