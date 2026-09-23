// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      'partner/agent/**',
      'docs/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // §78.1 / §82: PII must never reach logs. Bare console is banned in
      // service code; use the structured logger from @oolix/observability.
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Tests, scripts, seeds -- and operator CLIs, whose entire output contract
    // is stdout. The rule exists to keep PII out of service logs (§78.1,
    // §82); a command that prints a key id to the person who just ran it is
    // not what it is guarding against.
    files: [
      '**/*.test.ts',
      '**/*.spec.ts',
      '**/scripts/**',
      '**/seed/**',
      '**/*-cli.ts',
      // Container entrypoints and deployment tooling. Their output contract IS
      // stdout -- an operator reading `docker logs` is the audience, and the
      // structured logger they would otherwise use does not exist inside an
      // alpine container running one script.
      'oolix/infra/**/*.mjs',
    ],
    rules: { 'no-console': 'off' },
  },
);
