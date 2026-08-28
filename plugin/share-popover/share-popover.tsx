// Owner-facing "Share this thread" popover — the body of issue 15's
// `experimental_threadHeaderAction` and the target of the matching
// `commandPaletteAction`.
//
// The popover is anchored to a Share icon-button in the thread-header row
// (48px chrome, 28px controls per the SDK docs) and portalled via the
// vendored `Popover` — the row is too short for an inline form.
//
// RPC + realtime:
// - `listTokens()` seeds the "Existing tokens" list on open; a
//   `REALTIME_CHANNELS.tokensChanged` subscription refreshes it so a mint or
//   share change made in the nav panel (issue 16) or another window is
//   reflected here immediately.
// - Per-token "Add this thread as read | write" calls `addShare`; each perm
//   button greys out when the thread is already shared on that token with a
//   perm at least as permissive as the button's (write covers read).
// - The "Mint new share" section calls `mintToken` → `addShare` and copies
//   the returned guest URL to the clipboard.
//
// The "Manage all shares →" link routes to this plugin's `tokens` nav panel,
// which will be fleshed out by issue 16. The panel path is registered in
// `app.tsx`; `useBbNavigate().toPluginPanel("tokens")` resolves to
// `/plugins/bb-shared/tokens` at runtime.
import * as React from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Share08Icon } from "@hugeicons/core-free-icons";
import {
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";

import { Button } from "../components/ui/button.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover.js";
import { cn } from "../lib/utils.js";
import { REALTIME_CHANNELS } from "../lib/realtime-channels.js";
import type { Perm, Token, rpcContract } from "../server.js";
import { subscribeShareOpen } from "./open-bus.js";

// One row's worth of state — the two buttons per token can be pending
// independently, so we key by `${tokenId}:${perm}`.
type BusyKey = `${string}:${Perm}`;

const FLASH_MS = 1500;
const PERM_RANK: Record<Perm, number> = { read: 0, write: 1 };

/** Whether `existing` already grants at least `wanted`. */
function isPermCovered(existing: Perm | undefined, wanted: Perm): boolean {
  if (existing === undefined) return false;
  return PERM_RANK[existing] >= PERM_RANK[wanted];
}

interface ShareFormProps {
  threadId: string;
  projectId: string;
  onClose: () => void;
}

function ShareForm({ threadId, projectId, onClose }: ShareFormProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();

  const [tokens, setTokens] = React.useState<Token[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [busyKeys, setBusyKeys] = React.useState<Set<BusyKey>>(
    () => new Set(),
  );
  const [flash, setFlash] = React.useState<string | null>(null);
  const [newPerm, setNewPerm] = React.useState<Perm>("read");
  const [minting, setMinting] = React.useState(false);

  const load = React.useCallback(() => {
    // A stale call landing after the popover is reopened would clobber a
    // fresher list; abort-style cancellation isn't part of the rpc client, so
    // we tolerate the last-write-wins with a component-scoped flag.
    let cancelled = false;
    rpc
      .call("listTokens", null)
      .then((res) => {
        if (cancelled) return;
        setTokens(res.tokens);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  React.useEffect(() => load(), [load]);

  // Any token mutation anywhere (mint / rename / delete / share add / remove
  // / update) refetches. The channel is coarse on purpose — a fine-grained
  // patch stream would need consumer-side reducers per event kind.
  useRealtime(REALTIME_CHANNELS.tokensChanged, () => {
    load();
  });

  const showFlash = React.useCallback((message: string) => {
    setFlash(message);
    window.setTimeout(() => {
      setFlash((current) => (current === message ? null : current));
    }, FLASH_MS);
  }, []);

  const setBusy = React.useCallback((key: BusyKey, busy: boolean) => {
    setBusyKeys((prev) => {
      const next = new Set(prev);
      if (busy) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const handleAddShare = React.useCallback(
    async (tokenId: string, perm: Perm) => {
      const key: BusyKey = `${tokenId}:${perm}`;
      setBusy(key, true);
      setActionError(null);
      try {
        await rpc.call("addShare", {
          token_id: tokenId,
          thread_id: threadId,
          project_id: projectId,
          perm,
        });
        showFlash(`Shared as ${perm}`);
        // Realtime will refresh, but a local refetch keeps the UI honest if
        // the broadcast is delayed.
        load();
      } catch (err: unknown) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(key, false);
      }
    },
    [rpc, threadId, projectId, showFlash, load, setBusy],
  );

  const handleMint = React.useCallback(async () => {
    setMinting(true);
    setActionError(null);
    try {
      const { token, url } = await rpc.call("mintToken", {});
      // Mint alone doesn't attach the current thread — do both so the
      // freshly-copied URL is actually useful. If the addShare fails we
      // still surface the copied URL, since the token exists.
      try {
        await rpc.call("addShare", {
          token_id: token.id,
          thread_id: threadId,
          project_id: projectId,
          perm: newPerm,
        });
      } catch (err: unknown) {
        setActionError(
          `Token minted but share failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      // Clipboard writes require a user gesture; the mint button click is
      // that gesture. On surfaces without the API (older webviews) we
      // degrade to showing the URL in the flash.
      const clipboard = globalThis.navigator?.clipboard;
      if (clipboard !== undefined) {
        try {
          await clipboard.writeText(url);
          showFlash("Link copied to clipboard");
        } catch {
          showFlash(url);
        }
      } else {
        showFlash(url);
      }
      load();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setMinting(false);
    }
  }, [rpc, threadId, projectId, newPerm, showFlash, load]);

  const handleManageAll = React.useCallback(() => {
    onClose();
    navigate.toPluginPanel("tokens");
  }, [navigate, onClose]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-medium">Share this thread</h3>
        {flash !== null ? (
          <span className="text-xs text-muted-foreground" role="status">
            {flash}
          </span>
        ) : null}
      </div>

      {/* Existing tokens ------------------------------------------------ */}
      <section className="flex flex-col gap-2">
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Existing tokens
        </h4>
        {loadError !== null ? (
          <p className="text-xs text-destructive">{loadError}</p>
        ) : tokens === null ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : tokens.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No tokens yet. Mint one below.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {tokens.map((token) => {
              const existing = token.shares.find(
                (share) => share.thread_id === threadId,
              );
              return (
                <li
                  key={token.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-background/40 px-2 py-1.5"
                >
                  <span
                    className="min-w-0 truncate text-xs font-medium"
                    title={token.label}
                  >
                    {token.label}
                  </span>
                  <span className="flex shrink-0 gap-1">
                    {(["read", "write"] as const).map((perm) => {
                      const covered = isPermCovered(existing?.perm, perm);
                      const busy = busyKeys.has(`${token.id}:${perm}`);
                      return (
                        <Button
                          key={perm}
                          variant="outline"
                          size="sm"
                          disabled={covered || busy}
                          onClick={() => void handleAddShare(token.id, perm)}
                          className={cn("h-7 px-2 text-xs")}
                          aria-label={
                            covered
                              ? `Already shared as ${perm} on ${token.label}`
                              : `Add this thread as ${perm} on ${token.label}`
                          }
                        >
                          {perm}
                        </Button>
                      );
                    })}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Mint new share ------------------------------------------------- */}
      <section className="flex flex-col gap-2 border-t border-border/60 pt-3">
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Mint new share
        </h4>
        <div className="flex items-center justify-between gap-2">
          <div
            role="radiogroup"
            aria-label="Guest permission"
            className="inline-flex items-center rounded-md border border-input p-0.5"
          >
            {(["read", "write"] as const).map((perm) => (
              <button
                key={perm}
                type="button"
                role="radio"
                aria-checked={newPerm === perm}
                onClick={() => setNewPerm(perm)}
                className={cn(
                  "h-6 rounded-sm px-2 text-xs capitalize transition-colors",
                  newPerm === perm
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:bg-state-hover hover:text-foreground",
                )}
              >
                {perm}
              </button>
            ))}
          </div>
          <Button
            variant="default"
            size="sm"
            disabled={minting}
            onClick={() => void handleMint()}
            className="h-7 px-3 text-xs"
          >
            {minting ? "Creating…" : "Create + copy"}
          </Button>
        </div>
        {actionError !== null ? (
          <p className="text-xs text-destructive">{actionError}</p>
        ) : null}
      </section>

      {/* Manage-all link ----------------------------------------------- */}
      <button
        type="button"
        onClick={handleManageAll}
        className="self-start text-xs text-muted-foreground hover:text-foreground hover:underline"
      >
        Manage all shares →
      </button>
    </div>
  );
}

/**
 * Header-slot component: renders the Share icon-button plus the popover.
 * The popover is anchored to the button, opens on click, and can be opened
 * imperatively via `requestShareOpen(threadId)` (see `open-bus.ts`) so the
 * command palette's `run` — which fires outside any React tree — can hand
 * control here.
 */
export function ShareHeaderAction({
  threadId,
  projectId,
  isCompactViewport,
}: PluginThreadHeaderActionProps) {
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    return subscribeShareOpen((requestedThreadId) => {
      if (requestedThreadId === threadId) {
        setOpen(true);
      }
    });
  }, [threadId]);

  return (
    <ShareHeaderActionInner
      threadId={threadId}
      projectId={projectId}
      isCompactViewport={isCompactViewport}
      open={open}
      onOpenChange={setOpen}
    />
  );
}

interface ShareHeaderActionInnerProps extends PluginThreadHeaderActionProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function ShareHeaderActionInner({
  threadId,
  projectId,
  isCompactViewport,
  open,
  onOpenChange,
}: ShareHeaderActionInnerProps) {
  const iconSizeClass = isCompactViewport ? "size-4" : "size-3.5";
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Share thread"
          className="size-7"
        >
          <HugeiconsIcon
            icon={Share08Icon}
            className={iconSizeClass}
            aria-hidden
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-96"
        mobileTitle="Share thread"
      >
        {open ? (
          <ShareForm
            threadId={threadId}
            projectId={projectId}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
