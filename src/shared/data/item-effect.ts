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
