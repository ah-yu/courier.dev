import { describe, expect, it } from "vitest";
import { arrayMembers, classify } from "./classify";
import type { Property, Surface } from "./surface";

/**
 * The classifier is the gate's whole product: it decides which of the two numbers a wire
 * change moves, and its output is what an agent writes. Each rule in `docs/api.md`'s table
 * is pinned here, because a regression in it silently changes a compatibility promise.
 *
 * The cases are the shapes a real change takes, not every possible one: a new optional
 * field, a new required one, a removal, a retype, a route, and a member of an `as const`
 * set — the last one is the one that once read as "breaking" because the surface stores a
 * constant as its printed text.
 */
function surface(overrides: Partial<Surface> = {}): Surface {
  return { types: {}, routes: {}, constants: {}, ...overrides };
}

function text(value: string): Property {
  return { optional: false, shape: { primitive: value } };
}

function iface(entries: Record<string, Property>): Surface["types"][string] {
  return { kind: "interface", extends: [], properties: entries };
}

describe("classify", () => {
  it("answers unchanged when the surface is the same", () => {
    const one = surface({
      types: { A: iface({ a: text("string") }) },
      routes: { "/api/x": ["GET"] },
    });
    const two = surface({
      types: { A: iface({ a: text("string") }) },
      routes: { "/api/x": ["GET"] },
    });
    expect(classify(one, two).verdict).toBe("unchanged");
  });

  it("reads a new optional field as additive", () => {
    const result = classify(
      surface({ types: { A: iface({ a: text("string") }) } }),
      surface({
        types: {
          A: iface({ a: text("string"), b: { optional: true, shape: { primitive: "string" } } }),
        },
      }),
    );
    expect(result.verdict).toBe("additive");
  });

  it("reads a new required field as breaking", () => {
    // An older client cannot send it, and the surface does not say whether this is a request
    // or a response, so the conservative reading is the one that keeps the two in step.
    const result = classify(
      surface({ types: { A: iface({ a: text("string") }) } }),
      surface({ types: { A: iface({ a: text("string"), b: text("string") }) } }),
    );
    expect(result.verdict).toBe("breaking");
  });

  it("reads a removed field as breaking", () => {
    const result = classify(
      surface({ types: { A: iface({ a: text("string"), b: text("string") }) } }),
      surface({ types: { A: iface({ a: text("string") }) } }),
    );
    expect(result.verdict).toBe("breaking");
  });

  it("reads a retyped field as breaking", () => {
    const result = classify(
      surface({ types: { A: iface({ a: text("string") }) } }),
      surface({ types: { A: iface({ a: text("number") }) } }),
    );
    expect(result.verdict).toBe("breaking");
  });

  it("reads optional -> required as breaking and the reverse as additive", () => {
    const optional = surface({
      types: { A: iface({ a: { optional: true, shape: { primitive: "string" } } }) },
    });
    const required = surface({ types: { A: iface({ a: text("string") }) } });
    expect(classify(optional, required).verdict).toBe("breaking");
    expect(classify(required, optional).verdict).toBe("additive");
  });

  it("reads an added route as additive and a removed one as breaking", () => {
    expect(classify(surface(), surface({ routes: { "/api/x": ["GET"] } })).verdict).toBe(
      "additive",
    );
    expect(classify(surface({ routes: { "/api/x": ["GET"] } }), surface()).verdict).toBe(
      "breaking",
    );
    expect(
      classify(
        surface({ routes: { "/api/x": ["GET", "POST"] } }),
        surface({ routes: { "/api/x": ["GET"] } }),
      ).verdict,
    ).toBe("breaking");
  });

  it("reads an identical-shape type rename as additive", () => {
    const result = classify(
      surface({ types: { Old: iface({ a: text("string") }) } }),
      surface({ types: { New: iface({ a: text("string") }) } }),
    );
    expect(result.verdict).toBe("additive");
  });

  it("reads a member added to an `as const` set as additive", () => {
    // The case that matters: a new error code is a string in the surface, not a shape, so
    // comparing the text would have raised the client floor for something no old client can
    // notice.
    const result = classify(
      surface({ constants: { API_ERROR_CODES: '["A", "B"] as const' } }),
      surface({ constants: { API_ERROR_CODES: '["A", "B", "C"] as const' } }),
    );
    expect(result.verdict).toBe("additive");
    expect(result.changes[0]?.detail).toContain("C");
  });

  it("reads a member removed from an `as const` set as breaking", () => {
    const result = classify(
      surface({ constants: { API_ERROR_CODES: '["A", "B"] as const' } }),
      surface({ constants: { API_ERROR_CODES: '["A"] as const' } }),
    );
    expect(result.verdict).toBe("breaking");
  });

  it("reads a reformatted set with the same members as unchanged", () => {
    const result = classify(
      surface({ constants: { API_ERROR_CODES: '["A", "B"] as const' } }),
      surface({ constants: { API_ERROR_CODES: '["B", "A"] as const' } }),
    );
    expect(result.verdict).toBe("unchanged");
  });

  it("reads a changed scalar constant as breaking", () => {
    const result = classify(
      surface({ constants: { CHUNK_PLAINTEXT_BYTES: "4 * 1024 * 1024" } }),
      surface({ constants: { CHUNK_PLAINTEXT_BYTES: "8 * 1024 * 1024" } }),
    );
    expect(result.verdict).toBe("breaking");
  });
});

describe("arrayMembers", () => {
  it("reads a set of literals", () => {
    expect(arrayMembers('["a", "b", "c"] as const')).toEqual(['"a"', '"b"', '"c"']);
    expect(arrayMembers("[1, 2] as const")).toEqual(["1", "2"]);
  });

  it("ignores comments inside the set", () => {
    // The surface stores the printed source, and a comment explaining a code is exactly
    // where one lands. Left in, the set became unreadable and fell back to a text compare.
    expect(arrayMembers('[\n  "A", // why A exists\n  "B",\n] as const')).toEqual(['"A"', '"B"']);
    expect(arrayMembers('[/* the codes */ "A", "B"] as const')).toEqual(['"A"', '"B"']);
  });

  it("answers null for anything that is not a set of literals", () => {
    expect(arrayMembers("4 * 1024 * 1024")).toBeNull();
    expect(arrayMembers("[SOME_REFERENCE] as const")).toBeNull();
    expect(arrayMembers('["a"]')).toBeNull();
  });
});
