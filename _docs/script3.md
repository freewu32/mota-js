# 3.0 脚本与数据 API

!> 本章针对 **3.0 重写版**（开发中）。2.x 的 `core` API 见[脚本](script)与[附录：API列表](api)，两套 API 不兼容。

3.0 的目标之一是把「塔作者写什么」从「随便写 JS」变成「优先写数据，必要时写脚本」。原因很直接：旧引擎的效果、条件都存成 JS 字符串再 `eval`，塔一改数值就等于执行任意代码，既没法校验也没法单测，还绑死了全局 `core`。

## 一、先写数据，再写脚本

同一个效果有三种写法，优先用最左边的：

| 写法 | 例子 | 适用 |
| --- | --- | --- |
| 剧本动作列表 | `"useItemEffect": [{ "type": "setValue", "name": "status:hp", "operator": "+=", "value": "100" }]` | 绝大多数道具、事件 |
| 值块表达式 | `"canUseItemEffect": "blockId(nextX(), nextY()) == 'ice'"` | 条件判断、文本插值 `${...}` |
| 塔作者脚本 | `"useItemEffect": { "script": "items/bomb" }` | 需要循环 / 提前返回 / 批量扫描的命令式逻辑 |

只有第三种才需要写 TypeScript。

## 二、值块与内建函数

值块（`status:hp`、`flag:xxx`、`item:yellowKey` …）的语法与 2.x 一致，此外新增：

| 值块 | 说明 |
| --- | --- |
| `value:名称` | 读取塔属性里的 `values`（旧 `core.values.xxx`） |
| `floor:属性` | 读取当前层属性（旧 `core.status.thisMap.xxx`，如 `floor:ratio`） |
| `blockId:x,y` / `blockNumber:x,y` / `blockCls:x,y` | 读某点图块（旧 `core.getBlockId` 等） |

旧塔里散落在效果中的 `core.xxx()` 调用，3.0 改成**注入表达式的内建函数**，可以直接写在条件与 `${}` 里：

| 内建函数 | 对应旧写法 | 说明 |
| --- | --- | --- |
| `nextX(n)` / `nextY(n)` | `core.nextX(n)` | 勇士前方第 n 格坐标 |
| `blockId(x, y, floorId?)` | `core.getBlockId(x, y, floorId)` | 某点图块 id，空格与已移除图块为 `null` |
| `blockNumber(x, y, floorId?)` | `core.getBlockNumber(...)` | 某点图块编号 |
| `blockCls(x, y, floorId?)` | `core.getBlock(x,y).event.cls` | 某点图块类别 |
| `blockAttr(x, y, 属性名, floorId?)` | `core.getBlock(x,y).event.canBreak` | 某点图块的属性，空格 / 已移除为 `null`（破墙镐条件） |
| `blockCount(idOrCls, floorId?)` | `core.searchBlock('xxx').length` | 按 id / 类别 / 属性名统计数量（`blockCount('canBreak')` 即「本层可破坏的墙」） |
| `isEnemy(id)` | `core.material.enemys[id] != null` | 该 id 是否为怪物（炸弹条件） |
| `enemyAttr(id, 属性名)` | `core.material.enemys[id].notBomb` | 怪物属性（炸弹条件里的免炸标记） |
| `mapWidth(floorId?)` / `mapHeight(floorId?)` | `core.bigmap.width` / `height` | 地图尺寸 |
| `floorId()` / `floorIndex(floorId?)` / `floorCount()` | `core.status.floorId` / `core.floorIds` | 楼层信息 |
| `floorIdOffset(n, floorId?)` | `core.floorIds[index + n]` | 相对楼层 id，越界为 `null` |
| `nearStair(floorId?)` | `core.nearStair()` | 是否与楼梯 / 传送点相邻 |

于是「破冰镐能不能用」这类判断可以纯数据表达：

```json
"canUseItemEffect": "blockId(nextX(), nextY()) == 'ice'",
"useItemEffect": [
    { "type": "openDoor", "loc": ["nextX()", "nextY()"] },
    { "type": "tip", "text": "破冰镐使用成功" }
]
```

「上楼器能不能用」（目标层同一位置是否为空）：

```json
"canUseItemEffect": "floorIndex() < floorCount() - 1 && blockId(status:x, status:y, floorIdOffset(1)) == null"
```

?> 所有 `loc` 坐标都按表达式求值，所以 `["nextX()", "nextY()"]`、`["mapWidth() - 1 - status:x", "mapHeight() - 1 - status:y"]` 都能直接用。

## 三、新增与变更的剧本动作

| 动作 | 说明 |
| --- | --- |
| `removeBlock` | 移除图块。`loc` 指定坐标，或 `filter` 批量匹配，如 `{ "type": "removeBlock", "filter": { "canBreak": true } }`（地震卷轴） |
| `openDoor` | 开门。`loc` 指定坐标，或 `filter` 批量开门，如 `{ "type": "openDoor", "filter": { "id": "yellowDoor" } }`（大黄门钥匙）；`needKey: true` 才会检查并扣 `doorInfo.keys`，与旧引擎一致，剧本里开门默认不扣 |
| `openPanel` | 打开面板，交给呈现层：`{ "type": "openPanel", "panel": "monsterManual" }`（怪物手册）/ `"floorMap"`（楼层传送）/ `"items"` / `"equips"` |
| `jumpHero` | 勇士跳跃到 `loc` 或相对位移 `dxy`，位移由引擎完成、动画交给呈现层（跳跃靴） |
| `triggerDebuff` | 上/解毒衰咒：`{ "type": "triggerDebuff", "action": "remove", "kind": "poison" }` |
| `changeFloor` | 支持相对楼层：`":before"` / `":after"`（旧写法 `":next"` 同样接受），越界时停在当前层 |
| `hide` / `show` | 隐藏 / 恢复图块（3.0 新增，等价旧 `core.removeBlock` + 重新出现） |

## 四、塔作者脚本

### 目录与写法

脚本放在 `project/scripts/` 下，一个文件一个默认导出函数（样板塔的 `project/scripts/items/bomb.ts` 就是完整示例）：

```ts
/// <reference path="../../../mota.d.ts" />
import type { ItemScript } from 'mota:types';

export default (({ api, itemId }) => {
    const target = api.blockAt(api.nextX(), api.nextY());
    if (!target) return;
    api.removeBlock(target.x, target.y);
    api.playSound('炸弹');
    return [{ type: 'tip', text: `${api.itemName(itemId ?? '')}使用成功` }];
}) satisfies ItemScript;
```

类型声明在仓库根目录的 `mota.d.ts`（`mota:types` 模块），编辑器里能直接补全。
开发服务器会把 `/project/scripts/**/*.ts` 即时转译成 JS 再送到浏览器，所以脚本直接用 TypeScript 写、无需构建。

### 在数据里引用

```json
"bomb": {
    "cls": "tools",
    "name": "炸弹",
    "canUseItemEffect": "isEnemy(blockId(nextX(), nextY())) && !enemyAttr(blockId(nextX(), nextY()), 'notBomb')",
    "useItemEffect": { "script": "items/bomb" }
}
```

脚本路径相对 `project/scripts/`，`items/bomb` 对应 `project/scripts/items/bomb.ts`。

### 上下文与返回值

脚本收到一个上下文对象：

| 字段 | 说明 |
| --- | --- |
| `api` | 游戏 API（见下表） |
| `itemId` | 道具脚本才有：当前道具 id |
| `trigger` | `pickUp`（拾取即用）/ `use`（主动使用）/ `event` / `function` |
| `args` | `function` 动作传入的参数 |

返回值可以是单个动作、动作列表，或什么都不返回（只通过 `api` 改状态）。

### 加载方式

引擎不做 IO：脚本由宿主在开局前用动态 `import()` 预加载（`runtime.loadScripts()`），因为效果执行是同步的。加载失败的脚本会列在控制台里，对应的道具会退化成「无效果」而不是让整局崩掉。

## 五、游戏 API（`ctx.api`）

只读查询与上面那张内建函数表**完全同源**，表达式能写的，脚本也能读。

| 分类 | 成员 |
| --- | --- |
| 只读查询 | `nextX` `nextY` `blockId` `blockNumber` `blockCls` `blockAttr` `blockCount` `mapWidth` `mapHeight` `floorIndex` `floorCount` `floorIdOffset` `nearStair` |
| 状态 | `hero` `flags` `values` `floorId` `floorIds` `getStatus` `getBuff` `getFlag` `setFlag` `get` `set` |
| 道具与装备 | `itemName` `enemyName` `isEnemy` `enemyAttr` `itemCount` `hasItem` `addItem` `removeItem` `useItem` `canUseItem` `equip` `unequip` |
| 地图 | `blockAt` `searchBlocks` `removeBlock` `setBlock` |
| 楼层与剧本 | `changeFloor` `runAction` `insertAction` `tip` `playSound` |
| 界面 | `openPanel('monsterManual' \| 'floorMap' \| 'items' \| 'equips' \| 'help' \| 'statistics')` |

写值块用 `api.set`，与剧本的 `setValue` 共用运算符：

```ts
api.set('flag:skill', 1); // 赋值
api.set('status:hp', 50, '+='); // 加 50
api.set('item:yellowKey', 2, '-='); // 扣 2 把黄钥匙
```

## 六、旧塔怎么迁移

`bun run migrate --from <旧塔目录> --out project` 会自动转换大部分效果：

1. 能静态判定的旧 JS 片段（属性赋值、`core.addItem`、`core.setFlag`、`core.playSound`、`core.drawTip`、`core.triggerDebuff`、单 `return` 的条件函数）直接转成动作 / 表达式；
2. 认不出来的字段改名为 `*Legacy` **原样保留**，并打印一份清单，不会静默丢失；
3. 旧 `core.*` 调用在转换时会改写成新写法：

| 旧写法 | 新写法 |
| --- | --- |
| `core.status.hero.hp += 100` | `{ "type": "setValue", "name": "status:hp", "operator": "+=", "value": "100" }` |
| `core.status.thisMap.ratio` | `floor:ratio` |
| `core.nextX()` / `core.nextY()` | `nextX()` / `nextY()` |
| `core.getBlockId(x, y)` | `blockId(x, y)` |
| `core.removeBlock(x, y)` | `{ "type": "removeBlock", "loc": [[x, y]] }` |
| `core.playSound('炸弹')` | `{ "type": "playSound", "name": "炸弹" }` |
| `core.drawTip('使用成功')` | `{ "type": "tip", "text": "使用成功" }` |
| `core.insertAction([...])` | 直接写进 `useItemEvent`，或用脚本的 `api.insertAction` |

复杂道具不会丢给人工了：迁移器内置了一组规则，把旧塔里「成句」的效果（函数、循环、提前返回）逐条改写成新写法。样板塔的 51 个道具现在已全部迁移完，数据里不再有 `core.` 引用，也不再有 `*Legacy` 字段。典型对照：

| 道具 | 旧写法（节选） | 新写法 |
| --- | --- | --- |
| 怪物手册 | `core.ui.drawBook(0);` | `{ "type": "openPanel", "panel": "monsterManual" }` |
| 楼层传送器 | `core.ui.drawFly(...)` / `core.status.maps[floorId].canFlyFrom` | `{ "type": "openPanel", "panel": "floorMap" }` / `(!flag:flyNearStair \|\| nearStair()) && floor:canFlyFrom` |
| 冰冻徽章 | 判断 `getBlockId(...) == 'lava'` 再 `removeBlock` | 条件 `blockId(nextX(), nextY()) == 'lava'` + `{ "type": "removeBlock", "loc": ["nextX()", "nextY()"] }` |
| 破墙镐 | `var canBreak = function (x, y) {...}` | 条件 `blockAttr(nextX(), nextY(), 'canBreak')` + 同样的 `removeBlock` |
| 破冰镐 | `insertAction({type:'openDoor', ...})` | 条件 `blockId(nextX(), nextY()) == 'ice'` + `{ "type": "openDoor", "loc": ["nextX()", "nextY()"] }` |
| 大黄门钥匙 | `searchBlock("yellowDoor").map(...)` + `waitAsync` | 条件 `blockCount('yellowDoor') > 0` + `{ "type": "openDoor", "filter": { "id": "yellowDoor" } }` |
| 地震卷轴 | `removeBlockByIndexes` 扫描 `event.canBreak` | 条件 `blockCount('canBreak') > 0` + `{ "type": "removeBlock", "filter": { "canBreak": true } }` |
| 中心对称飞行器 | `setHeroLoc('x', core.bigmap.width - 1 - ...)` | `{ "type": "changePos", "loc": ["mapWidth() - 1 - status:x", ...] }` |
| 上楼器 / 下楼器 | `core.floorIds[index ± 1]` + `core.changeFloor` | 条件 `floorIndex() < floorCount() - 1 && blockId(status:x, status:y, floorIdOffset(1)) == null` + `{ "type": "changeFloor", "floorId": ":after", "loc": ["status:x", "status:y"] }` |
| 跳跃靴 | `insertAction({type:'jumpHero', loc:[nextX(2), nextY(2)]})` | 条件里做边界判断 + `{ "type": "jumpHero", "loc": ["nextX(2)", "nextY(2)"] }` |
| 技能开关 | 嵌套 `if` + `setFlag` | 用两个嵌套的 `if` 动作表达（`condition` + `true` / `false` 分支） |
| 生命魔杖 | `{ "type": "function", "function": "function(){core.addItem('lifeWand',1);}" }` | `{ "type": "setValue", "name": "item:lifeWand", "operator": "+=", "value": "1" }` |
| 炸弹 | `bombList` / `canBomb` / 退还道具 | 条件用 `isEnemy` + `enemyAttr(..., 'notBomb')`，效果指向脚本 `{ "script": "items/bomb" }` |

几点需要留意（迁移时会打印提示）：

- 旧写法习惯把 `canUseItemEffect` 写成 `'true'`、在效果里判断失败后退还道具；新写法改成**条件不满足就不能用**，同样不消耗，提示也更准确；
- 旧写法的 `waitAsync` / 门动画 / `clearMap` / `drawHero` 这些重绘与动画交给呈现层，数据里只保留状态变化；
- 真需要命令式逻辑的（扫怪列表、批量结算）才落脚本，例如炸弹。

`project/functions.js` 与 `project/plugins.js` 里是真正的代码（旧引擎用 `eval` 注入），迁移器只做检测、不做转换，需要人工改写成脚本或数据：

- 表达式里用到的自定义函数（如 `rand`、`rand2`）：写成脚本模块导出，或注册进 `runtime.functions`；
- 事件钩子（`resetGame` / `win` / `lose` 等）：3.0 会在游戏入口阶段提供对应钩子；
- 插件（修改引擎内部行为的代码）：3.0 不再支持直接改引擎内部，需要用公开 API 重写。
