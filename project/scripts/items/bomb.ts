/// <reference path="../../../mota.d.ts" />
import type { ItemScript } from 'mota:types';

/**
 * 炸弹：炸掉勇士面前的怪物。
 *
 * 这是塔作者脚本的示例。数据里这样引用它：
 *
 * ```json
 * "bomb": {
 *     "cls": "tools",
 *     "name": "炸弹",
 *     "canUseItemEffect": "isEnemy(blockId(nextX(), nextY())) && !enemyAttr(blockId(nextX(), nextY()), 'notBomb')",
 *     "useItemEffect": { "script": "items/bomb" }
 * }
 * ```
 *
 * 为什么炸弹要写成脚本而不是数据：旧塔的这段逻辑里有「扫怪列表 → 结算金币经验 →
 * 收集战后事件 → 全部失败就退还道具」这类命令式流程，用动作列表表达会很别扭；
 * 其余 13 个道具都已经能纯数据表达（见 `_docs/script3.md` 的对照表）。
 *
 * 想改成「炸掉周围一圈怪物」时，把 `DIRECTIONS` 换成四方向遍历即可；
 * 想启用「炸弹后获得金币经验」，取消下面那段注释。
 */
export default (({ api, itemId }) => {
    const target = api.blockAt(api.nextX(), api.nextY());
    if (!target) return;

    const enemyId = String(target.event.id);
    api.removeBlock(target.x, target.y);
    api.playSound('炸弹');

    // 旧塔里被注释掉的结算逻辑，需要时取消注释（金额由塔数据里的怪物属性决定）：
    // api.set('status:money', Number(api.enemyAttr(enemyId, 'money') ?? 0), '+=');
    // api.set('status:exp', Number(api.enemyAttr(enemyId, 'exp') ?? 0), '+=');

    return [{ type: 'tip', text: `${api.itemName(itemId ?? '')}使用成功` }];
}) satisfies ItemScript;
