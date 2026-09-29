import type { TargetedMouseEvent } from 'preact';
import { useRef } from 'preact/hooks';
import { $dialog, $tip, dialogConfirm, dialogPick, dialogSubmit } from '../dialog';
import { RichText } from './RichText';

export interface DialogProps {
    /** 点一下对话框 / 按空格回车：等价 `DialogController.advance()` */
    onAdvance?: () => void;
    /** `\i[id]` → 图片地址 */
    resolveIcon?: (id: string) => string | undefined;
}

/**
 * 对话框 / 选择项 / 确认框 / 输入框。
 *
 * 状态由 `$dialog` 驱动（`createSignalDialogView` 写入），本组件只负责渲染与
 * 把点击翻译回 `dialogPick` / `dialogConfirm` / `dialogSubmit`。
 */
export function Dialog({ onAdvance, resolveIcon }: DialogProps) {
    const state = $dialog.value;
    const tip = $tip.value;
    const inputRef = useRef<HTMLInputElement>(null);

    if (!state.visible && !tip) return null;

    const clickable = state.visible && state.kind === 'text';
    const stop = (event: TargetedMouseEvent<HTMLElement>): void => {
        event.stopPropagation();
    };

    const submitInput = (): void => {
        dialogSubmit(inputRef.current?.value ?? '');
    };

    return (
        <div class="mota-dialog-layer">
            {tip && (
                <div class="mota-tip" key={tip.id}>
                    <RichText nodes={tip.nodes} resolveIcon={resolveIcon} />
                </div>
            )}
            {state.visible && (
                <div
                    class={`mota-dialog${clickable ? ' is-clickable' : ''}`}
                    onClick={() => {
                        if (clickable) onAdvance?.();
                    }}
                >
                    {state.title && <div class="mota-dialog-title">{state.title}</div>}
                    {state.nodes.length > 0 && (
                        <div class="mota-dialog-text">
                            <RichText nodes={state.nodes} resolveIcon={resolveIcon} />
                        </div>
                    )}
                    {state.kind === 'choices' && (
                        <div class="mota-dialog-choices" onClick={stop}>
                            {state.choices.map((choice, index) => (
                                <button
                                    key={index}
                                    type="button"
                                    class="mota-button"
                                    disabled={choice.disabled}
                                    onClick={() => dialogPick(index)}
                                >
                                    {choice.text}
                                </button>
                            ))}
                        </div>
                    )}
                    {state.kind === 'confirm' && (
                        <div class="mota-dialog-choices" onClick={stop}>
                            <button
                                type="button"
                                class="mota-button"
                                onClick={() => dialogConfirm(true)}
                            >
                                确定
                            </button>
                            <button
                                type="button"
                                class="mota-button"
                                onClick={() => dialogConfirm(false)}
                            >
                                取消
                            </button>
                        </div>
                    )}
                    {state.kind === 'input' && (
                        <div class="mota-dialog-choices" onClick={stop}>
                            {state.hint && <div class="mota-dialog-hint">{state.hint}</div>}
                            <input
                                ref={inputRef}
                                class="mota-input"
                                type={state.inputType}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter') submitInput();
                                }}
                            />
                            <button type="button" class="mota-button" onClick={submitInput}>
                                确定
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
