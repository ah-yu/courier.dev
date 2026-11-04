import { describe, expect, it } from "vitest";
import { layoutAssertionsEnabled, obsidianLaunchCommand, obsidianRegistryPath } from "./platform";

/**
 * These cases need no Obsidian. They pin the OS branches the suite cannot
 * exercise locally (the developer machine is Windows; CI is Linux), so a wrong
 * path or launch shape fails here instead of as a 15-minute CI timeout.
 */

describe("obsidianRegistryPath", () => {
  it("uses %APPDATA% on Windows", () => {
    expect(
      obsidianRegistryPath({
        platform: "win32",
        appData: "C:/Users/dev/AppData/Roaming",
        home: "C:/Users/dev",
      }),
    ).toBe("C:\\Users\\dev\\AppData\\Roaming\\obsidian\\obsidian.json");
  });

  it("uses Application Support on macOS", () => {
    expect(
      obsidianRegistryPath({
        platform: "darwin",
        appData: "/unused",
        home: "/Users/dev",
      }),
    ).toBe("/Users/dev/Library/Application Support/obsidian/obsidian.json");
  });

  it("honours XDG_CONFIG_HOME on Linux", () => {
    expect(
      obsidianRegistryPath({
        platform: "linux",
        appData: "/unused",
        home: "/home/dev",
        xdgConfigHome: "/home/dev/.config-custom",
      }),
    ).toBe("/home/dev/.config-custom/obsidian/obsidian.json");
  });

  it("falls back to ~/.config on Linux", () => {
    expect(
      obsidianRegistryPath({
        platform: "linux",
        appData: "/unused",
        home: "/home/dev",
      }),
    ).toBe("/home/dev/.config/obsidian/obsidian.json");
  });
});

describe("obsidianLaunchCommand", () => {
  const app = "C:/Users/dev/AppData/Local/Programs/Obsidian/Obsidian.exe";
  const uri = "obsidian://open?vault=courier-e2e-a";

  it("starts the Windows app through cmd's start", () => {
    expect(obsidianLaunchCommand({ platform: "win32", appPath: app })).toEqual({
      command: "cmd",
      args: ["/c", "start", "", app],
    });
  });

  it("hands a URI to the Windows protocol handler", () => {
    expect(obsidianLaunchCommand({ platform: "win32", uri })).toEqual({
      command: "cmd",
      args: ["/c", "start", "", uri],
    });
  });

  it("opens the macOS app, with flags forwarded after --args", () => {
    expect(obsidianLaunchCommand({ platform: "darwin", flags: ["--no-sandbox"] })).toEqual({
      command: "open",
      args: ["-a", "Obsidian", "--args", "--no-sandbox"],
    });
  });

  it("opens the macOS app by path when the harness has one", () => {
    // A bundle copied into /Applications is not in LaunchServices until something
    // registers it, so the name form can miss it on a runner; the path form cannot.
    expect(
      obsidianLaunchCommand({ platform: "darwin", appPath: "/Applications/Obsidian.app" }),
    ).toEqual({ command: "open", args: ["-a", "/Applications/Obsidian.app"] });
  });

  it("opens a macOS URI with open", () => {
    expect(obsidianLaunchCommand({ platform: "darwin", uri })).toEqual({
      command: "open",
      args: [uri],
    });
  });

  it("runs the Linux app directly, flags before the URI", () => {
    expect(
      obsidianLaunchCommand({
        platform: "linux",
        appPath: "/opt/obsidian/obsidian",
        flags: ["--no-sandbox", "--disable-gpu"],
        uri,
      }),
    ).toEqual({
      command: "/opt/obsidian/obsidian",
      args: ["--no-sandbox", "--disable-gpu", uri],
    });
  });

  it("starts the Linux app without a URI", () => {
    expect(
      obsidianLaunchCommand({
        platform: "linux",
        appPath: "/opt/obsidian/obsidian",
        flags: ["--no-sandbox"],
      }),
    ).toEqual({
      command: "/opt/obsidian/obsidian",
      args: ["--no-sandbox"],
    });
  });

  it("falls back to xdg-open for a Linux URI when no app path is set", () => {
    expect(obsidianLaunchCommand({ platform: "linux", uri })).toEqual({
      command: "xdg-open",
      args: [uri],
    });
  });
});

describe("layoutAssertionsEnabled", () => {
  it("runs on the reference platform by default", () => {
    expect(layoutAssertionsEnabled({ platform: "win32" })).toBe(true);
    expect(layoutAssertionsEnabled({ platform: "darwin", reference: "darwin" })).toBe(true);
  });

  it("skips on another platform by default", () => {
    expect(layoutAssertionsEnabled({ platform: "darwin" })).toBe(false);
    expect(layoutAssertionsEnabled({ platform: "linux" })).toBe(false);
  });

  it("can be forced on anywhere", () => {
    expect(layoutAssertionsEnabled({ platform: "darwin", override: "1" })).toBe(true);
    expect(layoutAssertionsEnabled({ platform: "linux", override: "1" })).toBe(true);
  });

  it("can be forced off on the reference platform", () => {
    expect(layoutAssertionsEnabled({ platform: "win32", override: "0" })).toBe(false);
  });

  it("honours a moved reference platform", () => {
    expect(layoutAssertionsEnabled({ platform: "darwin", reference: "darwin" })).toBe(true);
    expect(layoutAssertionsEnabled({ platform: "win32", reference: "darwin" })).toBe(false);
  });

  it("treats an unrelated override value as unset", () => {
    expect(layoutAssertionsEnabled({ platform: "darwin", override: "yes" })).toBe(false);
  });
});
