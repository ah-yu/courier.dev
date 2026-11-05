import { describe, expect, it } from "vitest";
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
