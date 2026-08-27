// bb-plugin-shared — frontend entry.
//
// Registers three surfaces from a single `definePluginApp` collector:
//
// - `navPanel` — the token management console, built in issue 16 (see
//   `nav-panel/tokens-panel.tsx`). Grouped-by-token CRUD over the RPC contract
//   with live refetch on the `tokens-changed` realtime channel.
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
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { ShareHeaderAction } from "./share-popover/share-popover";
import { requestShareOpen } from "./share-popover/open-bus";
import { TokensPanel } from "./nav-panel/tokens-panel";

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
