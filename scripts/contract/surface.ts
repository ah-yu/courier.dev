/**
 * The API surface, derived from the code rather than listed by hand.
 *
 * Two questions decide whether a contract change is safe, and both are answered by the
 * same thing: *what can a peer observe?* That is not "which file changed" — an agent can
 * edit a response in `handlers/` or in a shared type and mean the same thing — so this
 * module reads the two places the wire actually lives:
 *
 * - `packages/shared/src/*.ts`: the declarations peers exchange (request/response bodies,
 *   the WebSocket messages, the error codes) plus the constants both sides must agree on
 *   (chunk sizes, blob layout, batch limits). A property's name, optionality and type are
 *   recorded as a tree, so `Array<T>` and `T[]` compare equal and a comment or a formatting
 *   change is invisible.
 * - `packages/server/src/routes/*.ts`: the route table, as `path → methods`.
 *
 * The output is the input of `contract/classify.ts` and the content of
 * `packages/shared/contract/<generation>.surface.json`.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * One property, or one array element, of the wire.
 *
 * The shapes are normalised (`Array<T>` → `{ array }`, sorted unions) so two spellings of
 * the same type produce the same tree. Anything the walker does not model falls back to
 * `{ text }` — still comparable, just coarser.
 */
export type Shape =
  | { primitive: string }
  | { literal: string | number | boolean }
  | { reference: string; args: Shape[] }
  | { array: Shape }
  | { tuple: Shape[] }
  | { union: Shape[] }
  | { intersection: Shape[] }
  | { object: Record<string, Property> }
  | { text: string };

export interface Property {
  optional: boolean;
  shape: Shape;
}

/** One exported declaration, as a peer sees it. */
export type TypeDeclaration =
  | { kind: "interface"; extends: string[]; properties: Record<string, Property> }
  | { kind: "alias"; shape: Shape };

/** The whole observable contract: types, routes and the constants both sides must share. */
export interface Surface {
  types: Record<string, TypeDeclaration>;
  routes: Record<string, string[]>;
  constants: Record<string, string>;
}

/**
 * Declarations that are not part of the wire.
 *
 * Everything else under `packages/shared/src` is included, so a new exported type lands in
 * the surface without anyone remembering to add it. These are the exceptions, and each is
 * an abstraction *over* the wire rather than a shape *on* it: the transport the plugin and
 * the CLI inject, and the client interface built on top of it.
 */
const TYPE_EXCLUSIONS = new Set([
  "TransportRequest",
  "TransportResponse",
  "HttpTransport",
  "CourierClientOptions",
  "CourierClient",
]);

/**
 * Constants that are policy rather than agreement.
 *
 * The three generations are excluded because they *are* the version of this file; a default
 * (a server URL, a batch default, a vault limit) is a build's own choice and a change to one
 * is not something a peer can observe.
 */
const CONSTANT_EXCLUSIONS = new Set([
  "CONTRACT_GENERATION",
  "MIN_CLIENT_CONTRACT",
  "MIN_SERVER_CONTRACT",
  "DEFAULT_SERVER_URL",
  "DEFAULT_HISTORY_LIMITS",
  "DEFAULT_MAX_FILE_BYTES",
  "DEFAULT_MAX_VAULTS",
  "DEFAULT_DEVICE_NAME",
]);

const PRIMITIVE_KEYWORDS = new Set([
  "string",
  "number",
  "boolean",
  "bigint",
  "symbol",
  "any",
  "unknown",
  "never",
  "void",
  "null",
  "undefined",
  "object",
]);

/** The three numbers, read from their declaration so nothing here imports the module. */
export interface Generations {
  contract: number;
  minClient: number;
  minServer: number;
}

/** Read the generation constants out of `packages/shared/src/contract.ts`. */
export function readGenerations(repoRoot: string): Generations {
  const file = join(repoRoot, "packages", "shared", "src", "contract.ts");
  const source = parse(file);
  const found: Record<string, number> = {};
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
      if (!ts.isNumericLiteral(declaration.initializer)) continue;
      found[declaration.name.text] = Number(declaration.initializer.text);
    }
  }
  const value = (name: string): number => {
    const number = found[name];
    if (number === undefined) throw new Error(`contract.ts does not declare ${name}`);
    return number;
  };
  return {
    contract: value("CONTRACT_GENERATION"),
    minClient: value("MIN_CLIENT_CONTRACT"),
    minServer: value("MIN_SERVER_CONTRACT"),
  };
}

/** Build the surface from the code. Deterministic: same tree in, same JSON out. */
export function readSurface(repoRoot: string): Surface {
  const types: Record<string, TypeDeclaration> = {};
  const constants: Record<string, string> = {};

  for (const file of sharedSources(repoRoot)) {
    const source = parse(file);
    for (const statement of source.statements) {
      if (!isExported(statement)) continue;
      if (ts.isInterfaceDeclaration(statement)) {
        const name = statement.name.text;
        if (TYPE_EXCLUSIONS.has(name)) continue;
        types[name] = {
          kind: "interface",
          extends: heritageNames(statement, source),
          properties: propertiesOf(statement.members, source),
        };
        continue;
      }
      if (ts.isTypeAliasDeclaration(statement)) {
        const name = statement.name.text;
        if (TYPE_EXCLUSIONS.has(name)) continue;
        types[name] = { kind: "alias", shape: shapeOf(statement.type, source) };
        continue;
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
          const name = declaration.name.text;
          if (CONSTANT_EXCLUSIONS.has(name)) continue;
          const initializer = declaration.initializer;
          // A function or a class is behaviour, not a value a peer can observe.
          if (
            ts.isArrowFunction(initializer) ||
            ts.isFunctionExpression(initializer) ||
            ts.isClassExpression(initializer)
          ) {
            continue;
          }
          constants[name] = normalize(initializer.getText(source));
        }
      }
    }
  }

  return {
    types: sortRecord(types),
    routes: readRoutes(repoRoot),
    constants: sortRecord(constants),
  };
}

/** `path → methods`, scanned out of the server's route tables. */
export function readRoutes(repoRoot: string): Record<string, string[]> {
  const routes: Record<string, string[]> = {};
  const directory = join(repoRoot, "packages", "server", "src", "routes");
  for (const file of sourceFiles(directory)) {
    const source = parse(file);
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name)) {
        const path = node.name.text;
        if (path.startsWith("/api/") && ts.isObjectLiteralExpression(node.initializer)) {
          const methods = new Set<string>();
          for (const member of node.initializer.properties) {
            if (!ts.isPropertyAssignment(member)) continue;
            const method = propertyName(member.name);
            if (method !== null && /^[A-Z]+$/.test(method)) methods.add(method);
          }
          routes[path] = [...methods].toSorted();
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sortRecord(routes);
}

/**
 * Serialise a surface exactly the way the committed files are written.
 *
 * One field per line, each property compact: a changed field is one changed line in the
 * diff, and a generation file stays a few kilobytes rather than forty.
 */
export function formatSurface(surface: Surface): string {
  const lines: string[] = ["{"];

  lines.push('  "types": {');
  Object.entries(surface.types).forEach(([name, declaration], index, all) => {
    lines.push(`    ${JSON.stringify(name)}: {`);
    if (declaration.kind === "interface") {
      lines.push('      "kind": "interface",');
      lines.push(`      "extends": ${JSON.stringify(declaration.extends)},`);
      lines.push('      "properties": {');
      Object.entries(declaration.properties).forEach(([property, value], at, every) => {
        lines.push(
          `        ${JSON.stringify(property)}: ${JSON.stringify(value)}${at < every.length - 1 ? "," : ""}`,
        );
      });
      lines.push("      }");
    } else {
      lines.push('      "kind": "alias",');
      lines.push(`      "shape": ${JSON.stringify(declaration.shape)}`);
    }
    lines.push(`    }${index < all.length - 1 ? "," : ""}`);
  });
  lines.push("  },");

  lines.push('  "routes": {');
  Object.entries(surface.routes).forEach(([path, methods], index, all) => {
    lines.push(
      `    ${JSON.stringify(path)}: ${JSON.stringify(methods)}${index < all.length - 1 ? "," : ""}`,
    );
  });
  lines.push("  },");

  lines.push('  "constants": {');
  Object.entries(surface.constants).forEach(([name, value], index, all) => {
    lines.push(
      `    ${JSON.stringify(name)}: ${JSON.stringify(value)}${index < all.length - 1 ? "," : ""}`,
    );
  });
  lines.push("  }");

  lines.push("}");
  return `${lines.join("\n")}\n`;
}

// ── Reading the declarations ──

function sharedSources(repoRoot: string): string[] {
  return sourceFiles(join(repoRoot, "packages", "shared", "src"));
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory)
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
    .toSorted()
    .map((entry) => join(directory, entry));
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}

function isExported(statement: ts.Statement): boolean {
  if (!ts.canHaveModifiers(statement)) return false;
  const modifiers = ts.getModifiers(statement) ?? [];
  return modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function heritageNames(node: ts.InterfaceDeclaration, source: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const clause of node.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    for (const type of clause.types) names.push(normalize(type.getText(source)));
  }
  return names.toSorted();
}

function propertiesOf(
  members: ts.NodeArray<ts.TypeElement>,
  source: ts.SourceFile,
): Record<string, Property> {
  const properties: Record<string, Property> = {};
  for (const member of members) {
    if (ts.isPropertySignature(member)) {
      const name = propertyName(member.name);
      if (name === null) continue;
      properties[name] = {
        optional: member.questionToken !== undefined,
        shape: member.type === undefined ? { primitive: "any" } : shapeOf(member.type, source),
      };
      continue;
    }
    if (ts.isIndexSignatureDeclaration(member)) {
      properties["[index]"] = {
        optional: false,
        shape: member.type === undefined ? { primitive: "any" } : shapeOf(member.type, source),
      };
      continue;
    }
    // A method on a wire type is unusual; keep its whole text so a change to its signature
    // is still a change (and not silently ignored).
    if (ts.isMethodSignature(member)) {
      const name = propertyName(member.name);
      if (name === null) continue;
      properties[name] = {
        optional: member.questionToken !== undefined,
        shape: { text: normalize(member.getText(source)) },
      };
    }
  }
  return sortRecord(properties);
}

function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

function shapeOf(node: ts.TypeNode, source: ts.SourceFile): Shape {
  if (ts.isTypeReferenceNode(node)) {
    const name = normalize(node.typeName.getText(source));
    const args = (node.typeArguments ?? []).map((arg) => shapeOf(arg, source));
    if ((name === "Array" || name === "ReadonlyArray") && args.length === 1)
      return { array: args[0]! };
    return { reference: name, args };
  }
  if (ts.isArrayTypeNode(node)) return { array: shapeOf(node.elementType, source) };
  if (ts.isTupleTypeNode(node)) {
    return {
      tuple: node.elements.map((element) =>
        shapeOf(ts.isNamedTupleMember(element) ? element.type : element, source),
      ),
    };
  }
  if (ts.isUnionTypeNode(node))
    return { union: sortedShapes(node.types.map((type) => shapeOf(type, source))) };
  if (ts.isIntersectionTypeNode(node)) {
    return { intersection: sortedShapes(node.types.map((type) => shapeOf(type, source))) };
  }
  if (ts.isLiteralTypeNode(node)) {
    const literal = node.literal;
    if (ts.isStringLiteral(literal) || ts.isNumericLiteral(literal)) {
      return { literal: ts.isNumericLiteral(literal) ? Number(literal.text) : literal.text };
    }
    if (literal.kind === ts.SyntaxKind.TrueKeyword) return { literal: true };
    if (literal.kind === ts.SyntaxKind.FalseKeyword) return { literal: false };
    if (literal.kind === ts.SyntaxKind.NullKeyword) return { primitive: "null" };
    return { text: normalize(literal.getText(source)) };
  }
  if (ts.isTypeLiteralNode(node)) return { object: propertiesOf(node.members, source) };
  if (ts.isParenthesizedTypeNode(node)) return shapeOf(node.type, source);
  if (ts.isTypeOperatorNode(node)) return shapeOf(node.type, source);
  if (ts.isOptionalTypeNode(node)) return shapeOf(node.type, source);
  const text = normalize(node.getText(source));
  return PRIMITIVE_KEYWORDS.has(text) ? { primitive: text } : { text };
}

function sortedShapes(shapes: Shape[]): Shape[] {
  const seen = new Set<string>();
  const unique: Shape[] = [];
  for (const shape of shapes) {
    const key = JSON.stringify(shape);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(shape);
  }
  return unique.toSorted((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  const sorted: Record<string, T> = {};
  for (const key of Object.keys(record).toSorted()) sorted[key] = record[key]!;
  return sorted;
}
