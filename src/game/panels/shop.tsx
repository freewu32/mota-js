import { Panel } from '../../ui';
import type { GameContext } from '../context';
import type { GamePanelProps } from './shared';

/**
 * 快捷商店（旧 `_drawQuickShop` + `_drawQuickShop` 的单商店直开逻辑）。
 *
 * 列表里的商店就是 `firstData.shops` 里「已访问过或不需要开启」的那些；
 * 未访问过的商店点开会进入预览模式（选项灰掉），与旧版一致。
 * 只有一个商店时直接打开它（旧 `events.openQuickShop`）。
 */
export function ShopPanel({ ctx, close }: GamePanelProps) {
    const shops = ctx.runtime.shopView();
    const single = shops.length === 1 ? shops[0] : undefined;
    const canUse = single ? ctx.runtime.shops.canUseQuickShop(single.id) : null;

    if (single && canUse == null && single.canOpen) {
        // 单商店：直接进商店界面
        ctx.runtime.openQuickShop(single.id);
        close();
        return null;
    }

    return (
        <Panel title="商店" onClose={close} footer="未到过的商店只能预览，无法购买">
            {shops.length === 0 ? (
                <div class="mota-muted">本游戏没有快捷商店。</div>
            ) : (
                <div class="mota-grid">
                    {shops.map((shop) => (
                        <button
                            key={shop.id}
                            type="button"
                            class="mota-entry"
                            disabled={!shop.canOpen}
                            onClick={() => {
                                ctx.playSound('确定');
                                ctx.runtime.openQuickShop(shop.id);
                                close();
                            }}
                        >
                            <span class="mota-entry-name">{shop.text}</span>
                            {!shop.visited && <span class="mota-entry-count">未到过</span>}
                        </button>
                    ))}
                </div>
            )}
        </Panel>
    );
}

/** 供工具栏 / 脚本使用：本塔是否有商店 */
export function hasShops(ctx: GameContext): boolean {
    return ctx.runtime.shops.list().length > 0;
}
