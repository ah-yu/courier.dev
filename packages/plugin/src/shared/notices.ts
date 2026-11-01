/**
 * A burst notifier: collect the events of one window, then say **one** line about them.
 *
 * The plugin reports two engine events this way — a conflict the engine resolved and a
 * file the size cap skipped — and the two were the same code written twice, differing
 * only in the function that renders the text. A burst is one message because the message
 * is the same for every event in it, and the window is what turns "a folder of conflicts"
 * into one Notice instead of thirty.
 *
 * The window alone is not enough for an event that fires **every pass**: a file over the
 * size cap is reported by each periodic reconcile (every five minutes), so a windowed
 * notice turned into an unrequested reminder four times an hour. {@link
 * BurstNotifierOptions.keyOf} gives an event an identity, and an identity the notifier has
 * already announced is dropped for the rest of the session — one line per file, not one
 * line per pass.
 */
export interface BurstNotifier<T> {
  /** Collect one event; the first one starts the window. */
  push(event: T): void;
  /** Drop what was collected and cancel the pending message (plugin unload). */
  reset(): void;
}

export interface BurstNotifierOptions<T> {
  /** How long a burst is collected before it is reported (ms). */
  windowMs: number;
  /** The line to show for a burst, or null when it needs no message at all. */
  render: (events: T[]) => string | null;
  /** How the line reaches the user (a Notice, in the plugin). */
  emit: (text: string) => void;
  /**
   * The event's identity for the session, when it has one.
   *
   * An event whose key was already announced — or is already waiting in the current
   * window — is dropped: the fact did not change, so repeating it is noise. Omit it for
   * events that happen once by nature (a conflict the engine resolved), and give it for
   * events a pass re-reports (a path over the size cap). An identity is only consumed
   * once a line has actually been emitted, so a burst that is reset or renders nothing
   * does not silence that file for the rest of the session.
   */
  keyOf?: (event: T) => string;
}

export function createBurstNotifier<T>(options: BurstNotifierOptions<T>): BurstNotifier<T> {
  let timer: number | null = null;
  let pending: T[] = [];
  /** Keys collected for the current window — a burst names each identity once. */
  let pendingKeys = new Set<string>();
  /** Identities a line has been emitted for. Survives `reset()`: the session does not restart. */
  const announced = new Set<string>();

  return {
    push(event) {
      if (options.keyOf) {
        const key = options.keyOf(event);
        if (announced.has(key) || pendingKeys.has(key)) return;
        pendingKeys.add(key);
      }
      pending.push(event);
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        const events = pending;
        const keys = pendingKeys;
        pending = [];
        pendingKeys = new Set();
        const text = options.render(events);
        if (!text) return;
        for (const key of keys) announced.add(key);
        options.emit(text);
      }, options.windowMs);
    },

    reset() {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      pending = [];
      pendingKeys = new Set();
    },
  };
}
