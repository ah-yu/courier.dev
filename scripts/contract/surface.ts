/**
 * The contract surface, read from the runtime registry.
 *
 * This file used to be a TypeScript AST walker: it scanned `packages/shared/src` and
 * `packages/server/src/routes` for declarations and route tables. That could only see
 * what the source said, not what the server executed — request constraints, status
 * codes, auth, WebSocket sends and the values of constants were invisible to it.
 *
 * It is now a thin adapter over `@courier/shared/wire`: the same registry the server
 * builds its route table from, serialized by the package itself. There is nothing to
 * parse and nothing to exclude.
 */
import { readFileSync } from "node:fs";
import { CONTRACT_GENERATION, MIN_CLIENT_CONTRACT } from "../../packages/shared/src/contract";
import {
  formatSurface as formatRegistrySurface,
  readSurface as readRegistrySurface,
  type WireSurface,
} from "../../packages/shared/src/wire/index";

/** The committed surface. */
export type Surface = WireSurface;

/** The generation numbers, imported as values rather than parsed out of the source. */
export interface Generations {
  contract: number;
  minClient: number;
}

export function readGenerations(): Generations {
  return { contract: CONTRACT_GENERATION, minClient: MIN_CLIENT_CONTRACT };
}

/** Build the surface from the registry. Deterministic: same code in, same JSON out. */
export function readSurface(): Surface {
  return readRegistrySurface();
}

/** Serialize a surface exactly the way the committed files are written. */
export const formatSurface = formatRegistrySurface;

/**
 * Read a committed generation file.
 *
 * Generation 4 is the first file in the registry format (`{ generation, decision,
 * surface }`); the older flat files are history and are never compared by this gate.
 */
export function readSurfaceFile(file: string): Surface {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { surface?: Surface } | Surface;
  if ("surface" in parsed && parsed.surface !== undefined) return parsed.surface;
  return parsed as Surface;
}

/** Compare two strings by code unit, so the result never depends on the machine's locale. */
export function byCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
