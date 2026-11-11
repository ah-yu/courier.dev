/**
 * The committed surface, serialized from the registry.
 *
 * There is no source scan here: `WIRE` is the same object the server builds its route
 * table from. The serializer's only job is to turn runtime schemas and values into a
 * deterministic, reviewable JSON tree — sorted keys, sorted sets, no `$schema`, no
 * `additionalProperties` (Zod strips unknown keys, it does not reject them).
 */
import { WIRE } from "./registry";
import type { HttpBody, HttpContract, HttpResponse } from "./registry";
import type { WireSchema } from "./schema";
import { z } from "./schema";

/** The committed surface: what a peer can observe, grouped the way it is authored. */
export interface WireSurface {
  /** Unknown JSON keys are ignored by every object schema. */
  unknownKeys: "strip";
  http: Record<string, unknown>;
  ws: unknown;
  binary: unknown;
  /** The body of every failed request. */
  error: unknown;
  constants: unknown;
}

export function readSurface(): WireSurface {
  const http: Record<string, unknown> = {};
  for (const contract of WIRE.http as readonly HttpContract[]) {
    http[`${contract.method} ${contract.path}`] = {
      auth: contract.auth,
      ...(contract.scope === undefined ? {} : { scope: contract.scope }),
      contract: contract.contract,
      status: [...contract.status],
      body: serializeBody(contract.body),
      ...(contract.query === undefined ? {} : { query: schemaOf(contract.query) }),
      ...(contract.params === undefined ? {} : { params: schemaOf(contract.params) }),
      ...(contract.paramFailure === undefined ? {} : { paramFailure: contract.paramFailure }),
      response: serializeResponse(contract.response),
      ...(contract.errors === undefined ? {} : { errors: [...contract.errors] }),
      ...(contract.headers === undefined ? {} : { headers: contract.headers }),
    };
  }

  return {
    unknownKeys: "strip",
    http: sortRecord(http),
    ws: {
      upgrade: { ...WIRE.ws.upgrade },
      client: schemaOf(WIRE.ws.client),
      server: schemaOf(WIRE.ws.server),
    },
    binary: {
      pushBody: { ...WIRE.binary.pushBody, header: schemaOf(WIRE.binary.pushBody.header) },
      contentBatch: { ...WIRE.binary.contentBatch },
      blob: { ...WIRE.binary.blob },
    },
    error: schemaOf(WIRE.error),
    constants: sortRecord(
      Object.fromEntries(
        Object.entries(WIRE.constants).map(([name, value]) => [name, valueOf(value)]),
      ),
    ),
  };
}

/** The surface as the committed file: deterministic JSON, one trailing newline. */
export function formatSurface(surface: WireSurface): string {
  return `${JSON.stringify(surface, null, 2)}\n`;
}

function serializeBody(body: HttpBody): unknown {
  switch (body.kind) {
    case "none":
      return { kind: "none" };
    case "json":
      return { kind: "json", schema: schemaOf(body.schema) };
    case "push":
      // The parsed body carries `Uint8Array`, which JSON Schema cannot express; the
      // wire is the header schema plus the binary frame's content rule.
      return { kind: "push", schema: schemaOf(WIRE.binary.pushBody.header) };
    case "bytes":
      return { kind: "bytes", limit: body.limit };
  }
}

function serializeResponse(response: HttpResponse): unknown {
  switch (response.kind) {
    case "none":
      return { kind: "none" };
    case "json":
      return { kind: "json", schema: schemaOf(response.schema) };
    case "binary":
      return { kind: "binary", contentType: response.contentType };
    case "stream":
      return {
        kind: "stream",
        contentType: response.contentType,
        headers: [...response.headers],
      };
  }
}

/** One schema as JSON Schema, canonicalised so the same tree always prints the same way. */
function schemaOf(schema: WireSchema): unknown {
  const json = z.toJSONSchema(schema, { target: "draft-2020-12" }) as unknown;
  return canonical(json);
}

/**
 * Canonical JSON Schema.
 *
 * Zod emits a stable tree, but the surface is committed and compared on three CI
 * platforms, so the serializer owns the order: object keys and every set-valued array
 * (`required`, `enum`, `type`, `anyOf`, `oneOf`, `allOf`) are sorted by code units.
 * `additionalProperties` is dropped because Zod's object schema **strips** unknown keys;
 * recording it as `false` would describe a rejection that never happens.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of sorted(Object.keys(source), byCodeUnits)) {
    if (key === "$schema" || key === "additionalProperties") continue;
    if (
      key === "required" ||
      key === "enum" ||
      key === "type" ||
      key === "anyOf" ||
      key === "oneOf" ||
      key === "allOf"
    ) {
      const list = source[key];
      if (Array.isArray(list)) {
        const members = sorted(list.map(canonical), (left: unknown, right: unknown) =>
          byCodeUnits(JSON.stringify(left), JSON.stringify(right)),
        );
        if (members.length > 0) out[key] = members;
        continue;
      }
    }
    out[key] = canonical(source[key]);
  }
  return out;
}

/**
 * A constant's value, with a regex as its source and flags.
 *
 * The registry's constants are numbers, strings, booleans, regexes and `as const` arrays;
 * a nested object would be serialized by `JSON.stringify` as authored, which is still
 * deterministic. Keeping the branches to the shapes that exist is what makes the surface
 * coverage honest rather than a list of unreachable cases.
 */
function valueOf(value: unknown): unknown {
  if (value instanceof RegExp) return { regex: value.source, flags: value.flags };
  if (Array.isArray(value)) return value.map(valueOf);
  return value;
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  const ordered: Record<string, T> = {};
  for (const key of sorted(Object.keys(record), byCodeUnits)) ordered[key] = record[key]!;
  return ordered;
}

/**
 * A stable sort by code unit, written without `Array#sort`.
 *
 * `toSorted` is ES2023 and this module is type-checked under the consumers' ES2022 libs
 * (the engine and the plugin), so the helper keeps the module inside the runtime surface
 * every host already has. The arrays are small (schema keys, set members).
 */
function sorted<T>(items: readonly T[], compare: (left: T, right: T) => number): T[] {
  const result = [...items];
  for (let index = 1; index < result.length; index += 1) {
    const item = result[index];
    let position = index - 1;
    while (position >= 0 && compare(result[position], item) > 0) {
      result[position + 1] = result[position];
      position -= 1;
    }
    result[position + 1] = item;
  }
  return result;
}

/** Compare by code unit, never locale: the surface is committed and diffed on CI. */
export function byCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
