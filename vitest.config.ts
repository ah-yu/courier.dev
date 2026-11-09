import { fileURLToPath } from "url";
import { defineConfig } from "vitest/config";

/**
 * The suite runs on `bun --bun vitest` (see `package.json`): Vitest is the runner, Bun
 * the runtime. That combination is deliberate — the server's tests import `bun:sqlite`
 * and start a real `Bun.serve`, so a Node runtime cannot run them; and Vitest is what
 * gives this repository statement, branch, function and line coverage (Bun's own
 * reporter has only the last two) plus Stryker's test runner for mutation surveys.
 *
 * `--bun` matters: without it Bun runs the Vitest CLI under Node, where `bun:sqlite`
 * does not exist.
 */

/**
 * Build output must never be collected as tests. The default `exclude` is resolved per
 * project root, which once let `packages/plugin/dist/*.test.js` (emitted by `tsc`) run as
 * a stale duplicate of the real test file and report a misleading pass/fail for code that
 * no longer exists. Tests live in `src/` only.
 */
const exclude = ["**/node_modules/**", "**/dist/**", "**/build/**", "**/target/**"];

export default defineConfig({
  test: {
    /**
     * Coverage is measured over `packages/*\/src` — the code under test — and nothing
     * else. The e2e suite's own harness (the Obsidian stub, `FakeVault`, the test server)
     * is the *instrument*, not the subject: its quality is asserted by
     * `packages/e2e/src/harness/stub-fidelity.test.ts`, and counting its lines would
     * reward writing more fake Obsidian instead of more real tests.
     *
     * It is **opt-in locally** (`bun run test:coverage`) because instrumenting every
     * project costs a couple of minutes — but `.github/workflows/ci.yml` runs the same
     * command as its own step, because a ratchet nothing executes is not a ratchet (the
     * engine drifted under its line floor over two weeks of feature work with everything
     * else green). The thresholds below are the floor the repository commits to: a module
     * that lands without tests moves its package's number down and fails.
     *
     * They are a **ratchet, not a target** — pinned at, or a point or two below, what each
     * package actually reaches, so ordinary churn does not fail and nothing is gained by
     * chasing a number. **Raise them when a package improves; never lower one to make a
     * change pass** — and if a package genuinely cannot hold its number, the commit says
     * which branch the drop came from and why that branch is not testable (see
     * `docs/mutation-testing.md` for the branches that are defensive by construction: the
     * floor is not the place to fight for them).
     */
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      // The e2e harness, `@courier/testing` and `@courier/build` are the instrument, not the
      // subject: their quality is asserted by `stub-fidelity.test.ts` (or, for the build
      // tooling, by running it), and counting their lines would reward writing more fake
      // Obsidian — or more build glue — instead of more real tests.
      exclude: [
        "**/*.test.ts",
        // Test-only fixtures are the instrument, not the subject — the same rule as the
        // e2e harness below. Counting the engine suite's fake adapter and API would let a
        // test file's growth mask a fall in the engine's own coverage.
        "**/*.test-helpers.ts",
        "**/*.d.ts",
        "packages/e2e/src/**",
        "packages/testing/src/**",
        "packages/build/src/**",
      ],
      reporter: ["text-summary", "json-summary"],
      reportsDirectory: "coverage",
      thresholds: {
        "packages/engine/src/**": { lines: 95, statements: 92, functions: 97, branches: 87 },
        "packages/server/src/**": { lines: 88, statements: 86, functions: 86, branches: 79 },
        "packages/plugin/src/**": { lines: 84, statements: 81, functions: 85, branches: 72 },
        "packages/cli/src/**": { lines: 86, statements: 84, functions: 86, branches: 77 },
        "packages/shared/src/**": { lines: 100, statements: 100, functions: 100, branches: 96 },
      },
    },
    projects: [
      {
        // Repository tooling: the workspace-scoped delete helper and the benchmark
        // reporter. A project of its own, so `bun run test` covers them, the
        // `agent-safety` gate can name one file, and coverage never counts them
        // (`include` above is `packages/*/src` only).
        root: ".",
        test: {
          include: ["scripts/**/*.test.ts"],
          exclude,
        },
      },
      {
        root: "packages/shared",
        test: {
          exclude,
        },
      },
      {
        root: "packages/engine",
        test: {
          exclude,
        },
      },
      {
        root: "packages/cli",
        test: {
          exclude,
        },
      },
      {
        root: "packages/plugin",
        test: {
          exclude,
          // The plugin creates its timers on `window`; Bun has none. See the file.
          setupFiles: ["../../scripts/vitest-window.ts"],
        },
        resolve: {
          alias: {
            "@": "/src",
            // The `obsidian` package ships types only, so a module that needs a value
            // from it (`Platform.isDesktop`) would not load outside the app. The plugin's
            // unit tests get the same stand-in the e2e project uses.
            obsidian: fileURLToPath(
              new URL("packages/e2e/src/harness/obsidian-stub.ts", import.meta.url),
            ),
          },
        },
      },
      {
        /**
         * Cross-stack end-to-end tests: real server (SQLite + `Bun.serve` + native
         * WebSocket) and the real plugin class, with `obsidian` aliased to a runtime stub
         * because the published package ships types only.
         *
         * Files run sequentially: each one boots a server on its own port and points
         * `process.env` at its own temp database, so parallel workers would race over
         * both.
         */
        root: "packages/e2e",
        test: {
          exclude,
          fileParallelism: false,
          // Generous: the opt-in Obsidian suite drives a real app over a CLI, where a
          // single round-trip is a process spawn.
          testTimeout: 120_000,
          hookTimeout: 300_000,
        },
        resolve: {
          alias: {
            obsidian: fileURLToPath(
              new URL("packages/e2e/src/harness/obsidian-stub.ts", import.meta.url),
            ),
          },
        },
      },
      {
        root: "packages/server",
        test: {
          exclude,
        },
        resolve: {
          alias: {
            "@": "/src",
          },
        },
      },
    ],
  },
});
