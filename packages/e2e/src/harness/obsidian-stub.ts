/**
 * Minimal runtime stand-in for the `obsidian` package.
 *
 * The real `obsidian` npm package ships **types only** — at runtime the module
 * is provided by the Obsidian app. That is why `buildActions()` in
 * `packages/plugin/src/main.ts` has historically been untestable: importing the
 * plugin pulls in `obsidian`, which does not resolve outside the app.
 *
 * The e2e Vitest project aliases `obsidian` to this file, so the *real* plugin
 * class can be constructed and driven by a test. Every DOM-ish API is a chainable
 * no-op, but the interactive components **record their callbacks** so tests can
 * drive a real dialog (`modalTexts` / `clickModalButton`) without a renderer.
 * `requestUrl` is deliberately not implemented here: tests install a handler
 * with {@link setRequestUrlHandler} that forwards to the real server.
 */

// ── Fake DOM ──

// ── The renderer's `window` ──
//
// Bun has no `window`, and the plugin's platform (`packages/plugin/src/platform.ts`) is
// written for the one runtime the plugin really runs in. Defining the global here, where
// the suite already stands in for the app, keeps plugin source truthful instead of
// teaching it to branch on a runtime it never sees. Engine suites never import this file,
// so the "the engine needs no window" property that L1 proves stays unweakened.
if (typeof (globalThis as { window?: unknown }).window === "undefined") {
  (globalThis as { window?: unknown }).window = globalThis;
}

/**
 * Chainable stand-in for Obsidian's DOM element extensions
 * (`createEl`/`createDiv`/`empty`/`setText`…). Children are recorded so a test
 * can reach the `Setting` rows a modal built on this element.
 */
export interface FakeEl {
  tagName: string;
  text: string;
  children: FakeEl[];
  /** The element this one hangs off, or null at the root — what `detach()` needs. */
  parent: FakeEl | null;
  /** Objects created *on* this element — `Setting` rows in practice. */
  attached: unknown[];
  /** CSS classes this element carries, so tests can find rendered rows. */
  classes: string[];
  /** The icon id a plugin set with {@link setIcon}; real Obsidian renders an SVG instead. */
  icon?: string;
  /** Listeners recorded per event type — a test drives the ones it needs. */
  listeners: Record<string, Array<(event: unknown) => void>>;
  /**
   * Test driver: fire the element's `click` listeners.
   *
   * The listeners get a minimal event, because a real click always has one and a handler
   * is entitled to call `preventDefault()` — an element that called them with nothing ran
   * handlers the app never runs that way.
   */
  click: () => void;
  style: Record<string, string>;
  /**
   * Assign several style properties at once — Obsidian's `setCssStyles`.
   *
   * The real method writes each entry onto the element's style, so the fake records the
   * same properties: a plugin that moved off `style.cssText` must remain testable, and
   * an element that threw here would take a branch the app never takes.
   */
  setCssStyles: (styles: Partial<CSSStyleDeclaration>) => void;
  /** Set CSS custom properties — Obsidian's `setCssProps`. */
  setCssProps: (props: Record<string, string>) => void;
  /**
   * The element's scroll offset, like the real DOM property.
   *
   * `empty()` puts it back to 0, as a real scroller does when its content is removed: the
   * settings page's `containerEl` **is** its scroll pane, so a rebuild that empties it
   * loses the position the user had scrolled to.
   */
  scrollTop: number;
  empty: () => FakeEl;
  createEl: (tag: string, options?: { text?: string; cls?: string }) => FakeEl;
  createDiv: (options?: { text?: string; cls?: string }) => FakeEl;
  createSpan: (options?: { text?: string; cls?: string }) => FakeEl;
  setText: (text: string) => FakeEl;
  addClass: (cls: string) => FakeEl;
  removeClass: (cls: string) => FakeEl;
  toggleClass: (cls: string) => FakeEl;
  appendChild: (child: FakeEl) => FakeEl;
  /**
   * Insert `node` before `reference` (Obsidian's `insertBefore`).
   *
   * Modelled, not stubbed: a plugin that puts its own control *before* an element the app
   * rendered — the action a file-explorer row places ahead of its extension tag — would
   * otherwise silently append instead, and the test would assert the wrong order.
   */
  insertBefore: (node: FakeEl, reference: FakeEl) => FakeEl;
  /**
   * Attributes, recorded rather than dropped.
   *
   * A view or a dropdown sets `aria-label` / `data-tooltip-position` on the element it owns;
   * a no-op here would let a test assert a name the app never receives. Only the attributes a
   * plugin sets are modelled — styles and layout still come from the real app.
   */
  setAttribute: (name: string, value: string) => void;
  getAttribute: (name: string) => string | null;
  /**
   * Search the fake tree for a **single class** selector (`.foo`).
   *
   * Deliberately narrow, but not a no-op: a plugin that looks for a wrapper class it did not
   * create — the extension tag a file-explorer row carries, the control area inside a
   * `Setting` row — takes the same branch in the stub as in the app, instead of always
   * taking the "not found" one. Anything else (a tag, an attribute, a compound selector)
   * finds nothing, which is what the stub's DOM cannot answer honestly.
   */
  querySelector: (selector: string) => FakeEl | null;
  /**
   * Remove this element from its parent — Obsidian's `detach()`.
   *
   * Modelled rather than stubbed out: a plugin that takes its own UI down calls this, and a
   * no-op here leaves the element findable, so a test would see the UI it just removed (the
   * reload card's whole lifecycle is "up until it is detached").
   */
  detach: () => void;
  show: () => void;
  hide: () => void;
  addEventListener: (type: string, cb: (event: unknown) => void) => void;
  removeEventListener: (type: string, cb: () => void) => void;
  /**
   * The element's box, as the real DOM reports it.
   *
   * A fake has no layout, so this answers a zero box until a test assigns {@link rect}.
   * The call itself must exist: a menu anchored to its trigger reads this in the app, and
   * an element that threw here would send the plugin down a branch the app never takes.
   */
  getBoundingClientRect: () => FakeRect;
  /** Test driver: the box {@link getBoundingClientRect} answers. */
  rect: { left: number; top: number; width: number; height: number };
}

/** The part of a `DOMRect` the plugin reads, plus the aliases a real one carries. */
export interface FakeRect {
  x: number;
  y: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * The class a **single class selector** (`.foo`) asks for, or `null` for anything the fake
 * DOM cannot answer honestly (a tag, an attribute, a compound selector, a descendant chain).
 */
function singleClassSelector(selector: string): string | null {
  if (!selector.startsWith(".")) return null;
  const name = selector.slice(1);
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : null;
}

export function createFakeEl(tagName = "div"): FakeEl {
  const attributes = new Map<string, string>();
  const el: FakeEl = {
    tagName,
    text: "",
    children: [],
    parent: null,
    attached: [],
    classes: [],
    listeners: {},
    click() {
      const event = { preventDefault() {}, stopPropagation() {} };
      for (const cb of el.listeners.click ?? []) cb(event);
    },
    style: {},
    setCssStyles(styles) {
      for (const [property, value] of Object.entries(styles)) {
        if (value !== undefined) el.style[property] = String(value);
      }
    },
    setCssProps(props) {
      for (const [property, value] of Object.entries(props)) el.style[property] = value;
    },
    scrollTop: 0,
    rect: { left: 0, top: 0, width: 0, height: 0 },
    getBoundingClientRect() {
      const { left, top, width, height } = el.rect;
      return {
        x: left,
        y: top,
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
      };
    },
    empty() {
      for (const child of el.children) child.parent = null;
      el.children = [];
      el.text = "";
      // A scroller whose content is gone is back at the top; keeping a stale offset would
      // hide the very regression this fake exists to catch.
      el.scrollTop = 0;
      // The components created directly on this element go with the nodes `empty()`
      // removed: real Obsidian detaches them from the document, so a re-render that
      // rebuilds a settings page must not leave the previous render's rows findable
      // (`buttonsIn` / `settingsIn`). Without this, a page that re-renders on every
      // change would look like it had every step's controls at once.
      el.attached = [];
      return el;
    },
    createEl(tag, options) {
      const child = createFakeEl(tag);
      child.text = options?.text ?? "";
      for (const cls of (options?.cls ?? "").split(/\s+/)) {
        if (cls) child.classes.push(cls);
      }
      child.parent = el;
      el.children.push(child);
      return child;
    },
    createDiv(options) {
      return el.createEl("div", options);
    },
    createSpan(options) {
      return el.createEl("span", options);
    },
    setText(text) {
      el.text = text;
      return el;
    },
    addClass(cls) {
      if (cls && !el.classes.includes(cls)) el.classes.push(cls);
      return el;
    },
    removeClass(cls) {
      const index = el.classes.indexOf(cls);
      if (index >= 0) el.classes.splice(index, 1);
      return el;
    },
    toggleClass(cls) {
      return el.classes.includes(cls) ? el.removeClass(cls) : el.addClass(cls);
    },
    appendChild(child) {
      // A move, not a copy: the real DOM detaches the node from wherever it was.
      if (child.parent) child.parent.children = child.parent.children.filter((c) => c !== child);
      child.parent = el;
      el.children.push(child);
      return child;
    },
    insertBefore(node, reference) {
      // Moving an element that is already here is not a duplicate: the real DOM moves it.
      if (node.parent) node.parent.children = node.parent.children.filter((c) => c !== node);
      el.children = el.children.filter((child) => child !== node);
      const index = el.children.indexOf(reference);
      if (index < 0) return el.appendChild(node);
      node.parent = el;
      el.children.splice(index, 0, node);
      return node;
    },
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    querySelector(selector) {
      const wanted = singleClassSelector(selector);
      if (wanted === null) return null;
      const walk = (node: FakeEl): FakeEl | null => {
        for (const child of node.children) {
          if (child.classes.includes(wanted)) return child;
          const nested = walk(child);
          if (nested) return nested;
        }
        return null;
      };
      return walk(el);
    },
    detach() {
      const parent = el.parent;
      if (parent) parent.children = parent.children.filter((child) => child !== el);
      el.parent = null;
    },
    show: () => {},
    hide: () => {},
    addEventListener(type, cb) {
      (el.listeners[type] ??= []).push(cb);
    },
    removeEventListener(type, cb) {
      const registered = el.listeners[type];
      if (!registered) return;
      const index = registered.indexOf(cb);
      if (index >= 0) registered.splice(index, 1);
    },
  };
  return el;
}

/** Every element in the fake DOM tree (root included) carrying `cls`. */
export function elementsWithClass(root: FakeEl, cls: string): FakeEl[] {
  const found: FakeEl[] = [];
  const walk = (el: FakeEl): void => {
    if (el.classes.includes(cls)) found.push(el);
    for (const child of el.children) walk(child);
  };
  walk(root);
  return found;
}

// ── Chainable UI components ──

class ChainableComponent {
  disabled = false;

  setDisabled(value: boolean): this {
    this.disabled = value;
    return this;
  }
}

export class TextComponent extends ChainableComponent {
  inputEl = createFakeEl("input");
  private value = "";
  private changeHandler: ((value: string) => unknown) | null = null;

  setPlaceholder(value: string): this {
    this.inputEl.text = value;
    return this;
  }

  setValue(value: string): this {
    this.value = value;
    return this;
  }

  getValue(): string {
    return this.value;
  }

  onChange(cb: (value: string) => unknown): this {
    this.changeHandler = cb;
    return this;
  }

  /** Test driver: type into the field as a user would. */
  simulateChange(value: string): void {
    this.value = value;
    void this.changeHandler?.(value);
  }
}

export class ButtonComponent extends ChainableComponent {
  text = "";
  isCta = false;
  /** `mod-warning` — Obsidian's red/destructive button style. */
  isWarning = false;
  /**
   * The `<button>` itself, which real Obsidian lets a caller reach into (the vault
   * picker keeps its buttons at their content width there, because the phone layout
   * stretches a settings row's control across the whole row).
   */
  buttonEl = createFakeEl("button");
  private clickHandler: (() => unknown) | null = null;

  /**
   * Real Obsidian appends the button to the container it is given; recording the
   * instance on that element is what lets `buttonsIn` reach a button a modal
   * created directly (rather than through a `Setting` row), and its `<button>` is
   * a real child element, which is what a class query or a layout measurement sees.
   */
  constructor(containerEl?: unknown) {
    super();
    const container = containerEl as FakeEl | undefined;
    container?.attached?.push(this);
    if (container) container.appendChild(this.buttonEl);
  }

  setButtonText(text: string): this {
    this.text = text;
    // The label is the `<button>`'s own text in the app, which is what a DOM query reads.
    this.buttonEl.setText(text);
    return this;
  }

  setIcon(_icon: string): this {
    return this;
  }

  setTooltip(_tooltip: string): this {
    return this;
  }

  setCta(): this {
    this.isCta = true;
    return this;
  }

  setWarning(): this {
    this.isWarning = true;
    return this;
  }

  /** `setWarning`'s replacement, `@since 1.13.0`; the same style under a truthful name. */
  setDestructive(): this {
    this.isWarning = true;
    return this;
  }

  onClick(cb: () => unknown): this {
    this.clickHandler = cb;
    return this;
  }

  /** Test driver: press the button as a user would. */
  click(): void {
    void this.clickHandler?.();
  }
}

export class ToggleComponent extends ChainableComponent {
  private changeHandler: ((value: boolean) => unknown) | null = null;
  /** The component's current value, so a test can assert what it renders. */
  value = false;

  /**
   * Real Obsidian appends the toggle to the container it is given; recording it there is
   * what lets `modalToggles` reach one a dialog created directly, rather than through
   * `Setting.addToggle`.
   */
  constructor(containerEl?: unknown) {
    super();
    const container = containerEl as FakeEl | undefined;
    container?.attached?.push(this);
  }

  setValue(value: boolean): this {
    this.value = value;
    return this;
  }

  getValue(): boolean {
    return this.value;
  }

  setTooltip(_tooltip: string): this {
    return this;
  }

  onChange(cb: (value: boolean) => unknown): this {
    this.changeHandler = cb;
    return this;
  }

  /** Test driver: flip the toggle as a user would. */
  simulateChange(value: boolean): void {
    this.value = value;
    void this.changeHandler?.(value);
  }
}

export class DropdownComponent extends ChainableComponent {
  private changeHandler: ((value: string) => unknown) | null = null;
  readonly options = new Map<string, string>();
  value = "";
  /**
   * The `<select>` itself, which real Obsidian exposes as `selectEl`. A caller that sets
   * `aria-label` on its control (the comparison's layout picker) has to reach the same
   * element here, or the stub would drop an attribute the app receives.
   */
  readonly selectEl = createFakeEl("select").addClass("dropdown");

  addOption(value: string, display: string): this {
    this.options.set(value, display);
    return this;
  }

  addOptions(options: Record<string, string>): this {
    for (const [value, display] of Object.entries(options)) this.options.set(value, display);
    return this;
  }

  setValue(value: string): this {
    this.value = value;
    return this;
  }

  onChange(cb: (value: string) => unknown): this {
    this.changeHandler = cb;
    return this;
  }

  /** Test driver: pick an option as a user would. */
  simulateChange(value: string): void {
    this.value = value;
    void this.changeHandler?.(value);
  }
}

export class ExtraButtonComponent extends ChainableComponent {
  icon = "";
  tooltip = "";
  private clickHandler: (() => unknown) | null = null;

  /**
   * Real Obsidian appends the button to the container it is given — the recycle bin's
   * header creates one directly rather than through a `Setting` row — so recording the
   * instance on that element is what lets a test reach it.
   */
  constructor(containerEl?: unknown) {
    super();
    const el = containerEl as FakeEl | undefined;
    if (el) el.attached.push(this);
  }

  setIcon(icon: string): this {
    this.icon = icon;
    return this;
  }

  setTooltip(tooltip: string): this {
    this.tooltip = tooltip;
    return this;
  }

  onClick(cb: () => unknown): this {
    this.clickHandler = cb;
    return this;
  }

  click(): void {
    void this.clickHandler?.();
  }
}

/**
 * Chainable settings row. Sub-builders are invoked with a recording component
 * and the instance attaches itself to its container element, so
 * {@link modalTexts} and friends can find it again.
 */
export class Setting {
  readonly texts: TextComponent[] = [];
  readonly buttons: ButtonComponent[] = [];
  readonly dropdowns: DropdownComponent[] = [];
  readonly toggles: ToggleComponent[] = [];
  /** Info/refresh icons, so a test can read the tooltip a section explains itself with. */
  readonly extraButtons: ExtraButtonComponent[] = [];
  /** The row's own wording — asserted by the settings-page tests, like a real render would show. */
  name = "";
  desc = "";
  /**
   * The row's own element, which real Obsidian creates inside the container.
   *
   * Deliberately detached from `containerEl.children` — the settings-page assertions
   * read the container's text and rows, and a second element per row would duplicate
   * every one of them. It exists because the settings page clears the chrome of a row
   * it nests inside a wrapper of its own (`row.settingEl.style`).
   */
  readonly settingEl: FakeEl = createFakeEl("div");
  /**
   * The row's two halves, as real Obsidian builds them: the description on the left, the
   * controls on the right. They are part of a row's contract even when a caller only reads
   * them through `settingEl`.
   */
  readonly infoEl: FakeEl = createFakeEl("div").addClass("setting-item-info");
  readonly controlEl: FakeEl = createFakeEl("div").addClass("setting-item-control");
  /** The row's title element, which `setName` fills and which lives in `infoEl`. */
  readonly nameEl: FakeEl = createFakeEl("div").addClass("setting-item-name");

  constructor(public containerEl: unknown = createFakeEl()) {
    const el = this.containerEl as FakeEl | undefined;
    el?.attached?.push(this);
    // The row's own element holds its two halves, as the app builds them.
    this.settingEl.appendChild(this.infoEl);
    this.settingEl.appendChild(this.controlEl);
  }

  setName(name: string): this {
    this.name = name;
    this.nameEl.setText(name);
    // Real Obsidian builds the title inside the row's info half.
    if (this.nameEl.parent !== this.infoEl) this.infoEl.appendChild(this.nameEl);
    return this;
  }

  setDesc(desc: string): this {
    this.desc = desc;
    return this;
  }

  setHeading(): this {
    return this;
  }

  setClass(_cls: string): this {
    return this;
  }

  setTooltip(_tooltip: string): this {
    return this;
  }

  addText(cb: (component: TextComponent) => unknown): this {
    const component = new TextComponent();
    this.texts.push(component);
    cb(component);
    return this;
  }

  addButton(cb: (component: ButtonComponent) => unknown): this {
    const component = new ButtonComponent();
    this.buttons.push(component);
    cb(component);
    return this;
  }

  addToggle(cb: (component: ToggleComponent) => unknown): this {
    const component = new ToggleComponent();
    this.toggles.push(component);
    cb(component);
    return this;
  }

  addDropdown(cb: (component: DropdownComponent) => unknown): this {
    const component = new DropdownComponent();
    this.dropdowns.push(component);
    cb(component);
    return this;
  }

  addExtraButton(cb: (component: ExtraButtonComponent) => unknown): this {
    const component = new ExtraButtonComponent();
    this.extraButtons.push(component);
    cb(component);
    return this;
  }
}

// ── Menus ──

/**
 * One entry of a context menu. `main.ts` builds its file-menu entry through
 * `Menu.addItem`, so tests hand a `Menu` to the workspace event and read what the
 * plugin put in it.
 */
export class MenuItem {
  title = "";
  icon = "";
  label = false;
  disabled = false;
  warning = false;
  checked: boolean | null = null;
  section = "";
  private clickHandler: (() => unknown) | null = null;

  setTitle(title: string): this {
    this.title = title;
    return this;
  }

  setIcon(icon: string): this {
    this.icon = icon;
    return this;
  }

  setIsLabel(label: boolean): this {
    this.label = label;
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    return this;
  }

  setWarning(warning: boolean): this {
    this.warning = warning;
    return this;
  }

  setChecked(checked: boolean | null): this {
    this.checked = checked;
    return this;
  }

  setSection(section: string): this {
    this.section = section;
    return this;
  }

  onClick(cb: () => unknown): this {
    this.clickHandler = cb;
    return this;
  }

  /** Test driver: activate the entry the way a click in the real menu does. */
  click(): void {
    void this.clickHandler?.();
  }
}

/** Every menu constructed so far, so a test can read the one the plugin just opened. */
export const openedMenus: Menu[] = [];

/** The slice of Obsidian's `Menu` the plugin uses. */
export class Menu {
  readonly items: MenuItem[] = [];
  separators = 0;
  shown = false;
  closed = false;
  /** `setUseNativeMenu(...)`; null until the plugin asks for one or the other. */
  useNativeMenu: boolean | null = null;
  /** Where the menu was shown, in Obsidian's anchor form (`showAtPosition`). */
  shownAt: { x: number; y: number; width?: number; overlap?: boolean } | null = null;
  private hideHandlers: Array<() => void> = [];

  constructor() {
    openedMenus.push(this);
  }

  addItem(cb: (item: MenuItem) => unknown): this {
    const item = new MenuItem();
    this.items.push(item);
    cb(item);
    return this;
  }

  addSeparator(): this {
    this.separators++;
    return this;
  }

  setUseNativeMenu(useNativeMenu: boolean): this {
    this.useNativeMenu = useNativeMenu;
    return this;
  }

  showAtMouseEvent(_event: unknown): this {
    this.shown = true;
    return this;
  }

  showAtPosition(position: { x: number; y: number; width?: number; overlap?: boolean }): this {
    this.shown = true;
    this.shownAt = { ...position };
    return this;
  }

  onHide(callback: () => void): void {
    this.hideHandlers.push(callback);
  }

  hide(): this {
    this.close();
    return this;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.shown = false;
    for (const callback of this.hideHandlers) callback();
  }
}

/** The most recently constructed menu, or undefined before one exists. */
export function lastOpenedMenu(): Menu | undefined {
  return openedMenus.at(-1);
}

// ── Notices ──

/** Every `new Notice(...)` message, in order. Asserted by plugin tests. */
export const notices: string[] = [];

export class Notice {
  constructor(public message: string) {
    notices.push(message);
  }

  setMessage(message: string): this {
    notices.push(message);
    return this;
  }

  hide(): void {}
}

// ── Components and markdown rendering ──

/**
 * Lifecycle owner, as Obsidian's `Component` is.
 *
 * The plugin creates one to hand to `MarkdownRenderer.render` from inside a `Modal`
 * (whose type does not declare `Component`, so the API's documented pattern for a
 * dialog is a component of its own). Loaded/unloaded counts are recorded, because
 * "the markdown renderer was given a live component" is the part of that pattern a
 * test can actually hold the plugin to.
 */
export class Component {
  loaded = 0;
  unloaded = 0;
  readonly children: Component[] = [];

  load(): void {
    this.loaded++;
    this.onload();
  }

  onload(): void {}

  unload(): void {
    this.unloaded++;
    this.onunload();
  }

  onunload(): void {}

  addChild(child: Component): Component {
    this.children.push(child);
    return child;
  }

  removeChild(child: Component): Component {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    return child;
  }

  register(_cb: () => unknown): void {}

  registerEvent(_ref: unknown): void {}

  registerInterval(id: number): number {
    return id;
  }
}

/** A markdown render child: a `Component` bound to the element it renders into. */
export class MarkdownRenderChild extends Component {
  constructor(public containerEl: FakeEl = createFakeEl()) {
    super();
  }
}

/** One `MarkdownRenderer.render` call: the source, the path it was rendered for. */
export interface MarkdownRenderCall {
  markdown: string;
  sourcePath: string;
  component: unknown;
}

/** Every markdown render so far, in order. Asserted by the preview tests. */
export const markdownRenders: MarkdownRenderCall[] = [];

/**
 * `MarkdownRenderer`, reduced to what a test can observe outside a renderer.
 *
 * There is no HTML here, so "rendering" means the element receives the markdown source
 * as its text: a test asserts that the *renderer* was handed the note's content (rather
 * than the plugin decoding it itself), which is the behaviour that matters — the actual
 * parse is Obsidian's.
 */
export const MarkdownRenderer = {
  async render(
    _app: unknown,
    markdown: string,
    el: FakeEl,
    sourcePath: string,
    component: unknown,
  ): Promise<void> {
    markdownRenders.push({ markdown, sourcePath, component });
    el.setText(markdown);
  },

  /** The deprecated alias, kept so a caller that still uses it does not explode. */
  async renderMarkdown(
    markdown: string,
    el: FakeEl,
    sourcePath: string,
    component: unknown,
  ): Promise<void> {
    await MarkdownRenderer.render(null, markdown, el, sourcePath, component);
  },
};

// ── App surface ──

/** Marker class: `main.ts` does `file instanceof TFile`. */
export class TFile {
  path = "";
  name = "";
  basename = "";
  extension = "";
  stat = { size: 0, mtime: 0 };
}

export class TFolder {
  path = "";
  name = "";
}

export const Platform = {
  isDesktop: true,
  isMobile: false,
  isDesktopApp: true,
  isMobileApp: false,
  /**
   * A phone, as opposed to a tablet — the real app reports both under `isMobile`, and the
   * plugin uses this one to pick the comparison's single-column default.
   */
  isPhone: false,
  isTablet: false,
};

export const apiVersion = "1.13.7";

/**
 * Obsidian's UI language, as the plugin's `getLanguage()` reads it.
 *
 * Defaults to Chinese so the suite's historical Chinese assertions keep describing the
 * same UI; a case that covers the English catalog calls {@link setStubLanguage} before
 * loading the plugin.
 */
let stubLanguage = "zh";

/** The language the stub reports; `main.ts` resolves it to a catalog at `onload`. */
export function getLanguage(): string {
  return stubLanguage;
}

/** Test driver: change the app language before loading (or reloading) the plugin. */
export function setStubLanguage(language: string): void {
  stubLanguage = language;
}

/**
 * `requestUrl` is not a real implementation outside the app — tests install
 * one with {@link setRequestUrlHandler}. The default rejects loudly so a test
 * that forgets to install it fails with a useful message.
 */
export interface RequestUrlParam {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  /** JSON text for the metadata routes; the push frame's bytes for a sync push. */
  body?: string | ArrayBuffer;
  contentType?: string;
  throw?: boolean;
}

export interface RequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  json: unknown;
  arrayBuffer: ArrayBuffer;
}

type RequestUrlHandler = (param: RequestUrlParam) => Promise<RequestUrlResponse>;

let requestUrlHandler: RequestUrlHandler | null = null;

/** Install the transport the plugin's `requestUrl` calls will use. */
export function setRequestUrlHandler(handler: RequestUrlHandler | null): void {
  requestUrlHandler = handler;
}

export async function requestUrl(param: RequestUrlParam): Promise<RequestUrlResponse> {
  if (!requestUrlHandler) {
    throw new Error("obsidian stub: no requestUrl handler installed (call setRequestUrlHandler)");
  }
  const response = await requestUrlHandler(param);
  // Obsidian's documented contract: `throw` defaults to **true**, so a 400+
  // status rejects instead of resolving with the response. Modelling it here is
  // what keeps the plugin honest — a stub that always returned the response let
  // a real defect hide for as long as it existed: in the app every 4xx arrived
  // as a rejection, so the plugin's status-and-body handling (and therefore the
  // specific message the settings page shows) never ran, while the suite — which
  // saw the response — passed.
  if (param.throw !== false && response.status >= 400) {
    throw new Error(`requestUrl: ${response.status} ${response.text}`);
  }
  // The other half of the same contract, and the same kind of trap: Obsidian's
  // `RequestUrlResponse` parses its body **lazily**, and `json` is a getter that
  // throws when the body is not JSON. A stub handing back a plain value let a real
  // defect live for as long as it existed — the plugin's transport read `.json`
  // eagerly, so in the app every binary download (the version-content route answers
  // ciphertext) threw a `SyntaxError` that the client mapped to "cannot reach the
  // server": **no device could ever pull**, while this suite passed.
  return {
    status: response.status,
    headers: response.headers,
    get text() {
      return response.text;
    },
    get json() {
      return response.text ? JSON.parse(response.text) : null;
    },
    get arrayBuffer() {
      return response.arrayBuffer;
    },
  };
}

/** Identity path normaliser — the stub performs no vault-path canonicalisation. */
export function normalizePath(path: string): string {
  return path;
}

/**
 * Record the icon a plugin sets on an element.
 *
 * Real Obsidian appends a Lucide `<svg>`; the fake DOM cannot render one, so the id is
 * kept on the element for tests. A caller that asks for an icon and never gets one
 * (`undefined`) is therefore still visible to an assertion.
 */
export function setIcon(element: unknown, icon: string): void {
  const target = element as FakeEl | undefined;
  if (target) target.icon = icon;
}

// ── App-level localStorage ──

/**
 * Stand-in for `App.loadLocalStorage` / `App.saveLocalStorage`.
 *
 * Module scope (not per `FakeApp`) on purpose: the real store survives an
 * Obsidian restart, so a test can build a second plugin instance over the same
 * store and observe what the first one persisted. `resetStubState()` clears it
 * between tests.
 */
const localStorageStore = new Map<string, unknown>();

/** Read a value the plugin persisted device-locally. */
export function loadLocalStorage(key: string): unknown {
  return localStorageStore.get(key) ?? null;
}

/** Write (or, with `null`, clear) a device-local value. */
export function saveLocalStorage(key: string, data: unknown | null): void {
  if (data === null) localStorageStore.delete(key);
  else localStorageStore.set(key, data);
}

/** Test driver: seed or overwrite a device-local value before plugin load. */
export function setLocalStorage(key: string, data: unknown): void {
  localStorageStore.set(key, data);
}

// ── Plugin lifecycle ──

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
}

/** Base plugin class: enough lifecycle for `CourierPlugin.onload()` to run. */
export class Plugin {
  /** In-memory stand-in for the plugin's `data.json`. */
  private data: unknown = null;

  readonly registeredViews = new Map<string, (leaf: unknown) => unknown>();
  readonly registeredCommands: Array<{ id: string; name: string; callback: () => unknown }> = [];
  readonly ribbonIcons: string[] = [];
  readonly settingTabs: unknown[] = [];
  readonly statusBarItems: FakeEl[] = [];

  constructor(
    public app: unknown,
    public manifest: PluginManifest = { id: "courier", name: "Courier", version: "0.0.0" },
  ) {}

  async loadData(): Promise<unknown> {
    return this.data;
  }

  async saveData(data: unknown): Promise<void> {
    this.data = data;
  }

  addRibbonIcon(icon: string, _title: string, _cb: () => unknown): FakeEl {
    this.ribbonIcons.push(icon);
    return createFakeEl();
  }

  addStatusBarItem(): FakeEl {
    const element = createFakeEl().addClass("status-bar-item");
    this.statusBarItems.push(element);
    return element;
  }

  addCommand(command: { id: string; name: string; callback: () => unknown }): void {
    this.registeredCommands.push(command);
  }

  addSettingTab(tab: unknown): void {
    this.settingTabs.push(tab);
  }

  registerView(type: string, factory: (leaf: unknown) => unknown): void {
    this.registeredViews.set(type, factory);
  }

  registerEvent(ref: unknown): void {
    void ref;
  }

  registerInterval(id: number): number {
    return id;
  }

  registerDomEvent(): void {}
}

/** A control as `getSettingDefinitions()` describes it (Obsidian 1.13). */
export interface SettingControlDefinition {
  type:
    | "toggle"
    | "dropdown"
    | "text"
    | "textarea"
    | "number"
    | "slider"
    | "color"
    | "file"
    | "folder";
  /** The settings property the tab reads and writes through `get/setControlValue`. */
  key: string;
  defaultValue?: unknown;
  options?: Record<string, string>;
  placeholder?: string;
}

/**
 * One item of `getSettingDefinitions()`, as much of it as a suite can observe.
 *
 * The real types are Obsidian's; this is the structural subset the stub renders, and it is
 * deliberately *not* imported from `obsidian` — this file **is** the `obsidian` module under
 * test, so importing from it would be a cycle.
 */
export interface SettingDefinitionItem {
  name?: string;
  desc?: string;
  /** A `group`, `list` or `page` holds items under its own heading. */
  type?: "group" | "list" | "page";
  items?: SettingDefinitionItem[];
  control?: SettingControlDefinition;
  action?: (...args: unknown[]) => unknown;
  render?: (setting: Setting, group: unknown) => void | (() => void);
  visible?: boolean | (() => boolean);
}

/** Read a dotted path (`fileTypes.markdown`) out of a settings object. */
function readSettingPath(settings: unknown, key: string): unknown {
  let current: unknown = settings;
  for (const part of key.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Write a dotted path into a settings object, creating the intermediate objects. */
function writeSettingPath(settings: unknown, key: string, value: unknown): void {
  const parts = key.split(".");
  let current = settings as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (typeof next !== "object" || next === null) current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  current[parts.at(-1)!] = value;
}

/** Whether an item's `visible` predicate says to draw it now. */
function isVisible(item: SettingDefinitionItem): boolean {
  if (item.visible === undefined) return true;
  return typeof item.visible === "function" ? item.visible() : item.visible;
}

/** Draw one control of a definition row, recording its current value like the app does. */
function renderControl(
  tab: PluginSettingTab,
  setting: Setting,
  control: SettingControlDefinition,
): void {
  const value = tab.getControlValue(control.key) ?? control.defaultValue;
  const cell = createFakeEl("div").addClass(`setting-control-${control.type}`);
  cell.setAttribute("data-key", control.key);
  cell.setText(value === undefined || value === null ? "" : String(value));
  setting.controlEl.appendChild(cell);

  // A control is wired to the tab the way the app wires it: a change writes through
  // `setControlValue`, which is where the tab decides what the write means.
  if (control.type === "toggle") {
    setting.toggles.push(
      new ToggleComponent(setting.controlEl).setValue(value === true).onChange((next) => {
        tab.setControlValue(control.key, next);
      }),
    );
    return;
  }
  if (control.type === "text" || control.type === "textarea" || control.type === "number") {
    const text = new TextComponent().setValue(
      value === undefined || value === null ? "" : String(value),
    );
    if (control.placeholder) text.setPlaceholder(control.placeholder);
    text.onChange((next) => {
      tab.setControlValue(control.key, next);
    });
    setting.texts.push(text);
  }
}

/** Draw every definition the tab declares into `containerEl`. */
function renderSettingDefinitions(tab: PluginSettingTab, containerEl: FakeEl): void {
  const draw = (items: readonly SettingDefinitionItem[]): void => {
    for (const item of items) {
      if (!isVisible(item)) continue;
      if (item.type === "group" || item.type === "list" || item.type === "page") {
        if (item.name) new Setting(containerEl).setName(item.name).setHeading();
        if (item.items) draw(item.items);
        continue;
      }
      const setting = new Setting(containerEl);
      if (item.name) setting.setName(item.name);
      if (item.desc) setting.setDesc(item.desc);
      if (item.render) {
        // The group is what the app passes: a `SettingGroup` whose `listEl` is the container
        // the rows live in. A `render` callback that wants to draw something other than a
        // row (the sign-in form) draws it there.
        item.render(setting, { listEl: containerEl } as unknown as never);
        continue;
      }
      if (item.control) renderControl(tab, setting, item.control);
    }
  };
  draw(tab.getSettingDefinitions());
}

/** Base settings tab. Mirrors Obsidian: a `containerEl` is created eagerly. */
export class PluginSettingTab {
  containerEl = createFakeEl();

  constructor(
    public app: unknown,
    public plugin: unknown,
  ) {}

  /** The tab's declarative definitions (Obsidian 1.13); a tab that has none returns `[]`. */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [];
  }

  /** A control's value, read the way the app reads it: out of the plugin's settings. */
  getControlValue(key: string): unknown {
    const settings = (this.plugin as { settings?: unknown } | null)?.settings;
    return readSettingPath(settings, key);
  }

  /** Write a control's value back to the plugin's settings. */
  setControlValue(key: string, value: unknown): void {
    const settings = (this.plugin as { settings?: unknown } | null)?.settings;
    if (settings) writeSettingPath(settings, key, value);
  }

  /**
   * Draw the tab, the way the app does when it opens it.
   *
   * A tab that declares `getSettingDefinitions()` is drawn from them; a tab that overrides
   * this method keeps its own renderer (which is what the old API did).
   */
  display(): void {
    this.containerEl.empty();
    renderSettingDefinitions(this, this.containerEl);
  }

  /**
   * Re-render from the definitions, which is what `update()` means in 1.13: the rows are
   * rebuilt, so a `visible` predicate that just changed takes effect.
   */
  update(): void {
    this.display();
  }

  hide(): void {}
}

/** Every modal opened so far, in order. */
export const openedModals: Modal[] = [];

/** Base modal. `open()` records the instance and runs `onOpen()`. */
export class Modal {
  containerEl = createFakeEl();
  contentEl = createFakeEl();
  titleEl = createFakeEl();
  modalEl = createFakeEl();
  title = "";
  scope = { register: () => {}, unregister: () => {} };
  isOpen = false;

  constructor(public app: unknown) {}

  setTitle(title: string): this {
    this.title = title;
    this.titleEl.setText(title);
    return this;
  }

  open(): void {
    this.isOpen = true;
    openedModals.push(this);
    this.onOpen();
  }

  close(): void {
    this.isOpen = false;
    this.onClose();
  }

  onOpen(): void {}

  onClose(): void {}
}

// ── Test drivers for real dialogs ──

/** Reset the stub's observable state (call in `beforeEach`). */
export function resetStubState(): void {
  stubLanguage = "zh";
  notices.length = 0;
  openedModals.length = 0;
  openedMenus.length = 0;
  markdownRenders.length = 0;
  localStorageStore.clear();
  // Declared below; a `function` hoists and a module-level array is initialised by the time
  // a test calls this.
  openLeaves.length = 0;
}

// ── Workspace leaves (a main-area tab) ──

/**
 * Every leaf the fake workspace handed out, in creation order — the app's own layout,
 * as far as a test can see it.
 *
 * Module scope rather than per `FakeApp`, because a leaf outlives the object a single test
 * happens to hold and a test reaches for it by view type, exactly like a real tab bar.
 */
export const openLeaves: WorkspaceLeaf[] = [];

/**
 * The view lifecycle a leaf drives.
 *
 * A leaf is the object both sides of the contract meet at: Obsidian constructs the view
 * through the plugin's `registerView` factory, calls `setState` **then** `onOpen`, and the
 * view reaches back to its leaf for `detach()`. Modelled rather than stubbed so a plugin
 * that opens a tab — and a view that closes itself — behave the same way here as in the app.
 *
 * The factory is looked up in the **plugin's** registrations when the view is created (not
 * passed in), because that is the order the app uses: `registerView` runs in `onload`, long
 * before the first leaf exists.
 */
export class WorkspaceLeaf {
  /** The state last handed to `setViewState` (what a layout file would hold). */
  state: { type: string; state?: Record<string, unknown> } | null = null;
  isActive = false;
  /** The view this leaf hosts, or `null` before any `setViewState` landed. */
  hostedView: ItemView | null = null;

  constructor(
    private readonly app: unknown,
    private readonly factoryFor: (type: string) => ((leaf: unknown) => unknown) | undefined,
  ) {
    openLeaves.push(this);
  }

  get view(): ItemView | null {
    return this.hostedView;
  }

  /** Close the tab: runs the view's `onClose` and removes the leaf from the layout. */
  detach(): void {
    const view = this.hostedView;
    if (view) {
      view.isOpen = false;
      void view.onClose();
    }
    this.hostedView = null;
    const index = openLeaves.indexOf(this);
    if (index >= 0) openLeaves.splice(index, 1);
  }

  async setViewState(viewState: { type: string; state?: Record<string, unknown> }): Promise<void> {
    const factory = this.factoryFor(viewState.type);
    if (!factory) throw new Error(`No view is registered for type "${viewState.type}"`);
    this.state = viewState;
    const view = factory(this) as ItemView;
    (view as { app?: unknown }).app = this.app;
    this.hostedView = view;
    await view.setState(viewState.state ?? null, { history: false });
    view.isOpen = true;
    await view.onOpen();
  }

  /**
   * The state this leaf would be saved with.
   *
   * A **deferred** leaf (a tab in the background) has no `view` yet in the app, so the plugin
   * finds it by this state instead of by its class; the fake has no deferral, so the state is
   * simply what was last handed to `setViewState`.
   */
  getViewState(): { type: string; state?: Record<string, unknown> } {
    return this.state ?? { type: "" };
  }
}

/**
 * What the stub `Plugin` base class recorded for an instance. These fields do
 * not exist on real Obsidian's `Plugin`, so tests read them through this
 * helper rather than casting inline.
 */
export interface RecordedPluginSurface {
  settingTabs: unknown[];
  registeredViews: Map<string, unknown>;
  registeredCommands: Array<{ id: string; name: string; callback: () => unknown }>;
  ribbonIcons: string[];
  statusBarItems: FakeEl[];
}

/** Read the stub's recordings off a real plugin instance. */
export function recordedSurface(plugin: unknown): RecordedPluginSurface {
  return plugin as RecordedPluginSurface;
}

/** The most recently opened modal. */
export function lastOpenedModal(): Modal | undefined {
  return openedModals.at(-1);
}

/** `Setting` rows created directly on a container element. */
function settingsOf(element: FakeEl): Setting[] {
  return element.attached.filter((item): item is Setting => item instanceof Setting);
}

/**
 * Components of one kind in a subtree, in document order.
 *
 * A dialog can put a component straight on an element it built (the replace confirmation
 * puts its toggle in the row it drew) as well as through a `Setting` row, so the lookup
 * walks the tree instead of reading only the rows a dialog happened to use.
 */
function componentsIn<T>(
  root: FakeEl,
  ofSetting: (setting: Setting) => T[],
  isKind: (item: unknown) => item is T,
): T[] {
  const found: T[] = [];
  const walk = (el: FakeEl): void => {
    for (const item of el.attached) {
      if (item instanceof Setting) found.push(...ofSetting(item));
      else if (isKind(item)) found.push(item);
    }
    for (const child of el.children) walk(child);
  };
  walk(root);
  return found;
}

/** Every button rendered in an element subtree, in document order. */
export function buttonsIn(root: FakeEl): ButtonComponent[] {
  return componentsIn(
    root,
    (setting) => setting.buttons,
    (item): item is ButtonComponent => item instanceof ButtonComponent,
  );
}

/**
 * Text fields the modal built, in document order.
 *
 * Walks the subtree rather than reading only `contentEl`'s direct rows: a dialog may group
 * its `Setting` rows in cards (the connection setup does), and "the modal's text fields"
 * means all of them, exactly like {@link buttonsIn} does for buttons.
 */
export function modalTexts(modal: Modal): TextComponent[] {
  const settings: Setting[] = [];
  const walk = (element: FakeEl): void => {
    for (const item of element.attached) {
      if (item instanceof Setting) settings.push(item);
    }
    for (const child of element.children) walk(child);
  };
  walk(modal.contentEl);
  return settings.flatMap((setting) => setting.texts);
}

/** Buttons the modal built, in creation order. */
export function modalButtons(modal: Modal): ButtonComponent[] {
  return buttonsIn(modal.contentEl);
}

/** Dropdowns the modal built, in creation order. */
export function modalDropdowns(modal: Modal): DropdownComponent[] {
  return settingsOf(modal.contentEl).flatMap((setting) => setting.dropdowns);
}

/** Toggles the modal built, in creation order. */
export function modalToggles(modal: Modal): ToggleComponent[] {
  return componentsIn(
    modal.contentEl,
    (setting) => setting.toggles,
    (item): item is ToggleComponent => item instanceof ToggleComponent,
  );
}

/** Press the modal button with the given label (throws if it does not exist). */
export function clickModalButton(modal: Modal, label: string): void {
  const button = modalButtons(modal).find((candidate) => candidate.text === label);
  if (!button) {
    const available = modalButtons(modal)
      .map((candidate) => candidate.text)
      .join(", ");
    throw new Error(`No button labelled "${label}" in the modal (have: ${available})`);
  }
  button.click();
}

/**
 * Base view — a main-area tab's content.
 *
 * Modelled far enough that a real `ItemView` subclass runs its lifecycle: `setState` is
 * called **before** `onOpen` the way Obsidian does it when a leaf is created, `onClose` runs
 * when the leaf is detached, and the view's own `viewType` lands on `data-type`-style
 * metadata a test can read. `contentEl` is a real fake element, so a view's rendered rows
 * are as reachable as a modal's.
 */
export class ItemView {
  containerEl = createFakeEl();
  contentEl = createFakeEl().addClass("view-content");
  leaf: unknown;
  app?: unknown;
  /** The state this view was last given (Obsidian keeps it on the leaf, not the view). */
  state: unknown = null;
  isOpen = false;

  constructor(leaf: unknown) {
    this.leaf = leaf;
  }

  getViewType(): string {
    return "";
  }

  getDisplayText(): string {
    return "";
  }

  getIcon(): string {
    return "";
  }

  async setState(state: unknown, result: unknown): Promise<void> {
    void result;
    this.state = state;
  }

  getState(): Record<string, unknown> {
    return {};
  }

  async onOpen(): Promise<void> {}

  async onClose(): Promise<void> {}

  addAction(_icon: string, _title: string, _cb: () => unknown): FakeEl {
    return createFakeEl();
  }
}

/** Type-only aliases so plugin modules that import them still type-check. */
export type App = unknown;
export type Vault = unknown;
export type TAbstractFile = unknown;
export type EventRef = unknown;
