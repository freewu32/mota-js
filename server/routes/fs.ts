import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { z, ZodError } from 'zod';

export class PathError extends Error {}

/** 将相对路径解析为 root 下的绝对路径，越界则抛错 */
export function resolveInRoot(root: string, rel: string): string {
    const base = resolve(root);
    const abs = resolve(base, rel);
    if (abs !== base && !abs.startsWith(base + sep)) {
        throw new PathError(`路径越界: ${rel}`);
    }
    return abs;
}

const readReq = z.object({ path: z.string() });
const writeReq = z.object({ path: z.string(), content: z.string() });
const listReq = z.object({ path: z.string().default('.') });

export type FsHandler = (req: Request) => Promise<Response>;

async function guard(fn: () => Promise<Response>): Promise<Response> {
    try {
        return await fn();
    } catch (error) {
        if (error instanceof PathError) {
            return Response.json({ error: error.message }, { status: 400 });
        }
        if (error instanceof ZodError) {
            return Response.json({ error: '请求参数错误', issues: error.issues }, { status: 400 });
        }
        if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
            return Response.json({ error: '文件不存在' }, { status: 404 });
        }
        const message = error instanceof Error ? error.message : String(error);
        return Response.json({ error: message }, { status: 500 });
    }
}

export interface FsHandlers {
    read: FsHandler;
    write: FsHandler;
    list: FsHandler;
}

/**
 * 创建限定在 root 目录内的文件读写处理器。
 * 编辑器与游戏数据都通过它访问 project/，避免路径越界。
 */
export function createFsHandlers(root: string): FsHandlers {
    const read: FsHandler = (req) =>
        guard(async () => {
            const { path } = readReq.parse(await req.json());
            const content = await readFile(resolveInRoot(root, path), 'utf8');
            return Response.json({ path, content });
        });

    const write: FsHandler = (req) =>
        guard(async () => {
            const { path, content } = writeReq.parse(await req.json());
            const abs = resolveInRoot(root, path);
            await mkdir(dirname(abs), { recursive: true });
            await writeFile(abs, content, 'utf8');
            return Response.json({ path, ok: true });
        });

    const list: FsHandler = (req) =>
        guard(async () => {
            const { path } = listReq.parse(await req.json());
            const entries = await readdir(resolveInRoot(root, path), { withFileTypes: true });
            return Response.json({
                path,
                entries: entries.map((e) => ({ name: e.name, isDir: e.isDirectory() })),
            });
        });

    return { read, write, list };
}
