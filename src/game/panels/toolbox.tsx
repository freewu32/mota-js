import { parseRichText, richTextToPlain, type ToolboxEntry } from '../../engine/modules/ui';
import { Panel } from '../../ui';
import { ItemIcon, useRevision, type GamePanelProps } from './shared';

/** 道具栏：消耗品 / 永久道具 / 未装备的装备；点击即用（走回合分发器） */
export function ToolboxPanel({ ctx, close }: GamePanelProps) {
    useRevision();
    const view = ctx.runtime.toolboxView();
    const sections: [string, readonly ToolboxEntry[]][] = [
        ['消耗道具', view.tools],
        ['永久道具', view.constants],
        ['装备', view.equips],
    ];
    const total = sections.reduce((sum, [, entries]) => sum + entries.length, 0);

    return (
        <Panel title="道具栏" onClose={close} footer="点击道具使用 / 装备；点击面板外关闭">
            {total === 0 && <div class="mota-muted">背包里没有道具。</div>}
            {sections.map(([label, entries]) =>
                entries.length === 0 ? null : (
                    <div key={label}>
                        <div class="mota-section">{label}</div>
                        <div class="mota-grid">
                            {entries.map((entry) => {
                                const isEquip = entry.cls === 'equips';
                                const usable = isEquip ? entry.equippable : entry.usable;
                                return (
                                    <button
                                        key={entry.id}
                                        type="button"
                                        class="mota-entry"
                                        disabled={!usable}
                                        title={entry.text ? richTextToPlain(parseRichText(entry.text)) : entry.name}
                                        onClick={() => {
                                            ctx.run(
                                                isEquip
                                                    ? `equip:${entry.id}`
                                                    : `item:${entry.id}`,
                                            );
                                            if (isEquip) ctx.playSound('穿脱装备');
                                            else ctx.playSound('确定');
                                        }}
                                    >
                                        <ItemIcon materials={ctx.materials} id={entry.id} />
                                        <span class="mota-entry-name">{entry.name}</span>
                                        <span class="mota-entry-count">x{entry.count}</span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                ),
            )}
        </Panel>
    );
}
