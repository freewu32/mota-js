import { readFile, readdir, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ZodType } from 'zod';
import {
    enemysSchema,
    eventsSchema,
    floorSchema,
    iconsSchema,
    itemsSchema,
    mapsSchema,
    towerDataSchema,
} from './schema';

export interface MigrateOptions {
    /** 旧数据目录（含 data.js、floors/*.js 等） */
    from: string;
    /** 新数据输出目录 */
    out: string;
}

export interface MigrateResult {
    /** 已生成的数据文件（相对 out） */
    files: string[];
    /** 已迁移的楼层 id */
    floors: string[];
    /** 需人工迁移的脚本文件（相对 from） */
    scripts: string[];
}

/**
 * 解析形如 `var name = <JSON>;` 或 `main.floors.id = <JSON>;` 的赋值语句。
 */
export function parseAssignment(src: string, pattern: RegExp): unknown {
    const match = src.match(pattern);
    if (!match || match.index === undefined) {
        throw new Error(`未找到匹配的赋值语句: ${pattern}`);
    }
    const body = src
        .slice(match.index + match[0].length)
        .trim()
        .replace(/;\s*$/, '');
    return JSON.parse(body);
}

async function readAssignment(path: string, pattern: RegExp): Promise<unknown> {
    return parseAssignment(await readFile(path, 'utf8'), pattern);
}

const VAR_PATTERN = /var\s+(\w+)\s*=/;

/** 纯 JSON 数据文件：旧名 -> schema */
const JSON_DATA: ReadonlyArray<[string, ZodType]> = [
    ['enemys', enemysSchema],
    ['icons', iconsSchema],
    ['maps', mapsSchema],
    ['items', itemsSchema],
    ['events', eventsSchema],
];

/** 含可执行脚本、需人工迁移的文件 */
const SCRIPT_FILES = ['functions', 'plugins'] as const;

export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
    const { from, out } = options;
    const files: string[] = [];
    const floors: string[] = [];

    const write = async (rel: string, data: unknown): Promise<void> => {
        const path = join(out, rel);
        await mkdir(dirname(path), { recursive: true });
        await Bun.write(path, `${JSON.stringify(data, null, 2)}\n`);
        files.push(rel);
    };

    // data.js -> tower.json
    const tower = await readAssignment(join(from, 'data.js'), VAR_PATTERN);
    await write('tower.json', towerDataSchema.parse(tower));

    // 其余纯 JSON 数据文件
    for (const [name, schema] of JSON_DATA) {
        const obj = await readAssignment(join(from, `${name}.js`), VAR_PATTERN);
        await write(`${name}.json`, schema.parse(obj));
    }

    // floors/*.js -> floors/<id>.json
    const floorDir = join(from, 'floors');
    for (const entry of await readdir(floorDir)) {
        if (!entry.endsWith('.js') || entry.endsWith('.min.js')) continue;
        const parsed = await readAssignment(join(floorDir, entry), /main\.floors\.(\w+)\s*=/);
        const floor = floorSchema.parse(parsed);
        const id = floor.floorId || entry.replace(/\.js$/, '');
        await write(join('floors', `${id}.json`), floor);
        floors.push(id);
    }

    // 检测脚本文件
    const scripts: string[] = [];
    for (const name of SCRIPT_FILES) {
        const path = join(from, `${name}.js`);
        if (await Bun.file(path).exists()) scripts.push(`${name}.js`);
    }

    return { files, floors, scripts };
}
