import type { Linter } from "eslint";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

/**
 * The community directory's scanner, reproduced for CI.
 *
 * The directory reviews the whole repository with `eslint-plugin-obsidianmd` and a
 * **fixed** ignore list; it does not read this repository's config. A monorepo
 * therefore cannot opt out of that scan, and a non-plugin package can fail the plugin's
 * review — which is exactly what this mirror is for.
 *
 * The directory reports only a known set of Obsidian rules as **Error** (traced from
 * its reviews); everything else it lists, including the typescript-eslint and
 * dependency findings, is a **Warning** and does not fail the review. This config
 * reproduces that split: every rule is a warning except the error set below, so
 * `eslint` exits non-zero exactly when the directory would fail. `bun run lint:review`
 * runs it locally and `bun run verify` runs it as the `review` gate.
 *
 * It runs over the **published** packages only — `packages/plugin`, `packages/engine` and
 * `packages/shared` — because that is exactly the tree the directory scans: the plugin is
 * published from a generated repository that holds nothing else
 * (see `scripts/mirror-plugin.ts`). Scanning the server, the CLI and the suites here would
 * report findings against code the directory never sees, and that cannot be made to
 * satisfy Obsidian's plugin rules.
 *
 * This file is not part of the published tree, so it is not scanned; it stays in
 * `tsconfig.scripts.json` for the type-aware rules to resolve it.
 *
 * The gate currently fails on **errors** only, which is what the directory rejects a
 * release for. `--max-warnings 0` is the target, and it is one line away — the remaining
 * findings are listed in the `review` gate's output rather than hidden.
 *
 * Two things must stay in step with the directory:
 *
 * - the ignore list below (the directory's fixed list, applied by path segment);
 * - the error set (`DIRECTORY_ERROR_RULES`), and the rule set (`obsidianmd.configs
 *   .recommended`, pinned in package.json).
 *
 * See docs/release.md for the review flow and where the list came from.
 */

/** The directory's fixed ignore list, matched at any depth. */
const DIRECTORY_IGNORES: string[] = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/pkg/**",
  "**/test-vault/**",
  "**/.pnpm-store/**",
  "**/.obsidian/**",
  "**/esbuild.config.mjs",
  "**/version-bump.mjs",
  "**/automation/**",
  "**/*.test.*",
  "**/*.tests.*",
  "**/*.spec.*",
  "**/*.specs.*",
  "**/test/**",
  "**/tests/**",
  "**/__tests__/**",
  "**/testUtils/**",
  "**/e2e-tests/**",
  "**/mocks/**",
  "**/__mocks__/**",
  "**/*.cjs",
  "**/*.mjs",
  "**/*.cts",
  "**/*.mts",
  "**/vite/**",
  "**/scripts/**",
  "**/docs/**",
  "**/i18n/**",
  "**/i18next/**",
  "**/locale/**",
  "**/locales/**",
  "**/translations/**",
  "**/l10n/**",
  /*
   * This checkout's local, gitignored artifacts. The directory's scan never sees
   * them (a fresh clone has no dev vaults, coverage, sibling worktrees or a
   * development database), but scanning them locally exhausts the heap and lints
   * other branches' code — so they are ignored here, not in the directory's list.
   */
  ".agents/**",
  ".e2e-vaults/**",
  ".courier-dev/**",
  ".bun-cache/**",
  "coverage/**",
  "reports/**",
  "vault_a*/**",
  "vault_b*/**",
  "packages/server/data/**",
];

/**
 * The rules the directory reports as Error. Its "no-static-styles-assignment" error
 * (2026-10) is the one that failed a release here; the rest are the error-severity
 * rules of the same rule set, kept so the mirror cannot be lulled by a downgraded
 * default.
 */
const DIRECTORY_ERROR_RULES = new Set<string>([
  "obsidianmd/detach-leaves",
  "obsidianmd/no-forbidden-elements",
  "obsidianmd/no-plugin-as-component",
  "obsidianmd/no-sample-code",
  "obsidianmd/no-static-styles-assignment",
  "obsidianmd/no-unsupported-api",
  "obsidianmd/no-view-references-in-plugin",
  "obsidianmd/platform",
  "obsidianmd/regex-lookbehind",
  "obsidianmd/sample-names",
  "obsidianmd/settings-tab/no-manual-html-headings",
  "obsidianmd/settings-tab/no-problematic-settings-headings",
]);

/** A rule's configured severity, whether it is a string or `[severity, ...options]`. */
function severityOf(rule: Linter.RuleEntry): Linter.RuleSeverity {
  return Array.isArray(rule) ? rule[0] : rule;
}

/** The same rule at a new severity, keeping its options. */
function withSeverity(rule: Linter.RuleEntry, severity: Linter.RuleSeverity): Linter.RuleEntry {
  return [severity, ...(Array.isArray(rule) ? rule.slice(1) : [])];
}

/** Downgrade every error the directory only warns about, and keep its error set. */
function withDirectorySeverities(config: Linter.Config): Linter.Config {
  if (!config.rules) return config;
  const rules: Linter.RulesRecord = {};
  for (const [name, rule] of Object.entries(config.rules)) {
    const severity = severityOf(rule);
    const isError = severity === "error" || severity === 2;
    rules[name] = isError && !DIRECTORY_ERROR_RULES.has(name) ? withSeverity(rule, "warn") : rule;
  }
  return { ...config, rules };
}

export default defineConfig([
  ...obsidianmd.configs.recommended.map(withDirectorySeverities),
  {
    languageOptions: {
      parserOptions: {
        // Type-checked rules need the nearest tsconfig for each file; the service
        // resolves one per package in the workspace. These three files are not in a
        // package project and are scanned anyway, so name them explicitly.
        projectService: {
          allowDefaultProject: [
            "eslint.config.ts",
            "vitest.config.ts",
            "packages/server/drizzle.config.ts",
          ],
        },
      },
    },
  },
  {
    // `DataAdapter.appendBinary` arrived in Obsidian 1.12.3; this file feature-detects
    // it and falls back to one write, so the rule cannot see the guard. Keep the rule
    // an error everywhere else.
    files: ["packages/plugin/src/unified/adapter.ts"],
    rules: { "obsidianmd/no-unsupported-api": "warn" },
  },
  { ignores: DIRECTORY_IGNORES },
]);
