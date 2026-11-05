import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { jsLiteral, unwrapEvalPayload } from "./cli";

/**
 * The two pure halves of the CLI wrapper: the literal that carries a value into
 * `code=...`, and the parsing that carries a result back out.
 *
 * Both fail in ways the app cannot explain, and both are invisible to a green L3
 * run. A mis-escaped literal is a syntax error inside Obsidian's **main process** —
 * the case that once left every later CLI call answering "unable to find Obsidian"
 * until the app was restarted. A parser that misses the CLI's quoting reports a
 * successful read as "returned nothing usable", which reads like a missing vault.
 * Neither needs a running app, so they are pinned here rather than in the opt-in
 * suite; `jsLiteral` in particular exists only because the code travels as one argv
 * element through `cmd.exe`, a path CI's Linux runner never exercises.
 */

describe("jsLiteral", () => {
  it("wraps a value in single quotes", () => {
    expect(jsLiteral("notes/a.md")).toBe("'notes/a.md'");
  });

  it("escapes the quote it wraps with", () => {
    expect(jsLiteral("it's")).toBe("'it\\'s'");
  });

  it("escapes a backslash before it can be read as an escape", () => {
    expect(jsLiteral("C:\\vault\\a.md")).toBe("'C:\\\\vault\\\\a.md'");
  });

  it("flattens both line endings into one escape", () => {
    expect(jsLiteral("a\nb")).toBe("'a\\nb'");
    expect(jsLiteral("a\r\nb")).toBe("'a\\nb'");
  });

  it("adds no double quote of its own", () => {
    // The whole code argument is one argv element, so a double quote it introduced is
    // the one cmd.exe would re-interpret; a value's own double quotes stay untouched.
    expect(jsLiteral("plain")).not.toContain('"');
    expect(jsLiteral('say "hi"')).toBe("'say \"hi\"'");
  });

  it("cannot be broken out of by a quote in the value", () => {
    expect(jsLiteral("'); throw new Error('boom")).toBe("'\\'); throw new Error(\\'boom'");
  });
});

describe("unwrapEvalPayload", () => {
  it("reads the value the CLI prints after its marker", () => {
    expect(unwrapEvalPayload("=> 42")).toBe("42");
  });

  it("takes the last non-empty line, so a banner or a blank tail is ignored", () => {
    expect(unwrapEvalPayload('Loading vault...\n\n=> "ok"\n\n')).toBe("ok");
  });

  it("unquotes the JSON string literal the CLI adds to a string result", () => {
    expect(unwrapEvalPayload('=> "a\\nb"')).toBe("a\nb");
  });

  it("keeps a payload that only starts and ends with a quote", () => {
    expect(unwrapEvalPayload('=> "a" "b"')).toBe('"a" "b"');
  });

  it("keeps an unterminated quoted payload raw", () => {
    expect(unwrapEvalPayload('=> "unterminated')).toBe('"unterminated');
  });

  it("reads CRLF output from Windows", () => {
    expect(unwrapEvalPayload("noise\r\n=> 7\r\n")).toBe("7");
  });

  it("answers an empty string when the CLI printed nothing", () => {
    expect(unwrapEvalPayload("")).toBe("");
    expect(unwrapEvalPayload("\n \r\n")).toBe("");
  });

  it("leaves an ERR: payload for evalInVault to report", () => {
    expect(unwrapEvalPayload('=> "ERR:boom"')).toBe("ERR:boom");
  });
});

/**
 * The timeout has to **end the process**, not just stop waiting for it.
 *
 * The failure this pins was seen on macOS: Obsidian's CLI ignored the default SIGTERM
 * while it sat in its socket read, so a request the app never answered kept the call
 * pending past its timeout. Every later helper waited behind it until Vitest's 300 s
 * hook timeout — the hang that took the L3 job down. A shell that traps TERM stands in
 * for it; only SIGKILL can end that one.
 */
// POSIX only: the fake CLI needs a shell that can trap TERM. Windows maps SIGKILL to
// TerminateProcess; the Windows L3 job exercises that path end to end.
const itPosix = process.platform === "win32" ? it.skip : it;

describe("runObsidianCli timeout", () => {
  itPosix(
    "kills a CLI that ignores SIGTERM instead of waiting for the process to exit",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "courier-fake-cli-"));
      const cli = join(dir, "obsidian");
      const pidFile = join(dir, "pid");
      await writeFile(
        cli,
        '#!/bin/sh\ntrap \'\' TERM\necho $$ > "$FAKE_CLI_PID_FILE"\ni=0\nwhile [ "$i" -lt 30 ]; do sleep 1; i=$((i + 1)); done\n',
      );
      await chmod(cli, 0o755);
      const previousCli = process.env.COURIER_OBSIDIAN_CLI;
      const previousPid = process.env.FAKE_CLI_PID_FILE;
      process.env.COURIER_OBSIDIAN_CLI = cli;
      process.env.FAKE_CLI_PID_FILE = pidFile;
      // `CLI_BINARY` is resolved when the module loads, so the override needs a fresh
      // instance rather than the one this file imported for the pure helpers.
      vi.resetModules();
      try {
        const { runObsidianCli } = await import("./cli");
        const started = Date.now();
        const result = await runObsidianCli(["version"], 2_000);
        expect(result.status).toBe(-1);
        expect(result.stderr).toContain("did not answer within 2000ms");
        expect(result.stderr).toContain("version");
        expect(Date.now() - started).toBeLessThan(10_000);

        let pid = 0;
        for (let attempt = 0; attempt < 40 && pid === 0; attempt++) {
          try {
            pid = Number((await readFile(pidFile, "utf8")).trim());
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
        expect(pid).toBeGreaterThan(0);
        let alive = true;
        for (let attempt = 0; attempt < 20; attempt++) {
          try {
            process.kill(pid, 0);
          } catch {
            alive = false;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(alive).toBe(false);
      } finally {
        if (previousCli === undefined) delete process.env.COURIER_OBSIDIAN_CLI;
        else process.env.COURIER_OBSIDIAN_CLI = previousCli;
        if (previousPid === undefined) delete process.env.FAKE_CLI_PID_FILE;
        else process.env.FAKE_CLI_PID_FILE = previousPid;
        await rm(dir, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
