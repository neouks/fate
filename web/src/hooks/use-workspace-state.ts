"use client";
import * as React from "react";

/** Session-local UI preferences are isolated by task; they never submit domain changes. */
export function useWorkspaceState<T>(scope: string, name: string, initial: T) {
  const storageKey = `series:workspace:${scope}:${name}`;
  const initialRef = React.useRef(initial);
  const [state, setState] = React.useState({ key: storageKey, value: initial, ready: false });
  React.useEffect(() => {
    let value = initialRef.current;
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw !== null) {
        const parsed = JSON.parse(raw);
        if (typeof parsed === typeof value) value = parsed;
      }
    } catch {
      /* Storage may be disabled. */
    }
    setState({ key: storageKey, value, ready: true });
  }, [storageKey]);
  React.useEffect(() => {
    if (!state.ready || state.key !== storageKey) return;
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(state.value));
    } catch {
      /* In-memory UI remains usable. */
    }
  }, [state, storageKey]);
  const setValue = React.useCallback(
    (update: React.SetStateAction<T>) =>
      setState((old) => ({
        key: storageKey,
        ready: true,
        value:
          typeof update === "function"
            ? (update as (value: T) => T)(old.key === storageKey ? old.value : initialRef.current)
            : update,
      })),
    [storageKey],
  );
  return [state.key === storageKey ? state.value : initialRef.current, setValue] as const;
}
