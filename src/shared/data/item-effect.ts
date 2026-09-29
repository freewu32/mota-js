/**
 * 旧道具效果的迁移转换。
 *
 * 旧塔把 `itemEffect` / `useItemEffect` / `canUseItemEffect` 写成 JS 片段，由
 * 引擎 `eval` 执行。新引擎不再 `eval`：
 *
 * - 效果 → 剧本动作列表（`src/engine/modules/events.ts` 的动作词汇）；
 * - 条件 → 值块表达式（`src/engine/modules/values.ts`）；
 * - 提示文本 → `${表达式}` 插值（迁移时顺带把 `core.values.x` 改写成 `value:x`）。
 *
 * 本模块只做「可静态判定」的保守转换：识别不了的一律保持原文并交给人工迁移，
 * 转换结果会被校验，绝不会产出引擎无法解析的表达式。
 */

/** 转换结果：成功时给出 actions 或 expression，失败时给出原因 */
export interface TranslateResult {
    /** 转换后的剧本动作列表（效果类字段） */
    actions?: unknown[];
    /** 转换后的表达式（条件类字段） */
    expression?: string;
    /** 无法转换的原因 */
    reason?: string;
}

/** 值块前缀，供校验与文本替换使用 */
const TRAIT_PREFIX = '(status|item|buff|flag|switch|temp|global|value|enemy|floor|equip)';
/** 值块：前缀 + 名称（名称不含空白、运算符与括号） */
const TRAIT_BLOCK = new RegExp(`${TRAIT_PREFIX}:[^\\s()+.\\-*/%<>=!&|?:,\\[\\]]+`, 'g');

/** 去掉 `//` 行注释与 `/* *\/` 块注释 */
export function stripComments(src: string): string {
    let result = '';
    let i = 0;
    let quote: string | null = null;
    while (i < src.length) {
        const c = src[i]!;
        if (quote) {
            result += c;
            if (c === '\\') {
                result += src[i + 1] ?? '';
                i += 2;
                continue;
            }
            if (c === quote) quote = null;
            i += 1;
            continue;
        }
        if (c === '"' || c === "'") {
            quote = c;
            result += c;
            i += 1;
            continue;
        }
        if (c === '/' && src[i + 1] === '/') {
            while (i < src.length && src[i] !== '\n') i += 1;
            continue;
        }
        if (c === '/' && src[i + 1] === '*') {
            const end = src.indexOf('*/', i + 2);
            if (end < 0) return result;
            result += ' ';
            i = end + 2;
            continue;
        }
        result += c;
        i += 1;
    }
    return result;
}

/**
 * 按顶层 `;` 切分语句。
 * 遇到花括号（函数体 / 对象字面量）或括号不配对时返回 null，表示无法静态转换。
 */
export function splitStatements(src: string): string[] | null {
    const statements: string[] = [];
    let current = '';
    let quote: string | null = null;
    const stack: string[] = [];
    for (let i = 0; i < src.length; i += 1) {
        const c = src[i]!;
        if (quote) {
            current += c;
            if (c === '\\') {
                current += src[i + 1] ?? '';
                i += 1;
            } else if (c === quote) quote = null;
            continue;
        }
        if (c === '"' || c === "'") {
            quote = c;
            current += c;
            continue;
        }
        if (c === '{' || c === '}') return null;
        if (c === '(' || c === '[') {
            stack.push(c);
            current += c;
            continue;
        }
        if (c === ')' || c === ']') {
            const expected = c === ')' ? '(' : '[';
            if (stack.pop() !== expected) return null;
            current += c;
            continue;
        }
        if (c === ';' && stack.length === 0) {
            statements.push(current);
            current = '';
            continue;
        }
        current += c;
    }
    if (quote || stack.length > 0) return null;
    statements.push(current);
    return statements.map((one) => one.trim()).filter((one) => one !== '');
}

/** 旧引用 → 新值块。返回 null 表示认不出来 */
function readCoreReference(src: string, start: number): [string, number] | null {
    const rest = src.slice(start);
    const stringArg = `(['"])([^'"]*)\\1`;
    const patterns: [RegExp, (m: RegExpMatchArray) => string][] = [
        [/^core\.status\.thisMap\.([\w$]+)/, (m) => `floor:${m[1]}`],
        [/^core\.status\.hero\.([\w$]+)/, (m) => `status:${m[1]}`],
        [/^core\.status\.items\.[\w$]+\.([\w$]+)/, (m) => `status:${m[1]}`],
        [/^core\.status\.([\w$]+)/, (m) => `status:${m[1]}`],
        [/^core\.values\.([\w$]+)/, (m) => `value:${m[1]}`],
        [/^core\.flags\.([\w$]+)/, (m) => `flag:${m[1]}`],
        [new RegExp(`^core\\.getStatus\\(${stringArg}\\)`), (m) => `status:${m[2]}`],
        [new RegExp(`^core\\.hasFlag\\(${stringArg}\\)`), (m) => `flag:${m[2]}`],
        [new RegExp(`^core\\.itemCount\\(${stringArg}\\)`), (m) => `item:${m[2]}`],
        // getFlag 的默认值语义不同（新引擎缺省读 0），只接受显式的 0 / false
        [
            new RegExp(`^core\\.getFlag\\(${stringArg}(?:\\s*,\\s*(0|false))?\\s*\\)`),
            (m) => `flag:${m[2]}`,
        ],
    ];
    for (const [pattern, render] of patterns) {
        const match = rest.match(pattern);
        if (match) return [render(match), start + match[0].length];
    }
    return null;
}

/** 把旧表达式改写成新表达式；认不出 `core.` 引用时返回 null */
export function translateExpression(src: string): string | null {
    const text = stripComments(src).trim();
    if (text === '') return null;
    let out = '';
    let i = 0;
    let quote: string | null = null;
    while (i < text.length) {
        const c = text[i]!;
        if (quote) {
            out += c;
            if (c === '\\') {
                out += text[i + 1] ?? '';
                i += 2;
                continue;
            }
            if (c === quote) quote = null;
            i += 1;
            continue;
        }
        if (c === '"' || c === "'") {
            quote = c;
            out += c;
            i += 1;
            continue;
        }
        if (text.startsWith('core.', i)) {
            const reference = readCoreReference(text, i);
            if (!reference) return null;
            // 值块后面紧跟属性访问 / 调用（如 core.getFlag('a').toString()）一律放弃
            const next = text[reference[1]];
            if (next === '.' || next === '(' || next === '[') return null;
            out += reference[0];
            i = reference[1];
            continue;
        }
        out += c;
        i += 1;
    }
    if (quote) return null;
    return isValidExpression(out) ? out.replace(/\s+/g, ' ').trim() : null;
}

/** 校验最终表达式：只允许值块、数字、运算符与 true/false/null */
export function isValidExpression(expr: string): boolean {
    const withoutTraits = expr.replace(TRAIT_BLOCK, ' ');
    if (/\b(core|function|return|var|let|const|new|typeof)\b/.test(withoutTraits)) return false;
    // 值块不得再带成员访问 / 调用
    if (withoutTraits.includes('core.')) return false;
    const words = withoutTraits.match(/[A-Za-z_$][\w$]*/g) ?? [];
    if (words.some((word) => !['true', 'false', 'null'].includes(word))) return false;
    // 去掉比较运算符后不应残留单个 `=`
    const withoutCompare = withoutTraits.replace(/[=!<>]=/g, ' ');
    if (/[=;{}[\]]/.test(withoutCompare)) return false;
    if (/[^0-9A-Za-z_$\s+\-*/%()<>=!&|?:.,]/.test(withoutCompare)) return false;
    // 至少要含一个数字或值块，避免把空串或纯符号当成表达式
    return /[\w:]/.test(expr);
}

/** 展开 `(function () { ... })()`，只认函数体里唯一的一条 `return 表达式;` */
export function unwrapIife(src: string): string | null {
    const text = stripComments(src).trim();
    if (!/^\(\s*function\s*\([^)]*\)\s*\{/.test(text)) return null;
    const bodyStart = text.indexOf('{') + 1;
    const bodyEnd = text.lastIndexOf('}');
    if (bodyEnd < bodyStart) return null;
    const tail = text.slice(bodyEnd + 1).replace(/[\s()]/g, '');
    if (tail !== ';' && tail !== '') return null;
    const body = text.slice(bodyStart, bodyEnd).trim();
    const match = body.match(/^return\s+([\s\S]*?);?$/);
    return match ? match[1]!.trim() : null;
}

function shorten(src: string, max = 60): string {
    const oneLine = src.replace(/\s+/g, ' ').trim();
    return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** 把一条简单语句转换成剧本动作；认不出时返回原因字符串 */
function translateStatement(stmt: string): { action: unknown } | { reason: string } {
    const assignment = stmt.match(
        /^(core\.(?:status\.hero\.|status\.|flags\.|values\.)[\w$]+)\s*(\*\*=|max=|min=|\+=|-=|\*=|\/=|%=|=)\s*([\s\S]+)$/,
    );
    if (assignment) {
        const [, target, operator, raw] = assignment;
        const name = target!
            .replace(/^core\.status\.hero\./, 'status:')
            .replace(/^core\.status\./, 'status:')
            .replace(/^core\.flags\./, 'flag:')
            .replace(/^core\.values\./, 'value:');
        const value = translateExpression(raw!);
        if (value == null) return { reason: `无法转换的赋值表达式：${shorten(raw!)}` };
        const action: Record<string, unknown> = { type: 'setValue', name };
        if (operator !== '=') action.operator = operator;
        action.value = value;
        return { action };
    }

    const addItem = stmt.match(/^core\.addItem\(\s*(['"])([^'"]+)\1\s*(?:,\s*([\s\S]+?))?\s*\)$/);
    if (addItem) {
        const value = addItem[3] ? translateExpression(addItem[3]) : '1';
        if (value == null) return { reason: `无法转换的 addItem 数量：${shorten(stmt)}` };
        return {
            action: { type: 'setValue', name: `item:${addItem[2]}`, operator: '+=', value },
        };
    }

    const setItem = stmt.match(/^core\.setItem\(\s*(['"])([^'"]+)\1\s*,\s*([\s\S]+?)\s*\)$/);
    if (setItem) {
        const value = translateExpression(setItem[3]!);
        if (value == null) return { reason: `无法转换的 setItem 数量：${shorten(stmt)}` };
        return { action: { type: 'setValue', name: `item:${setItem[2]}`, value } };
    }

    const setFlag = stmt.match(/^core\.setFlag\(\s*(['"])([^'"]+)\1\s*,\s*([\s\S]+?)\s*\)$/);
    if (setFlag) {
        const value = translateExpression(setFlag[3]!);
        if (value == null) return { reason: `无法转换的 setFlag 取值：${shorten(stmt)}` };
        return { action: { type: 'setValue', name: `flag:${setFlag[2]}`, value } };
    }

    const removeFlag = stmt.match(/^core\.removeFlag\(\s*(['"])([^'"]+)\1\s*\)$/);
    if (removeFlag) {
        return { action: { type: 'setValue', name: `flag:${removeFlag[2]}`, value: 'false' } };
    }

    const playSound = stmt.match(/^core\.playSound\(\s*(['"])([^'"]+)\1\s*\)$/);
    if (playSound) return { action: { type: 'playSound', name: playSound[2] } };

    const debuff = stmt.match(
        /^core\.triggerDebuff\(\s*(['"])(get|remove)\1\s*,\s*(\[[\s\S]*?\]|(['"])[^'"]+\4)\s*\)$/,
    );
    if (debuff) {
        const raw = debuff[3]!.trim();
        const types = raw
            .replace(/^\[|\]$/g, '')
            .split(',')
            .map((one) => one.trim())
            .map((one) => one.replace(/^['"]|['"]$/g, ''))
            .filter((one) => one !== '');
        if (types.length === 0) return { reason: `无法转换的毒衰咒类型：${shorten(stmt)}` };
        const kinds = types.length === 1 ? types[0] : types;
        return { action: { type: 'triggerDebuff', action: debuff[2], kind: kinds } };
    }

    const tip = stmt.match(/^core\.drawTip\(\s*(['"])([^'"]*)\1\s*(?:,\s*[\s\S]+)?\)$/);
    if (tip) return { action: { type: 'tip', text: tip[2] } };

    return { reason: `无法转换的语句：${shorten(stmt)}` };
}

/** 转换效果类字段（`itemEffect` / `useItemEffect`）：转成剧本动作列表 */
export function translateItemActions(src: unknown): TranslateResult {
    if (Array.isArray(src)) return { actions: src };
    if (typeof src !== 'string') return { reason: '不是字符串或动作列表' };
    const text = stripComments(src).trim();
    if (text === '') return { actions: [] };

    // 函数表达式形式的「即捡即用」效果：只有一条 return 时仍无法表达副作用，直接转交人工
    if (text.startsWith('(function') || text.startsWith('function')) {
        return { reason: '函数表达式形式的效果无法静态转换' };
    }

    const statements = splitStatements(text);
    if (!statements) return { reason: '含有代码块或无法配对的括号' };

    const actions: unknown[] = [];
    for (const statement of statements) {
        const result = translateStatement(statement);
        if ('reason' in result) return { reason: result.reason };
        actions.push(result.action);
    }
    return { actions };
}

/** 转换条件类字段（`canUseItemEffect`）：转成值块表达式 */
export function translateItemCondition(src: unknown): TranslateResult {
    if (typeof src !== 'string') return { reason: '不是字符串' };
    const text = stripComments(src).trim();
    if (text === '') return { reason: '空条件' };

    const unwrapped = unwrapIife(text);
    if (unwrapped != null) {
        const expression = translateExpression(unwrapped);
        return expression == null
            ? { reason: `无法转换的函数返回值：${shorten(unwrapped)}` }
            : { expression };
    }
    if (text.startsWith('(') || text.includes('{')) {
        return { reason: '函数体包含多条语句，需人工迁移' };
    }

    const statements = splitStatements(text);
    if (!statements || statements.length !== 1) {
        return { reason: '条件不是单个表达式' };
    }
    const expression = translateExpression(statements[0]!);
    return expression == null
        ? { reason: `无法转换的条件表达式：${shorten(statements[0]!)}` }
        : { expression };
}

/** 提示文本里的 `core.xxx` 引用改写为值块（失败时保持原文） */
export function translateTipText(tip: unknown): string | undefined {
    if (typeof tip !== 'string') return undefined;
    const expressionPattern = /\$\{([^}]*)\}/g;
    return tip.replace(expressionPattern, (whole, expr: string) => {
        const translated = translateExpression(expr);
        return translated == null ? whole : `\${${translated}}`;
    });
}

////// 成句道具的迁移规则 //////

/** 规则匹配上下文：道具 id / 名称与旧字段原文 */
export interface ItemRuleContext {
    id: string;
    /** 道具名，用于生成「xxx使用成功」这类提示 */
    name: string;
    /** 旧 `useItemEffect` / `itemEffect` 原文（可能为空） */
    effect: string;
    /** 旧 `canUseItemEffect` 原文（可能为空） */
    condition: string;
}

/** 规则产出的新字段 */
export interface ItemRuleResult {
    /** 新的 `useItemEffect`；未设置表示不改动该字段 */
    useItemEffect?: unknown;
    /** 新的 `canUseItemEffect`；`null` 表示删除该字段 */
    canUseItemEffect?: string | null;
    /** 需塔作者自备的脚本（相对 `project/scripts/`，不含扩展名） */
    script?: string;
    /** 迁移提示：行为变化、需人工确认之处 */
    notes?: string[];
}

interface ItemRule {
    /** 规则名（用于测试与排查） */
    name: string;
    match(ctx: ItemRuleContext): boolean;
    build(ctx: ItemRuleContext): ItemRuleResult;
}

/** 「用不成会退还」的旧写法：新写法改成条件不满足就不能用，提示作者行为有变 */
const REFUND_NOTE =
    '旧写法在效果里判断失败后退还道具（canUseItemEffect 恒为真），已改为 canUseItemEffect 条件：不满足时不能使用，同样不消耗';

function tip(ctx: ItemRuleContext, suffix = '使用成功'): string {
    return `${ctx.name}${suffix}`;
}

function readVar(source: string, name: string): string | null {
    const match = source.match(new RegExp(`(?:var\\s+)?${name}\\s*=\\s*([^;]+);`));
    return match ? match[1]!.trim() : null;
}

/** 去掉单/双引号 */
function unquote(text: string): string {
    return text.replace(/^['"]|['"]$/g, '');
}

/**
 * 旧塔里成句的复杂道具效果。
 *
 * 这些片段没法靠「逐条语句」翻译（里面是函数、循环与提前返回），但它们的意图很明确，
 * 且在新词汇里都有对应写法，因此逐条改写为数据；只有真正需要命令式逻辑的（炸弹）
 * 指向塔作者脚本。每一条规则都附上行为变化的提示，不静默改变语义。
 */
const ITEM_RULES: ItemRule[] = [
    {
        name: '怪物手册',
        match: (ctx) => /core\.ui\.drawBook\s*\(/.test(ctx.effect),
        build: () => ({ useItemEffect: [{ type: 'openPanel', panel: 'monsterManual' }] }),
    },
    {
        name: '楼层传送器',
        match: (ctx) =>
            /core\.ui\.drawFly\s*\(/.test(ctx.effect) || /canFlyFrom/.test(ctx.condition),
        build: () => ({
            useItemEffect: [{ type: 'openPanel', panel: 'floorMap' }],
            canUseItemEffect: '(!flag:flyNearStair || nearStair()) && floor:canFlyFrom',
        }),
    },
    {
        name: '冰冻徽章',
        match: (ctx) => /getBlockId/.test(ctx.effect) && /'lava'/.test(ctx.effect),
        build: (ctx) => ({
            canUseItemEffect: "blockId(nextX(), nextY()) == 'lava'",
            useItemEffect: [
                { type: 'removeBlock', loc: ['nextX()', 'nextY()'] },
                { type: 'playSound', name: '打开界面' },
                { type: 'tip', text: tip(ctx) },
            ],
            notes: [REFUND_NOTE],
        }),
    },
    {
        name: '破墙镐',
        match: (ctx) =>
            /pickaxeFourDirections/.test(ctx.effect) || /var canBreak = function/.test(ctx.effect),
        build: (ctx) => ({
            canUseItemEffect: "blockAttr(nextX(), nextY(), 'canBreak')",
            useItemEffect: [
                { type: 'removeBlock', loc: ['nextX()', 'nextY()'] },
                { type: 'playSound', name: '破墙镐' },
                { type: 'tip', text: tip(ctx) },
            ],
            notes: [REFUND_NOTE],
        }),
    },
    {
        name: '破冰镐',
        match: (ctx) => /'ice'/.test(ctx.effect) || /'ice'/.test(ctx.condition),
        build: (ctx) => ({
            canUseItemEffect: "blockId(nextX(), nextY()) == 'ice'",
            useItemEffect: [
                { type: 'openDoor', loc: ['nextX()', 'nextY()'] },
                { type: 'tip', text: tip(ctx) },
            ],
        }),
    },
    {
        name: '大黄门钥匙',
        match: (ctx) => /searchBlock\(\s*['"]yellowDoor['"]\s*\)/.test(ctx.effect),
        build: (ctx) => ({
            canUseItemEffect: "blockCount('yellowDoor') > 0",
            useItemEffect: [
                { type: 'openDoor', filter: { id: 'yellowDoor' } },
                { type: 'tip', text: tip(ctx) },
            ],
            notes: [
                '旧写法逐个门插异步动作再 waitAsync，新写法的 openDoor 支持 filter 批量开门且同步完成',
            ],
        }),
    },
    {
        name: '炸弹',
        match: (ctx) => /bombList/.test(ctx.effect) || /var canBomb = function/.test(ctx.effect),
        build: () => ({
            canUseItemEffect:
                "isEnemy(blockId(nextX(), nextY())) && !enemyAttr(blockId(nextX(), nextY()), 'notBomb')",
            useItemEffect: { script: 'items/bomb' },
            script: 'items/bomb',
            notes: [
                '炸弹是命令式逻辑（扫怪、结算、多方向），已改为塔作者脚本：请自备 project/scripts/items/bomb.ts（示例塔已提供一份）',
            ],
        }),
    },
    {
        name: '中心对称飞行器',
        match: (ctx) => /core\.bigmap\.width\s*-\s*1\s*-\s*core\.getHeroLoc/.test(ctx.effect),
        build: (ctx) => ({
            canUseItemEffect:
                'blockId(mapWidth() - 1 - status:x, mapHeight() - 1 - status:y) == null',
            useItemEffect: [
                { type: 'playSound', name: 'centerFly.mp3' },
                {
                    type: 'changePos',
                    loc: ['mapWidth() - 1 - status:x', 'mapHeight() - 1 - status:y'],
                },
                { type: 'tip', text: tip(ctx) },
            ],
            notes: ['旧写法的 clearMap / drawHero 等重绘交给呈现层，数据里只保留位移'],
        }),
    },
    {
        name: '上楼器',
        match: (ctx) => /indexOf\(core\.status\.floorId\)\s*\+\s*1/.test(ctx.effect),
        build: (ctx) => ({
            canUseItemEffect:
                'floorIndex() < floorCount() - 1 && blockId(status:x, status:y, floorIdOffset(1)) == null',
            useItemEffect: [
                { type: 'changeFloor', floorId: ':after', loc: ['status:x', 'status:y'] },
                { type: 'tip', text: tip(ctx) },
            ],
        }),
    },
    {
        name: '下楼器',
        match: (ctx) => /indexOf\(core\.status\.floorId\)\s*-\s*1/.test(ctx.effect),
        build: (ctx) => ({
            canUseItemEffect:
                'floorIndex() > 0 && blockId(status:x, status:y, floorIdOffset(-1)) == null',
            useItemEffect: [
                { type: 'changeFloor', floorId: ':before', loc: ['status:x', 'status:y'] },
                { type: 'tip', text: tip(ctx) },
            ],
        }),
    },
    {
        name: '地震卷轴',
        match: (ctx) =>
            /removeBlockByIndexes/.test(ctx.effect) || /block\.event\.canBreak/.test(ctx.effect),
        build: (ctx) => ({
            canUseItemEffect: "blockCount('canBreak') > 0",
            useItemEffect: [
                { type: 'removeBlock', filter: { canBreak: true } },
                { type: 'playSound', name: '炸弹' },
                { type: 'tip', text: tip(ctx) },
            ],
        }),
    },
    {
        name: '跳跃靴',
        match: (ctx) => /jumpHero/.test(ctx.effect) && /nextX\(2\)/.test(ctx.effect),
        build: (ctx) => ({
            canUseItemEffect:
                'nextX(2) >= 0 && nextX(2) < mapWidth() && nextY(2) >= 0 && nextY(2) < mapHeight() && blockId(nextX(2), nextY(2)) == null',
            useItemEffect: [
                { type: 'playSound', name: '跳跃' },
                { type: 'jumpHero', loc: ['nextX(2)', 'nextY(2)'] },
            ],
            notes: [tip(ctx, '的位移由引擎完成，跳跃动画交给呈现层')],
        }),
    },
    {
        name: '技能开关',
        match: (ctx) => /skillValue/.test(ctx.effect) && /getFlag\('skill'/.test(ctx.effect),
        build: (ctx) => {
            const value = readVar(ctx.effect, 'skillValue');
            const need = readVar(ctx.effect, 'skillNeed');
            const name = readVar(ctx.effect, 'skillName');
            if (value == null || need == null || name == null) return {};
            const skillName = unquote(name);
            return {
                useItemEffect: [
                    {
                        type: 'if',
                        condition: `flag:skill != ${value}`,
                        true: [
                            {
                                type: 'if',
                                condition: `status:mana >= ${need}`,
                                true: [
                                    { type: 'playSound', name: '打开界面' },
                                    { type: 'setValue', name: 'flag:skill', value },
                                    {
                                        type: 'setValue',
                                        name: 'flag:skillName',
                                        value: `'${skillName}'`,
                                    },
                                ],
                                false: [
                                    { type: 'playSound', name: '操作失败' },
                                    { type: 'tip', text: '魔力不足，无法开启技能' },
                                ],
                            },
                        ],
                        false: [
                            { type: 'setValue', name: 'flag:skill', value: '0' },
                            { type: 'setValue', name: 'flag:skillName', value: "'无'" },
                        ],
                    },
                ],
            };
        },
    },
];

/** 按顺序尝试规则；没有匹配的规则时返回 null（交给逐条语句翻译） */
export function translateKnownItem(ctx: ItemRuleContext): ItemRuleResult | null {
    for (const rule of ITEM_RULES) {
        if (rule.match(ctx)) return rule.build(ctx);
    }
    return null;
}

/** 已注册的规则名（供测试与文档核对） */
export const ITEM_RULE_NAMES: readonly string[] = ITEM_RULES.map((rule) => rule.name);

////// 剧本动作里的旧 JS //////

/** 取出 `function(){...}` / `() => {...}` 的函数体；带返回值或认不出时返回 null */
export function readFunctionBody(src: string): string | null {
    const text = stripComments(src).trim();
    const match = text.match(/^(?:function\s*[\w$]*\s*\([^)]*\)|\(?[\w$,\s]*\)?\s*=>)\s*\{/);
    if (!match) return null;
    const bodyStart = text.indexOf('{', match[0].length - 1);
    const bodyEnd = text.lastIndexOf('}');
    if (bodyStart < 0 || bodyEnd <= bodyStart) return null;
    if (text.slice(bodyEnd + 1).replace(/[\s;()]/g, '') !== '') return null;
    return text.slice(bodyStart + 1, bodyEnd).trim();
}

/**
 * 把 `{ "type": "function", "function": "function(){ core.addItem('x'); }" }`
 * 翻译成等价的剧本动作列表。
 *
 * 新引擎不再 `eval` 剧本里的函数字符串，旧塔里这类写法必须逐条翻译；
 * 只认能静态判定的语句（与效果字段同一套规则），认不出就返回 null 交给人工。
 */
export function translateFunctionAction(value: unknown): unknown[] | null {
    if (typeof value !== 'object' || value === null) return null;
    const action = value as Record<string, unknown>;
    if (action.type !== 'function' || typeof action.function !== 'string') return null;
    const body = readFunctionBody(action.function);
    if (body == null) return null;
    const statements = splitStatements(stripComments(body));
    if (!statements || statements.length === 0) return null;
    const actions: unknown[] = [];
    for (const statement of statements) {
        const result = translateStatement(statement);
        if ('reason' in result) return null;
        actions.push(result.action);
    }
    return actions;
}

/** 动作列表里可能嵌套子动作的字段 */
const NESTED_ACTION_KEYS = ['true', 'false', 'actions', 'data', 'list'] as const;

/**
 * 递归翻译动作列表里的 `function` 动作（旧塔里 `useItemEvent` / 楼层事件常用）。
 *
 * 返回翻译后的新值；整棵树里没有可翻译项时返回 null。
 */
export function translateActionsDeep(value: unknown): unknown[] | null {
    if (!Array.isArray(value)) return null;
    let changed = false;
    const output: unknown[] = [];
    for (const item of value) {
        const translated = translateFunctionAction(item);
        if (translated) {
            output.push(...translated);
            changed = true;
            continue;
        }
        if (item != null && typeof item === 'object' && !Array.isArray(item)) {
            const action = { ...(item as Record<string, unknown>) };
            for (const key of NESTED_ACTION_KEYS) {
                const nested = translateActionsDeep(action[key]);
                if (nested) {
                    action[key] = nested;
                    changed = true;
                }
            }
            output.push(action);
            continue;
        }
        output.push(item);
    }
    return changed ? output : null;
}
