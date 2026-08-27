// bb-plugin-shared — frontend entry.
//
// Registers three surfaces from a single `definePluginApp` collector:
//
// - `navPanel` — the token management panel. Still a placeholder here;
//   issue 16 replaces `TokensPanel` without touching this registration.
// - `experimental_threadHeaderAction` — the Share icon-button + popover
//   built in issue 15 (see `share-popover/share-popover.tsx`). The Share
//   button lives in the 48 px thread-header row; the popover is portalled
//   because the row is too short for an inline form.
// - `commandPaletteAction` — a "Share this thread" row in bb's palette
//   (Mod+Shift+P). `isAvailable` hides it on surfaces without a thread; on
//   `run`, it asks the mounted `ShareHeaderAction` (via `open-bus.ts`) to
//   open its popover, so the two entry points always share one code path.
//
// The RPC contract is imported type-only from `./server` — the frontend
// bundle never pulls the backend module.
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { ShareHeaderAction } from "./share-popover/share-popover";
import { requestShareOpen } from "./share-popover/open-bus";

// A trivial hook that exists only to prove `useRpc` typechecks against the
// contract. Downstream issues use it in earnest.
function useSharedRpc() {
  return useRpc<typeof rpcContract>();
}

function TokensPanel(_props: PluginNavPanelProps) {
  // Reference useSharedRpc so the type-only import chain is exercised.
  // Never call the returned rpc — the backend stubs would throw.
  void useSharedRpc;
  return (
    <div className="p-4 text-sm text-muted-foreground">
      bb-shared: management panel scaffold. Wired up in issue 16.
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "tokens",
    title: "Shared threads",
    icon: "Link",
    path: "tokens",
    component: TokensPanel,
  });
  app.slots.experimental_threadHeaderAction({
    id: "share",
    title: "Share thread",
    component: ShareHeaderAction,
  });
  app.slots.commandPaletteAction({
    id: "share-this-thread",
    title: "Share this thread",
    isAvailable: (context) => context.threadId !== null,
    run: (context) => {
      // isAvailable narrows this at the palette layer; guard once more so a
      // stale invocation from before an `isAvailable` recheck can't crash.
      if (context.threadId === null) return;
      requestShareOpen(context.threadId);
    },
  });
});
