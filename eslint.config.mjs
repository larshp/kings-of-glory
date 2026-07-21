import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['**/dist/**', '**/node_modules/**'],
  },
  {
    files: ['packages/simulation/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'pg', 'react', 'react-dom', 'vite', 'ws'],
              message: 'Simulation rules must stay platform-independent.',
            },
          ],
        },
      ],
    },
  },
);
