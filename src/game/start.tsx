import { useState } from 'preact/hooks';

export interface StartLevel {
    title?: string;
    name?: string;
    hard?: number;
}

export interface StartOverlayProps {
    title: string;
    version: string;
    levels: readonly StartLevel[];
    onStart(levelIndex: number): void;
    onLoad(): void;
}

/** 开始界面（旧 startPanel）：选难度 → 开始游戏 / 读取存档 */
export function StartOverlay({ title, version, levels, onStart, onLoad }: StartOverlayProps) {
    const [selected, setSelected] = useState(0);
    return (
        <div class="mota-start">
            <div class="mota-start-box">
                <h1 class="mota-start-title">{title}</h1>
                <div class="mota-start-version">v{version}</div>
                {levels.length > 1 && (
                    <div class="mota-start-levels">
                        {levels.map((level, index) => (
                            <button
                                key={String(level.name ?? index)}
                                type="button"
                                class={
                                    index === selected
                                        ? 'mota-button is-selected'
                                        : 'mota-button'
                                }
                                onClick={() => setSelected(index)}
                            >
                                {level.title ?? level.name ?? `难度 ${index + 1}`}
                            </button>
                        ))}
                    </div>
                )}
                <div class="mota-start-buttons">
                    <button
                        type="button"
                        class="mota-button"
                        onClick={() => onStart(selected)}
                    >
                        开始游戏
                    </button>
                    <button type="button" class="mota-button" onClick={onLoad}>
                        读取存档
                    </button>
                </div>
            </div>
        </div>
    );
}
