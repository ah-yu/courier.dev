/**
 * The WebSocket frame schemas.
 *
 * The socket has no route table: the server upgrades any request that asks for one, and
 * the frames are the whole contract. They used to be TypeScript unions only, while the
 * server sent them through `trySend(ws, message: unknown)` — a frame whose payload
 * changed kept the union intact and the gate green. The schema is what the server now
 * validates a send against in tests/dev, and what the surface records.
 */
import { MAX_DEVICE_NAME_LENGTH } from "../sync";
import { HistoryLimitsSchema, API_ERROR_CODE_VALUES } from "./http";
import { text, z } from "./schema";

/** What a client may send on the socket. */
export const WsClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("subscribe"),
    vaultId: z.string(),
    userKey: z.string(),
    // Empty is allowed here and normalised by the hub (`trimDeviceName`), exactly as
    // the HTTP push header allows `null`: a label is display metadata, not a credential.
    deviceName: z.optional(text({ max: MAX_DEVICE_NAME_LENGTH })),
  }),
  z.object({ type: z.literal("unsubscribe"), vaultId: z.string() }),
  z.object({ type: z.literal("pong") }),
]);

/** What the server may send on the socket. */
export const WsServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("subscribe_success"),
    vaultId: z.string(),
    sessionId: z.string(),
  }),
  z.object({
    type: z.literal("subscribe_error"),
    vaultId: z.string(),
    message: z.string(),
    code: z.optional(z.enum(API_ERROR_CODE_VALUES)),
  }),
  z.object({ type: z.literal("unsubscribed"), vaultId: z.string() }),
  z.object({ type: z.literal("vault_deleted"), vaultId: z.string() }),
  z.object({
    type: z.literal("vault_settings"),
    vaultId: z.string(),
    historyLimits: HistoryLimitsSchema,
  }),
  z.object({ type: z.literal("api_key_revoked"), vaultId: z.string() }),
  z.object({ type: z.literal("api_key_disabled"), vaultId: z.string() }),
  z.object({ type: z.literal("ping") }),
  z.object({
    type: z.literal("files_pushed"),
    vaultId: z.string(),
    files: z.array(
      z.object({
        fileId: z.string(),
        versionId: z.string(),
        deviceName: z.optional(z.nullable(z.string())),
      }),
    ),
  }),
]);

export type WsClientMessage = z.infer<typeof WsClientMessageSchema>;
export type WsServerMessage = z.infer<typeof WsServerMessageSchema>;
