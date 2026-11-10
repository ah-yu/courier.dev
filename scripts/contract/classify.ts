/**
 * The rule that turns a surface difference into the numbers to write.
 *
 * The whole design rests on one question — *would the old side misread this byte?* — and
 * this module answers it mechanically for everything the surface can see. Three outcomes:
 *
 * - **unchanged**: nothing a peer can observe moved; `bun run contract` passes.
 * - **additive**: a peer that predates the change still reads it correctly (a new optional
 *   field, a new route, a new type). Only `CONTRACT_GENERATION` moves.
 * - **breaking**: an older peer would misread what it receives, or send something the newer
 *   side reads differently. Every number moves.
 *
 * A new **required** property is treated as breaking on purpose: for a response an older
 * client would ignore it, but for a request the older client cannot send it, and the
 * surface does not say which of the two a declaration is. Erring here costs one extra
 * "upgrade" prompt; erring the other way is a client that talks to a server it does not
 * understand.
 */
import { byCodeUnits, type Property, type Shape, type Surface } from "./surface";

export type Verdict = "unchanged" | "additive" | "breaking";

/** One observable difference, with the reading that decides the numbers to write. */
export interface Change {
  verdict: "additive" | "breaking";
  /** Where it is, in a form a reader can search the code for. */
  path: string;
  /** What changed, as one sentence. */
  detail: string;
  /** For an addition: the bare identifier (a field, a type or a route), for the usage check. */
  name?: string;
}

export interface Classification {
  changes: Change[];
  verdict: Verdict;
}

/** Compare two surfaces. Never throws: a missing side is an addition or a removal. */
export function classify(previous: Surface, current: Surface): Classification {
  const changes: Change[] = [];
  diffTypes(previous.types, current.types, changes);
  diffRoutes(previous.routes, current.routes, changes);
  diffConstants(previous.constants, current.constants, changes);

  // Code units again: the printed order is what a reviewer reads, so it must not depend on
  // the machine's locale either.
  const sorted = changes.toSorted((left, right) => byCodeUnits(left.path, right.path));
  return { changes: sorted, verdict: verdictOf(sorted) };
}

/** The single line a caller prints before acting. */
export function verdictOf(changes: readonly Change[]): Verdict {
  if (changes.some((change) => change.verdict === "breaking")) return "breaking";
  if (changes.length > 0) return "additive";
  return "unchanged";
}

/** Bare identifiers that were added — the client-usage check greps for these. */
export function addedNames(changes: readonly Change[]): string[] {
  const names = new Set<string>();
  for (const change of changes) {
    if (change.verdict === "additive" && change.name !== undefined) names.add(change.name);
  }
  return [...names].toSorted();
}

function diffTypes(
  previous: Record<string, import("./surface").TypeDeclaration>,
  current: Record<string, import("./surface").TypeDeclaration>,
  changes: Change[],
): void {
  // A rename is not a wire change: the JSON a peer reads is identical, and only the
  // TypeScript name moved. Pair a removed declaration with an added one of exactly the same
  // shape, so a refactor does not read as "an older peer would misread this".
  const removed = Object.keys(previous).filter((name) => !(name in current));
  const added = Object.keys(current).filter((name) => !(name in previous));
  const renamedTo = new Map<string, string>();
  const renamedFrom = new Set<string>();
  for (const name of removed) {
    const match = added.find(
      (candidate) =>
        !renamedFrom.has(candidate) &&
        JSON.stringify(current[candidate]) === JSON.stringify(previous[name]),
    );
    if (match === undefined) continue;
    renamedTo.set(name, match);
    renamedFrom.add(match);
    changes.push({
      verdict: "additive",
      path: `${name} → ${match}`,
      detail: "renamed; the wire shape is unchanged, so only the declaration's name moved",
    });
  }

  for (const name of removed) {
    if (renamedTo.has(name)) continue;
    changes.push({
      verdict: "breaking",
      path: name,
      detail: "the declaration is gone, so a peer built against it reads nothing",
    });
  }
  for (const [name, after] of Object.entries(current)) {
    const before = previous[name];
    if (before === undefined) {
      if (renamedFrom.has(name)) continue;
      changes.push({ verdict: "additive", path: name, detail: "new declaration", name });
      continue;
    }
    if (before.kind !== after.kind) {
      changes.push({
        verdict: "breaking",
        path: name,
        detail: "interface became a type alias (or back)",
      });
      continue;
    }
    if (before.kind === "interface" && after.kind === "interface") {
      diffExtends(name, before.extends, after.extends, changes);
      diffProperties(before.properties, after.properties, name, changes);
    }
    if (before.kind === "alias" && after.kind === "alias") {
      diffShape(before.shape, after.shape, name, changes);
    }
  }
}

function diffExtends(name: string, before: string[], after: string[], changes: Change[]): void {
  for (const base of before) {
    if (!after.includes(base)) {
      changes.push({
        verdict: "breaking",
        path: `${name} extends ${base}`,
        detail: "an inherited field is gone",
      });
    }
  }
  for (const base of after) {
    if (!before.includes(base)) {
      changes.push({
        verdict: "additive",
        path: `${name} extends ${base}`,
        detail: "new inherited fields",
      });
    }
  }
}

function diffProperties(
  before: Record<string, Property>,
  after: Record<string, Property>,
  path: string,
  changes: Change[],
): void {
  for (const name of Object.keys(before)) {
    if (!(name in after)) {
      changes.push({
        verdict: "breaking",
        path: `${path}.${name}`,
        detail: "the field is gone, so an older peer reads `undefined`",
      });
    }
  }
  for (const [name, next] of Object.entries(after)) {
    const previous = before[name];
    if (previous === undefined) {
      changes.push({
        verdict: next.optional ? "additive" : "breaking",
        path: `${path}.${name}`,
        detail: next.optional
          ? "new optional field"
          : "new required field: an older client cannot send it (and cannot read it)",
        name,
      });
      continue;
    }
    if (previous.optional !== next.optional) {
      changes.push({
        verdict: next.optional ? "additive" : "breaking",
        path: `${path}.${name}`,
        detail: next.optional ? "became optional" : "became required",
      });
    }
    diffShape(previous.shape, next.shape, `${path}.${name}`, changes);
  }
}

function diffShape(before: Shape, after: Shape, path: string, changes: Change[]): void {
  if (JSON.stringify(before) === JSON.stringify(after)) return;

  const beforeKind = shapeKind(before);
  const afterKind = shapeKind(after);
  if (beforeKind !== afterKind) {
    changes.push({
      verdict: "breaking",
      path,
      detail: `type changed from ${describeShape(before)} to ${describeShape(after)}`,
    });
    return;
  }

  switch (afterKind) {
    case "object": {
      const beforeObject = (before as { object: Record<string, Property> }).object;
      const afterObject = (after as { object: Record<string, Property> }).object;
      diffProperties(beforeObject, afterObject, path, changes);
      return;
    }
    case "array": {
      diffShape(
        (before as { array: Shape }).array,
        (after as { array: Shape }).array,
        `${path}[]`,
        changes,
      );
      return;
    }
    case "tuple": {
      const beforeItems = (before as { tuple: Shape[] }).tuple;
      const afterItems = (after as { tuple: Shape[] }).tuple;
      if (beforeItems.length !== afterItems.length) {
        changes.push({ verdict: "breaking", path, detail: "the tuple's length changed" });
        return;
      }
      afterItems.forEach((item, index) =>
        diffShape(beforeItems[index]!, item, `${path}[${index}]`, changes),
      );
      return;
    }
    case "union": {
      diffMembers(
        (before as { union: Shape[] }).union,
        (after as { union: Shape[] }).union,
        path,
        changes,
      );
      return;
    }
    case "intersection": {
      diffMembers(
        (before as { intersection: Shape[] }).intersection,
        (after as { intersection: Shape[] }).intersection,
        path,
        changes,
      );
      return;
    }
    case "reference": {
      const beforeReference = before as { reference: string; args: Shape[] };
      const afterReference = after as { reference: string; args: Shape[] };
      if (beforeReference.reference !== afterReference.reference) {
        changes.push({
          verdict: "breaking",
          path,
          detail: `type changed from ${beforeReference.reference} to ${afterReference.reference}`,
        });
        return;
      }
      if (beforeReference.args.length !== afterReference.args.length) {
        changes.push({ verdict: "breaking", path, detail: "the type's arguments changed" });
        return;
      }
      afterReference.args.forEach((argument, index) =>
        diffShape(beforeReference.args[index]!, argument, `${path}<${index}>`, changes),
      );
      return;
    }
    default: {
      changes.push({
        verdict: "breaking",
        path,
        detail: `type changed from ${describeShape(before)} to ${describeShape(after)}`,
      });
    }
  }
}

/** A union: a member that appears is additive, one that disappears is not. */
function diffMembers(before: Shape[], after: Shape[], path: string, changes: Change[]): void {
  const beforeKeys = new Set(before.map((shape) => JSON.stringify(shape)));
  const afterKeys = new Set(after.map((shape) => JSON.stringify(shape)));
  for (const shape of after) {
    if (!beforeKeys.has(JSON.stringify(shape))) {
      changes.push({ verdict: "additive", path, detail: `new member ${describeShape(shape)}` });
    }
  }
  for (const shape of before) {
    if (!afterKeys.has(JSON.stringify(shape))) {
      changes.push({ verdict: "breaking", path, detail: `member ${describeShape(shape)} is gone` });
    }
  }
}

function diffRoutes(
  previous: Record<string, string[]>,
  current: Record<string, string[]>,
  changes: Change[],
): void {
  for (const path of Object.keys(previous)) {
    if (!(path in current)) {
      changes.push({ verdict: "breaking", path, detail: "the route is gone", name: path });
      continue;
    }
    const before = new Set(previous[path]!);
    const after = new Set(current[path]!);
    for (const method of before) {
      if (!after.has(method))
        changes.push({ verdict: "breaking", path, detail: `${method} was removed` });
    }
    for (const method of after) {
      if (!before.has(method))
        changes.push({ verdict: "additive", path, detail: `${method} was added` });
    }
  }
  for (const path of Object.keys(current)) {
    if (!(path in previous)) {
      changes.push({ verdict: "additive", path, detail: "new route", name: path });
    }
  }
}

function diffConstants(
  previous: Record<string, string>,
  current: Record<string, string>,
  changes: Change[],
): void {
  for (const name of Object.keys(previous)) {
    if (!(name in current)) {
      changes.push({ verdict: "breaking", path: name, detail: "the constant is gone" });
    }
  }
  for (const [name, value] of Object.entries(current)) {
    const before = previous[name];
    if (before === undefined) {
      changes.push({ verdict: "additive", path: name, detail: "new constant", name });
      continue;
    }
    if (before === value) continue;

    // An `as const` array of literals (the error codes, the sync actions, the history
    // kinds) is a **set**, not a string: adding a member is additive — an older peer simply
    // never produces it — and only removing one breaks a reader. Comparing the text instead
    // made a new error code read as "breaking", which would have raised the client floor for
    // a change no old client can notice.
    const beforeMembers = arrayMembers(before);
    const afterMembers = arrayMembers(value);
    if (beforeMembers !== null && afterMembers !== null) {
      const beforeSet = new Set(beforeMembers);
      const afterSet = new Set(afterMembers);
      for (const member of afterMembers) {
        if (!beforeSet.has(member)) {
          changes.push({ verdict: "additive", path: `${name}[]`, detail: `new member ${member}` });
        }
      }
      for (const member of beforeMembers) {
        if (!afterSet.has(member)) {
          changes.push({
            verdict: "breaking",
            path: `${name}[]`,
            detail: `member ${member} is gone`,
          });
        }
      }
      continue;
    }

    changes.push({
      verdict: "breaking",
      path: name,
      detail: `changed from ${before} to ${value}; both sides must agree on this value`,
    });
  }
}

/**
 * The members of an `as const` array of literals, or null when the value is anything else.
 *
 * The surface stores a constant as its printed source text, so this is where that text is
 * read back as what it means: a set of strings and numbers.
 */
export function arrayMembers(value: string): string[] | null {
  // A comment inside the array is not a member: the surface stores the printed source, and
  // an error-code list is exactly where a "why this code exists" comment lands. Left in, it
  // made the member list unreadable and the set fell back to a text compare — the bug this
  // function exists to prevent.
  const stripped = value
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .trim();
  const match = /^\[\s*([\s\S]*?)\s*\]\s*as const$/.exec(stripped);
  if (match === null) return null;
  const body = match[1] ?? "";
  if (body.trim() === "") return [];
  const members: string[] = [];
  for (const raw of body.split(",")) {
    const member = raw.trim();
    if (member === "") continue;
    if (!/^(["'])[^"']*\1$/.test(member) && !/^-?\d+$/.test(member)) return null;
    members.push(member);
  }
  return members;
}

function shapeKind(shape: Shape): string {
  const [kind] = Object.keys(shape);
  return kind ?? "text";
}

/** A short human reading of a shape, for a one-line change description. */
function describeShape(shape: Shape): string {
  if ("primitive" in shape) return shape.primitive;
  if ("literal" in shape) return JSON.stringify(shape.literal);
  if ("reference" in shape) {
    return shape.args.length === 0 ? shape.reference : `${shape.reference}<…>`;
  }
  if ("array" in shape) return `${describeShape(shape.array)}[]`;
  if ("tuple" in shape) return "a tuple";
  if ("union" in shape) return shape.union.map(describeShape).join(" | ");
  if ("intersection" in shape) return shape.intersection.map(describeShape).join(" & ");
  if ("object" in shape) {
    // Name the members: "an object" is useless in a failure message, and a union of
    // discriminated objects is exactly where one member can differ from another.
    const keys = Object.keys(shape.object);
    return keys.length === 0 ? "an object" : `an object { ${keys.join(", ")} }`;
  }
  return shape.text;
}
