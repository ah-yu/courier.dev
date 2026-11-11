/**
 * The executable wire: schemas, the route/frame registry, and the surface serializer.
 *
 * Imported as `@courier/shared/wire`. The package's main entry stays the type-only
 * surface (plus the framing helpers), so a host that does not validate at runtime does
 * not pull Zod into its bundle.
 */
export * from "./binary";
export * from "./http";
export * from "./registry";
export * from "./schema";
export * from "./surface";
export * from "./ws";
