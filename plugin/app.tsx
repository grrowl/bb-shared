// Owner management, thread sharing, and the share command use one invitation contract.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { ShareHeaderAction } from "./share-popover/share-popover";
import { requestShareOpen } from "./share-popover/open-bus";
import { TokensPanel } from "./nav-panel/tokens-panel";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "tokens",
    title: "Shared threads",
    // BB does not expose a `Share` sidebar glyph. `Sent` is its built-in
    // paper-plane/share glyph; an unknown `Share` name falls back to Zap.
    icon: "Sent",
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
