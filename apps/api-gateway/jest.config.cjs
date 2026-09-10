/**
 * Jest configuration -- spec v5 §79.
 *
 * Two projects, because §79.1 orders the pipeline "lint/typecheck -> unit ->
 * build -> integration with ephemeral dependencies". Unit tests must run with
 * no Postgres, no Redis and no network; integration tests boot the real Nest
 * application against the docker-compose stack. Keeping them in one suite
 * would mean the fast gate could not run without infrastructure.
 *
 * ts-jest rather than a bundler transform: the DI graph depends on
 * `emitDecoratorMetadata`, which esbuild-based transforms drop.
 */
const base = {
  rootDir: __dirname,
  transform: {
    '^.+\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json', isolatedModules: false }],
    // jose 6 is pure ESM. Node 24 can `require()` it, but the Jest runtime
    // cannot, so it is down-levelled to CommonJS for tests only. The app
    // itself keeps loading the real ESM build.
    '^.+\.js$': [
      'ts-jest',
      {
        tsconfig: {
          allowJs: true,
          module: 'CommonJS',
          target: 'ES2023',
          esModuleInterop: true,
          isolatedModules: true,
        },
      },
    ],
  },
  // Everything under node_modules is left alone EXCEPT jose. Written as a
  // single negative lookahead anchored at the start, because pnpm nests the
  // real package under `.pnpm/<name>@<version>/node_modules/<name>` and a
  // `node_modules/(?!jose)` pattern matches at the inner segment.
  transformIgnorePatterns: ['^(?!.*[\\/]jose[\\/]).*[\\/]node_modules[\\/]'],
  moduleNameMapper: {
    // Workspace packages are published as ESM, which a CommonJS Jest runtime
    // cannot parse. Resolve them to their TypeScript source instead, so
    // ts-jest compiles them alongside the app and the tests exercise the same
    // code the build does.
    '^@oolix/ad-sdk-web$': '<rootDir>/../../packages/sdk-web/src/index.ts',
    '^@oolix/([^/]+)$': '<rootDir>/../../packages/$1/src/index.ts',
  },
  // Handles the app's NodeNext-style `.js` specifiers without rewriting the
  // identical specifiers inside third-party CommonJS. See the resolver.
  resolver: '<rootDir>/jest.resolver.cjs',
  testEnvironment: 'node',
  clearMocks: true,
};

module.exports = {
  // `maxWorkers` is a top-level option -- Jest ignores it inside a project.
  // These suites boot Nest against one Postgres and one Redis, so parallel
  // workers would share rate-limit windows and idempotency keys. The
  // `test:integration` script also passes --runInBand; this makes a bare
  // `jest` invocation behave the same way.
  maxWorkers: 1,
  projects: [
    {
      ...base,
      displayName: 'unit',
      testMatch: ['<rootDir>/src/**/*.spec.ts'],
    },
    {
      ...base,
      displayName: 'integration',
      testMatch: ['<rootDir>/test/**/*.int-spec.ts'],
      setupFiles: ['<rootDir>/test/setup-integration.ts'],
      testTimeout: 60_000,
    },
  ],
};
