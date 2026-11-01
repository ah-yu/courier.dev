/**
 * The renderer's `window`, for the suites that run plugin code outside Obsidian.
 *
 * The plugin creates its timers on `window` — that is the shape Obsidian's plugin guidelines
 * ask for, and it is what keeps them off the bare globals — but Bun, where these suites run,
 * has no `window` at all. Defining it as the global object is what a renderer is: the e2e
 * project gets the same thing from the Obsidian stub, and this file covers the plugin's own
 * unit tests.
 *
 * Lives outside `packages/` on purpose: it is test scaffolding, not shipped source.
 */
if (typeof (globalThis as { window?: unknown }).window === "undefined") {
  (globalThis as { window?: unknown }).window = globalThis;
}
