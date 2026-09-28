import { loadTower } from '../engine/loader';
import { MaterialStore } from '../engine/materials';
import { drawScene } from '../engine/renderer';
import { MotaRuntime } from '../engine/runtime';
import { TILE } from '../engine/tiles';

const canvas = document.querySelector<HTMLCanvasElement>('#game');
if (!canvas) throw new Error('未找到 #game 画布');
const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('无法获取 2D 上下文');
ctx.imageSmoothingEnabled = false;

const data = await loadTower();
const materials = new MaterialStore(data.icons, data.tower.main.tilesets ?? []);
await materials.load('/project');

// autotile 跨编号连通表：数据里登记的每个 autotile 编号 -> id
const autotileNumbers: Record<number, string> = {};
for (const [number, element] of Object.entries(data.maps)) {
    if (element.cls === 'autotile') autotileNumbers[Number(number)] = element.id;
}
materials.buildAutotileEdges(autotileNumbers);

const runtime = new MotaRuntime(data);

/** 动画计数：每约 120ms 推进一步 */
let animate = 0;

function resize(): void {
    const width = (runtime.floor.map[0]?.length ?? 13) * TILE;
    const height = runtime.floor.map.length * TILE;
    if (canvas!.width !== width || canvas!.height !== height) {
        canvas!.width = width;
        canvas!.height = height;
        ctx!.imageSmoothingEnabled = false;
    }
}

function render(): void {
    resize();
    drawScene(
        ctx as CanvasRenderingContext2D,
        runtime.floor,
        data.maps,
        runtime.state.hero,
        materials,
        animate,
    );
}

const DIRS: Record<string, [number, number]> = {
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
};

window.addEventListener('keydown', (e) => {
    const dir = DIRS[e.key];
    if (!dir) return;
    e.preventDefault();
    runtime.move(dir[0], dir[1]);
    render();
});

document.querySelector('#save')?.addEventListener('click', () => {
    console.log('存档', runtime.save());
});
document.querySelector('#load')?.addEventListener('click', () => {
    if (runtime.load()) render();
});

// 暴露运行时，便于调试与后续接入脚本 API
Object.assign(globalThis, { mota: runtime, motaApi: runtime.api });

let last = performance.now();
function loop(now: number): void {
    if (now - last >= 120) {
        last = now;
        animate += 1;
        render();
    }
    requestAnimationFrame(loop);
}

render();
requestAnimationFrame(loop);
