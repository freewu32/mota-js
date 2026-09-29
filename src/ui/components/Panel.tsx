import type { ComponentChildren, TargetedMouseEvent } from 'preact';

export interface PanelProps {
    title: string;
    onClose?: () => void;
    /** 面板底部的说明 / 操作区 */
    footer?: ComponentChildren;
    /** 面板的额外类名（宽度 / 布局变体） */
    class?: string;
    children?: ComponentChildren;
}

/**
 * 面板外壳：遮罩 + 九宫格窗口皮肤 + 标题栏。
 * 具体内容由各面板组件填充，皮肤取自 CSS 变量 `--mota-skin`。
 */
export function Panel({ title, onClose, footer, class: className, children }: PanelProps) {
    const stop = (event: TargetedMouseEvent<HTMLDivElement>): void => {
        event.stopPropagation();
    };
    return (
        <div class="mota-panel-backdrop" onClick={() => onClose?.()}>
            <div class={className ? `mota-panel ${className}` : 'mota-panel'} onClick={stop}>
                <div class="mota-panel-head">
                    <h2 class="mota-panel-title">{title}</h2>
                    <button class="mota-close" type="button" onClick={() => onClose?.()}>
                        ×
                    </button>
                </div>
                <div class="mota-panel-body">{children}</div>
                {footer != null && <div class="mota-panel-foot">{footer}</div>}
            </div>
        </div>
    );
}
