/**
 * The one data hook.
 *
 * Three behaviours it exists to guarantee:
 *
 *  - **Previous data survives a refetch.** `data` is not cleared when a new
 *    request starts, so changing a filter dims the widget instead of blanking it.
 *  - **Stale responses lose.** Every request carries a sequence number and a late
 *    reply from a superseded request is dropped. Without this, dragging a filter
 *    can leave the screen showing the second-to-last answer.
 *  - **A failed refetch does not destroy good data.** `error` is set and `data`
 *    is kept, and AsyncBody shows both.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface AsyncState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
}

export function useApi<T>(fetcher: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> & {
  reload: () => void;
} {
  const [state, setState] = useState<AsyncState<T>>({ data: null, error: null, loading: true });
  const seq = useRef(0);
  const [nonce, setNonce] = useState(0);

  // The fetcher is a fresh closure every render; deps are the real trigger.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    const mine = ++seq.current;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));

    fetcherRef
      .current()
      .then((data) => {
        if (cancelled || mine !== seq.current) return;
        setState({ data, error: null, loading: false });
      })
      .catch((error: unknown) => {
        if (cancelled || mine !== seq.current) return;
        setState((s) => ({ data: s.data, error, loading: false }));
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}

/** Debounce, for filter controls that fire on every keystroke or drag. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [out, setOut] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setOut(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return out;
}
