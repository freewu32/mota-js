import { STATUS_BAR_LABELS } from '../../engine/modules/ui';
import { $status } from '../store';

/**
 * 状态栏。
 *
 * 内容来自 `runtime.statusBarView()`（引擎纯模型），本组件只读 `$status`：
 * 内容没变时 `setStatus` 不写 signal，因此主循环每帧调用也不会重渲染。
 */
export function StatusBar() {
    const view = $status.value;
    if (!view) return <div class="mota-status" />;

    const counters: string[] = [];
    if (view.visibility.keys) {
        counters.push(...view.keys.map((one) => `${one.label} ${one.count}`));
    }
    if (view.visibility.pzf) {
        counters.push(...view.tools.map((one) => `${one.label}${one.count}`));
    }
    if (view.visibility.debuff) counters.push(...view.debuffs);

    return (
        <div class="mota-status">
            <div class="mota-status-slots">
                {view.visibility.slots.map((slot) => (
                    <div class="mota-status-slot" key={slot}>
                        <span class="mota-status-label">{STATUS_BAR_LABELS[slot]}</span>
                        <span class="mota-status-value">{view.slots[slot]}</span>
                    </div>
                ))}
            </div>
            {counters.length > 0 && <div class="mota-status-counters">{counters.join('　')}</div>}
        </div>
    );
}
