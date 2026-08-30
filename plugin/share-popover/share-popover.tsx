// Owner-facing "Share this thread" popover — the body of issue 15's
// `experimental_threadHeaderAction` and the target of the matching
// `commandPaletteAction`.
//
// The popover is anchored to a Share icon-button in the thread-header row
// (48px chrome, 28px controls per the SDK docs) and portalled via the
// vendored `Popover` — the row is too short for an inline form.
//
// Recipient-first model (issue 34): a Link is a named recipient you grant
// threads to. The popover lists the Links and, per row, shows a 3-state
// `PermSegment` (off | read | write) for THIS thread's grant on that Link.
// Off revokes, read/write grant. A small read-only badge shows the Link's
// derived perm summary — the highest perm across all its threads.
//
// RPC + realtime:
// - `listTokens()` seeds the list on open; a `REALTIME_CHANNELS.tokensChanged`
//   subscription refreshes it so a share change made in the nav panel or
//   another window is reflected here immediately.
// - The segment calls `removeShare` (off), `addShare` (a fresh read/write), or
//   `updateShare` (read↔write on a thread already shared).
// - "New link" calls `mintToken` → attaches this thread → copies the returned
//   guest URL. The server auto-names the Link (verb-noun) when no label is
//   passed.
//
// The "Manage all links" link routes to this plugin's `tokens` nav panel.
// `useBbNavigate().toPluginPanel("tokens")` resolves to
// `/plugins/shared/tokens` at runtime.
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
  PermSegment,
  type PermValue,
} from "../components/ui/perm-segment.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover.js";
import { cn } from "../lib/utils.js";
import { REALTIME_CHANNELS } from "../lib/realtime-channels.js";
import type { Perm, Token, rpcContract } from "../server.js";
import { subscribeShareOpen } from "./open-bus.js";

const FLASH_MS = 1500;

/** The Link's highest grant across all its threads, for the read-only badge:
 * write if any share is write, else read, else null when the Link holds none. */
export function derivedPerm(token: Token): Perm | null {
  if (token.shares.length === 0) return null;
  return token.shares.some((share) => share.perm === "write") ? "write" : "read";
}

/** What a segment change on this thread's row means as an rpc intent, given
 * the thread's current perm on the Link (`undefined` when not shared) and the
 * segment's next value. Pure so it can be tested without a DOM harness; the
 * PermSegment never re-fires the selected cell, so the no-op update case
 * (`update` with an unchanged perm) is unreachable in practice. */
export type ShareAction =
  | { kind: "none" }
  | { kind: "remove" }
  | { kind: "add"; perm: Perm }
  | { kind: "update"; perm: Perm };

export function resolveShareAction(
  existing: Perm | undefined,
  next: PermValue,
): ShareAction {
  if (next === "off") {
    return existing === undefined ? { kind: "none" } : { kind: "remove" };
  }
  if (existing === undefined) return { kind: "add", perm: next };
  return { kind: "update", perm: next };
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
  // The one row whose segment change is in flight; its segment is disabled
  // until the RPC settles so a double-tap can't race two mutations.
  const [busyTokenId, setBusyTokenId] = React.useState<string | null>(null);
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

  // One gesture for grant / upgrade / downgrade / revoke on this thread's row.
  // `off` revokes; a fresh read/write adds; read↔write on an existing share
  // updates. The PermSegment never re-fires for the already-selected cell, so
  // we don't guard against a no-op change here.
  const handleSegmentChange = React.useCallback(
    async (token: Token, next: PermValue) => {
      const existing = token.shares.find(
        (share) => share.thread_id === threadId,
      );
      const action = resolveShareAction(existing?.perm, next);
      if (action.kind === "none") return;
      setBusyTokenId(token.id);
      setActionError(null);
      try {
        if (action.kind === "remove") {
          await rpc.call("removeShare", {
            token_id: token.id,
            thread_id: threadId,
          });
          showFlash("Removed.");
        } else if (action.kind === "add") {
          await rpc.call("addShare", {
            token_id: token.id,
            thread_id: threadId,
            project_id: projectId,
            perm: action.perm,
          });
          showFlash(`Shared as ${action.perm}`);
        } else {
          await rpc.call("updateShare", {
            token_id: token.id,
            thread_id: threadId,
            perm: action.perm,
          });
          showFlash(`Shared as ${action.perm}`);
        }
        // Realtime will refresh, but a local refetch keeps the UI honest if
        // the broadcast is delayed.
        load();
      } catch (err: unknown) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyTokenId(null);
      }
    },
    [rpc, threadId, projectId, showFlash, load],
  );

  const handleMint = React.useCallback(async () => {
    setMinting(true);
    setActionError(null);
    try {
      // Mint and attach the current thread in one call, so `url` is a deep
      // link straight to this thread (the query `?token=` form the worker
      // needs to set the session cookie). The label is omitted so the server
      // auto-names the Link with its verb-noun generator.
      const { url } = await rpc.call("mintToken", {
        firstThread: { thread_id: threadId, project_id: projectId, perm: newPerm },
      });

      // Clipboard writes require a user gesture; the mint button click is
      // that gesture. On surfaces without the API (older webviews) we
      // degrade to showing the URL in the flash.
      const clipboard = globalThis.navigator?.clipboard;
      if (clipboard !== undefined) {
        try {
          await clipboard.writeText(url);
          showFlash("Link copied.");
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

  const hasLinks = tokens !== null && tokens.length > 0;

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

      {/* Grant this thread to a Link (recipient) ----------------------- */}
      <section className="flex flex-col gap-2">
        {loadError !== null ? (
          <p className="text-xs text-destructive">{loadError}</p>
        ) : tokens === null ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : tokens.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No link yet. Create one below to share this thread.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {tokens.map((token) => {
              const existing = token.shares.find(
                (share) => share.thread_id === threadId,
              );
              const value: PermValue = existing?.perm ?? "off";
              const summary = derivedPerm(token);
              return (
                <li
                  key={token.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-background/40 px-2 py-1.5"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span
                      className="min-w-0 truncate text-xs font-medium"
                      title={token.label}
                    >
                      {token.label}
                    </span>
                    {summary !== null ? (
                      <span
                        className="w-fit rounded bg-muted px-1 py-px text-[10px] uppercase tracking-wide text-muted-foreground"
                        title="Highest access across this link's threads"
                      >
                        {summary}
                      </span>
                    ) : null}
                  </div>
                  <PermSegment
                    value={value}
                    onChange={(next) => void handleSegmentChange(token, next)}
                    disabled={busyTokenId === token.id}
                    aria-label={`This thread's access on ${token.label}`}
                    className="shrink-0"
                  />
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Create a new link --------------------------------------------- */}
      <section className="flex flex-col gap-2 border-t border-border/60 pt-3">
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          New link
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
            {minting ? "Creating…" : hasLinks ? "Create new link" : "Create link"}
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
        Manage all links
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
