import { afterEach, describe, expect, it } from "vitest";
import {
  ButtonComponent,
  createFakeEl,
  DropdownComponent,
  ItemView,
  openLeaves,
  PluginSettingTab,
  requestUrl,
  resetStubState,
  setIcon,
  setRequestUrlHandler,
  Setting,
  WorkspaceLeaf,
  type RequestUrlParam,
} from "./obsidian-stub";
import { FakeVault } from "./fake-vault";
import type { TFile } from "obsidian";

/** The indexed `TFile` at `path` — what `getAbstractFileByPath` answers for a real file. */
function fileAt(vault: FakeVault, path: string): TFile {
  return vault.getAbstractFileByPath(path) as TFile;
}

/**
 * The fidelity of the fake Obsidian.
 *
 * The harness is the **oracle** for every plugin test: L2 drives the real plugin class
 * against it and believes whatever it answers. A stub that is kinder than the app therefore
 * does not merely miss defects — it certifies them. Two did reach a running vault that way:
 * `requestUrl`'s 4xx rejection and its lazy, throwing `json` getter, and in both cases the
 * whole suite was green while every pull failed in the app.
 *
 * So the fake's contract is asserted here, one case per modelled behaviour, with the defect
 * each one would hide. If someone loosens the fake to make a test pass, this file is what
 * stops it from being a silent decision.
 */

/** Install a handler answering every request with the given body. */
function respondWith(response: { status?: number; text?: string }): void {
  setRequestUrlHandler(async (_param: RequestUrlParam) => {
    const text = response.text ?? "";
    return {
      status: response.status ?? 200,
      headers: {},
      text,
      json: null,
      arrayBuffer: new TextEncoder().encode(text).buffer as ArrayBuffer,
    };
  });
}

afterEach(() => {
  setRequestUrlHandler(null);
});

describe("obsidian-stub — requestUrl", () => {
  it("resolves with the response when the caller passes throw: false", async () => {
    respondWith({ status: 404, text: '{"error":"NOT_FOUND","message":"no such vault"}' });

    const response = await requestUrl({ url: "http://s/vaults/x", throw: false });

    expect(response.status).toBe(404);
    expect(response.json).toEqual({ error: "NOT_FOUND", message: "no such vault" });
  });

  it("rejects on 4xx by default, the way Obsidian does", async () => {
    respondWith({ status: 401, text: '{"error":"UNAUTHORIZED","message":"bad key"}' });

    // Hiding this is how every structured error used to reach the settings page as
    // "cannot reach the server": the app rejects, so the plugin's status-and-body
    // handling never ran, while a stub that always resolved let it look correct.
    await expect(requestUrl({ url: "http://s/vaults/x" })).rejects.toThrow(/401/);
  });

  it("rejects on 5xx too", async () => {
    respondWith({ status: 503, text: "upstream down" });

    await expect(requestUrl({ url: "http://s/vaults/x" })).rejects.toThrow(/503/);
  });

  it("parses json on demand for a JSON body", async () => {
    respondWith({ status: 200, text: '{"name":"bbb"}' });

    expect((await requestUrl({ url: "http://s/me" })).json).toEqual({ name: "bbb" });
  });

  it("throws from json for a body that is not JSON, while text and bytes still work", async () => {
    const ciphertext = "\u0000\u0001\u00ff not json at all";
    respondWith({ status: 200, text: ciphertext });

    const response = await requestUrl({ url: "http://s/versions/h/content" });

    // This is the shape that broke every pull: Obsidian parses lazily and `json` throws,
    // so a transport that reads `.json` eagerly turns a download into a SyntaxError the
    // client can only report as a transport failure.
    expect(() => response.json).toThrow();
    expect(response.text).toBe(ciphertext);
    expect(new TextDecoder().decode(response.arrayBuffer)).toBe(ciphertext);
  });

  it("is a loud failure when no handler is installed", async () => {
    setRequestUrlHandler(null);

    await expect(requestUrl({ url: "http://s/" })).rejects.toThrow(/no requestUrl handler/);
  });
});

describe("FakeVault — the file APIs the plugin writes through", () => {
  it("refuses createBinary for a path whose folder the index does not have", async () => {
    const vault = new FakeVault();

    await expect(vault.createBinary("notes/deep/a.md", new ArrayBuffer(0))).rejects.toThrow(
      /ENOENT/,
    );
    // …and nothing is left behind, exactly like the app.
    expect(vault.has("notes/deep/a.md")).toBe(false);
    expect(vault.getFolderByPath("notes/deep")).toBeNull();
  });

  it("accepts createBinary once the folder exists", async () => {
    const vault = new FakeVault();

    await vault.createFolder("notes/deep");
    await vault.createBinary("notes/deep/a.md", new ArrayBuffer(0));

    expect(vault.has("notes/deep/a.md")).toBe(true);
  });

  it("gives two concurrent createBinary calls the app's race: one wins, one throws", async () => {
    const vault = new FakeVault();

    // A reconcile pull and a `files_pushed` pull can both reach the same absent path.
    // Obsidian registers the file only after its adapter write resolves, so the second
    // caller gets `File already exists.` — the plugin adapter's job to accept only when
    // the bytes match. A fake that silently overwrote could never show that.
    const results = await Promise.allSettled([
      vault.createBinary("a.md", new TextEncoder().encode("one").buffer as ArrayBuffer),
      vault.createBinary("a.md", new TextEncoder().encode("two").buffer as ArrayBuffer),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect((rejected!.reason as Error).message).toMatch(/already exists/);
  });

  it("refuses a rename into a folder the index does not have", async () => {
    const vault = new FakeVault();
    await vault.create("a.md", "one");
    const file = fileAt(vault, "a.md");

    // The API, not the `move` helper: the helper creates the target folder the way the UI
    // would, so only the raw call shows the refusal `renameFile` has to prepare for.
    await expect(vault.rename(file, "archive/a.md")).rejects.toThrow(/ENOENT/);
  });

  it("renames a folder with its children, as the adapter's rename does", async () => {
    const vault = new FakeVault();
    await vault.createFolder(".courier/sync-lease");
    await vault.adapter.write(".courier/sync-lease/owner.json", "{}");

    // The lease takeover renames the holder's lease directory aside; a fake that moved
    // only files would make that unreachable here and hide the real contract.
    await vault.adapter.rename(".courier/sync-lease", ".courier/sync-lease.stale");

    expect(await vault.adapter.exists(".courier/sync-lease")).toBe(false);
    expect(await vault.adapter.read(".courier/sync-lease.stale/owner.json")).toBe("{}");
  });

  it("throws from createFolder when the folder is already there", async () => {
    const vault = new FakeVault();
    await vault.createFolder("notes");

    await expect(vault.createFolder("notes")).rejects.toThrow(/already exists/);
  });

  it("gives two concurrent createFolder calls the app's race: one wins, one throws", async () => {
    const vault = new FakeVault();

    // Obsidian registers a folder only after its adapter call resolves, so the second
    // caller still reads null from getFolderByPath and then gets `Folder already exists.`
    // The plugin's folder helpers catch that and continue; a fake with no window at all
    // could never reproduce the burst that lost a note.
    const results = await Promise.allSettled([
      vault.createFolder("shared"),
      vault.createFolder("shared"),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("refuses modifyBinary for a file the vault no longer holds", async () => {
    const vault = new FakeVault();
    await vault.create("a.md", "one");
    const file = fileAt(vault, "a.md");
    await vault.delete(file);

    await expect(vault.modifyBinary(file, new ArrayBuffer(0))).rejects.toThrow(/ENOENT/);
  });

  it("refuses delete for a file the vault does not hold", async () => {
    const vault = new FakeVault();
    await vault.create("a.md", "one");
    const file = fileAt(vault, "a.md");
    await vault.delete(file);

    // The same TFile, deleted twice: the app throws rather than no-opping.
    await expect(vault.delete(file)).rejects.toThrow(/ENOENT/);
  });

  it("keeps the config folder out of the index while the data adapter still sees it", async () => {
    const vault = new FakeVault();

    // Every real vault has `.obsidian` on disk, and Obsidian deliberately keeps it out of
    // the index: `getAbstractFileByPath` answers null while the adapter can read it.
    expect(vault.getAbstractFileByPath(".obsidian")).toBeNull();
    expect(vault.getAbstractFileByPath(".obsidian/app.json")).toBeNull();
    expect(await vault.adapter.exists(".obsidian")).toBe(true);
  });

  it("refuses a data-adapter write into a folder that does not exist", async () => {
    const vault = new FakeVault();

    // The adapter is the plain filesystem, so the plugin's `ensureFoldersInAdapter` is what
    // creates `.obsidian/snippets` — a fake that created it implicitly would let a peer's
    // snippet land nowhere in the app.
    await expect(
      vault.adapter.writeBinary(".obsidian/snippets/x.css", new ArrayBuffer(0)),
    ).rejects.toThrow(/ENOENT/);

    await vault.adapter.mkdir(".obsidian/snippets");
    await vault.adapter.writeBinary(".obsidian/snippets/x.css", new ArrayBuffer(0));
    expect(await vault.adapter.exists(".obsidian/snippets/x.css")).toBe(true);
  });

  it("appends binary data through the data adapter, without a vault event", async () => {
    const vault = new FakeVault();
    await vault.adapter.mkdir(".courier");
    await vault.adapter.mkdir(".courier/tmp");
    const seen: string[] = [];
    vault.on("create", (file) => seen.push(file.path));
    vault.on("modify", (file) => seen.push(file.path));

    await vault.adapter.writeBinary(".courier/tmp/x.part", new Uint8Array([1, 2]).buffer);
    await vault.adapter.appendBinary(".courier/tmp/x.part", new Uint8Array([3]).buffer);
    await vault.settle();

    expect(
      Array.from(new Uint8Array(await vault.adapter.readBinary(".courier/tmp/x.part"))),
    ).toEqual([1, 2, 3]);
    // The data adapter fires no vault events: a large download's chunks must not be
    // reported as a user edit while the temporary file is being filled.
    expect(seen).toEqual([]);
    // Appending to a path that is not there is the app's ENOENT, not a silent create.
    await expect(
      vault.adapter.appendBinary(".courier/tmp/missing.part", new Uint8Array([1]).buffer),
    ).rejects.toThrow(/ENOENT/);
  });

  it("fires no vault event for a data-adapter write", async () => {
    const vault = new FakeVault();
    const seen: string[] = [];
    vault.on("create", (file) => seen.push(file.path));
    vault.on("modify", (file) => seen.push(file.path));

    await vault.writeConfig(".obsidian/app.json", "{}");
    await vault.settle();

    // This is why the host polls the config folder at all: no event ever arrives.
    expect(seen).toEqual([]);
  });

  it("fires the events a vault write does fire", async () => {
    const vault = new FakeVault();
    const seen: string[] = [];
    vault.on("create", (file) => seen.push(`create:${file.path}`));
    vault.on("modify", (file) => seen.push(`modify:${file.path}`));
    vault.on("delete", (file) => seen.push(`delete:${file.path}`));

    await vault.create("a.md", "one");
    await vault.modify("a.md", "two");
    await vault.remove("a.md");
    await vault.settle();

    expect(seen).toEqual(["create:a.md", "modify:a.md", "delete:a.md"]);
  });

  it("lets the user-facing helpers place files in folders that do not exist yet", async () => {
    const vault = new FakeVault();

    // A test says "a note lives here" the way a user's UI would: the folder chain comes
    // first. The API the plugin calls stays strict (see the first case).
    await vault.create("notes/deep/a.md", "one");
    await vault.createAttachment("photos/raw.png", new Uint8Array([1, 2, 3]));
    await vault.move("notes/deep/a.md", "archive/moved.md");

    expect(vault.paths()).toEqual(["archive/moved.md", "photos/raw.png"]);
  });

  it("separates getFiles from getMarkdownFiles, the gap the attachment cases cover", async () => {
    const vault = new FakeVault();
    await vault.create("note.md", "one");
    await vault.createAttachment("photo.png", new Uint8Array([1]));

    expect(vault.getMarkdownFiles().map((f) => f.path)).toEqual(["note.md"]);
    expect(
      vault
        .getFiles()
        .map((f) => f.path)
        .toSorted(),
    ).toEqual(["note.md", "photo.png"]);
  });

  it("lists folders, including empty ones, for the excluded-folder dialog", async () => {
    const vault = new FakeVault();
    await vault.create("notes/deep/a.md", "one");
    await vault.createFolder("empty");

    const folders = vault
      .getAllLoadedFiles()
      .filter((entry) => !("extension" in entry))
      .map((entry) => entry.path)
      .toSorted();
    // The config folder and any other dot-folder are not part of the vault index; an
    // empty folder is, and the dialog has to offer it as an exclusion target.
    expect(folders).toEqual(["empty", "notes", "notes/deep"]);
  });

  it("reads the cached UTF-8 text a comparison shows, and throws for a gone file", async () => {
    const vault = new FakeVault();
    await vault.create("notes/plan.md", "# 标题\nline\n");
    const file = fileAt(vault, "notes/plan.md");

    // `cachedRead` is how the conflict dialog shows both sides; a fake that threw or
    // decoded differently would make every comparison render as "cannot read".
    expect(await vault.cachedRead(file)).toBe("# 标题\nline\n");

    await vault.remove("notes/plan.md");
    await expect(vault.cachedRead(file)).rejects.toThrow(/ENOENT/);
  });
});

describe("FakeEl — the DOM the file-explorer decoration relies on", () => {
  it("records the icon id a plugin sets, so a missing icon is testable", () => {
    const icon = createFakeEl("span");
    setIcon(icon, "folder");
    expect(icon.icon).toBe("folder");
  });

  it("inserts before a reference node instead of appending", () => {
    const row = createFakeEl();
    const tag = row.createDiv({ cls: "nav-file-tag", text: "PNG" });
    const button = row.createDiv({ cls: "courier-conflict-action", text: "replace" });

    row.insertBefore(button, tag);

    // The action has to sit **before** the extension tag; appending would put it after.
    expect(row.children.map((child) => child.classes[0])).toEqual([
      "courier-conflict-action",
      "nav-file-tag",
    ]);
  });

  it("moves an element that is already in the tree, like the DOM", () => {
    const row = createFakeEl();
    const first = row.createDiv({ cls: "first" });
    const second = row.createDiv({ cls: "second" });

    row.insertBefore(first, second);

    expect(row.children).toEqual([first, second]);
  });

  it("answers a single-class selector and nothing it cannot model", () => {
    const row = createFakeEl();
    const tag = row.createDiv({ cls: "nav-file-tag" });

    expect(row.querySelector(".nav-file-tag")).toBe(tag);
    expect(row.querySelector(".missing")).toBeNull();
    // A tag, an attribute or a compound selector is not something the fake can answer
    // honestly; returning null keeps the plugin on the branch the app takes.
    expect(row.querySelector("div")).toBeNull();
    expect(row.querySelector("div.nav-file-tag")).toBeNull();
  });

  it("hands click handlers a cancellable event, because the row's click would open the file", () => {
    const row = createFakeEl();
    const seen: unknown[] = [];
    row.addEventListener("click", (event) => seen.push(event));

    row.click();

    expect(seen).toHaveLength(1);
    const event = seen[0] as { preventDefault?: unknown; stopPropagation?: unknown };
    expect(typeof event.preventDefault).toBe("function");
    expect(typeof event.stopPropagation).toBe("function");
  });
});

describe("FakeEl — closest", () => {
  it("walks up to the nearest ancestor with a single class, itself included", () => {
    const modal = createFakeEl().addClass("modal");
    const pane = modal.createDiv();
    const inner = pane.createDiv();

    expect(inner.closest(".modal")).toBe(modal);
    expect(modal.closest(".modal")).toBe(modal);
    expect(inner.closest(".missing")).toBeNull();
    // Anything but a single class is outside what the fake can answer honestly.
    expect(inner.closest("div")).toBeNull();
  });
});

describe("FakeEl — the settings page's scroll container", () => {
  it("returns to the top when its content is emptied, like a real scroller", () => {
    const scroller = createFakeEl();
    scroller.createDiv({ cls: "setting-item" });
    scroller.scrollTop = 240;

    scroller.empty();

    // The plugin's `containerEl` is Obsidian's `.vertical-tab-content`, the pane that
    // scrolls. A full render that empties it has to show up as the lost offset; keeping a
    // stale value here would make the phone's jump-to-top regression invisible to L2.
    expect(scroller.scrollTop).toBe(0);
  });
});

describe("obsidian-stub — the leaves a view lives in", () => {
  afterEach(() => resetStubState());

  it("records an attribute a caller sets on an element", () => {
    const select = createFakeEl("select");
    select.setAttribute("aria-label", "布局");

    expect(select.getAttribute("aria-label")).toBe("布局");
    expect(select.getAttribute("title")).toBeNull();
  });

  it("moves a node appended into a second parent instead of duplicating it", () => {
    const first = createFakeEl();
    const second = createFakeEl();
    const node = first.createDiv({ cls: "node" });

    second.appendChild(node);

    // The real DOM detaches from the old parent; a stub that pushed it into both arrays would
    // let a moved row stay findable where the app no longer shows it.
    expect(first.children).toEqual([]);
    expect(second.children).toEqual([node]);
    expect(node.parent).toBe(second);
  });

  it("calls setState before onOpen, and onClose when the leaf is detached", async () => {
    class ProbeView extends ItemView {
      readonly calls: string[] = [];
      override async setState(): Promise<void> {
        this.calls.push("state");
      }
      override async onOpen(): Promise<void> {
        this.calls.push("open");
      }
      override async onClose(): Promise<void> {
        this.calls.push("close");
      }
    }

    const leaf = new WorkspaceLeaf({}, (type) =>
      type === "probe" ? (host) => new ProbeView(host) : undefined,
    );
    await leaf.setViewState({ type: "probe", state: { pair: "a" } });

    const view = leaf.view as ProbeView;
    expect(view.calls, "the view must be told what it shows before it opens").toEqual([
      "state",
      "open",
    ]);
    expect(view.isOpen).toBe(true);
    expect(leaf.state).toEqual({ type: "probe", state: { pair: "a" } });
    expect(openLeaves).toContain(leaf);

    leaf.detach();

    expect(view.calls).toEqual(["state", "open", "close"]);
    expect(leaf.view).toBeNull();
    expect(openLeaves).not.toContain(leaf);
  });

  it("builds a settings row's two halves, and fills its title", () => {
    const row = new Setting(createFakeEl());
    row.setName("布局");

    expect(row.settingEl.children).toEqual([row.infoEl, row.controlEl]);
    expect(row.infoEl.children).toEqual([row.nameEl]);
    expect(row.nameEl.text).toBe("布局");
  });

  it("exposes a dropdown's select element and a button's button element", () => {
    const dropdown = new DropdownComponent();
    dropdown.selectEl.setAttribute("aria-label", "布局");
    expect(dropdown.selectEl.getAttribute("aria-label")).toBe("布局");

    const container = createFakeEl();
    const button = new ButtonComponent(container).setButtonText("替换");
    expect(container.children).toEqual([button.buttonEl]);
    expect(button.buttonEl.text).toBe("替换");
  });

  it("makes a button's label and icon replace each other, and its tooltip an aria-label", () => {
    // The app writes `textContent` for a label and empties the element before painting an
    // icon: a stub that kept both would let a test see a button the app never renders.
    const button = new ButtonComponent(createFakeEl());

    button.setButtonText("保存");
    expect(button.text).toBe("保存");
    expect(button.icon).toBe("");
    expect(button.buttonEl.text).toBe("保存");

    button.setIcon("pencil");
    expect(button.icon).toBe("pencil");
    expect(button.text).toBe("");
    expect(button.buttonEl.text).toBe("");

    button.setTooltip("修改");
    expect(button.tooltip).toBe("修改");
    expect(button.buttonEl.getAttribute("aria-label")).toBe("修改");

    // …and the other way round: an icon painted first is gone once a label is written.
    button.setButtonText("保存");
    expect(button.icon).toBe("");
    expect(button.buttonEl.text).toBe("保存");
  });
});

/**
 * The rows a tab drew, in order. A group's heading is a row too: its title, plus the
 * buttons the group put on it (the info icon a section explains itself with).
 */
function drawnRows(tab: PluginSettingTab): Setting[] {
  return tab.containerEl.attached.filter((entry): entry is Setting => entry instanceof Setting);
}

describe("declarative settings (Obsidian 1.13)", () => {
  it("draws definitions, skips the invisible ones, and reads control values from settings", () => {
    const plugin = { settings: { deviceName: "laptop", fileTypes: { markdown: true } } };
    const tab = new PluginSettingTab({}, plugin);
    tab.getSettingDefinitions = () => [
      {
        type: "group",
        heading: "Device",
        items: [
          { name: "Device name", control: { type: "text", key: "deviceName" } },
          {
            name: "Hidden row",
            control: { type: "toggle", key: "fileTypes.markdown" },
            visible: () => false,
          },
        ],
      },
      { name: "Markdown files", control: { type: "toggle", key: "fileTypes.markdown" } },
    ];

    tab.display();

    expect(drawnRows(tab).map((row) => row.name)).toEqual([
      "Device",
      "Device name",
      "Markdown files",
    ]);
    // The control's cell carries the value the tab would show, read through the plugin.
    const nameRow = drawnRows(tab)[1];
    expect(nameRow.controlEl.children[0].text).toBe("laptop");
    const toggleRow = drawnRows(tab)[2];
    expect(toggleRow.toggles[0].value).toBe(true);
  });

  it("puts a group's buttons on its heading, and gives a group that only sets `name` no title", () => {
    const tab = new PluginSettingTab({}, { settings: {} });
    tab.getSettingDefinitions = () => [
      {
        type: "group",
        heading: "Device",
        extraButtons: [
          (button) => button.setIcon("help-circle").setTooltip("a label, not a device"),
        ],
        items: [{ name: "Device name" }],
      },
      // A group has `heading` in the typings, never `name`; the app draws no title for
      // this one, so the stub must not draw one either.
      { type: "group", name: "Ignored", items: [{ name: "Row" }] },
    ];

    tab.display();

    // The heading row is the group's title, and the button reaches the component the app
    // would give the plugin — the only way a test can read a section's tooltip.
    const rows = drawnRows(tab);
    expect(rows.map((row) => row.name)).toEqual(["Device", "Device name", "Row"]);
    expect(rows[0]!.extraButtons.map((button) => [button.icon, button.tooltip])).toEqual([
      ["help-circle", "a label, not a device"],
    ]);
    expect(rows[1]!.extraButtons).toHaveLength(0);
  });

  it("writes a control's value back through the key's path", () => {
    const plugin = { settings: { fileTypes: { markdown: true } } };
    const tab = new PluginSettingTab({}, plugin);

    tab.setControlValue("fileTypes.markdown", false);

    expect(plugin.settings.fileTypes.markdown).toBe(false);
    expect(tab.getControlValue("fileTypes.markdown")).toBe(false);
  });

  it("keeps the pane's scroll offset across an update, as the app's refresh does", () => {
    const tab = new PluginSettingTab({}, { settings: {} });
    tab.display();
    tab.containerEl.scrollTop = 420;

    tab.update();

    // `update()` re-renders the open tab in place; the app saves the pane's offset around
    // it and restores it. A fake that reset the offset here would certify a step change
    // that leaves the user below the new page's content, which is exactly how the phone's
    // blank settings pane shipped.
    expect(tab.containerEl.scrollTop).toBe(420);
  });
});
