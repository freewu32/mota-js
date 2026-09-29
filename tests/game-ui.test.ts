import { describe, expect, test } from 'bun:test';
import { DialogController, type RichNode } from '../src/engine/modules/ui';
import { resolveSoundName } from '../src/game/audio';
import { clamp01, damageMotion, pointAt } from '../src/game/fx-math';
import {
    SKIN_GRID,
    SKIN_SIZE,
    WINDOW_SKIN_PATCHES,
    buildWindowSkinDataUrl,
    isWindowSkin,
} from '../src/game/skin';
import {
    $dialog,
    $tip,
    createSignalDialogView,
    dialogConfirm,
    dialogPick,
    dialogSubmit,
} from '../src/ui/dialog';
import {
    closePanel,
    openPanel,
    setStatus,
    togglePanel,
    $panel,
    $revision,
    bumpRevision,
    $status,
} from '../src/ui/store';
import { parseTheme, skinDeclarations, themeVars } from '../src/ui/theme';

describe('src/ui 对话框（signal 视图）', () => {
    function makeController(charInterval = 0): DialogController {
        return new DialogController(createSignalDialogView(), { charInterval });
    }

    test('文本 → 选择 → 确认 → 输入 各自写进 signal 并回调', () => {
        const dialog = makeController();
        let advanced = false;
        dialog.text('你好\n世界', { type: 'text' }, () => {
            advanced = true;
        });
        expect($dialog.value.visible).toBe(true);
        expect($dialog.value.kind).toBe('text');
        expect(
            $dialog.value.nodes.map((node: RichNode) => (node.type === 'text' ? node.text : '')),
        ).toEqual(['你好', '', '世界']);

        dialog.advance();
        expect(advanced).toBe(true);

        const picks: (number | null)[] = [];
        dialog.choices(
            '选一个',
            [{ text: 'A' }, { text: 'B', _disabled: true }],
            { type: 'choices' },
            (index) => void picks.push(index),
        );
        expect($dialog.value.kind).toBe('choices');
        expect($dialog.value.choices.map((one) => one.disabled)).toEqual([false, true]);
        dialogPick(1);
        expect(picks).toEqual([null]); // 禁选项传 null

        const answers: (boolean | null)[] = [];
        dialog.confirm('确定吗', { type: 'confirm' }, (ok) => void answers.push(ok));
        expect($dialog.value.kind).toBe('confirm');
        dialogConfirm(true);
        expect(answers).toEqual([true]);

        const values: string[] = [];
        dialog.input('名字', true, (text) => void values.push(text));
        expect($dialog.value.inputType).toBe('text');
        dialogSubmit('勇者');
        expect(values).toEqual(['勇者']);
    });

    test('打字机按时间推进，advance 立即补全', () => {
        let now = 0;
        const dialog = new DialogController(createSignalDialogView(), {
            charInterval: 10,
            timers: {
                now: () => now,
                setTimeout: () => 0,
                clearTimeout: () => {},
            },
        });
        const nodes = (): RichNode[] => [...$dialog.value.nodes];
        dialog.text('abcd', { type: 'text' }, () => {});
        expect(nodes().length).toBe(0); // 还没到第一个字
        now = 25;
        dialog.tick(now);
        expect(nodes().length).toBeGreaterThan(0);
        now = 100;
        dialog.tick(now);
        dialog.advance();
        expect($dialog.value.visible).toBe(false);
    });

    test('tip 写进 $tip，hideTip 清掉', () => {
        const dialog = makeController();
        dialog.tip('无法飞往…', 'fly');
        expect($tip.value?.icon).toBe('fly');
        $tip.value = null;
        expect($tip.value).toBeNull();
    });
});

describe('src/ui 主题', () => {
    test('parseTheme 容错解析，变量名补 --mota- 前缀', () => {
        const theme = parseTheme({ id: 't', name: '测试', vars: { title: '#fff', '--x': '1' }, skin: 'a.png', skinSlice: 8 });
        expect(theme.id).toBe('t');
        expect(theme.vars['--mota-title']).toBe('#fff');
        expect(theme.vars['--x']).toBe('1');
        expect(theme.skin).toBe('a.png');
        expect(theme.skinSlice).toBe(8);
        expect(parseTheme(null).id).toBe('default');
        expect(parseTheme('nope').id).toBe('default');
    });

    test('themeVars 合并默认令牌；skin 决定九宫格变量与声明', () => {
        const vars = themeVars({ id: 'a', name: 'a', vars: {}, skin: 'win.png', skinSlice: 16 });
        expect(vars['--mota-skin']).toBe('url("win.png")');
        expect(vars['--mota-skin-slice']).toBe('16');
        expect(vars['--mota-skin-width']).toBe('16px');
        expect(vars['--mota-text']).toBeDefined();
        expect(skinDeclarations({ id: 'a', name: 'a', vars: {}, skin: 'win.png' })).toMatchObject({
            'border-image-source': 'url("win.png")',
        });
        expect(skinDeclarations(null)).toEqual({});
    });
});

describe('src/ui store', () => {
    function statusView() {
        return {
            slots: { hp: '10' },
            visibility: { slots: [], keys: false, pzf: false, debuff: false },
            keys: [],
            tools: [],
            debuffs: [],
        } as never;
    }

    test('状态栏内容不变时不写 signal', () => {
        setStatus(null);
        setStatus(statusView());
        const first = $status.value;
        setStatus(statusView());
        expect($status.value).toBe(first);
    });

    test('面板开关与 revision', () => {
        openPanel('items', { from: 'test' });
        expect($panel.value).toEqual({ name: 'items', data: { from: 'test' } });
        togglePanel('items');
        expect($panel.value).toBeNull();
        const before = $revision.value;
        bumpRevision();
        expect($revision.value).toBe(before + 1);
        closePanel();
        expect($panel.value).toBeNull();
    });
});

describe('音频别名解析', () => {
    test('别名优先、扩展名直通、其余忽略', () => {
        expect(resolveSoundName({ 操作失败: 'error.mp3' }, '操作失败')).toBe('error.mp3');
        expect(resolveSoundName({}, 'attack.mp3')).toBe('attack.mp3');
        expect(resolveSoundName(undefined, 'BGM.MP3')).toBe('BGM.MP3');
        expect(resolveSoundName({}, '操作失败')).toBeNull();
        expect(resolveSoundName({}, '')).toBeNull();
    });
});

describe('窗口皮肤重切（RM 布局 → 标准九宫格）', () => {
    test('切片位置与顺序', () => {
        expect(SKIN_GRID).toBe(16);
        expect(SKIN_SIZE).toBe(48);
        expect(WINDOW_SKIN_PATCHES).toHaveLength(9);
        expect(WINDOW_SKIN_PATCHES[0]).toEqual({ dst: [0, 0], src: [128, 0] });
        expect(WINDOW_SKIN_PATCHES[2]).toEqual({ dst: [2, 0], src: [176, 0] });
        expect(WINDOW_SKIN_PATCHES[4]).toEqual({ dst: [1, 1], src: [0, 0] });
        expect(WINDOW_SKIN_PATCHES[8]).toEqual({ dst: [2, 2], src: [176, 48] });
    });

    test('isWindowSkin 只认 RM 皮肤名', () => {
        expect(isWindowSkin('/project/images/winskin.png')).toBe(true);
        expect(isWindowSkin('winskin.png')).toBe(true);
        expect(isWindowSkin('/x/skin.png')).toBe(false);
    });

    test('无 DOM 环境返回 null（不抛错）', async () => {
        expect(await buildWindowSkinDataUrl('/project/images/winskin.png')).toBeNull();
    });
});

describe('特效数学', () => {
    test('pointAt 端点与弧顶', () => {
        const from = { x: 0, y: 0 };
        const to = { x: 10, y: 0 };
        expect(pointAt(0, from, to)).toEqual({ x: 0, y: 0 });
        expect(pointAt(1, from, to)).toEqual({ x: 10, y: 0 });
        const mid = pointAt(0.5, from, to, 1);
        expect(mid.x).toBeCloseTo(5, 5);
        expect(mid.y).toBeCloseTo(-1, 5);
    });

    test('damageMotion 上浮后淡出，clamp01 夹紧', () => {
        expect(damageMotion(0)).toEqual({ offsetY: -0, alpha: 1 });
        expect(damageMotion(1).alpha).toBeCloseTo(0, 5);
        expect(damageMotion(0.5).offsetY).toBeLessThan(0);
        expect(clamp01(-3)).toBe(0);
        expect(clamp01(3)).toBe(1);
    });
});
