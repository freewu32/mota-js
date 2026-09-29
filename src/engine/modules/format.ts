/**
 * 数字格式化（旧 `utils.setTwoDigits` / `core.formatBigNumber`）。
 *
 * 单独成文件是为了让 `enemys.ts`（显伤文本）也能用，而不把 `ui.ts` 拖进来
 * 造成 `enemys -> ui -> control -> enemys` 的循环依赖。
 */

/** 旧 `core.setTwoDigits`：0-9 补前导零，其余原样 */
export function setTwoDigits(x: number | string): string {
    const n = parseInt(String(x), 10);
    return n >= 0 && n < 10 ? `0${x}` : String(x);
}

const BIG_NUMBER_UNITS = [
    { val: 1e4, suffix: 'w' },
    { val: 1e8, suffix: 'e' },
    { val: 1e12, suffix: 'z' },
    { val: 1e16, suffix: 'j' },
    { val: 1e20, suffix: 'g' },
];

/** 旧 `core.formatBigNumber`：大数用 w/e/z/j/g 后缀，溢出时转科学记数法 */
export function formatBigNumber(x: number | string, digits?: number | boolean): string {
    let total = digits === true ? 5 : (digits ?? 6); // 兼容旧版 onMap 传 true
    if (!total || total < 5) total = 6;
    let value = Math.trunc(parseFloat(String(x))); // 尝试识别为小数，然后向 0 取整
    if (!Number.isFinite(value)) return '???';
    if (Math.abs(value) > 1e20 * Math.pow(10, total - 2)) return value.toExponential(0);

    const sign = value < 0 ? '-' : '';
    if (sign) total--;
    value = Math.abs(value);
    if (value < Math.pow(10, total)) return sign + value;

    for (const unit of BIG_NUMBER_UNITS) {
        let text = (value / unit.val).toFixed(total).substring(0, total);
        if (!text.includes('.')) continue;
        text = text.substring(0, text[text.length - 2] === '.' ? text.length - 2 : text.length - 1);
        return sign + text + unit.suffix;
    }
    return sign + value.toExponential(0);
}

