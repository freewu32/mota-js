import { STATUS_BAR_LABELS, type EquipEntry } from '../../engine/modules/ui';
import { Panel } from '../../ui';
import { ItemIcon, useRevision, type GamePanelProps } from './shared';

function statLabel(name: string): string {
    return (STATUS_BAR_LABELS as unknown as Record<string, string>)[name] ?? name;
}

/** 换装属性差文本（旧 `_drawEquipbox_getStatusChanged`） */
function diffText(entry: EquipEntry): string {
    const parts: string[] = [];
    for (const [name, value] of Object.entries(entry.value)) {
        if (value) parts.push(`${statLabel(name)} ${value > 0 ? '+' : ''}${value}`);
    }
    for (const [name, value] of Object.entries(entry.percentage)) {
        if (value) parts.push(`${statLabel(name)} ${value > 0 ? '+' : ''}${value}%`);
    }
    return parts.length > 0 ? parts.join('，') : '无属性变化';
}

/** 装备栏：每格显示当前装备与候选，点击换装 / 卸下 */
export function EquipPanel({ ctx, close }: GamePanelProps) {
    useRevision();
    const slots = ctx.runtime.equipView();

    return (
        <Panel
            title="装备栏"
            onClose={close}
            footer={
                <div class="mota-toolbar">
                    <button
                        type="button"
                        class="mota-button"
                        onClick={() => ctx.run('saveEquip:0')}
                    >
                        保存套装 1
                    </button>
                    <button
                        type="button"
                        class="mota-button"
                        onClick={() => ctx.run('loadEquip:0')}
                    >
                        读取套装 1
                    </button>
                    <span class="mota-muted">点击已装备的道具可卸下</span>
                </div>
            }
        >
            {slots.length === 0 && <div class="mota-muted">当前塔没有装备槽。</div>}
            {slots.map((slot) => (
                <div key={slot.type}>
                    <div class="mota-section">{slot.label}</div>
                    <div class="mota-grid">
                        {slot.current ? (
                            <button
                                type="button"
                                class="mota-entry is-current"
                                title="点击卸下"
                                onClick={() => {
                                    ctx.run(`unEquip:${slot.type}`);
                                    ctx.playSound('穿脱装备');
                                }}
                            >
                                <ItemIcon materials={ctx.materials} id={slot.current.id} />
                                <span class="mota-entry-name">{slot.current.name}</span>
                                <span class="mota-entry-count">已装备</span>
                            </button>
                        ) : (
                            <div class="mota-muted">（空）</div>
                        )}
                        {slot.candidates.map((candidate) => (
                            <button
                                key={candidate.id}
                                type="button"
                                class="mota-entry"
                                disabled={!candidate.equippable}
                                title={diffText(candidate)}
                                onClick={() => {
                                    ctx.run(`equip:${candidate.id}`);
                                    ctx.playSound('穿脱装备');
                                }}
                            >
                                <ItemIcon materials={ctx.materials} id={candidate.id} />
                                <span class="mota-entry-name">{candidate.name}</span>
                                <span class="mota-entry-count">{diffText(candidate)}</span>
                            </button>
                        ))}
                    </div>
                </div>
            ))}
        </Panel>
    );
}
