import { describe, expect, it } from "vitest";
import { classify } from "./classify";
import { byCodeUnits, type Surface } from "./surface";

/**
 * The direction-aware rules, as the table in `docs/api.md` reads them.
 *
 * Each case builds a minimal registry surface: the classifier only looks at the fields
 * the surface serializer writes, so a route fixture is enough to pin one rule.
 */

function jsonSchema(
  properties: Record<string, unknown> = {},
  required: string[] = [],
): Record<string, unknown> {
  return { type: "object", properties, required };
}

function jsonBody(
  properties: Record<string, unknown> = {},
  required: string[] = [],
): Record<string, unknown> {
  return { kind: "json", schema: jsonSchema(properties, required) };
}

function jsonResponse(
  properties: Record<string, unknown> = {},
  required: string[] = [],
): Record<string, unknown> {
  return { kind: "json", schema: jsonSchema(properties, required) };
}

function route(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    auth: "user",
    contract: "required",
    status: [200],
    body: { kind: "none" },
    response: jsonResponse({ id: { type: "string" } }, ["id"]),
    ...overrides,
  };
}

function frame(type: string): Record<string, unknown> {
  return {
    type: "object",
    properties: { type: { const: type, type: "string" } },
    required: ["type"],
  };
}

function surface(overrides: Partial<Surface> = {}): Surface {
  return {
    unknownKeys: "strip",
    http: {},
    ws: {
      upgrade: { path: "/", anyPath: true, contract: "exempt", headers: ["upgrade"] },
      client: { oneOf: [] },
      server: { oneOf: [] },
    },
    binary: { pushBody: { headerLengthBytes: 4 }, contentBatch: {}, blob: {} },
    error: {},
    constants: {},
    ...overrides,
  };
}

function withRoute(base: Surface, key: string, value: unknown): Surface {
  return { ...base, http: { ...(base.http as Record<string, unknown>), [key]: value } };
}

function verdict(before: Surface, after: Surface): string {
  return classify(before, after).verdict;
}

function routeVerdict(before: Record<string, unknown>, after: Record<string, unknown>): string {
  return verdict(withRoute(surface(), "POST /x", before), withRoute(surface(), "POST /x", after));
}

describe("the classifier", () => {
  it("answers unchanged when the surface is the same", () => {
    expect(verdict(surface(), surface())).toBe("unchanged");
  });

  it("reads a new route as additive and a removed one as breaking", () => {
    expect(verdict(surface(), withRoute(surface(), "POST /x", route()))).toBe("additive");
    expect(verdict(withRoute(surface(), "POST /x", route()), surface())).toBe("breaking");
  });

  it("distinguishes an optional request field from a required one", () => {
    const before = route({ body: jsonBody({ a: { type: "string" } }, ["a"]) });
    const optional = route({
      body: jsonBody({ a: { type: "string" }, b: { type: "string" } }, ["a"]),
    });
    const required = route({
      body: jsonBody({ a: { type: "string" }, b: { type: "string" } }, ["a", "b"]),
    });
    expect(routeVerdict(before, optional)).toBe("additive");
    expect(routeVerdict(before, required)).toBe("breaking");
  });

  it("reads a new response field as additive, but a removed one as breaking", () => {
    const before = route();
    const added = route({
      response: jsonResponse({ id: { type: "string" }, extra: { type: "string" } }, [
        "id",
        "extra",
      ]),
    });
    const removed = route({ response: jsonResponse({}, []) });
    expect(routeVerdict(before, added)).toBe("additive");
    expect(routeVerdict(before, removed)).toBe("breaking");
  });

  it("reads a narrowed request constraint as breaking and a widened one as additive", () => {
    const wide = route({ body: jsonBody({ name: { type: "string", maxLength: 255 } }, ["name"]) });
    const narrow = route({
      body: jsonBody({ name: { type: "string", maxLength: 100 } }, ["name"]),
    });
    const wider = route({ body: jsonBody({ name: { type: "string", maxLength: 300 } }, ["name"]) });
    expect(routeVerdict(wide, narrow)).toBe("breaking");
    expect(routeVerdict(wide, wider)).toBe("additive");
  });

  it("reads a removed status as breaking and an added one as additive", () => {
    const two = route({ status: [200, 206] });
    const one = route({ status: [200] });
    expect(routeVerdict(two, one)).toBe("breaking");
    expect(routeVerdict(one, two)).toBe("additive");
  });

  it("reads a tightened auth requirement as breaking", () => {
    expect(routeVerdict(route({ auth: "none" }), route({ auth: "user" }))).toBe("breaking");
  });

  it("reads a removed server frame as degrading and a removed client frame as breaking", () => {
    const withServer = surface({
      ws: {
        upgrade: { path: "/", anyPath: true, contract: "exempt", headers: ["upgrade"] },
        client: { oneOf: [] },
        server: { oneOf: [frame("ping")] },
      },
    });
    const withoutServer = surface({
      ws: {
        upgrade: { path: "/", anyPath: true, contract: "exempt", headers: ["upgrade"] },
        client: { oneOf: [] },
        server: { oneOf: [] },
      },
    });
    expect(verdict(withServer, withoutServer)).toBe("degrading");

    const withClient = surface({
      ws: {
        upgrade: { path: "/", anyPath: true, contract: "exempt", headers: ["upgrade"] },
        client: { oneOf: [frame("pong")] },
        server: { oneOf: [] },
      },
    });
    expect(verdict(withClient, withoutServer)).toBe("breaking");
  });

  it("reads any binary framing change as breaking", () => {
    const changed = surface({
      binary: { pushBody: { headerLengthBytes: 8 }, contentBatch: {}, blob: {} },
    });
    expect(verdict(surface(), changed)).toBe("breaking");
  });

  it("treats a constant's array as a set", () => {
    const two = surface({ constants: { API_ERROR_CODES: ["A", "B"] } });
    const three = surface({ constants: { API_ERROR_CODES: ["A", "B", "C"] } });
    expect(verdict(two, three)).toBe("additive");
    expect(verdict(three, two)).toBe("breaking");
  });

  it("orders by code unit, never by locale", () => {
    expect(byCodeUnits("Z", "a")).toBeLessThan(0);
  });

  it("lets a degrading change outrank an additive one, but not a breaking one", () => {
    const before = withRoute(
      surface({
        ws: {
          upgrade: { path: "/", anyPath: true, contract: "exempt", headers: ["upgrade"] },
          client: { oneOf: [] },
          server: { oneOf: [frame("ping")] },
        },
      }),
      "POST /x",
      route(),
    );
    const after = withRoute(
      withRoute(
        surface({
          ws: {
            upgrade: { path: "/", anyPath: true, contract: "exempt", headers: ["upgrade"] },
            client: { oneOf: [] },
            server: { oneOf: [] },
          },
        }),
        "POST /x",
        route(),
      ),
      "POST /y",
      route(),
    );
    expect(verdict(before, after)).toBe("degrading");

    const breaking = withRoute(before, "POST /x", route({ status: [] }));
    expect(verdict(before, breaking)).toBe("breaking");
  });
});
