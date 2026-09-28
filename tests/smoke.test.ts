import { describe, expect, test } from 'bun:test';

describe('工具链', () => {
    test('bun test 可运行', () => {
        expect(1 + 1).toBe(2);
    });
});
