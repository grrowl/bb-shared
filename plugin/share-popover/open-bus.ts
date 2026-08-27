// Module-level event bus that lets `commandPaletteAction.run()` — which runs
// outside any React tree — ask a mounted `ShareHeaderAction` to open its
// popover. The header action anchors the Radix popover to its Share button;
// without a mounted anchor the popover has nowhere to land. The palette's
// `isAvailable` guard already requires a `threadId`, and the header slot is
// present on every real thread route, so a mounted subscriber is the normal
// case. If none is listening the request is dropped silently — the palette
// is a hint, not a hard route.
type OpenListener = (threadId: string) => void;

const listeners = new Set<OpenListener>();

export function subscribeShareOpen(listener: OpenListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function requestShareOpen(threadId: string): void {
  for (const listener of listeners) {
    listener(threadId);
  }
}
