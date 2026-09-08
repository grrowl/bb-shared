// Thread permissions for audience invitations, using the default connection.
import * as React from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Copy01Icon, Share08Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import {
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";

import { ConnectionSummary, useConnections } from "../nav-panel/connections.js";
import { Input } from "../components/ui/input.js";
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
import { REALTIME_CHANNELS } from "../lib/realtime-channels.js";
import type { Perm, Token, rpcContract } from "../server.js";
import { subscribeShareOpen } from "./open-bus.js";

const FLASH_MS = 1500;

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
  const { connections, error: connectionError } = useConnections();
  const connection = connections?.find((item) => item.isDefault);
  const [label, setLabel] = React.useState("");

  const [tokens, setTokens] = React.useState<Token[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  // The one row whose segment change is in flight; its segment is disabled
  // until the RPC settles so a double-tap can't race two mutations.
  const [busyTokenId, setBusyTokenId] = React.useState<string | null>(null);
  const [copiedTokenId, setCopiedTokenId] = React.useState<string | null>(null);
  const [flash, setFlash] = React.useState<string | null>(null);
  const [minting, setMinting] = React.useState(false);

  const request = React.useRef(0);
  const load = React.useCallback(() => {
    const current = ++request.current;
    rpc.call("listTokens", null).then((res) => {
      if (current !== request.current) return;
      setTokens(res.tokens); setLoadError(null);
    }).catch((err: unknown) => {
      if (current === request.current) setLoadError(err instanceof Error ? err.message : String(err));
    });
  }, [rpc]);
  React.useEffect(() => { load(); return () => { request.current++; }; }, [load]);
  useRealtime(REALTIME_CHANNELS.tokensChanged, load);
  useRealtime(REALTIME_CHANNELS.workerChanged, load);

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

  const copyUrl = React.useCallback(
    async (tokenId: string, url: string | undefined) => {
      if (url === undefined) return;
      const clipboard = globalThis.navigator?.clipboard;
      if (clipboard !== undefined) {
        try {
          await clipboard.writeText(url);
          setCopiedTokenId(tokenId);
          window.setTimeout(() => {
            setCopiedTokenId((current) => current === tokenId ? null : current);
          }, FLASH_MS);
          showFlash("Link copied.");
          return;
        } catch {
          // Fall through to show the URL for environments that reject writes.
        }
      }
      showFlash(url);
    },
    [showFlash],
  );

  const handleMint = React.useCallback(async (perm: Perm) => {
    setMinting(true);
    setActionError(null);
    try {
      // Persist the invitation and its first thread atomically. A connection
      // can be added later; then listTokens supplies the copyable URL.
      const { url } = await rpc.call("mintToken", {
        ...(label.trim() ? { label: label.trim() } : {}),
        firstThread: { thread_id: threadId, project_id: projectId, perm },
      });

      setLabel("");
      if (url === undefined) {
        showFlash("Invitation created. Add a connection to copy its link.");
      } else {
        await copyUrl("new", url);
      }
      load();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setMinting(false);
    }
  }, [rpc, threadId, projectId, label, showFlash, copyUrl, load]);

  const handleManageAll = React.useCallback(() => {
    onClose();
    navigate.toPluginPanel("tokens");
  }, [navigate, onClose]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">Share this thread</h3>
        {flash !== null ? (
          <span className="text-xs text-muted-foreground" role="status">
            {flash}
          </span>
        ) : null}
      </div>

      {connectionError ? <p className="text-xs text-destructive">{connectionError}</p> : connection ? <>
        <ConnectionSummary connection={connection} />
        {connection.state !== "ready" ? <p className="text-xs text-muted-foreground">Links can be copied now. Guests can connect when this hostname is ready.</p> : null}
      </> : <p className="text-xs text-muted-foreground">{connections === null ? "Checking connections…" : "Invitations are saved on this machine. Open management to deploy a connection or add your hostname, then copy a link."}</p>}

      {/* Grant this thread to a Link (recipient) ----------------------- */}
      <section className="flex flex-col gap-2">
        {loadError !== null ? (
          <p className="text-xs text-destructive">{loadError}</p>
        ) : tokens === null ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : tokens.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No invitations yet. Create one below to share this thread.
          </p>
        ) : (
          <>
            <ul className="flex flex-col gap-2">
              {tokens.map((token) => {
                const existing = token.shares.find(
                  (share) => share.thread_id === threadId,
                );
                const value: PermValue = existing?.perm ?? "off";
                return (
                  <li
                    key={token.id}
                    className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-background/40 px-2 py-1.5"
                  >
                    <div className="flex min-w-0 items-center gap-1">
                      <span
                        className="min-w-0 truncate text-xs font-medium"
                        title={token.label}
                      >
                        {token.label}
                      </span>
                      <span
                        title={
                          existing?.url === undefined
                            ? existing === undefined ? "Share this thread first to copy its URL" : "Add a connection to copy this invitation"
                            : "Copy URL for this thread"
                        }
                      >
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled={existing?.url === undefined}
                          onClick={() => void copyUrl(token.id, existing?.url)}
                          className="size-5 shrink-0 text-muted-foreground hover:text-foreground"
                          aria-label={`Copy ${token.label} URL for this thread`}
                        >
                          <HugeiconsIcon
                            icon={copiedTokenId === token.id ? Tick02Icon : Copy01Icon}
                            className="size-3"
                            aria-hidden
                          />
                        </Button>
                      </span>
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
          </>
        )}
      </section>

      {/* Create a new link --------------------------------------------- */}
      <section className="flex flex-col gap-2 border-t border-border/60 pt-3">
        <Input aria-label="Audience label (optional)" placeholder="Audience label (optional)" value={label} maxLength={64} disabled={minting} onChange={(event) => setLabel(event.target.value)} />
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium">Create invitation</span>
          <div
            role="group"
            aria-label="Create invitation with permission"
            className="inline-flex items-center rounded-md border border-input p-0.5"
          >
            {(["read", "write"] as const).map((perm) => (
              <button
                key={perm}
                type="button"
                disabled={minting}
                onClick={() => void handleMint(perm)}
                className="h-6 rounded-sm px-2 text-xs capitalize text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                {perm}
              </button>
            ))}
          </div>
        </div>
        {actionError !== null ? (
          <p className="text-xs text-destructive">{actionError}</p>
        ) : null}
      </section>
      {(
        <button
          type="button"
          onClick={handleManageAll}
          className="self-start text-xs text-muted-foreground underline underline-offset-2 hover:text-muted-foreground/80"
        >
          Manage connections and invitations
        </button>
      )}
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
