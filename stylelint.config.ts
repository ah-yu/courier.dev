/**
 * Obsidian's own Stylelint config, over the plugin's stylesheet.
 *
 * The community directory scans a release's `styles.css` the same way the automatic review
 * lints its source, and this is the config that produces those findings. Running it here
 * means a stylesheet problem shows up in CI rather than on the plugin's scorecard.
 *
 * There is no `overrides` block: `bun run lint:review` names the one sheet this repository
 * has, so the config only has to say which rules apply.
 */
export default {
  extends: ["stylelint-config-obsidianmd"],
};
