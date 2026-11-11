/**
 * The rule that turns a surface difference into the numbers to write.
 *
 * The whole design rests on one question — *would the old side misread this byte?* —
 * and this module answers it for the registry surface. Four outcomes:
 *
 * - **unchanged**: nothing a peer can observe moved.
 * - **additive**: an older peer still reads it correctly (a new optional request field,
 *   a new route, a new error code). Only `CONTRACT_GENERATION` moves.
 * - **degrading**: an older peer ignores or misses something but does not misread it (a
 *   renamed server frame, a response enum value it does not know). The generation moves;
 *   the client floor stays.
 * - **breaking**: an older peer would read the same bytes differently, or could not send
 *   a request the server now requires. Every number moves.
 *
 * Direction matters now, because the registry says which side a schema describes: a new
 * required **request** field breaks an old sender, while a new required **response** field
 * is ignored by an old reader. The old declaration-only surface could not tell them apart
 * and treated both as breaking.
 */
import { byCodeUnits, type Surface } from "./surface";

export type Verdict = "unchanged" | "additive" | "degrading" | "breaking";
export type Direction = "request" | "response";

/** One observable difference, with the reading that decides the numbers to write. */
export interface Change {
  verdict: "additive" | "degrading" | "breaking";
  /** Where it is, in a form a reader can search the registry for. */
  path: string;
  /** What changed, as one sentence. */
  detail: string;
  /** For an addition: the bare identifier, for the client-usage hint. */
  name?: string;
}

export interface Classification {
  changes: Change[];
  verdict: Verdict;
}

/** Compare two surfaces. Never throws: a missing side is an addition or a removal. */
export function classify(previous: Surface, current: Surface): Classification {
  const changes: Change[] = [];
  diffHttp(previous.http, current.http, changes);
  diffWs(previous.ws, current.ws, changes);
  diffBinary(previous.binary, current.binary, changes);
  diffSchema(previous.error, current.error, "error", "response", changes);
  diffConstants(previous.constants, current.constants, changes);
  if (previous.unknownKeys !== current.unknownKeys) {
    changes.push({
      verdict: "breaking",
      path: "unknownKeys",
      detail: "the rule for unknown JSON keys changed",
    });
  }
  // Fail closed: a serialized field the classifier does not model must not pass as
  // "unchanged" just because no rule read it.
  if (changes.length === 0 && JSON.stringify(previous) !== JSON.stringify(current)) {
    changes.push({
      verdict: "breaking",
      path: "surface",
      detail: "the surface changed in a field the classifier does not model",
    });
  }

  const sorted = [...changes].toSorted((left, right) => byCodeUnits(left.path, right.path));
  return { changes: sorted, verdict: verdictOf(sorted) };
}

/** The single line a caller prints before acting. */
export function verdictOf(changes: readonly Change[]): Verdict {
  if (changes.some((change) => change.verdict === "breaking")) return "breaking";
  if (changes.some((change) => change.verdict === "degrading")) return "degrading";
  if (changes.length > 0) return "additive";
  return "unchanged";
}

/** Bare identifiers that were added — the client-usage check greps for these. */
export function addedNames(changes: readonly Change[]): string[] {
  const names = new Set<string>();
  for (const change of changes) {
    if (change.verdict === "additive" && change.name !== undefined) names.add(change.name);
  }
  return [...names].toSorted(byCodeUnits);
}

// ── HTTP ──

function diffHttp(before: unknown, after: unknown, changes: Change[]): void {
  const oldRoutes = record(before);
  const newRoutes = record(after);
  const paths = [...new Set([...Object.keys(oldRoutes), ...Object.keys(newRoutes)])].toSorted(
    byCodeUnits,
  );
  for (const path of paths) {
    const oldRoute = object(oldRoutes[path]);
    const newRoute = object(newRoutes[path]);
    if (oldRoute === null) {
      changes.push({ verdict: "additive", path, detail: "new route", name: path });
      continue;
    }
    if (newRoute === null) {
      changes.push({ verdict: "breaking", path, detail: "the route is gone" });
      continue;
    }
    diffRoute(path, oldRoute, newRoute, changes);
  }
}

function diffRoute(
  path: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  changes: Change[],
): void {
  diffAuth(path, before.auth, after.auth, changes);
  if (before.scope !== after.scope) {
    changes.push({
      verdict: "breaking",
      path: `${path}.scope`,
      detail: "the host-key scope changed",
    });
  }
  diffContractFlag(path, before.contract, after.contract, changes);
  if (before.paramFailure !== after.paramFailure) {
    changes.push({
      verdict: "breaking",
      path: `${path}.paramFailure`,
      detail: "a malformed path parameter answers differently",
    });
  }
  diffStatus(path, before.status, after.status, changes);
  diffBody(path, before.body, after.body, changes);
  diffQuery(path, before.query, after.query, changes);
  diffParams(path, before.params, after.params, changes);
  diffResponse(path, before.response, after.response, changes);
  diffErrorCodes(path, before.errors, after.errors, changes);
  diffHeaders(path, before.headers, after.headers, changes);
}

function diffAuth(path: string, before: unknown, after: unknown, changes: Change[]): void {
  const oldAuth = string(before);
  const newAuth = string(after);
  if (oldAuth === newAuth) return;
  const verdict: Change["verdict"] =
    oldAuth === "none" && newAuth !== "none"
      ? "breaking"
      : oldAuth !== "none" && newAuth === "none"
        ? "additive"
        : "breaking";
  changes.push({
    verdict,
    path: `${path}.auth`,
    detail: `auth changed from ${oldAuth ?? "absent"} to ${newAuth ?? "absent"}`,
  });
}

function diffContractFlag(path: string, before: unknown, after: unknown, changes: Change[]): void {
  const oldFlag = string(before);
  const newFlag = string(after);
  if (oldFlag === newFlag) return;
  changes.push({
    verdict: oldFlag === "exempt" && newFlag === "required" ? "breaking" : "additive",
    path: `${path}.contract`,
    detail: `the contract header is now ${newFlag ?? "absent"}`,
  });
}

function diffStatus(path: string, before: unknown, after: unknown, changes: Change[]): void {
  const oldStatus = new Set(values(before).map((value) => String(value)));
  const newStatus = new Set(values(after).map((value) => String(value)));
  for (const status of newStatus) {
    if (!oldStatus.has(status)) {
      changes.push({ verdict: "additive", path: `${path}.status`, detail: `${status} was added` });
    }
  }
  for (const status of oldStatus) {
    if (!newStatus.has(status)) {
      changes.push({
        verdict: "breaking",
        path: `${path}.status`,
        detail: `${status} was removed`,
      });
    }
  }
}

function diffBody(path: string, before: unknown, after: unknown, changes: Change[]): void {
  const oldBody = object(before);
  const newBody = object(after);
  if (oldBody === null || newBody === null) return;
  const oldKind = string(oldBody.kind);
  const newKind = string(newBody.kind);
  if (oldKind !== newKind) {
    changes.push({
      verdict: "breaking",
      path: `${path}.body`,
      detail: `body changed from ${oldKind ?? "absent"} to ${newKind ?? "absent"}`,
    });
    return;
  }
  if (oldKind === "json" || oldKind === "push") {
    diffSchema(oldBody.schema, newBody.schema, `${path}.body`, "request", changes);
  }
  if (oldKind === "bytes" && oldBody.limit !== newBody.limit) {
    changes.push({
      verdict: "breaking",
      path: `${path}.body.limit`,
      detail: `body limit changed from ${string(oldBody.limit) ?? "absent"} to ${string(newBody.limit) ?? "absent"}`,
    });
  }
}

function diffQuery(path: string, before: unknown, after: unknown, changes: Change[]): void {
  if (before === undefined && after === undefined) return;
  if (before === undefined && after !== undefined) {
    const required = requiredKeys(after);
    changes.push({
      verdict: required.length > 0 ? "breaking" : "additive",
      path: `${path}.query`,
      detail:
        required.length > 0 ? `new required query ${required.join(", ")}` : "new optional query",
    });
    return;
  }
  if (before !== undefined && after === undefined) {
    changes.push({ verdict: "additive", path: `${path}.query`, detail: "the query is gone" });
    return;
  }
  diffSchema(before, after, `${path}.query`, "request", changes);
}

function diffParams(path: string, before: unknown, after: unknown, changes: Change[]): void {
  if (before === undefined && after === undefined) return;
  if (before === undefined && after !== undefined) {
    changes.push({ verdict: "breaking", path: `${path}.params`, detail: "new path parameters" });
    return;
  }
  if (before !== undefined && after === undefined) {
    changes.push({
      verdict: "additive",
      path: `${path}.params`,
      detail: "path parameters are no longer checked",
    });
    return;
  }
  diffSchema(before, after, `${path}.params`, "request", changes);
}

function diffResponse(path: string, before: unknown, after: unknown, changes: Change[]): void {
  const oldResponse = object(before);
  const newResponse = object(after);
  if (oldResponse === null || newResponse === null) return;
  const oldKind = string(oldResponse.kind);
  const newKind = string(newResponse.kind);
  if (oldKind !== newKind) {
    changes.push({
      verdict: "breaking",
      path: `${path}.response`,
      detail: `response changed from ${oldKind ?? "absent"} to ${newKind ?? "absent"}`,
    });
    return;
  }
  if (oldKind === "json") {
    diffSchema(oldResponse.schema, newResponse.schema, `${path}.response`, "response", changes);
    return;
  }
  if (oldResponse.contentType !== newResponse.contentType) {
    changes.push({
      verdict: "breaking",
      path: `${path}.response.contentType`,
      detail: `content type changed from ${string(oldResponse.contentType) ?? "absent"} to ${string(newResponse.contentType) ?? "absent"}`,
    });
  }
  if (oldKind === "stream") {
    diffStrings(path, oldResponse.headers, newResponse.headers, changes, "response header");
  }
}

function diffErrorCodes(path: string, before: unknown, after: unknown, changes: Change[]): void {
  if (before === undefined && after === undefined) return;
  const oldCodes = new Set(values(before).map((value) => String(value)));
  const newCodes = new Set(values(after).map((value) => String(value)));
  for (const code of newCodes) {
    if (!oldCodes.has(code)) {
      changes.push({ verdict: "additive", path: `${path}.errors`, detail: `new error ${code}` });
    }
  }
  for (const code of oldCodes) {
    if (!newCodes.has(code)) {
      changes.push({ verdict: "breaking", path: `${path}.errors`, detail: `${code} is gone` });
    }
  }
}

function diffHeaders(path: string, before: unknown, after: unknown, changes: Change[]): void {
  const oldHeaders = object(before);
  const newHeaders = object(after);
  for (const side of ["request", "response"] as const) {
    diffStrings(path, oldHeaders?.[side], newHeaders?.[side], changes, `${side} header`);
  }
}

function diffStrings(
  path: string,
  before: unknown,
  after: unknown,
  changes: Change[],
  label: string,
): void {
  const oldValues = new Set(values(before).map((value) => String(value)));
  const newValues = new Set(values(after).map((value) => String(value)));
  for (const value of newValues) {
    if (!oldValues.has(value)) {
      changes.push({
        verdict: "additive",
        path: `${path}.headers`,
        detail: `new ${label} ${value}`,
      });
    }
  }
  for (const value of oldValues) {
    if (!newValues.has(value)) {
      changes.push({
        verdict: "breaking",
        path: `${path}.headers`,
        detail: `${label} ${value} is gone`,
      });
    }
  }
}

// ── JSON Schema ──

const CONSTRAINT_KEYS = [
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "multipleOf",
  "minProperties",
  "maxProperties",
] as const;

function diffSchema(
  before: unknown,
  after: unknown,
  path: string,
  direction: Direction,
  changes: Change[],
): void {
  if (before === undefined && after === undefined) return;
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  const oldSchema = object(before);
  const newSchema = object(after);
  if (oldSchema === null || newSchema === null) {
    changes.push({ verdict: "breaking", path, detail: "the schema is gone or changed shape" });
    return;
  }

  diffEnum(path, oldSchema, newSchema, direction, changes);
  diffTypes(path, oldSchema, newSchema, direction, changes);
  diffProperties(path, oldSchema, newSchema, direction, changes);
  diffConstraints(path, oldSchema, newSchema, direction, changes);

  if (oldSchema.items !== undefined || newSchema.items !== undefined) {
    diffSchema(oldSchema.items, newSchema.items, `${path}[]`, direction, changes);
  }
  if (oldSchema.prefixItems !== undefined || newSchema.prefixItems !== undefined) {
    const oldItems = values(oldSchema.prefixItems);
    const newItems = values(newSchema.prefixItems);
    if (oldItems.length !== newItems.length) {
      changes.push({ verdict: "breaking", path, detail: "the tuple's length changed" });
    } else {
      oldItems.forEach((item, index) => {
        diffSchema(item, newItems[index], `${path}.prefixItems[${index}]`, direction, changes);
      });
    }
  }
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    if (oldSchema[key] === undefined && newSchema[key] === undefined) continue;
    diffVariants(path, key, oldSchema[key], newSchema[key], direction, changes);
  }
}

function diffEnum(
  path: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  direction: Direction,
  changes: Change[],
): void {
  const oldValues = enumValues(before);
  const newValues = enumValues(after);
  if (oldValues === null && newValues === null) return;
  if (oldValues === null || newValues === null) {
    changes.push({ verdict: "breaking", path, detail: "the value set changed shape" });
    return;
  }
  for (const value of newValues) {
    if (!oldValues.has(value)) {
      changes.push({
        verdict: direction === "request" ? "additive" : "degrading",
        path,
        detail: `new value ${value}`,
      });
    }
  }
  for (const value of oldValues) {
    if (!newValues.has(value)) {
      changes.push({ verdict: "breaking", path, detail: `value ${value} is gone` });
    }
  }
}

function diffTypes(
  path: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  direction: Direction,
  changes: Change[],
): void {
  const oldTypes = typeSet(before.type);
  const newTypes = typeSet(after.type);
  if (oldTypes === null && newTypes === null) return;
  const oldNullable = oldTypes?.has("null") ?? false;
  const newNullable = newTypes?.has("null") ?? false;
  if (oldNullable !== newNullable) {
    const verdict: Change["verdict"] =
      direction === "request"
        ? newNullable
          ? "additive"
          : "breaking"
        : newNullable
          ? "degrading"
          : "breaking";
    changes.push({
      verdict,
      path,
      detail: newNullable ? "became nullable" : "stopped being nullable",
    });
  }
  const oldNonNull = new Set([...(oldTypes ?? [])].filter((type) => type !== "null"));
  const newNonNull = new Set([...(newTypes ?? [])].filter((type) => type !== "null"));
  for (const type of newNonNull) {
    if (!oldNonNull.has(type)) {
      changes.push({ verdict: "breaking", path, detail: `type changed to ${type}` });
    }
  }
  for (const type of oldNonNull) {
    if (!newNonNull.has(type)) {
      changes.push({ verdict: "breaking", path, detail: `type ${type} is gone` });
    }
  }
}

function diffProperties(
  path: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  direction: Direction,
  changes: Change[],
): void {
  const oldProperties = record(before.properties);
  const newProperties = record(after.properties);
  const oldRequired = new Set(values(before.required).map((value) => String(value)));
  const newRequired = new Set(values(after.required).map((value) => String(value)));
  const names = [
    ...new Set([...Object.keys(oldProperties), ...Object.keys(newProperties)]),
  ].toSorted(byCodeUnits);

  for (const name of names) {
    const inBefore = name in oldProperties;
    const inAfter = name in newProperties;
    const wasRequired = oldRequired.has(name);
    const isRequired = newRequired.has(name);

    if (!inBefore && inAfter) {
      const verdict: Change["verdict"] =
        direction === "request" ? (isRequired ? "breaking" : "additive") : "additive";
      changes.push({
        verdict,
        path: `${path}.${name}`,
        detail: isRequired ? "new required field" : "new optional field",
        name,
      });
      continue;
    }
    if (inBefore && !inAfter) {
      changes.push({
        verdict: direction === "request" ? "additive" : "breaking",
        path: `${path}.${name}`,
        detail: "the field is gone",
      });
      continue;
    }
    if (wasRequired !== isRequired) {
      const verdict: Change["verdict"] =
        direction === "request"
          ? isRequired
            ? "breaking"
            : "additive"
          : isRequired
            ? "additive"
            : "breaking";
      changes.push({
        verdict,
        path: `${path}.${name}`,
        detail: isRequired ? "became required" : "became optional",
      });
    }
    diffSchema(oldProperties[name], newProperties[name], `${path}.${name}`, direction, changes);
  }
}

function diffConstraints(
  path: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  direction: Direction,
  changes: Change[],
): void {
  for (const key of CONSTRAINT_KEYS) {
    if (before[key] === undefined && after[key] === undefined) continue;
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    changes.push({
      verdict: constraintVerdict(key, before[key], after[key], direction),
      path: `${path}.${key}`,
      detail: `${key} changed from ${JSON.stringify(before[key])} to ${JSON.stringify(after[key])}`,
    });
  }
}

function constraintVerdict(
  key: string,
  before: unknown,
  after: unknown,
  direction: Direction,
): Change["verdict"] {
  if (direction === "response") return "degrading";
  if (before === undefined) return "breaking";
  if (after === undefined) return "additive";
  if (key === "minLength" || key === "minItems" || key === "minimum") {
    return number(after) > number(before) ? "breaking" : "additive";
  }
  if (key === "maxLength" || key === "maxItems" || key === "maximum") {
    return number(after) < number(before) ? "breaking" : "additive";
  }
  return "breaking";
}

function diffVariants(
  path: string,
  key: "anyOf" | "oneOf" | "allOf",
  before: unknown,
  after: unknown,
  direction: Direction,
  changes: Change[],
): void {
  const oldVariants = values(before).map((value) => JSON.stringify(value));
  const newVariants = values(after).map((value) => JSON.stringify(value));
  const oldSet = new Set(oldVariants);
  const newSet = new Set(newVariants);
  for (const variant of newVariants) {
    if (!oldSet.has(variant)) {
      changes.push({
        verdict: direction === "request" ? "additive" : "degrading",
        path: `${path}.${key}`,
        detail: `new member ${variant}`,
      });
    }
  }
  for (const variant of oldVariants) {
    if (!newSet.has(variant)) {
      changes.push({
        verdict: "breaking",
        path: `${path}.${key}`,
        detail: `member ${variant} is gone`,
      });
    }
  }
}

// ── WebSocket ──

function diffWs(before: unknown, after: unknown, changes: Change[]): void {
  const oldWs = object(before) ?? {};
  const newWs = object(after) ?? {};
  if (JSON.stringify(oldWs.upgrade) !== JSON.stringify(newWs.upgrade)) {
    changes.push({ verdict: "breaking", path: "ws.upgrade", detail: "the socket upgrade changed" });
  }
  diffFrames("ws.client", oldWs.client, newWs.client, "request", "breaking", changes);
  diffFrames("ws.server", oldWs.server, newWs.server, "response", "degrading", changes);
}

function diffFrames(
  path: string,
  before: unknown,
  after: unknown,
  direction: Direction,
  removed: Change["verdict"],
  changes: Change[],
): void {
  const oldFrames = frames(before);
  const newFrames = frames(after);
  const types = [...new Set([...oldFrames.keys(), ...newFrames.keys()])].toSorted(byCodeUnits);
  for (const type of types) {
    const oldFrame = oldFrames.get(type);
    const newFrame = newFrames.get(type);
    if (oldFrame === undefined) {
      changes.push({
        verdict: "additive",
        path: `${path}.${type}`,
        detail: "new frame",
        name: type,
      });
      continue;
    }
    if (newFrame === undefined) {
      changes.push({ verdict: removed, path: `${path}.${type}`, detail: "the frame is gone" });
      continue;
    }
    diffSchema(oldFrame, newFrame, `${path}.${type}`, direction, changes);
  }
}

function frames(schema: unknown): Map<string, unknown> {
  const root = object(schema);
  const variants = values(root?.oneOf ?? root?.anyOf);
  const result = new Map<string, unknown>();
  for (const variant of variants) {
    const value = object(variant);
    const properties = object(value?.properties);
    const type = object(properties?.type);
    const name = string(type?.const);
    if (name !== undefined) result.set(name, variant);
  }
  return result;
}

// ── Binary and constants ──

function diffBinary(before: unknown, after: unknown, changes: Change[]): void {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  changes.push({
    verdict: "breaking",
    path: "binary",
    detail: "the binary framing changed; both sides must agree exactly",
  });
}

function diffConstants(before: unknown, after: unknown, changes: Change[]): void {
  const oldConstants = record(before);
  const newConstants = record(after);
  const names = [...new Set([...Object.keys(oldConstants), ...Object.keys(newConstants)])].toSorted(
    byCodeUnits,
  );
  for (const name of names) {
    const inBefore = name in oldConstants;
    const inAfter = name in newConstants;
    if (!inBefore) {
      changes.push({
        verdict: "additive",
        path: `constants.${name}`,
        detail: "new constant",
        name,
      });
      continue;
    }
    if (!inAfter) {
      changes.push({
        verdict: "breaking",
        path: `constants.${name}`,
        detail: "the constant is gone",
      });
      continue;
    }
    const oldValue = oldConstants[name];
    const newValue = newConstants[name];
    if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;
    if (Array.isArray(oldValue) && Array.isArray(newValue)) {
      diffArrayConstant(name, oldValue, newValue, changes);
      continue;
    }
    changes.push({
      verdict: "breaking",
      path: `constants.${name}`,
      detail: `changed from ${JSON.stringify(oldValue)} to ${JSON.stringify(newValue)}; both sides must agree`,
    });
  }
}

function diffArrayConstant(
  name: string,
  before: readonly unknown[],
  after: readonly unknown[],
  changes: Change[],
): void {
  const oldSet = new Set(before.map((value) => JSON.stringify(value)));
  const newSet = new Set(after.map((value) => JSON.stringify(value)));
  for (const value of after) {
    if (!oldSet.has(JSON.stringify(value))) {
      changes.push({
        verdict: "additive",
        path: `constants.${name}[]`,
        detail: `new member ${JSON.stringify(value)}`,
      });
    }
  }
  for (const value of before) {
    if (!newSet.has(JSON.stringify(value))) {
      changes.push({
        verdict: "breaking",
        path: `constants.${name}[]`,
        detail: `member ${JSON.stringify(value)} is gone`,
      });
    }
  }
}

// ── Reading JSON ──

function object(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return object(value) ?? {};
}

function values(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function number(value: unknown): number {
  return typeof value === "number" ? value : Number.NaN;
}

function typeSet(value: unknown): Set<string> | null {
  if (typeof value === "string") return new Set([value]);
  if (Array.isArray(value))
    return new Set(value.filter((item): item is string => typeof item === "string"));
  return null;
}

function enumValues(schema: Record<string, unknown>): Set<string> | null {
  if (schema.const !== undefined) return new Set([JSON.stringify(schema.const)]);
  if (Array.isArray(schema.enum)) return new Set(schema.enum.map((value) => JSON.stringify(value)));
  return null;
}

function requiredKeys(schema: unknown): string[] {
  const value = object(schema);
  return values(value?.required).map((item) => String(item));
}
