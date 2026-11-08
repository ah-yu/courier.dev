/** Poll `predicate` until it holds, or throw with `message` after `timeoutMs`. */
export async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${message}`);
}

/** Poll an async predicate until it holds. */
export async function waitForAsync(
  predicate: () => Promise<boolean>,
  message: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${message}`);
}

/**
 * Poll an assertion until it stops throwing, and fail with the last assertion error.
 *
 * A wait for a *predicate* proves the state was observed once; it does not prove the state
 * is still there when the assertion reads it again. That gap is real for a surface that
 * repaints itself: the version-history pane draws its list, then fetches the selected
 * version's bytes before it fills the body, and a debounced silent re-read can start a new
 * paint on the file's own vault events. Assert the settled reading with this, not a second
 * one-shot read.
 *
 * Only for readings a repaint can legitimately blank. Retrying an assertion about a value
 * that only changes when the code changes would hide the bug the case exists to catch.
 */
export async function expectEventually(
  assertion: () => void | Promise<void>,
  message: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (lastError instanceof Error) {
    // The same error object with the wait appended: the runner keeps the assertion's own
    // message and diff, and the timeout is what the reader needs on top of it.
    lastError.message = `${lastError.message} (still failing after ${timeoutMs}ms: ${message})`;
    throw lastError;
  }
  // A non-Error throw has no message to keep; the value itself is the only diagnosis.
  throw new Error(`Timed out: ${message} (last error: ${String(lastError)})`);
}
