/**
 * 值块与表达式求值。
 *
 * 迁移自旧 `libs/utils.js` 的 `replaceText` / `replaceValue` / `calValue`。
 * 旧实现把 `flag:x`、`status:hp` 之类的值块替换成 `core.getFlag('x', 0)` 等
 * 字符串，再交给 `eval` 执行——既能实现任意 JS，也就无法脱离全局 `core`。
 * 新实现改为「词法分析 + 递归下降求值」，只支持剧本需要的那部分语法，
 * 不执行任意 JS，也不依赖任何全局变量。
 *
 * 支持的值块（与旧版冒号缩写量一致）：
 * - 只读：`enemy:id:属性`、`blockId:x,y`、`blockNumber:x,y`、`blockCls:x,y`、`equip:n`
 * - 可读写：`status:属性`、`item:道具`、`buff:属性`、`flag:变量`、`switch:A—Z`、
 *   `temp:A—Z`、`global:名称`
 * - 新增：`value:名称`，读取全塔属性 `values`
 *
 * 前缀（`prefix`）用于 `switch:` 等按坐标取值的值块，形如 `MT1@3@4`；
 * 无楼层/坐标时旧实现回退为 `:f@x@y`。
 */
import type { HeroState } from '../types';
import { addItem, itemCount, removeItem } from './control';
import type { Block } from './maps';
import { getBuff, setBuff, type StatusName } from './status';

export class ValueSyntaxError extends Error {}

export interface ValueScope {
    flags: Record<string, unknown>;
    values: Record<string, unknown>;
    /** 跨存档的全局存储（`global:`），缺省时读为 0，写时自动创建 */
    globals?: Record<string, unknown>;
    hero: HeroState;
    /** 怪物数据（供 `enemy:id:属性` 读取） */
    enemys?: Record<string, unknown>;
    /** 值块前缀，决定独立开关等按点取值 */
    prefix?: string;
    /** 查询当前层某点的图块（blockId / blockNumber / blockCls） */
    getBlock?: (x: number, y: number) => Block | undefined;
    /** 宿主注入的函数，供条件/文本表达式调用（如 rand / rand2） */
    functions?: Record<string, (...args: unknown[]) => unknown>;
}

export const DEFAULT_PREFIX = ':f@x@y';

function effectivePrefix(scope: ValueScope, prefix?: string): string {
    return prefix ?? scope.prefix ?? DEFAULT_PREFIX;
}

/* ------------------------------------------------------------------ *
 * 词法分析
 * ------------------------------------------------------------------ */

type TraitName =
    | 'status'
    | 'item'
    | 'buff'
    | 'flag'
    | 'switch'
    | 'temp'
    | 'global'
    | 'value'
    | 'enemy'
    | 'blockId'
    | 'blockNumber'
    | 'blockCls'
    | 'equip';

interface TraitToken {
    kind: 'trait';
    name: TraitName;
    args: (string | number)[];
}

type Token =
    | { kind: 'number'; value: number }
    | { kind: 'string'; value: string }
    | { kind: 'ident'; name: string }
    | TraitToken
    | { kind: 'op'; op: string };

const NAME_START = /[A-Za-z_$\u4E00-\u9FCC\u3040-\u30FF\u2160-\u216B\u0391-\u03C9]/;
const NAME_CHAR = /[A-Za-z0-9_$\u4E00-\u9FCC\u3040-\u30FF\u2160-\u216B\u0391-\u03C9]/;
const TRAIT_RE =
    /^(status|item|buff|flag|switch|temp|global|value|enemy|blockId|blockNumber|blockCls|equip)[:：]/;

/** 从长到短匹配，避免 `===` 被拆成 `==` + `=` */
const OPERATORS = [
    '===',
    '!==',
    '**',
    '&&',
    '||',
    '==',
    '!=',
    '<=',
    '>=',
    '(',
    ')',
    '[',
    ']',
    ',',
    '.',
    '+',
    '-',
    '*',
    '/',
    '%',
    '<',
    '>',
    '!',
    '?',
    ':',
];

function readString(input: string, start: number): [string, number] {
    const quote = input[start];
    let i = start + 1;
    let value = '';
    while (i < input.length) {
        const c = input[i];
        if (c === '\\') {
            const next = input[i + 1];
            value += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
            i += 2;
            continue;
        }
        if (c === quote) return [value, i + 1];
        value += c;
        i += 1;
    }
    throw new ValueSyntaxError('字符串未闭合');
}

function readNumber(input: string, start: number): [number, number] {
    let i = start;
    while (i < input.length && /[0-9]/.test(input[i])) i += 1;
    if (input[i] === '.') {
        i += 1;
        while (i < input.length && /[0-9]/.test(input[i])) i += 1;
    }
    if (input[i] === 'e' || input[i] === 'E') {
        i += 1;
        if (input[i] === '+' || input[i] === '-') i += 1;
        while (i < input.length && /[0-9]/.test(input[i])) i += 1;
    }
    return [Number(input.slice(start, i)), i];
}

function scanTrait(kind: TraitName, input: string, start: number): [TraitToken, number] {
    let i = start;
    const readName = (): string => {
        const begin = i;
        while (i < input.length && NAME_CHAR.test(input[i])) i += 1;
        if (i === begin) throw new ValueSyntaxError(`${kind}: 缺少名称`);
        return input.slice(begin, i);
    };
    const readInt = (): number => {
        const begin = i;
        if (input[i] === '-') i += 1;
        while (i < input.length && /[0-9]/.test(input[i])) i += 1;
        const text = input.slice(begin, i);
        if (text === '' || text === '-') throw new ValueSyntaxError(`${kind}: 缺少数字`);
        return Number.parseInt(text, 10);
    };

    switch (kind) {
        case 'enemy': {
            const id = readName();
            if (input[i] !== ':' && input[i] !== '：' && input[i] !== '.') {
                throw new ValueSyntaxError('enemy: 缺少属性名');
            }
            i += 1;
            return [{ kind: 'trait', name: kind, args: [id, readName()] }, i];
        }
        case 'blockId':
        case 'blockNumber':
        case 'blockCls': {
            const x = readInt();
            if (input[i] !== ',' && input[i] !== '，') {
                throw new ValueSyntaxError(`${kind}: 坐标应为 x,y`);
            }
            i += 1;
            const y = readInt();
            return [{ kind: 'trait', name: kind, args: [x, y] }, i];
        }
        case 'equip': {
            const n = readInt();
            return [{ kind: 'trait', name: kind, args: [n] }, i];
        }
        default: {
            const name = readName();
            return [{ kind: 'trait', name: kind, args: [name] }, i];
        }
    }
}

export function tokenize(input: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    while (i < input.length) {
        const c = input[i];
        if (/\s/.test(c)) {
            i += 1;
            continue;
        }
        if (c === '"' || c === "'") {
            const [value, next] = readString(input, i);
            tokens.push({ kind: 'string', value });
            i = next;
            continue;
        }
        if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(input[i + 1] ?? ''))) {
            const [value, next] = readNumber(input, i);
            tokens.push({ kind: 'number', value });
            i = next;
            continue;
        }
        const rest = input.slice(i);
        const trait = TRAIT_RE.exec(rest);
        if (trait) {
            const [token, next] = scanTrait(trait[1] as TraitName, input, i + trait[0].length);
            tokens.push(token);
            i = next;
            continue;
        }
        if (NAME_START.test(c)) {
            const begin = i;
            while (i < input.length && NAME_CHAR.test(input[i])) i += 1;
            tokens.push({ kind: 'ident', name: input.slice(begin, i) });
            continue;
        }
        const op = OPERATORS.find((candidate) => rest.startsWith(candidate));
        if (op) {
            tokens.push({ kind: 'op', op });
            i += op.length;
            continue;
        }
        throw new ValueSyntaxError(`无法解析的字符：${c}`);
    }
    return tokens;
}

/* ------------------------------------------------------------------ *
 * 取值与写值
 * ------------------------------------------------------------------ */

function numeric(value: unknown, fallback = 0): number {
    const n = Number(value);
    return Number.isFinite(n) ? Math.floor(n) : fallback;
}

/** 读取单个值块 */
function readTraitValue(scope: ValueScope, token: TraitToken, prefix: string): unknown {
    const [a, b] = token.args;
    const hero = scope.hero as unknown as Record<string, unknown>;

    switch (token.name) {
        case 'status': {
            const name = String(a);
            if (name === 'x' || name === 'y' || name === 'direction') return hero[name];
            const value = hero[name];
            return value == null ? 0 : numeric(value);
        }
        case 'item':
            return itemCount(scope.hero, String(a));
        case 'buff':
            return getBuff(scope.flags, String(a) as StatusName);
        case 'flag':
            return scope.flags[String(a)] ?? 0;
        case 'switch':
            return scope.flags[`${prefix}@${String(a)}`] ?? 0;
        case 'temp':
            return scope.flags[`@temp@${String(a)}`] ?? 0;
        case 'global':
            return scope.globals?.[String(a)] ?? 0;
        case 'value':
            return scope.values[String(a)] ?? 0;
        case 'enemy': {
            const enemy = scope.enemys?.[String(a)] as Record<string, unknown> | undefined;
            if (!enemy) return undefined;
            return enemy[String(b)];
        }
        case 'blockId': {
            const block = scope.getBlock?.(Number(a), Number(b));
            return block ? block.event.id : null;
        }
        case 'blockNumber': {
            const block = scope.getBlock?.(Number(a), Number(b));
            return block ? block.id : null;
        }
        case 'blockCls': {
            const block = scope.getBlock?.(Number(a), Number(b));
            return block ? block.event.cls : null;
        }
        case 'equip':
            return scope.hero.equipment[Number(a)] ?? null;
    }
}

/** 值块的读写类别，写值时按此分派 */
function traitKind(name: string): TraitName | null {
    const normalized = name.replaceAll('：', ':');
    const index = normalized.indexOf(':');
    if (index < 0) return null;
    const kind = normalized.slice(0, index);
    if (TRAIT_RE.test(normalized.slice(0, index + 1))) return kind as TraitName;
    return null;
}

/** 写入某个可读写值块（`status:` / `item:` / `flag:` / `switch:` / `temp:` / `global:` / `buff:` / `value:`） */
export function writeValue(scope: ValueScope, name: string, value: unknown, prefix?: string): void {
    const normalized = name.replaceAll('：', ':');
    const kind = traitKind(normalized);
    const arg = kind ? normalized.slice(kind.length + 1) : '';
    const hero = scope.hero as unknown as Record<string, unknown>;
    const usePrefix = effectivePrefix(scope, prefix);

    switch (kind) {
        case 'status': {
            if (arg === 'x' || arg === 'y') hero[arg] = numeric(value);
            else if (arg === 'direction') scope.hero.direction = value as HeroState['direction'];
            else hero[arg] = value;
            return;
        }
        case 'buff':
            setBuff(scope.flags, arg as StatusName, Number(value) || 0);
            return;
        case 'item': {
            const count = itemCount(scope.hero, arg);
            const target = numeric(value);
            if (target > count) addItem(scope.hero, arg, target - count);
            else if (target < count) removeItem(scope.hero, arg, count - target);
            return;
        }
        case 'flag':
            scope.flags[arg] = value;
            return;
        case 'switch':
            scope.flags[`${usePrefix}@${arg}`] = value;
            return;
        case 'temp':
            scope.flags[`@temp@${arg}`] = value;
            return;
        case 'global':
            if (!scope.globals) scope.globals = {};
            scope.globals[arg] = value;
            return;
        case 'value':
            scope.values[arg] = value;
            return;
        default:
            return;
    }
}

/** 复合赋值，语义与旧 `_updateValueByOperator` 一致 */
export function applyOperator(
    operator: string | undefined,
    origin: unknown,
    value: unknown,
): unknown {
    switch (operator) {
        case '+=':
            return (origin as number) + (value as number);
        case '-=':
            return (origin as number) - (value as number);
        case '*=':
            return (origin as number) * (value as number);
        case '/=':
            return (origin as number) / (value as number);
        case '**=':
            return (origin as number) ** (value as number);
        case '//=':
            return Math.trunc((origin as number) / (value as number));
        case '%=':
            return (origin as number) % (value as number);
        case 'min=':
            return Math.min(Number(origin), Number(value));
        case 'max=':
            return Math.max(Number(origin), Number(value));
        default:
            return value;
    }
}

/* ------------------------------------------------------------------ *
 * 表达式求值
 * ------------------------------------------------------------------ */

function toNumber(value: unknown): number {
    if (typeof value === 'number') return value;
    if (value == null) return 0;
    if (typeof value === 'boolean') return value ? 1 : 0;
    const n = Number(value);
    return Number.isNaN(n) ? 0 : n;
}

export function truthy(value: unknown): boolean {
    if (typeof value === 'string') return value.length > 0;
    return Boolean(value);
}

function looseEquals(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a == null || b == null) return false;
    if (typeof a === 'boolean') return looseEquals(toNumber(a), b);
    if (typeof b === 'boolean') return looseEquals(a, toNumber(b));
    if (typeof a === 'number' && typeof b === 'string') return a === Number(b);
    if (typeof a === 'string' && typeof b === 'number') return Number(a) === b;
    return false;
}

function compare(a: unknown, b: unknown): number {
    if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
    const x = toNumber(a);
    const y = toNumber(b);
    return x < y ? -1 : x > y ? 1 : 0;
}

function getMember(target: unknown, key: unknown): unknown {
    if (target == null) throw new ValueSyntaxError('无法读取 null/undefined 的成员');
    return (target as Record<string, unknown>)[String(key)];
}

type HostFunction = (...args: unknown[]) => unknown;

class Evaluator {
    private pos = 0;

    constructor(
        private readonly tokens: Token[],
        private readonly scope: ValueScope,
        private readonly prefix: string,
    ) {}

    evaluate(): unknown {
        const value = this.parseTernary();
        if (this.pos < this.tokens.length) throw new ValueSyntaxError('表达式末尾有多余内容');
        return value;
    }

    private peek(): Token | undefined {
        return this.tokens[this.pos];
    }

    private eatOp(op: string): boolean {
        const token = this.peek();
        if (token && token.kind === 'op' && token.op === op) {
            this.pos += 1;
            return true;
        }
        return false;
    }

    private expectOp(op: string): void {
        if (!this.eatOp(op)) throw new ValueSyntaxError(`缺少 "${op}"`);
    }

    private parseTernary(): unknown {
        const condition = this.parseBinary(0);
        if (this.eatOp('?')) {
            const whenTrue = this.parseTernary();
            this.expectOp(':');
            const whenFalse = this.parseTernary();
            return truthy(condition) ? whenTrue : whenFalse;
        }
        return condition;
    }

    /** 二元运算的优先级爬升：层级越高绑定越紧 */
    private static readonly PRECEDENCE: Record<string, number> = {
        '||': 1,
        '&&': 2,
        '==': 3,
        '!=': 3,
        '===': 3,
        '!==': 3,
        '<': 4,
        '<=': 4,
        '>': 4,
        '>=': 4,
        '+': 5,
        '-': 5,
        '*': 6,
        '/': 6,
        '%': 6,
        '**': 7,
    };

    private parseBinary(minPrecedence: number): unknown {
        let left = this.parseUnary();
        for (;;) {
            const token = this.peek();
            if (!token || token.kind !== 'op') break;
            const precedence = Evaluator.PRECEDENCE[token.op];
            if (precedence == null || precedence < minPrecedence) break;
            this.pos += 1;
            // `**` 右结合，其余左结合
            const nextMin = token.op === '**' ? precedence : precedence + 1;
            const right = this.parseBinary(nextMin);
            left = this.applyBinary(token.op, left, right);
        }
        return left;
    }

    private applyBinary(op: string, left: unknown, right: unknown): unknown {
        switch (op) {
            case '||':
                return truthy(left) ? left : right;
            case '&&':
                return truthy(left) ? right : left;
            case '==':
                return looseEquals(left, right);
            case '!=':
                return !looseEquals(left, right);
            case '===':
                return left === right;
            case '!==':
                return left !== right;
            case '<':
                return compare(left, right) < 0;
            case '<=':
                return compare(left, right) <= 0;
            case '>':
                return compare(left, right) > 0;
            case '>=':
                return compare(left, right) >= 0;
            case '+':
                if (typeof left === 'string' || typeof right === 'string') {
                    return `${left as string}${right as string}`;
                }
                return toNumber(left) + toNumber(right);
            case '-':
                return toNumber(left) - toNumber(right);
            case '*':
                return toNumber(left) * toNumber(right);
            case '/':
                return toNumber(left) / toNumber(right);
            case '%':
                return toNumber(left) % toNumber(right);
            case '**':
                return toNumber(left) ** toNumber(right);
            default:
                throw new ValueSyntaxError(`不支持的运算符：${op}`);
        }
    }

    private parseUnary(): unknown {
        if (this.eatOp('!')) return !truthy(this.parseUnary());
        if (this.eatOp('-')) return -toNumber(this.parseUnary());
        if (this.eatOp('+')) return toNumber(this.parseUnary());
        return this.parsePostfix();
    }

    private parsePostfix(): unknown {
        let value = this.parsePrimary();
        for (;;) {
            if (this.eatOp('(')) {
                const args = this.parseArguments();
                if (typeof value !== 'function') throw new ValueSyntaxError('尝试调用非函数');
                value = (value as HostFunction)(...args);
                continue;
            }
            if (this.eatOp('.')) {
                const token = this.peek();
                if (!token || token.kind !== 'ident') throw new ValueSyntaxError('缺少属性名');
                this.pos += 1;
                value = getMember(value, token.name);
                continue;
            }
            if (this.eatOp('[')) {
                const key = this.parseTernary();
                this.expectOp(']');
                value = getMember(value, key);
                continue;
            }
            break;
        }
        return value;
    }

    private parseArguments(): unknown[] {
        const args: unknown[] = [];
        if (this.eatOp(')')) return args;
        for (;;) {
            args.push(this.parseTernary());
            if (this.eatOp(',')) continue;
            this.expectOp(')');
            return args;
        }
    }

    private parsePrimary(): unknown {
        const token = this.peek();
        if (!token) throw new ValueSyntaxError('表达式不完整');
        switch (token.kind) {
            case 'number':
                this.pos += 1;
                return token.value;
            case 'string':
                this.pos += 1;
                return token.value;
            case 'trait':
                this.pos += 1;
                return readTraitValue(this.scope, token, this.prefix);
            case 'ident': {
                this.pos += 1;
                switch (token.name) {
                    case 'true':
                        return true;
                    case 'false':
                        return false;
                    case 'null':
                        return null;
                    case 'undefined':
                        return undefined;
                    case 'Math':
                        return Math;
                    default:
                        return this.resolveIdentifier(token.name);
                }
            }
            case 'op':
                if (token.op === '(') {
                    this.pos += 1;
                    const value = this.parseTernary();
                    this.expectOp(')');
                    return value;
                }
                break;
        }
        throw new ValueSyntaxError(`无法解析的记号：${JSON.stringify(token)}`);
    }

    /** 标识符：仅支持宿主注入的函数（如 rand / rand2） */
    private resolveIdentifier(name: string): unknown {
        const fn = this.scope.functions?.[name];
        if (fn) return fn;
        throw new ValueSyntaxError(`未知标识符：${name}`);
    }
}

/** 求值一个表达式；失败抛出 ValueSyntaxError */
export function evaluateValue(expr: unknown, scope: ValueScope, prefix?: string): unknown {
    if (typeof expr === 'number' || typeof expr === 'boolean') return expr;
    if (expr == null) return expr;
    if (typeof expr !== 'string') return expr;
    const text = expr.trim();
    if (text === '') return undefined;
    const evaluator = new Evaluator(tokenize(text), scope, effectivePrefix(scope, prefix));
    return evaluator.evaluate();
}

/** 求值为条件（JS 真值语义）；表达式非法时记录错误并返回 false */
export function evaluateCondition(expr: unknown, scope: ValueScope, prefix?: string): boolean {
    try {
        return truthy(evaluateValue(expr, scope, prefix));
    } catch (error) {
        console.error('条件表达式求值失败：', expr, error);
        return false;
    }
}

/** 把文本中的 `${表达式}` 替换为求值结果；null / undefined 视为空串 */
export function replaceText(text: unknown, scope: ValueScope, prefix?: string): string {
    if (typeof text !== 'string') return text == null ? '' : String(text);
    let result = '';
    let i = 0;
    while (i < text.length) {
        const start = text.indexOf('${', i);
        if (start < 0) {
            result += text.slice(i);
            break;
        }
        result += text.slice(i, start);
        let depth = 0;
        let end = start + 1;
        for (; end < text.length; end += 1) {
            if (text[end] === '{') depth += 1;
            else if (text[end] === '}') {
                depth -= 1;
                if (depth === 0) break;
            }
        }
        if (depth !== 0) {
            // 花括号不配对，按原样保留剩余文本
            result += text.slice(start);
            break;
        }
        const expr = text.slice(start + 2, end);
        let value: unknown;
        try {
            value = evaluateValue(expr, scope, prefix);
        } catch (error) {
            console.error('文本表达式求值失败：', expr, error);
            value = '';
        }
        result += value == null ? '' : String(value);
        i = end + 1;
    }
    return result;
}
