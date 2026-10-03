/**
 * Snapshot store for useSyncExternalStore in DSH settings cards.
 */

export function createStore(initial) {
  let snapshot = initial
  const listeners = new Set()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(next) {
      snapshot = next
      for (const listener of listeners) listener()
    },
  }
}
