import { STATUS_BAR_LABELS, type StatusBarSlot } from '../../engine/modules/ui';
import { $theme, Panel } from '../../ui';
import type { GameContext } from '../context';
import type { GamePanelProps } from './shared';

/** 存读档 */
export function SaveLoadPanel({ ctx, close }: GamePanelProps) {
    return (
        <Panel title="存读档" onClose={close} footer="存档保存在浏览器本地；读档会回到存档时的楼层与坐标">
            <div class="mota-toolbar">
                <button type="button" class="mota-button" onClick={() => ctx.save()}>
                    存档
                </button>
                <button type="button" class="mota-button" onClick={() => ctx.load()}>
                    读档
                </button>
            </div>
        </Panel>
    );
}

/** 设置：音效 / 音乐 / 音量 / 窗口皮肤 */
export function SettingsPanel({ ctx, close }: GamePanelProps) {
    const theme = $theme.value;
    const skinOn = Boolean(theme.skin);
    return (
        <Panel title="设置" onClose={close}>
            <div class="mota-toolbar">
                <button
                    type="button"
                    class="mota-button"
                    onClick={() => {
                        const enabled = !ctx.audio.soundEnabled;
                        ctx.audio.setSoundEnabled(enabled);
                        if (enabled) ctx.playSound('确定');
                    }}
                >
                    音效：{ctx.audio.soundEnabled ? '开' : '关'}
                </button>
                <button
                    type="button"
                    class="mota-button"
                    onClick={() => {
                        ctx.audio.setBgmEnabled(!ctx.audio.bgmEnabled);
                    }}
                >
                    音乐：{ctx.audio.bgmEnabled ? '开' : '关'}
                </button>
                <button
                    type="button"
                    class="mota-button"
                    onClick={() => ctx.toggleSkin()}
                >
                    窗口皮肤：{skinOn ? '开' : '关'}
                </button>
            </div>
            <div class="mota-toolbar">
                <span class="mota-muted">音量</span>
                <input
                    class="mota-input"
                    type="range"
                    min="0"
                    max="1"
                    step="0.1"
                    value={ctx.audio.volume}
                    onChange={(event) => {
                        const value = Number((event.currentTarget as HTMLInputElement).value);
                        ctx.audio.setVolume(value);
                    }}
                />
            </div>
        </Panel>
    );
}

/** 统计：状态栏数值 + 步数 / 录像长度 / 到达楼层 */
export function StatisticsPanel({ ctx, close }: GamePanelProps) {
    const bar = ctx.runtime.statusBarView();
    const slots: StatusBarSlot[] = ['floor', 'lv', 'hp', 'atk', 'def', 'mdef', 'money', 'exp'];
    const visited = ctx.runtime.floorIds.filter((id) => ctx.runtime.hasVisited(id));
    return (
        <Panel title="统计" onClose={close}>
            {slots.map((slot) => (
                <div class="mota-line" key={slot}>
                    {STATUS_BAR_LABELS[slot]}：{bar.slots[slot]}
                </div>
            ))}
            <div class="mota-line">步数：{ctx.runtime.state.hero.steps ?? 0}</div>
            <div class="mota-line">录像长度：{ctx.runtime.route.route.length}</div>
            <div class="mota-line">
                到达楼层：{visited.length} / {ctx.runtime.floorIds.length}
            </div>
            <StatisticsItems ctx={ctx} />
        </Panel>
    );
}

const KEY_HELP: [string, string][] = [
    ['方向键', '移动 / 撞击 / 触发事件'],
    ['空格 / 回车 / 点击', '继续对话、确认'],
    ['X', '怪物手册'],
    ['T', '道具栏'],
    ['Q', '装备栏'],
    ['F', '楼层传送'],
    ['M', '地图浏览'],
    ['S', '存读档'],
    ['B', '统计'],
    ['Esc', '关闭面板'],
];

/** 塔作者配置的剩余图块统计（旧 `functions.ui.drawStatistics`） */
function StatisticsItems({ ctx }: { ctx: GameContext }) {
    const items = ctx.runtime.statisticsView();
    if (items.length === 0) return null;
    return (
        <>
            <div class="mota-section">本层剩余</div>
            {items.map((item) => (
                <div class="mota-entry" key={item.id}>
                    <span class="mota-entry-name">{item.name}</span>
                    <span class="mota-entry-count">{item.count}</span>
                </div>
            ))}
        </>
    );
}

/** 帮助：键位说明 + 塔作者的说明文本（旧 `functions.ui.drawAbout`） */
export function HelpPanel({ ctx, close }: GamePanelProps) {
    const about = ctx.runtime.aboutText();
    return (
        <Panel title="帮助" onClose={close} footer="触屏设备可用右下角虚拟键盘或滑动操作">
            <div class="mota-grid">
                {KEY_HELP.map(([key, text]) => (
                    <div class="mota-entry" key={key}>
                        <span class="mota-entry-name">{key}</span>
                        <span class="mota-entry-count">{text}</span>
                    </div>
                ))}
            </div>
            {about && <div class="mota-line">{about}</div>}
            <div class="mota-line mota-muted">
                当前塔：{ctx.runtime.data.tower.firstData.title} v
                {ctx.runtime.data.tower.firstData.version}
            </div>
        </Panel>
    );
}
