import type { CSSProperties, TargetedMouseEvent } from 'preact';
import { STATUS_BAR_LABELS, type StatusBarSlot } from '../../engine/modules/ui';
import { $status } from '../store';

/**
 * 状态栏。
 *
 * 内容来自 `runtime.statusBarView()`（引擎纯模型），本组件只读 `$status`：
 * 内容没变时 `setStatus` 不写 signal，因此主循环每帧调用也不会重渲染。
 *
 * 排版对齐旧版 `#statusBar`：横屏每项一行、竖屏每行 3 项（旧版是
 * `float:left; max-width:95%` 的自动折行，这里用网格表达），图标取自
 * `project/materials/icons.png`（旧 `main.statusBar.icons` 的格号），图集缺失时
 * 退回文字标签。
 */

/** 旧 `main.statusBar.icons`：状态项 → icons.png 的格号（图集为单列 32px） */
export const STATUS_ICONS: Partial<Record<StatusBarSlot, number>> = {
    floor: 0,
    lv: 1,
    hpmax: 2,
    hp: 3,
    atk: 4,
    def: 5,
    mdef: 6,
    money: 7,
    exp: 8,
    up: 9,
    mana: 25,
    skill: 26,
};

export interface StatusBarProps {
    /** 点击状态项（旧 `onStatusBarClick`）；未提供时不响应点击 */
    onSlotClick?(slot: string): void;
}

/** 状态栏里可点击的两项（旧：楼梯图标 -> 浏览地图，金币 -> 快捷商店） */
const CLICKABLE: Record<string, string> = {
    floor: 'viewMap',
    money: 'shops',
};

/** 毒 / 衰 / 咒 的稳定 id（供配色） */
const DEBUFF_IDS = ['poison', 'weak', 'curse'];

/** 钥匙 / 破炸飞 / 状态的配色（旧 `styles.css` 与 `index.html` 的行内颜色） */
const COUNTER_COLORS: Record<string, string> = {
    yellowKey: '#FFCCAA',
    blueKey: '#AAAADD',
    redKey: '#FF8888',
    greenKey: '#88FF88',
    pickaxe: '#BC6E27',
    bomb: '#FA14B9',
    centerFly: '#8DB600',
    poison: '#AFFCA8',
    weak: '#FECCD0',
    curse: '#C2F4E7',
};

function iconStyle(index: number | undefined): CSSProperties | undefined {
    if (index == null) return undefined;
    return { backgroundPositionY: `calc(var(--mota-status-icon-size) * ${-index})` };
}

interface CounterItem {
    id: string;
    text: string;
}

function CounterValue({ items }: { items: readonly CounterItem[] }) {
    return (
        <span class="mota-status-value">
            {items.map((item) => (
                <span key={item.id} style={{ color: COUNTER_COLORS[item.id] }}>
                    {item.text}
                    {'  '}
                </span>
            ))}
        </span>
    );
}

export function StatusBar({ onSlotClick }: StatusBarProps) {
    const view = $status.value;
    if (!view) return <div class="mota-status" />;

    const click = (slot: string) => (event: TargetedMouseEvent<HTMLElement>) => {
        const panel = CLICKABLE[slot];
        if (!panel || !onSlotClick) return;
        event.stopPropagation();
        onSlotClick(panel);
    };

    const counters: { key: string; items: CounterItem[]; title: string }[] = [];
    if (view.visibility.keys) {
        counters.push({
            key: 'key',
            title: '钥匙',
            // 旧版只显示两位数字（颜色区分钥匙种类，不写名字）
            items: view.keys.map((one) => ({ id: one.id, text: one.count })),
        });
    }
    if (view.visibility.pzf) {
        counters.push({
            key: 'pzf',
            title: '破墙镐 / 炸弹 / 飞行器',
            items: view.tools.map((one) => ({ id: one.id, text: `${one.label}${one.count}` })),
        });
    }
    if (view.visibility.debuff) {
        counters.push({
            key: 'debuff',
            title: '状态',
            items: view.debuffs.map((text, index) => ({ id: DEBUFF_IDS[index] ?? text, text })),
        });
    }

    return (
        <div class="mota-status">
            <div class="mota-status-slots">
                {view.visibility.slots.map((slot) => (
                    <div
                        class={`mota-status-slot${CLICKABLE[slot] ? ' is-clickable' : ''}`}
                        key={slot}
                        title={STATUS_BAR_LABELS[slot]}
                        onClick={click(slot)}
                    >
                        <span class="mota-status-icon" style={iconStyle(STATUS_ICONS[slot])} />
                        <span class="mota-status-label">{STATUS_BAR_LABELS[slot]}</span>
                        <span class="mota-status-value">{view.slots[slot]}</span>
                    </div>
                ))}
                {counters.map((counter) => (
                    <div
                        class={`mota-status-slot mota-status-${counter.key}`}
                        key={counter.key}
                        title={counter.title}
                    >
                        <CounterValue items={counter.items} />
                    </div>
                ))}
            </div>
        </div>
    );
}
