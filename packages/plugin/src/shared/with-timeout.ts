/**
 * `promise`'s rejection reason as an `Error`.
 *
 * A rejection reason is whatever the other side threw; a promise that rejects with a value
 * that is not an `Error` is still an ordinary refusal here, and wrapping it keeps the
 * caller able to read `.message` without every call site narrowing. The original reason is
 * kept as `cause`, so a refusal that did carry detail (an object with fields, a status)
 * does not lose it in the wrap.
 */
function asError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === "string" ? reason : "the wrapped promise rejected", {
    cause: reason,
  });
}

/**
 * Reject when `promise` has not settled within `timeoutMs`.
 *
 * The status menu reads the account before it opens, and a request that never settles
 * would leave the user staring at an icon that did nothing. The timeout does not cancel
 * the underlying request (the shared client takes no abort signal); it only lets the menu
 * fall back to what it already knows. The timer is cleared on either settlement, so a
 * successful read leaves nothing behind.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message = `Timed out after ${timeoutMs} ms`,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        reject(asError(error));
      },
    );
  });
}
