import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PathError, createFsHandlers, resolveInRoot } from '../server/routes/fs';

function post(url: string, body: unknown): Request {
    return new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

describe('resolveInRoot', () => {
    const root = '/tmp/mota-root';

    test('允许 root 内路径', () => {
        expect(resolveInRoot(root, 'a/b.txt')).toBe('/tmp/mota-root/a/b.txt');
    });

    test('拒绝越界路径', () => {
        expect(() => resolveInRoot(root, '../etc/passwd')).toThrow(PathError);
    });
});

describe('fs handlers', () => {
    test('write / read / list 往返', async () => {
        const root = mkdtempSync(join(tmpdir(), 'mota-fs-'));
        const fs = createFsHandlers(root);

        const w = await fs.write(post('http://x/', { path: 'sub/a.json', content: '{"x":1}' }));
        expect(w.status).toBe(200);

        const r = await fs.read(post('http://x/', { path: 'sub/a.json' }));
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual({ path: 'sub/a.json', content: '{"x":1}' });

        const l = await fs.list(post('http://x/', { path: '.' }));
        const data = (await l.json()) as { entries: { name: string; isDir: boolean }[] };
        expect(data.entries.map((e) => e.name)).toContain('sub');
        expect(data.entries.find((e) => e.name === 'sub')?.isDir).toBe(true);
    });

    test('读取不存在的文件返回 404', async () => {
        const root = mkdtempSync(join(tmpdir(), 'mota-fs-'));
        const fs = createFsHandlers(root);
        const r = await fs.read(post('http://x/', { path: 'nope.txt' }));
        expect(r.status).toBe(404);
    });

    test('越界写入返回 400', async () => {
        const root = mkdtempSync(join(tmpdir(), 'mota-fs-'));
        const fs = createFsHandlers(root);
        const r = await fs.write(post('http://x/', { path: '../evil.txt', content: 'x' }));
        expect(r.status).toBe(400);
    });

    test('非法请求体返回 400', async () => {
        const root = mkdtempSync(join(tmpdir(), 'mota-fs-'));
        const fs = createFsHandlers(root);
        const r = await fs.read(post('http://x/', { wrong: true }));
        expect(r.status).toBe(400);
    });
});
