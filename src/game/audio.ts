/**
 * 音效与背景音乐。
 *
 * 塔数据里音效是「别名 → 文件名」的映射（`tower.main.nameMap`，如
 * `"操作失败": "error.mp3"`），剧本与引擎都按别名调用（`core.playSound('操作失败')`）。
 * 这里把别名解析成 `/project/sounds/<文件名>`，BGM 走 `/project/bgms/<文件名>`。
 *
 * 音频播放是宿主能力，引擎只通过 `presenter.effect('playSound', { name })` 通知。
 */

/** 音频扩展名 */
const AUDIO_EXTENSIONS = ['.mp3', '.ogg', '.wav', '.m4a', '.aac'];

/**
 * 别名 → 音频文件名（纯函数，便于测试）。
 * 没有映射且不像文件名时返回 null（旧引擎会静默忽略）。
 */
export function resolveSoundName(
    nameMap: Record<string, string> | undefined,
    name: string,
): string | null {
    if (!name) return null;
    const mapped = nameMap?.[name];
    if (mapped) return mapped;
    if (AUDIO_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext))) return name;
    return null;
}

export interface AudioOptions {
    /** `tower.main.nameMap` */
    nameMap?: Record<string, string>;
    /** 项目根路径，音效在 `${base}/sounds`，BGM 在 `${base}/bgms` */
    base?: string;
}

export class AudioPlayer {
    soundEnabled = true;
    bgmEnabled = true;
    volume = 1;

    private readonly nameMap: Record<string, string>;
    private readonly base: string;
    private readonly sounds = new Map<string, HTMLAudioElement>();
    private bgm: HTMLAudioElement | null = null;
    private currentBgm: string | null = null;
    private unlocked = false;

    constructor(options: AudioOptions = {}) {
        this.nameMap = options.nameMap ?? {};
        this.base = options.base ?? '/project';
    }

    /** 首次用户手势后调用（浏览器自动播放策略） */
    unlock(): void {
        this.unlocked = true;
        if (this.bgm && this.bgmEnabled && this.bgm.paused) void this.bgm.play().catch(() => {});
    }

    get ready(): boolean {
        return this.unlocked;
    }

    playSound(name: string): void {
        if (!this.soundEnabled || !this.unlocked) return;
        const file = resolveSoundName(this.nameMap, name);
        if (!file) return;
        let audio = this.sounds.get(file);
        if (!audio) {
            audio = new Audio(`${this.base}/sounds/${encodeURIComponent(file)}`);
            audio.preload = 'auto';
            this.sounds.set(file, audio);
        }
        audio.volume = Math.max(0, Math.min(1, this.volume));
        // 复制一份播放，允许同一音效叠加（对齐旧 WebAudio 的 buffer source）
        const instance = audio.cloneNode() as HTMLAudioElement;
        void instance.play().catch(() => {});
    }

    playBgm(name: string | null | undefined): void {
        const file = resolveSoundName(this.nameMap, name ?? '');
        if (!file) return;
        if (this.currentBgm === file && this.bgm && !this.bgm.paused) return;
        this.currentBgm = file;
        this.bgm?.pause();
        this.bgm = new Audio(`${this.base}/bgms/${encodeURIComponent(file)}`);
        this.bgm.loop = true;
        this.bgm.volume = Math.max(0, Math.min(1, this.volume));
        if (this.bgmEnabled && this.unlocked) void this.bgm.play().catch(() => {});
    }

    pauseBgm(): void {
        this.bgm?.pause();
    }

    resumeBgm(): void {
        if (this.bgmEnabled && this.unlocked) void this.bgm?.play().catch(() => {});
    }

    stopBgm(): void {
        this.bgm?.pause();
        this.currentBgm = null;
    }

    setVolume(value: number): void {
        this.volume = Math.max(0, Math.min(1, value));
        for (const audio of this.sounds.values()) audio.volume = this.volume;
        if (this.bgm) this.bgm.volume = this.volume;
    }

    setSoundEnabled(enabled: boolean): void {
        this.soundEnabled = enabled;
    }

    setBgmEnabled(enabled: boolean): void {
        this.bgmEnabled = enabled;
        if (!enabled) this.pauseBgm();
        else this.resumeBgm();
    }
}
