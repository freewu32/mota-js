/**
 * 特效层（`#fx` canvas）。
 *
 * 与地图层（`#game`）分离：地图只在动画帧/状态变化时重绘，特效层每帧重绘但只画
 * 变化的东西。帧级数据（勇士跳跃位置、显伤、光标）都留在这里，不写进 signal。
 *
 * `execute()` 是塔作者在剧本里做自绘的受控出口（旧 `ui` 画布的
 * `fillRect` / `fillText` / `drawSelector` 等），命令会持久保留并每帧重放，
 * 直到 `clearUi` / `clearMap` 清掉——与旧引擎「清空 ui 层后重绘」的语义一致。
 * 代价是没有 `eval`：只认白名单里的绘制指令，认不出的一律忽略。
 */
import { TILE } from '../engine/tiles';
import { clamp01, damageMotion, pointAt, seeded, type Point } from './fx-math';

interface DamagePopup {
    x: number;
    y: number;
    text: string;
    color: string;
    start: number;
    duration: number;
}

interface Flash {
    color: string;
    start: number;
    duration: number;
}

interface Jump {
    from: Point;
    to: Point;
    start: number;
    duration: number;
}

interface WeatherParticle {
    x: number;
    y: number;
    speed: number;
    drift: number;
    size: number;
}

interface DrawCommand {
    type: string;
    data: Record<string, unknown>;
    code: string | null;
}

/** 会被保留并每帧重放的绘制指令 */
const PERSISTENT_COMMANDS = new Set([
    'fillRect',
    'strokeRect',
    'fillText',
    'drawLine',
    'drawArrow',
    'fillEllipse',
    'strokeEllipse',
    'fillArc',
    'strokeArc',
    'drawSelector',
    'drawImage',
]);

const DAMAGE_DURATION = 820;
const FLASH_DEFAULT = 200;
const SUSPEND_COMMANDS = new Set(['clearUi', 'clearMap', 'clearUI']);

function numberField(data: Record<string, unknown>, key: string, fallback = 0): number {
    const value = data[key];
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
}

function stringField(data: Record<string, unknown>, key: string, fallback = ''): string {
    const value = data[key];
    return typeof value === 'string' ? value : fallback;
}

function rgba(color: unknown, fallback = '#ffffff'): string {
    if (typeof color === 'string') return color;
    if (Array.isArray(color) && color.length >= 3) {
        const [r, g, b, a] = color.map((one) => Number(one) || 0);
        return `rgba(${r}, ${g}, ${b}, ${a == null ? 1 : a})`;
    }
    return fallback;
}

/** 特效层：光标、显伤、跳跃、屏闪、天气、塔作者自绘 */
export class FxLayer {
    private canvas: HTMLCanvasElement | null = null;
    private ctx: CanvasRenderingContext2D | null = null;
    private width = 0;
    private height = 0;
    private last = 0;
    private dirty = true;

    private damage: DamagePopup[] = [];
    private flashes: Flash[] = [];
    private jump: Jump | null = null;
    private cursor: { x: number; y: number; color: string } | null = null;
    private commands: DrawCommand[] = [];
    private weather: { name: string; level: number; particles: WeatherParticle[] } | null = null;
    private curtain: string | null = null;
    private lastCommandCode = 0;

    attach(canvas: HTMLCanvasElement): void {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        if (this.ctx) this.ctx.imageSmoothingEnabled = false;
        this.dirty = true;
    }

    resize(width: number, height: number): void {
        if (!this.canvas) return;
        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
            if (this.ctx) this.ctx.imageSmoothingEnabled = false;
            this.dirty = true;
        }
        this.width = width;
        this.height = height;
    }

    //// 帧级状态 ////

    /** 是否正在动画（主循环据此决定要不要重绘地图层） */
    get animating(): boolean {
        const now = this.last;
        return (
            this.jump != null ||
            this.damage.some((one) => now - one.start < one.duration) ||
            this.flashes.some((one) => now - one.start < one.duration)
        );
    }

    /** 跳跃动画中的勇士位置（图块坐标）；无跳跃时为 null */
    get heroOverride(): Point | null {
        if (!this.jump) return null;
        const progress = this.jump.duration <= 0 ? 1 : (this.last - this.jump.start) / this.jump.duration;
        if (progress >= 1) return null;
        return pointAt(progress, this.jump.from, this.jump.to, 0.6);
    }

    //// 一次性特效 ////

    damagePopup(x: number, y: number, text: string, color = '#ff6666'): void {
        this.damage.push({
            x: x * TILE + TILE / 2,
            y: y * TILE,
            text,
            color,
            start: this.last,
            duration: DAMAGE_DURATION,
        });
        this.dirty = true;
    }

    flash(color = '#ffffff', duration = FLASH_DEFAULT): void {
        this.flashes.push({ color, start: this.last, duration });
        this.dirty = true;
    }

    jumpHero(from: Point, to: Point, time = 500): void {
        this.jump = { from, to, start: this.last, duration: Math.max(1, time) };
        this.dirty = true;
    }

    //// 持久特效 ////

    setCursor(x: number, y: number, color = '#ffd479'): void {
        this.cursor = { x, y, color };
        this.dirty = true;
    }

    clearCursor(): void {
        this.cursor = null;
        this.dirty = true;
    }

    setCurtain(color: string | null): void {
        this.curtain = color;
        this.dirty = true;
    }

    setWeather(name: string | null, level = 1): void {
        if (!name || name === 'none') {
            this.weather = null;
            this.dirty = true;
            return;
        }
        const count = Math.max(20, Math.min(240, Math.round(level * 24)));
        const random = seeded(level * 7919 + name.length * 131);
        const particles: WeatherParticle[] = [];
        for (let i = 0; i < count; i++) {
            particles.push({
                x: random() * (this.width || 416),
                y: random() * (this.height || 416),
                speed: 0.6 + random() * 1.4,
                drift: (random() - 0.5) * 0.6,
                size: name === 'rain' ? 1 : 1 + random() * 2,
            });
        }
        this.weather = { name, level, particles };
        this.dirty = true;
    }

    //// 塔作者绘制指令 ////

    /** 执行一个视觉动作；返回是否被本层处理 */
    execute(type: string, data: Record<string, unknown>): boolean {
        if (SUSPEND_COMMANDS.has(type)) {
            this.commands = [];
            this.dirty = true;
            return true;
        }
        if (type === 'screenFlash') {
            this.flash(rgba(data.color, '#ffffff'), numberField(data, 'time', FLASH_DEFAULT));
            return true;
        }
        if (type === 'setCurtain') {
            this.setCurtain(data.color == null ? null : rgba(data.color));
            return true;
        }
        if (type === 'clearCurtain') {
            this.setCurtain(null);
            return true;
        }
        if (type === 'setWeather') {
            this.setWeather(stringField(data, 'name') || null, numberField(data, 'level', 1));
            return true;
        }
        if (type === 'jumpHero') {
            const to = Array.isArray(data.to) ? data.to : null;
            const from = Array.isArray(data.from) ? data.from : to;
            if (from && to) {
                this.jumpHero(
                    { x: Number(from[0]), y: Number(from[1]) },
                    { x: Number(to[0]), y: Number(to[1]) },
                    numberField(data, 'time', 500),
                );
            }
            return true;
        }
        if (type === 'vibrate') {
            const time = numberField(data, 'time', 30);
            if (typeof navigator !== 'undefined') navigator.vibrate?.(time);
            return true;
        }
        if (type === 'clearSelector' || type === 'clearUiEventSelector') {
            this.clearSelector(data.code == null ? null : String(data.code));
            return true;
        }
        if (!PERSISTENT_COMMANDS.has(type)) return false;
        const code = data.code == null ? null : String(data.code);
        this.commands.push({ type, data, code: code ?? `c${(this.lastCommandCode += 1)}` });
        this.dirty = true;
        return true;
    }

    /** 清除自绘选择光标；不给 code 时全部清除 */
    clearSelector(code: string | null = null): void {
        if (code == null) this.commands = this.commands.filter((one) => one.type !== 'drawSelector');
        else this.commands = this.commands.filter((one) => one.code !== code);
        this.dirty = true;
    }

    //// 每帧 ////

    /** 推进动画；返回是否需要重绘地图层 */
    update(now: number): boolean {
        const dt = this.last === 0 ? 0 : Math.min(100, now - this.last);
        this.last = now;

        this.damage = this.damage.filter((one) => now - one.start < one.duration);
        this.flashes = this.flashes.filter((one) => now - one.start < one.duration);
        if (this.jump && now - this.jump.start >= this.jump.duration) this.jump = null;

        let animating = this.jump != null;
        if (this.damage.length > 0 || this.flashes.length > 0) animating = true;

        if (this.weather && dt > 0) {
            const speedScale = this.weather.name === 'rain' ? 3.4 : 1;
            for (const particle of this.weather.particles) {
                particle.y += particle.speed * speedScale * (dt / 16);
                particle.x += particle.drift * (dt / 16);
                if (particle.y > this.height) {
                    particle.y = -4;
                    particle.x = Math.abs(particle.x + particle.drift * 40) % (this.width || 1);
                }
                if (particle.x < -8) particle.x = (this.width || 0) + 8;
                if (particle.x > (this.width || 0) + 8) particle.x = -8;
            }
            this.dirty = true;
            animating = true;
        }

        if (this.damage.length > 0 || this.flashes.length > 0 || this.jump) this.dirty = true;
        return animating;
    }

    /** 重绘特效层；没有变化时直接跳过 */
    draw(): void {
        const ctx = this.ctx;
        if (!ctx) return;
        if (!this.dirty) return;
        this.dirty = false;

        ctx.clearRect(0, 0, this.canvas?.width ?? this.width, this.canvas?.height ?? this.height);
        this.drawCommands(ctx);
        this.drawCursor(ctx);
        this.drawWeather(ctx);
        this.drawDamage(ctx);
        this.drawFlash(ctx);
        this.drawCurtain(ctx);
    }

    private drawCommands(ctx: CanvasRenderingContext2D): void {
        for (const command of this.commands) {
            const data = command.data;
            const color = rgba(data.color, '#ffffff');
            ctx.save();
            ctx.strokeStyle = color;
            ctx.fillStyle = color;
            ctx.lineWidth = numberField(data, 'lineWidth', numberField(data, 'width', 2));
            switch (command.type) {
                case 'fillRect':
                    ctx.fillRect(
                        numberField(data, 'x'),
                        numberField(data, 'y'),
                        numberField(data, 'width'),
                        numberField(data, 'height'),
                    );
                    break;
                case 'strokeRect':
                    ctx.strokeRect(
                        numberField(data, 'x'),
                        numberField(data, 'y'),
                        numberField(data, 'width'),
                        numberField(data, 'height'),
                    );
                    break;
                case 'fillText': {
                    const size = numberField(data, 'size', 16);
                    ctx.font = `${size}px ${stringField(data, 'font', 'sans-serif')}`;
                    ctx.textAlign = (stringField(data, 'align', 'left') as CanvasTextAlign) || 'left';
                    ctx.fillText(
                        stringField(data, 'text'),
                        numberField(data, 'x'),
                        numberField(data, 'y'),
                    );
                    break;
                }
                case 'drawLine': {
                    const x1 = numberField(data, 'x1', numberField(data, 'x'));
                    const y1 = numberField(data, 'y1', numberField(data, 'y'));
                    ctx.beginPath();
                    ctx.moveTo(x1, y1);
                    ctx.lineTo(numberField(data, 'x2'), numberField(data, 'y2'));
                    ctx.stroke();
                    break;
                }
                case 'drawArrow': {
                    const x1 = numberField(data, 'x1', numberField(data, 'x'));
                    const y1 = numberField(data, 'y1', numberField(data, 'y'));
                    const x2 = numberField(data, 'x2');
                    const y2 = numberField(data, 'y2');
                    ctx.beginPath();
                    ctx.moveTo(x1, y1);
                    ctx.lineTo(x2, y2);
                    ctx.stroke();
                    const angle = Math.atan2(y2 - y1, x2 - x1);
                    const head = numberField(data, 'head', 10);
                    ctx.beginPath();
                    ctx.moveTo(x2, y2);
                    ctx.lineTo(
                        x2 - head * Math.cos(angle - Math.PI / 6),
                        y2 - head * Math.sin(angle - Math.PI / 6),
                    );
                    ctx.lineTo(
                        x2 - head * Math.cos(angle + Math.PI / 6),
                        y2 - head * Math.sin(angle + Math.PI / 6),
                    );
                    ctx.closePath();
                    ctx.fill();
                    break;
                }
                case 'fillEllipse':
                case 'strokeEllipse':
                case 'fillArc':
                case 'strokeArc': {
                    const x = numberField(data, 'x');
                    const y = numberField(data, 'y');
                    const rx = numberField(data, 'width') / 2 || numberField(data, 'radius', 8);
                    const ry = numberField(data, 'height') / 2 || rx;
                    ctx.beginPath();
                    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
                    if (command.type.startsWith('fill')) ctx.fill();
                    else ctx.stroke();
                    break;
                }
                case 'drawSelector':
                    ctx.lineWidth = numberField(data, 'lineWidth', 4);
                    ctx.strokeRect(
                        numberField(data, 'x'),
                        numberField(data, 'y'),
                        numberField(data, 'width', TILE),
                        numberField(data, 'height', TILE),
                    );
                    break;
                case 'drawImage':
                    // 需要图片素材，交给宿主注册（未注册时忽略）
                    this.drawRegisteredImage(ctx, data);
                    break;
                default:
                    break;
            }
            ctx.restore();
        }
    }

    /** 塔作者自定义图片绘制（`drawImage`）由宿主注入 */
    drawRegisteredImage: (ctx: CanvasRenderingContext2D, data: Record<string, unknown>) => void = () => {
        /* 未注册：忽略 */
    };

    private drawCursor(ctx: CanvasRenderingContext2D): void {
        const cursor = this.cursor;
        if (!cursor) return;
        const width = 4;
        ctx.save();
        ctx.strokeStyle = cursor.color;
        ctx.lineWidth = width;
        ctx.strokeRect(cursor.x * TILE + width / 2, cursor.y * TILE + width / 2, TILE - width, TILE - width);
        ctx.restore();
    }

    private drawWeather(ctx: CanvasRenderingContext2D): void {
        const weather = this.weather;
        if (!weather) return;
        ctx.save();
        if (weather.name === 'rain') {
            ctx.strokeStyle = 'rgba(180, 210, 255, 0.55)';
            ctx.lineWidth = 1;
            for (const particle of weather.particles) {
                ctx.beginPath();
                ctx.moveTo(particle.x, particle.y);
                ctx.lineTo(particle.x, particle.y + 6);
                ctx.stroke();
            }
        } else {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
            for (const particle of weather.particles) {
                ctx.beginPath();
                ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        ctx.restore();
    }

    private drawDamage(ctx: CanvasRenderingContext2D): void {
        for (const popup of this.damage) {
            const progress = clamp01((this.last - popup.start) / popup.duration);
            const motion = damageMotion(progress);
            ctx.save();
            ctx.globalAlpha = motion.alpha;
            ctx.fillStyle = popup.color;
            ctx.font = 'bold 18px sans-serif';
            ctx.textAlign = 'center';
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
            ctx.lineWidth = 3;
            const y = popup.y + 10 + motion.offsetY;
            ctx.strokeText(popup.text, popup.x, y);
            ctx.fillText(popup.text, popup.x, y);
            ctx.restore();
        }
    }

    private drawFlash(ctx: CanvasRenderingContext2D): void {
        for (const flash of this.flashes) {
            const progress = clamp01((this.last - flash.start) / flash.duration);
            ctx.save();
            ctx.globalAlpha = 1 - progress;
            ctx.fillStyle = flash.color;
            ctx.fillRect(0, 0, this.width, this.height);
            ctx.restore();
        }
    }

    private drawCurtain(ctx: CanvasRenderingContext2D): void {
        if (!this.curtain) return;
        ctx.save();
        ctx.fillStyle = this.curtain;
        ctx.fillRect(0, 0, this.width, this.height);
        ctx.restore();
    }
}
