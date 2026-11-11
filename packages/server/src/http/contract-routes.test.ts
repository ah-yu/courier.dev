import { z, type HttpContract } from "@courier/shared/wire";
import { describe, expect, it } from "vitest";
import type { Logger } from "../lib/logger";
import { toRouteTable, type RouteDeps, type RouteHandlerBody } from "./contract-routes";
import type { RouteRequest, RouteTable } from "./router";

/**
 * The adapter's guards, which the e2e suite only sees on the happy path.
 *
 * `toRouteTable` is the one place a missing handler, a duplicate route or a contract that
 * contradicts its auth is turned into a startup error; the response side turns a mismatch
 * into a 500 before a bad body reaches a peer.
 */

const logger: Logger = {
  level: "error",
  enabled: () => false,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const deps: RouteDeps = {
  findUserByKey: async () => undefined,
  findVaultById: async () => undefined,
  findByKey: async () => undefined,
};

const okSchema = z.object({ ok: z.boolean() });

function contract(overrides: Partial<HttpContract> = {}): HttpContract {
  return {
    id: "test.get",
    method: "GET",
    path: "/api/test",
    auth: "none",
    contract: "exempt",
    body: { kind: "none" },
    response: { kind: "json", schema: okSchema },
    status: [200],
    ...overrides,
  };
}

const ok: RouteHandlerBody = () => ({ body: { ok: true } });

async function call(table: RouteTable, path = "/api/test"): Promise<Response> {
  const route = table[path]?.GET;
  if (route === undefined) throw new Error(`no route for ${path}`);
  const request = Object.assign(new Request(`http://localhost${path}`), { params: {} });
  return await route(request as RouteRequest);
}

describe("toRouteTable", () => {
  it("refuses a contract without a handler", () => {
    expect(() => toRouteTable([contract()], {}, logger, deps)).toThrow(/no handler/);
  });

  it("refuses a handler without a contract", () => {
    expect(() => toRouteTable([], { "test.get": ok }, logger, deps)).toThrow(/has no route/);
  });

  it("refuses a duplicate route", () => {
    expect(() => toRouteTable([contract(), contract()], { "test.get": ok }, logger, deps)).toThrow(
      /duplicate route/,
    );
  });

  it("refuses a host route without a scope", () => {
    expect(() =>
      toRouteTable([contract({ auth: "host" })], { "test.get": ok }, logger, deps),
    ).toThrow(/host-key scope/);
  });

  it("refuses a contract flag that contradicts its auth", () => {
    expect(() =>
      toRouteTable([contract({ contract: "required" })], { "test.get": ok }, logger, deps),
    ).toThrow(/declares contract=required/);
  });

  it("serves a JSON response that matches its schema", async () => {
    const table = toRouteTable([contract()], { "test.get": ok }, logger, deps);
    const response = await call(table);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("answers 500 for a raw Response on a JSON route", async () => {
    const table = toRouteTable(
      [contract()],
      { "test.get": () => new Response("raw") },
      logger,
      deps,
    );
    expect((await call(table)).status).toBe(500);
  });

  it("answers 500 for a JSON body on a stream route", async () => {
    const table = toRouteTable(
      [contract({ response: { kind: "stream", contentType: "x", headers: [] } })],
      { "test.get": () => ({ body: {} }) },
      logger,
      deps,
    );
    expect((await call(table)).status).toBe(500);
  });

  it("answers 500 for an undeclared status", async () => {
    const table = toRouteTable(
      [contract()],
      { "test.get": () => ({ status: 201, body: { ok: true } }) },
      logger,
      deps,
    );
    expect((await call(table)).status).toBe(500);
  });

  it("answers 500 for a response that does not match its schema", async () => {
    const table = toRouteTable(
      [contract()],
      { "test.get": () => ({ body: { ok: "yes" } }) },
      logger,
      deps,
    );
    expect((await call(table)).status).toBe(500);
  });
});
