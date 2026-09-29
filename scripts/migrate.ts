#!/usr/bin/env bun
import { migrate } from '../src/shared/data/migrate';

const args = process.argv.slice(2);
const get = (name: string, fallback: string): string => {
    const i = args.indexOf(name);
    return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};

const from = get('--from', 'project');
const out = get('--out', 'project');

console.log(`迁移旧数据: ${from} -> ${out}`);
const result = await migrate({ from, out });
console.log(`数据文件 ${result.files.length} 个，楼层 ${result.floors.length} 个`);
console.log(`  ${result.files.join(', ')}`);
if (result.scripts.length > 0) {
    console.log(`需人工迁移的脚本: ${result.scripts.join(', ')}`);
}
if (result.untranslated.length > 0) {
    console.log(`需人工迁移的道具效果 ${result.untranslated.length} 处：`);
    for (const one of result.untranslated) console.log(`  ${one}`);
}
