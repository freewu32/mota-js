// mota-js 3.0 开发服务器
// 阶段 2：文件读写 API；阶段 3：数据 API 与游戏页面托管。
import gameHtml from '../src/game/index.html';
import { createDataHandlers } from './routes/data';
import { createFsHandlers, resolveInRoot } from './routes/fs';

const PORT = Number(process.env.PORT ?? 3000);
const PROJECT_ROOT = process.env.MOTA_PROJECT ?? 'project';

const fs = createFsHandlers(PROJECT_ROOT);
const data = createDataHandlers(PROJECT_ROOT);

const server = Bun.serve({
    port: PORT,
    routes: {
        '/': gameHtml,

        '/api/health': {
            GET: () => Response.json({ ok: true, version: '3.0.0-dev' }),
        },

        '/api/fs/read': { POST: fs.read },
        '/api/fs/write': { POST: fs.write },
        '/api/fs/list': { POST: fs.list },

        '/api/data/:name': { GET: data.data },
        '/api/floors': { GET: data.floorList },
        '/api/floors/:id': { GET: data.floor },
    },
    development: true,
    async fetch(req) {
        const url = new URL(req.url);
        // 静态素材：/project/materials/xxx.png 等
        if (url.pathname.startsWith('/project/')) {
            const rel = decodeURIComponent(url.pathname.slice('/project/'.length));
            try {
                const file = Bun.file(resolveInRoot(PROJECT_ROOT, rel));
                if (await file.exists()) return new Response(file);
            } catch {
                // 路径越界，按未找到处理
            }
        }
        return new Response('Not Found', { status: 404 });
    },
});

console.log(`服务已启动: ${server.url}`);
