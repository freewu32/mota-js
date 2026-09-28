import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    {
        // 旧代码（绞杀者模式下逐步移除）与生成物不参与 lint
        ignores: [
            'node_modules/**',
            'dist/**',
            'libs/**',
            '_server/**',
            'project/**',
            'extensions/**',
            '_docs/**',
            'docs/**',
            '常用工具/**',
            '*.min.js',
            '*.min.ts',
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ['**/*.ts'],
        rules: {
            '@typescript-eslint/no-unused-vars': [
                'warn',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
            ],
            '@typescript-eslint/no-explicit-any': 'warn',
        },
    },
);
