import tseslint from 'typescript-eslint';
import stylistic from '@stylistic/eslint-plugin';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['node_modules/**', 'out/**', 'release/**', 'dist/**', 'resources/runtime/**'] },
  ...tseslint.configs.recommended,
  prettier,
  {
    plugins: { '@stylistic': stylistic },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/prefer-as-const': 'warn',
      '@stylistic/semi': ['warn', 'always'],
      '@stylistic/quotes': ['warn', 'single', { avoidEscape: true }],
      '@stylistic/comma-dangle': ['warn', 'never'],
      '@stylistic/no-trailing-spaces': 'warn',
      '@stylistic/eol-last': ['warn', 'always']
    }
  }
);
