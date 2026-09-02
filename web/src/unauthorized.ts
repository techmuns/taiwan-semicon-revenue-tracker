/**
 * The "we have no credential" signal, in its own module so both the API client
 * and the dataset loader can raise it without importing each other.
 *
 * A 401 is a fact about the WHOLE dashboard, not about one card. When the
 * Worker is in `secret` mode and the cookie is missing or stale, every request
 * fails the same way; left to the widgets it would draw six identical
 * "unauthorized" error cards and no way to fix any of them. So it is published
 * once, and App shows the unlock screen.
 */

const listeners = new Set<() => void>();

/** Subscribe. Returns an unsubscribe, so it drops straight into a useEffect. */
export function onUnauthorized(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function reportUnauthorized(): void {
  for (const fn of listeners) fn();
}
