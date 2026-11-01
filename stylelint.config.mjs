/**
 * Obsidian's own Stylelint config, over the plugin's stylesheet.
 *
 * The community directory scans a release's `styles.css` the same way the automatic review
 * lints its source, and this is the config that produces those findings. Running it here
 * means a stylesheet problem shows up in CI rather than on the plugin's scorecard.
 *
 * Only the plugin's sheet is in scope: `@courier/server` and the docs carry no plugin CSS.
 */
export default {
  extends: ["stylelint-config-obsidianmd"],
  overrides: [
    {
      files: ["packages/plugin/styles.css"],
    },
  ],
};
