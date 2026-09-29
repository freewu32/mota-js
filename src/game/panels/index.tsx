import type { ComponentType } from 'preact';
import { $panel, Panel } from '../../ui';
import type { GameContext } from '../context';
import { BookPanel } from './book';
import { EquipPanel } from './equip';
import { FlyPanel, ViewMapPanel } from './fly';
import { ShopPanel } from './shop';
import { HelpPanel, SaveLoadPanel, SettingsPanel, StatisticsPanel } from './system';
import { ToolboxPanel } from './toolbox';
import type { GamePanelProps } from './shared';

/** 面板名 → 组件（名字与 `game-api.ts` 的 `PanelName` 对齐） */
const PANELS: Record<string, ComponentType<GamePanelProps>> = {
    monsterManual: BookPanel,
    items: ToolboxPanel,
    equips: EquipPanel,
    floorMap: FlyPanel,
    viewMap: ViewMapPanel,
    save: SaveLoadPanel,
    load: SaveLoadPanel,
    settings: SettingsPanel,
    statistics: StatisticsPanel,
    help: HelpPanel,
    shops: ShopPanel,
    shop: ShopPanel,
};

/** 面板出口：读 `$panel`，渲染对应面板；塔作者自绘面板没有注册时给个占位 */
export function PanelOutlet({ ctx }: { ctx: GameContext }) {
    const request = $panel.value;
    if (!request) return null;
    const close = (): void => ctx.closePanel();
    const Component = PANELS[request.name];
    if (!Component) {
        return (
            <Panel title={request.name} onClose={close}>
                <div class="mota-muted">该面板尚未实现。</div>
            </Panel>
        );
    }
    return <Component ctx={ctx} close={close} data={request.data} />;
}

export { type GamePanelProps } from './shared';
