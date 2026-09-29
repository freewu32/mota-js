import { getSpecialText } from '../../engine/modules/enemys';
import { formatMonsterManual, parseRichText, type ManualEntry } from '../../engine/modules/ui';
import type { MotaRuntime } from '../../engine/runtime';
import { Panel } from '../../ui';
import { RichText } from '../../ui/components/RichText';
import type { GamePanelProps } from './shared';

/** 当前层怪物手册条目（旧 `core.ui.drawBook` 的数据部分） */
export function monsterManualEntries(runtime: MotaRuntime): ManualEntry[] {
    const grouped = new Map<string, { locs: [number, number][]; damage?: string }>();
    for (const one of runtime.listEnemies()) {
        const found = grouped.get(one.id);
        if (found) found.locs.push([one.x, one.y]);
        else grouped.set(one.id, { locs: [[one.x, one.y]], damage: one.damage });
    }
    const asNumber = (value: unknown): number | undefined =>
        typeof value === 'number' ? value : undefined;
    const asText = (value: unknown): string | undefined =>
        typeof value === 'string' ? value : undefined;
    const entries: ManualEntry[] = [];
    for (const [id, { locs, damage }] of grouped) {
        const enemy = runtime.data.enemys[id];
        entries.push({
            id,
            name: enemy?.name ?? id,
            hp: enemy?.hp,
            atk: enemy?.atk,
            def: enemy?.def,
            // `mdef` / `description` 不在数据 schema 的必填字段里，按需取用
            mdef: asNumber(enemy?.mdef),
            money: enemy?.money,
            exp: enemy?.exp,
            damage,
            specials: enemy ? getSpecialText(enemy) : [],
            description: asText(enemy?.description),
            locs,
        });
    }
    return entries;
}

/** 怪物手册：本层怪物的属性、伤害与特殊能力 */
export function BookPanel({ ctx, close }: GamePanelProps) {
    const entries = monsterManualEntries(ctx.runtime);
    const lines = entries.length > 0 ? formatMonsterManual(entries) : ['本层没有怪物。'];
    return (
        <Panel
            title={`怪物手册 - ${ctx.runtime.floor.title}`}
            onClose={close}
            footer="点击面板外关闭"
        >
            {lines.map((line, index) => (
                <div class="mota-line" key={index}>
                    <RichText nodes={parseRichText(line)} />
                </div>
            ))}
        </Panel>
    );
}
