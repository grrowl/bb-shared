// Owner management for connections and audience invitations.
import * as React from "react";
import {
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Copy01Icon,
  Delete02Icon,
  PencilEdit02Icon,
  Share08Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";

import { ConnectionsPanel } from "./connections.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { PermSegment } from "../components/ui/perm-segment.js";
import type { PermValue } from "../components/ui/perm-segment.js";
import { cn } from "../lib/utils.js";
import { REALTIME_CHANNELS } from "../lib/realtime-channels.js";
import type { Perm, Token, rpcContract } from "../server.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./alert-dialog.js";

const FLASH_MS = 1500;
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Token list data hook. Last-write-wins refetch guard mirrors the popover: the
// rpc client has no cancellation, so a stale response is dropped by request id.
// ---------------------------------------------------------------------------

function useTokens(): {
  tokens: Token[] | null;
  error: string | null;
  refetch: () => void;
} {
  const rpc = useRpc<typeof rpcContract>();
  const [tokens, setTokens] = React.useState<Token[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const requestRef = React.useRef(0);

  const refetch = React.useCallback(() => {
    const requestId = ++requestRef.current;
    rpc
      .call("listTokens", null)
      .then((res) => {
        if (requestRef.current !== requestId) return;
        setTokens(res.tokens);
        setError(null);
      })
      .catch((err: unknown) => {
        if (requestRef.current !== requestId) return;
        setError(errorText(err));
      });
  }, [rpc]);

  React.useEffect(() => refetch(), [refetch]);
  // Coarse "something changed" channel: any mint / rename / delete / share
  // add / remove / update anywhere refetches the whole list.
  useRealtime(REALTIME_CHANNELS.tokensChanged, () => refetch());
  useRealtime(REALTIME_CHANNELS.workerChanged, () => refetch());
  return { tokens, error, refetch };
}

// ---------------------------------------------------------------------------
// Inline-renameable label. Click (or the pencil) swaps the label for an input;
// Enter / blur commits via `renameToken`, Escape reverts. A rename that no-ops
// (unchanged, or empty after trim) just exits edit mode without an RPC.
// ---------------------------------------------------------------------------

function RenameableLabel({
  token,
  onRenamed,
  onError,
  badge,
}: {
  token: Token;
  onRenamed: () => void;
  onError: (message: string) => void;
  badge?: React.ReactNode;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(token.label);
  const [saving, setSaving] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const startEdit = React.useCallback(() => {
    setDraft(token.label);
    setEditing(true);
  }, [token.label]);

  React.useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = React.useCallback(async () => {
    const next = draft.trim();
    if (next.length === 0 || next === token.label) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await rpc.call("renameToken", { id: token.id, label: next });
      setEditing(false);
      onRenamed();
    } catch (err: unknown) {
      onError(errorText(err));
    } finally {
      setSaving(false);
    }
  }, [draft, token.label, token.id, rpc, onRenamed, onError]);

  if (editing) {
    return (
      <div className="flex min-w-0 items-center gap-2">
        <Input
          ref={inputRef}
          value={draft}
          maxLength={64}
          disabled={saving}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            }
          }}
          aria-label="Audience label"
          className="h-7 max-w-56 text-sm font-medium"
        />
        {badge}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      <button
        type="button"
        onClick={startEdit}
        className="min-w-0 truncate rounded-sm text-sm font-medium hover:text-foreground"
        title="Rename invitation"
      >
        {token.label}
      </button>
      {badge}
      <Button
        variant="ghost"
        size="icon"
        onClick={startEdit}
        className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
        aria-label={`Rename invitation ${token.label}`}
      >
        <HugeiconsIcon icon={PencilEdit02Icon} className="size-3.5" aria-hidden />
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Derived link perm (issue 35). A Link has no perm of its own — perm lives per
// (link, thread). The card header shows a read-only summary: write if any
// thread on the link is write, else read; nothing when the link has no shares.
// ---------------------------------------------------------------------------

export function summaryPerm(shares: Token["shares"]): Perm | null {
  if (shares.length === 0) return null;
  return shares.some((share) => share.perm === "write") ? "write" : "read";
}

function PermSummaryBadge({ perm }: { perm: Perm }) {
  return (
    <span
      className={cn(
        "rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        perm === "write"
          ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
          : "bg-muted text-muted-foreground",
      )}
      title={
        perm === "write"
          ? "At least one thread on this invitation is write"
          : "Every thread on this invitation is read"
      }
    >
      {perm}
    </span>
  );
}

// ---------------------------------------------------------------------------
// One share row: thread title + a three-state perm segment (issue 35). The
// segment is the single control for the thread on this invitation: read / write
// grant at that perm via `updateShare`, off revokes via `removeShare`
// (`addShare` isn't reachable from a row that already exists). The title
// (issue 32, `share.title`, falling back to the id) is the primary label and
// links to the thread; the raw id rides along as the tooltip.
// ---------------------------------------------------------------------------

export function ShareRow({
  tokenId,
  share,
  onChanged,
  onError,
}: {
  tokenId: string;
  share: Token["shares"][number];
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [busy, setBusy] = React.useState(false);

  const run = React.useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await action();
        onChanged();
      } catch (err: unknown) {
        onError(errorText(err));
      } finally {
        setBusy(false);
      }
    },
    [onChanged, onError],
  );

  const onPermChange = (next: PermValue) => {
    void run(() =>
      next === "off"
        ? rpc.call("removeShare", {
            token_id: tokenId,
            thread_id: share.thread_id,
          })
        : rpc.call("updateShare", {
            token_id: tokenId,
            thread_id: share.thread_id,
            perm: next,
          }),
    );
  };

  return (
    <li className="flex items-center justify-between gap-2 rounded-md border border-border/50 bg-background/30 px-2 py-1.5">
      <button
        type="button"
        onClick={() => navigate.toThread(share.thread_id)}
        className="min-w-0 truncate text-left text-xs text-muted-foreground hover:text-foreground hover:underline"
        title={`Open thread ${share.thread_id}`}
      >
        {share.title ?? share.thread_id}
      </button>
      <PermSegment
        value={share.perm}
        onChange={onPermChange}
        disabled={busy}
        aria-label={`Permission for ${share.title ?? share.thread_id}`}
        className="shrink-0"
      />
    </li>
  );
}

// ---------------------------------------------------------------------------
// One token card.
//
export function TokenCard({
  token,
  onChanged,
  onFlash,
  onError,
}: {
  token: Token;
  onChanged: () => void;
  onFlash: (message: string) => void;
  onError: (message: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const derivedPerm = summaryPerm(token.shares);

  const copyUrl = React.useCallback(async () => {
    if (token.url === undefined) return;
    const clipboard = globalThis.navigator?.clipboard;
    if (clipboard !== undefined) {
      try {
        await clipboard.writeText(token.url);
        onFlash("Link copied");
        return;
      } catch {
        // fall through to surfacing the URL
      }
    }
    onFlash(token.url);
  }, [token.url, onFlash]);

  const confirmDelete = React.useCallback(async () => {
    setDeleting(true);
    try {
      await rpc.call("deleteToken", { id: token.id });
      setConfirmOpen(false);
      onChanged();
    } catch (err: unknown) {
      onError(errorText(err));
    } finally {
      setDeleting(false);
    }
  }, [rpc, token.id, onChanged, onError]);

  return (
    <li className="flex flex-col gap-3 rounded-lg border border-border/60 bg-background/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <RenameableLabel
          token={token}
          onRenamed={onChanged}
          onError={onError}
          badge={derivedPerm !== null ? <PermSummaryBadge perm={derivedPerm} /> : undefined}
        />
        <div className="flex shrink-0 items-center gap-1">
          <span
            title={
              token.url === undefined
                ? "Add a connection to copy this invitation"
                : "Copy the guest link"
            }
          >
            <Button
              variant="outline"
              size="sm"
              disabled={token.url === undefined}
              onClick={() => void copyUrl()}
              className="h-7 gap-1.5 px-2 text-xs"
            >
              <HugeiconsIcon
                icon={Copy01Icon}
                className="size-3.5"
                aria-hidden
              />
              Copy URL
            </Button>
          </span>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setConfirmOpen(true)}
            className="size-7 text-muted-foreground hover:text-destructive"
            aria-label={`Delete invitation ${token.label}`}
          >
            <HugeiconsIcon icon={Delete02Icon} className="size-4" aria-hidden />
          </Button>
        </div>
      </div>

      {token.shares.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No threads on this invitation yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {token.shares.map((share) => (
            <ShareRow
              key={share.thread_id}
              tokenId={token.id}
              share={share}
              onChanged={onChanged}
              onError={onError}
            />
          ))}
        </ul>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this invitation?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{token.label}&rdquo; and its {token.shares.length}{" "}
              {token.shares.length === 1 ? "share" : "shares"} stop working
              right away. Access granted by this invitation is revoked. Other invitations remain valid.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                // Keep the dialog mounted while the delete is in flight so the
                // pending state stays visible; close on success in the handler.
                e.preventDefault();
                void confirmDelete();
              }}
            >
              {deleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Panel root.
// ---------------------------------------------------------------------------

export function TokensPanel(_props: PluginNavPanelProps) {
  const { tokens, error, refetch } = useTokens();

  const [flash, setFlash] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);

  const showFlash = React.useCallback((message: string) => {
    setFlash(message);
    window.setTimeout(() => {
      setFlash((current) => (current === message ? null : current));
    }, FLASH_MS);
  }, []);

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border min-h-full w-full max-w-3xl px-4 pb-6 pt-4 md:px-5">
        {/* Header ---------------------------------------------------------- */}
        <header className="flex flex-col gap-3 border-b border-border/60 pb-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <HugeiconsIcon
                icon={Share08Icon}
                className="size-4 text-muted-foreground"
                aria-hidden
              />
              <h1 className="text-sm font-semibold">Shared threads</h1>
            </div>
          </div>
          {flash !== null ? (
            <p className="text-xs text-muted-foreground" role="status">
              {flash}
            </p>
          ) : null}
          {actionError !== null ? (
            <p className="text-xs text-destructive">{actionError}</p>
          ) : null}
        </header>

        <ConnectionsPanel />

        {/* Token list ------------------------------------------------------ */}
        <div className="pt-4">
          {error !== null ? (
            <div className="flex flex-col items-start gap-2">
              <p className="text-xs text-destructive">
                Couldn&rsquo;t load your invitations: {error}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={refetch}
                className="h-7 px-2 text-xs"
              >
                Retry
              </Button>
            </div>
          ) : tokens === null ? (
            <p className="text-xs text-muted-foreground">Loading invitations…</p>
          ) : tokens.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No invitations yet. Use the Share button in any thread header to
              create one.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {tokens.map((token) => (
                <TokenCard
                  key={token.id}
                  token={token}
                  onChanged={refetch}
                  onFlash={showFlash}
                  onError={setActionError}
                />
              ))}
            </ul>
          )}
          <div className="mt-4 flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">
              Invitations work through every connected hostname. Deleting an invitation revokes its access across all connections.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
