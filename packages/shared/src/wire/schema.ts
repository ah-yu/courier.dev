/**
 * The runtime schema vocabulary for the wire.
 *
 * The wire used to be described twice: TypeScript declarations in `@courier/shared`, and
 * the server's Zod schemas in `routes/`. The two could drift — a request constraint that
 * lived only in Zod was invisible to the contract gate. This module is the start of the
 * one description that both sides execute: the schemas here are the validators the server
 * runs and the input the contract surface is serialized from.
 *
 * `zod/mini` rather than full Zod: it is the same schema model with a tree-shakeable API,
 * and the wire needs no transforms, defaults or coercion beyond the two query helpers.
 * Only `@courier/shared/wire` imports this module; the package's main entry stays free of
 * the dependency, so the plugin and CLI bundle do not grow unless a host opts into
 * runtime validation.
 */
import { z } from "zod/mini";

export { z };

/** Any wire schema. The registry stores these and the adapter parses with them. */
export type WireSchema = z.ZodMiniType;

/** A string, optionally bounded and/or matched against a pattern. */
export function text(options: { min?: number; max?: number; pattern?: RegExp } = {}) {
  let schema = z.string();
  if (options.min !== undefined) schema = schema.check(z.minLength(options.min));
  if (options.max !== undefined) schema = schema.check(z.maxLength(options.max));
  if (options.pattern !== undefined) schema = schema.check(z.regex(options.pattern));
  return schema;
}

/** A number that must be an integer, optionally bounded. */
export function integer(options: { min?: number; max?: number } = {}) {
  let schema = z.number().check(z.int());
  if (options.min !== undefined) schema = schema.check(z.minimum(options.min));
  if (options.max !== undefined) schema = schema.check(z.maximum(options.max));
  return schema;
}

/** An array, optionally bounded in length. */
export function list<T extends WireSchema>(item: T, options: { min?: number; max?: number } = {}) {
  let schema = z.array(item);
  // `minLength`/`maxLength` are the array **length** checks in Zod (`minSize`/`maxSize`
  // read `.size`, which an array does not have). JSON Schema maps them to
  // `minItems`/`maxItems`, which is what the surface records.
  if (options.min !== undefined) schema = schema.check(z.minLength(options.min));
  if (options.max !== undefined) schema = schema.check(z.maxLength(options.max));
  return schema;
}

/**
 * The same integer, but read from a URL query string.
 *
 * A query value is always a string, so the schema coerces before it validates; the
 * inferred type stays `number`, which is what the handler and the surface record.
 */
export function queryInteger(options: { min?: number; max?: number } = {}) {
  let schema = z.coerce.number().check(z.int());
  if (options.min !== undefined) schema = schema.check(z.minimum(options.min));
  if (options.max !== undefined) schema = schema.check(z.maximum(options.max));
  return schema;
}
