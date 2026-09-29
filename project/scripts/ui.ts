/// <reference path="../../mota.d.ts" />
import type { TowerScript } from 'mota:types';

/**
 * 塔作者的 UI 钩子脚本（旧 `project/functions.js` 的 `ui` 段）。
 *
 * 数据里这样引用它：
 *
 * ```json
 * "firstData": {
 *     "ui": {
 *         "script": "ui",
 *         "statistics": ["yellowKey", "redKey"],
 *         "toolboxSort": "name",
 *         "about": "..."
 *     }
 * }
 * ```
 *
 * 与旧版的区别：钩子只返回**数据**，不再直接画 canvas / 改 DOM。
 * 所以这里能做的事情是：
 * - `getToolboxItems(cls, ids)`：决定道具栏显示哪些、按什么顺序；
 * - `statistics()`：决定地图浏览 / 统计面板统计哪些图块；
 * - `about()`：帮助面板里的说明文本。
 *
 * 状态栏的布局由 `src/ui` 决定，塔作者只能改显示项（`flags.statusBarItems`）
 * 与主题 CSS 变量，不能像旧版那样整块自绘——这是有意为之（见重写方案「风险与建议」）。
 */
export default (({ api }) => {
    api.ui.register({
        // 道具栏：装备排前面，其余按名称（声明式配置里是 toolboxSort: 'name'）
        getToolboxItems(cls, ids) {
            return [...ids].sort((a, b) => {
                if (cls === 'equips') return api.itemName(a).localeCompare(api.itemName(b), 'zh');
                return api.itemName(a).localeCompare(api.itemName(b), 'zh');
            });
        },

        // 统计项：本层还剩多少钥匙 / 血瓶（比数据配置多一项绿宝石）
        statistics() {
            return ['yellowKey', 'blueKey', 'redKey', 'redPotion', 'bluePotion', 'greenGem'];
        },

        // 关于文本：会显示在「帮助」面板里
        about() {
            return '这是 3.0 样板塔。UI 钩子示例见 project/scripts/ui.ts。';
        },
    });
}) satisfies TowerScript;
