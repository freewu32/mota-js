import { useEffect, useRef, useState } from 'preact/hooks';

export interface StartLevel {
    title?: string;
    name?: string;
    hard?: number;
}

export interface StartStyles {
    /** `main.styles.startBackground`（竖屏可用 `startVerticalBackground`） */
    background?: string;
    /** `main.styles.startLogoStyle`：一段 CSS 文本，旧版直接赋给 `#startLogo.style` */
    logoStyle?: string;
    /** `main.styles.startButtonsStyle`：同上，作用于按钮组 */
    buttonsStyle?: string;
}

export interface StartOverlayProps {
    title: string;
    version: string;
    levels: readonly StartLevel[];
    styles?: StartStyles;
    onStart(levelIndex: number): void;
    onLoad(): void;
}

/**
 * 开始界面（旧 `#startPanel`）。
 *
 * 对齐旧版：铺满屏幕、居中显示塔的背景图（`startBackground`，`#startBackground`
 * 的 `height:100%` 定位）、塔名用 `startLogoStyle`、底部是按钮组（`startButtonsStyle`）；
 * 点「开始游戏」后按钮组换成难度列表（旧 `levelChooseButtons`），点难度才开局。
 */
export function StartOverlay({
    title,
    version,
    levels,
    styles,
    onStart,
    onLoad,
}: StartOverlayProps) {
    const [choosing, setChoosing] = useState(false);
    const [selected, setSelected] = useState(0);
    const logo = useRef<HTMLDivElement>(null);
    const buttons = useRef<HTMLDivElement>(null);

    // 塔作者写的是 CSS 文本（旧版直接 setAttribute style），这里同样整段套用
    useEffect(() => {
        if (logo.current && styles?.logoStyle) logo.current.style.cssText = styles.logoStyle;
        if (buttons.current && styles?.buttonsStyle) {
            buttons.current.style.cssText = styles.buttonsStyle;
        }
    }, [styles?.logoStyle, styles?.buttonsStyle]);

    const list = levels.length > 0 ? levels : [{ title: '开始游戏', name: '' }];

    return (
        <div class="mota-start">
            {styles?.background && (
                <img class="mota-start-background" src={styles.background} alt="" />
            )}
            <div class="mota-start-logo" ref={logo}>
                {title}
            </div>
            <div class="mota-start-buttons" ref={buttons}>
                {!choosing ? (
                    <>
                        <button
                            type="button"
                            class="mota-start-button is-selected"
                            onClick={() => {
                                if (levels.length > 0) setChoosing(true);
                                else onStart(0);
                            }}
                        >
                            开始游戏
                        </button>
                        <button type="button" class="mota-start-button" onClick={onLoad}>
                            载入游戏
                        </button>
                    </>
                ) : (
                    <>
                        {list.map((level, index) => (
                            <button
                                key={String(level.name ?? index)}
                                type="button"
                                class={
                                    index === selected
                                        ? 'mota-start-button is-selected'
                                        : 'mota-start-button'
                                }
                                onMouseEnter={() => setSelected(index)}
                                onClick={() => onStart(index)}
                            >
                                {level.title ?? level.name ?? `难度 ${index + 1}`}
                            </button>
                        ))}
                        <div class="mota-start-hint">{version}</div>
                    </>
                )}
            </div>
        </div>
    );
}
