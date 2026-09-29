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
import { translateItemActions, translateItemCondition, translateTipText } from './item-effect';

/**
 * 迁移道具的效果字段。
 *
 * 旧塔把效果写成 JS 片段（引擎 `eval` 执行），新引擎改为剧本动作列表 +
 * 值块表达式；无法静态转换的字段改名为 `*Legacy` 保留原文并计入报告。
 */
/** 迁移后的道具表：字段结构宽松（效果为动作列表、条件为表达式字符串） */
export type MigratedItems = Record<string, Record<string, unknown>>;

interface MigrateItemsResult {
    items: MigratedItems;
    untranslated: string[];
}

/**
 * 单个字段的转换失败不应中断整塔迁移：异常一律记入报告并退回人工迁移。
 */
function safeTranslate<T>(label: string, report: string[], run: () => T): T | null {
    try {
        return run();
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        report.push(`${label}：转换异常 ${reason}`);
        return null;
    }
}

function migrateItems(raw: unknown): MigrateItemsResult {
    const untranslated: string[] = [];
    const source = (raw ?? {}) as Record<string, Record<string, unknown>>;
    const items: MigratedItems = {};
    for (const [id, original] of Object.entries(source)) {
        const item: Record<string, unknown> = { ...original };
        for (const field of ['itemEffect', 'useItemEffect'] as const) {
            const script = item[field];
            if (script == null) continue;
            const result = safeTranslate(`${id}.${field}`, untranslated, () =>
                translateItemActions(script),
            );
            if (result?.actions) {
                item[field] = result.actions;
                continue;
            }
            if (result) untranslated.push(`${id}.${field}：${result.reason}`);
            item[`${field}Legacy`] = script;
            delete item[field];
        }
        if (typeof item.canUseItemEffect === 'string') {
            const condition = item.canUseItemEffect;
            const result = safeTranslate(`${id}.canUseItemEffect`, untranslated, () =>
                translateItemCondition(condition),
            );
            if (result?.expression) item.canUseItemEffect = result.expression;
            else {
                if (result) untranslated.push(`${id}.canUseItemEffect：${result.reason}`);
                item.canUseItemEffectLegacy = condition;
                delete item.canUseItemEffect;
            }
        }
        for (const field of ['text', 'itemEffectTip', 'useItemTip'] as const) {
            const translated = safeTranslate(`${id}.${field}`, untranslated, () =>
                translateTipText(item[field]),
            );
            if (translated != null && translated !== item[field]) item[field] = translated;
        }
        if (item.useItemEvent != null && JSON.stringify(item.useItemEvent).includes('core.')) {
            untranslated.push(`${id}.useItemEvent：含 core 引用，需人工迁移`);
        }
        items[id] = item;
    }
    return { items, untranslated };
}
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
    /** 需人工迁移的道具效果字段（含原因） */
    untranslated: string[];
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

/** 读取并解析赋值语句；失败时带上文件名，便于定位是哪份数据出错 */
async function readAssignment(path: string, pattern: RegExp): Promise<unknown> {
    const src = await readFile(path, 'utf8');
    try {
        return parseAssignment(src, pattern);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`解析失败 ${path}：${reason}`, { cause: error });
    }
}

const VAR_PATTERN = /var\s+(\w+)\s*=/;

/** 纯 JSON 数据文件：旧名 -> schema */
const JSON_DATA: ReadonlyArray<[string, ZodType]> = [
    ['enemys', enemysSchema],
    ['icons', iconsSchema],
    ['maps', mapsSchema],
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

    // items.js -> items.json：效果字段需要把旧 JS 片段转成剧本动作 / 值块表达式
    const rawItems = await readAssignment(join(from, 'items.js'), VAR_PATTERN);
    const { items, untranslated } = migrateItems(rawItems);
    await write('items.json', itemsSchema.parse(items));

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

    return { files, floors, scripts, untranslated };
}
