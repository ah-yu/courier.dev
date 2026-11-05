import type { HttpTransport } from "@courier/shared";
import { exactBuffer } from "./bytes";
import { withTimeout } from "./with-timeout";

/**
 * How long one transport request may take.
 *
 * `requestUrl` has no timeout of its own. A request that never settles used to hold the
 * whole reconcile pass — and the bind — forever, which is indistinguishable from a sync
 * bug in the UI. 120 s still covers a 4 MiB chunk on a slow connection (~35 KB/s), and a
 * dead socket becomes a `NETWORK_ERROR` the host retries on its next pass instead of
 * hanging. The request itself is not cancelled; the engine's chunk resume and the
 * push's lost-response retry make a retried request safe.
 */
export const REQUEST_TIMEOUT_MS = 120_000;

/** The subset of Obsidian's `requestUrl` parameter this transport uses. */
export interface RequestUrlParamLike {
  url: string;
  method: string;
  headers: Record<string, string>;
  contentType?: string;
  body?: string | ArrayBuffer;
  throw: boolean;
}

/** The subset of Obsidian's `RequestUrlResponse` this transport reads. */
export interface RequestUrlResponseLike {
  status: number;
  headers: Record<string, string>;
  text: string;
  json: unknown;
  arrayBuffer: ArrayBuffer;
}

/** The `requestUrl` function, injected so the transport can be unit-tested. */
export type RequestUrlLike = (param: RequestUrlParamLike) => Promise<RequestUrlResponseLike>;

/**
 * Build the transport every plugin request goes through.
 *
 * `requestUrl` is Obsidian's own HTTP stack (Electron's `net`), so this is the only
 * host-specific part of the plugin's networking: URLs, auth headers, the session-id
 * header and error mapping all belong to the shared client.
 *
 * Its response is handed on **lazily**, because `json` is a getter that throws when the
 * body is not JSON. (Obsidian buffers the body before `requestUrl` resolves — the getters
 * only decode it — so the timeout covers the transfer too. The request itself is not
 * cancelled, so a retry may run beside the abandoned one.) The
 * version-content route answers raw ciphertext, so reading `.json` eagerly here made
 * every download fail — as a `SyntaxError` the shared client could only report as
 * "cannot reach the server" — while pushes (JSON responses) kept working. Nothing
 * surfaced it either: a pass tolerates a pull that could not be carried out, and the
 * next one retries into the same failure. `json` therefore answers `null` for a body
 * that is not JSON, which is what `TransportResponse` documents.
 */
export function createObsidianTransport(
  requestUrl: RequestUrlLike,
  timeoutMs = REQUEST_TIMEOUT_MS,
): HttpTransport {
  return async (request) => {
    const { "Content-Type": contentType, ...headers } = request.headers;
    const body = request.body;
    const response = await withTimeout(
      requestUrl({
        url: request.url,
        method: request.method,
        headers,
        ...(contentType === undefined ? {} : { contentType }),
        ...(body === undefined
          ? {}
          : {
              body:
                typeof body === "string"
                  ? body
                  : body instanceof Uint8Array
                    ? exactBuffer(body)
                    : body,
            }),
        // The shared client reads the status and maps the error body itself.
        // Obsidian's `requestUrl` rejects on 4xx/5xx by default (`throw: true`),
        // which hid every structured error from the settings page: an expired key
        // and a stopped server both surfaced as "cannot reach the server".
        throw: false,
      }),
      timeoutMs,
      `the server did not answer within ${timeoutMs}ms`,
    );
    return {
      status: response.status,
      // `requestUrl` already lower-cases its header names; the shared client reads
      // `retry-after` to know how long a 429 asked it to wait.
      headers: response.headers,
      get text() {
        return response.text;
      },
      get json(): unknown {
        try {
          // `RequestUrlResponse.json` is `any`; the shared client narrows what it needs,
          // and answering `unknown` is what keeps the unsafe value from travelling further.
          return response.json;
        } catch {
          // Not JSON: binary content, an empty body, a proxy's HTML error page.
          return null;
        }
      },
      get arrayBuffer() {
        return response.arrayBuffer;
      },
    };
  };
}
