/**
 * 对话框的 signal 视图。
 *
 * `DialogController` 只依赖 `DialogView` 抽象；这里把它的调用翻译成 signal，
 * `components/Dialog.tsx` 再消费 signal 渲染成 DOM。好处：
 *
 * - 打字机每推进一字只重渲染文本节点，不需要手工 replaceChildren；
 * - 选择项 / 确认 / 输入用同一份状态，弱化了「谁是当前模态」的状态机；
 * - 测试里可以不开浏览器直接断言 signal（见 `tests/ui-dialog.test.ts`）。
 */
import { signal } from '@preact/signals';
import type {
    ChoiceButton,
    DialogTextExtra,
    DialogView,
    RichNode,
} from '../engine/modules/ui';

export type DialogKind = 'text' | 'choices' | 'confirm' | 'input';

export interface DialogState {
    visible: boolean;
    kind: DialogKind;
    title: string | null;
    nodes: readonly RichNode[];
    choices: readonly ChoiceButton[];
    inputType: 'text' | 'number';
    hint: string;
}

export interface TipState {
    nodes: readonly RichNode[];
    icon?: string;
    /** 每次显示递增，供组件重播淡出动画 */
    id: number;
}

function initialState(): DialogState {
    return {
        visible: false,
        kind: 'text',
        title: null,
        nodes: [],
        choices: [],
        inputType: 'text',
        hint: '',
    };
}

export const $dialog = signal<DialogState>(initialState());
export const $tip = signal<TipState | null>(null);

interface Pending {
    pick?: (index: number) => void;
    confirm?: (ok: boolean) => void;
    submit?: (value: string) => void;
}

const pending: Pending = {};
let tipId = 0;

/** 选择项被点击 */
export function dialogPick(index: number): void {
    const pick = pending.pick;
    pending.pick = undefined;
    pick?.(index);
}

/** 确认框被回答 */
export function dialogConfirm(ok: boolean): void {
    const confirm = pending.confirm;
    pending.confirm = undefined;
    confirm?.(ok);
}

/** 输入框提交 */
export function dialogSubmit(value: string): void {
    const submit = pending.submit;
    pending.submit = undefined;
    submit?.(value);
}

export function setDialogTitle(title: string | null): void {
    $dialog.value = { ...$dialog.value, title };
}

/** 重置为初始状态（读档 / 重开一局时用） */
export function resetDialog(): void {
    pending.pick = pending.confirm = pending.submit = undefined;
    $tip.value = null;
    $dialog.value = initialState();
}

export interface SignalDialogOptions {
    /** 点一下对话框是否等价于 advance（默认由宿主接管） */
    clickToAdvance?: boolean;
}

/** 创建一个由 signal 驱动的 `DialogView` */
export function createSignalDialogView(_options: SignalDialogOptions = {}): DialogView {
    const base = (): DialogState => $dialog.value;
    return {
        showText(nodes: readonly RichNode[], extra: DialogTextExtra) {
            pending.pick = pending.confirm = pending.submit = undefined;
            $dialog.value = {
                ...base(),
                visible: true,
                kind: 'text',
                title: extra.title ?? null,
                nodes,
                choices: [],
            };
        },
        showChoices(nodes, choices, pick) {
            pending.pick = pick;
            pending.confirm = undefined;
            pending.submit = undefined;
            $dialog.value = {
                ...base(),
                visible: true,
                kind: 'choices',
                title: null,
                nodes,
                choices: [...choices],
            };
        },
        showConfirm(nodes, pick) {
            pending.confirm = pick;
            pending.pick = undefined;
            pending.submit = undefined;
            $dialog.value = {
                ...base(),
                visible: true,
                kind: 'confirm',
                title: null,
                nodes,
                choices: [],
            };
        },
        showInput(hint, isText, confirm) {
            pending.submit = confirm;
            pending.pick = undefined;
            pending.confirm = undefined;
            $dialog.value = {
                ...base(),
                visible: true,
                kind: 'input',
                title: null,
                nodes: [],
                choices: [],
                hint,
                inputType: isText ? 'text' : 'number',
            };
        },
        showTip(nodes, icon) {
            tipId += 1;
            $tip.value = { nodes, icon, id: tipId };
        },
        hide() {
            pending.pick = pending.confirm = pending.submit = undefined;
            $dialog.value = { ...base(), visible: false, choices: [] };
        },
        hideTip() {
            $tip.value = null;
        },
        effect() {
            /* 视觉 / 音频动作由 game 层的 onEffect 接管 */
        },
    };
}
