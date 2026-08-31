// bb-plugin-shared — the token management console (issue 16).
//
// Registered as the `navPanel` at `/plugins/shared/tokens` (see `app.tsx`).
// It is the full-fidelity counterpart to issue 15's quick-share popover:
//
// - Tokens are listed grouped by token (each a card). Per token: an inline-
//   renameable label (`renameToken`), a read-only derived perm badge (issue
//   35 — highest perm across the token's shares), the share list (one row per
//   thread with an off/read/write segment that grants, upgrades, downgrades,
//   or revokes), a copy-URL action, and delete-token behind an `AlertDialog`
//   confirm.
// - The header carries a live worker-status pill that calls `getWorkerStatus`
//   — a stub in v0 (issue 07 fills it), so a "not implemented" rejection is
//   handled gracefully as an "offline" pill. When a temporary worker exposes
//   a claim URL, its status reads "Temporary worker" beside a Claim action.
// - `useRealtime("tokens-changed")` refetches so mutations made from the share
//   popover (or another window) reflect here immediately.
//
// Modeled on `plugins/automations/app.tsx` in the bb repo (navPanel + useRpc
// CRUD + useRealtime refetch) and issue 15's `share-popover.tsx` for the local
// idioms (busy-key sets, flash, last-write-wins refetch guard).
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
} from "@hugeicons/core-free-icons";

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
  AlertDialogTrigger,
} from "./alert-dialog.js";

// `getWorkerStatus` is stubbed to throw "not implemented" until issue 07 wires
// the CF deploy pipeline; its message is matched loosely so the pill can render
// an honest "not deployed yet" state instead of an error.
const NOT_IMPLEMENTED_RE = /not implemented/i;

const FLASH_MS = 1500;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Worker status. The RPC contract's `WorkerStatus` is `{ url?, healthy, ... }`.
// The CF `claim.url` is deliberately NOT on this payload (H1, ticket 20) — it
// is an account-takeover bearer, fetched separately via the owner-only
// `getClaimUrl` RPC (see `useClaimUrl`).
// ---------------------------------------------------------------------------

interface WorkerStatusView {
  url?: string;
  healthy: boolean;
  fault?: string;
}

type WorkerState =
  | { kind: "loading" }
  | { kind: "not-deployed" } // stub / "not implemented"
  | { kind: "error"; message: string }
  | { kind: "ready"; status: WorkerStatusView };

function useWorkerStatus(): { state: WorkerState; refetch: () => void } {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = React.useState<WorkerState>({ kind: "loading" });
  const requestRef = React.useRef(0);

  const refetch = React.useCallback(() => {
    const requestId = ++requestRef.current;
    rpc
      .call("getWorkerStatus", null)
      .then((status) => {
        if (requestRef.current !== requestId) return;
        setState({ kind: "ready", status: status as WorkerStatusView });
      })
      .catch((err: unknown) => {
        if (requestRef.current !== requestId) return;
        const message = errorText(err);
        setState(
          NOT_IMPLEMENTED_RE.test(message)
            ? { kind: "not-deployed" }
            : { kind: "error", message },
        );
      });
  }, [rpc]);

  React.useEffect(() => refetch(), [refetch]);
  // Worker deploy / health transitions ride their own channel; subscribe so
  // the pill tracks them live.
  useRealtime(REALTIME_CHANNELS.workerChanged, () => refetch());
  return { state, refetch };
}

// ---------------------------------------------------------------------------
// Claim URL (owner-only). H1 (ticket 20): the CF claim.url is an account-
// takeover bearer, so it is deliberately kept OFF getWorkerStatus and the
// worker-changed broadcast. The owner pulls it on demand via the dedicated
// `getClaimUrl` RPC (the worker denies that path to guests, M2). Refetched on
// the same worker-changed signal so the nudge appears as soon as a worker
// deploys. A rejection (stub / no worker) collapses to "no claim link yet".
// ---------------------------------------------------------------------------

function useClaimUrl(): string | undefined {
  const rpc = useRpc<typeof rpcContract>();
  const [claimUrl, setClaimUrl] = React.useState<string | undefined>(undefined);
  const requestRef = React.useRef(0);

  const refetch = React.useCallback(() => {
    const requestId = ++requestRef.current;
    rpc
      .call("getClaimUrl", null)
      .then((res) => {
        if (requestRef.current !== requestId) return;
        setClaimUrl(res.claim?.url ?? undefined);
      })
      .catch(() => {
        if (requestRef.current !== requestId) return;
        setClaimUrl(undefined);
      });
  }, [rpc]);

  React.useEffect(() => refetch(), [refetch]);
  useRealtime(REALTIME_CHANNELS.workerChanged, () => refetch());
  return claimUrl;
}

function WorkerStatusPill({
  state,
  hasShares,
  onOpenWorker,
}: {
  state: WorkerState;
  hasShares: boolean;
  onOpenWorker: (url: string) => void;
}) {
  const { label, dotClass, title } = describeWorker(state, hasShares);
  const url = state.kind === "ready" ? state.status.url : undefined;
  const content = <>
    <span className={cn("size-2 rounded-full", dotClass)} aria-hidden />
    {label}
  </>;
  const className = "inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/40 px-2.5 py-1 text-xs text-muted-foreground";

  if (url !== undefined) {
    return (
      <button
        type="button"
        onClick={() => onOpenWorker(url)}
        className={`${className} hover:bg-state-hover hover:text-foreground`}
        title={url}
        aria-label={`Open worker ${url}`}
      >
        {content}
      </button>
    );
  }

  return (
    <span
      className={className}
      title={title}
      role="status"
    >
      {content}
    </span>
  );
}

// Before any share exists there is no worker to expect, so the pill reads as a
// calm empty state rather than a fault. It only turns to an error color when a
// worker that should be running is not answering.
function describeWorker(
  state: WorkerState,
  hasShares: boolean,
): {
  label: string;
  dotClass: string;
  title: string;
} {
  const noShares = {
    label: "No shares yet",
    dotClass: "bg-muted-foreground/50",
    title: "Share a thread to set up your worker",
  };
  switch (state.kind) {
    case "loading":
      return {
        label: "Checking worker…",
        dotClass: "bg-muted-foreground/50 animate-pulse",
        title: "Contacting the share worker",
      };
    case "not-deployed":
      return hasShares
        ? {
            label: "Setting up worker…",
            dotClass: "bg-muted-foreground/50 animate-pulse",
            title: "Your share worker is being set up. This happens once.",
          }
        : noShares;
    case "error":
      return hasShares
        ? {
            label: "Worker not responding",
            dotClass: "bg-destructive",
            title: state.message,
          }
        : noShares;
    case "ready":
      return state.status.healthy
        ? {
            label: "Worker online",
            dotClass: "bg-emerald-500",
            title: state.status.url ?? "Worker is online",
          }
        : {
            label: "Worker offline",
            dotClass: "bg-destructive",
            title: "Check the worker or recreate it explicitly",
          };
  }
}

/**
 * The claim action. SPEC §"Worker lifecycle": unclaimed CF temp accounts
 * self-destruct after 60 min, so an owner can claim it from the status area.
 * `claim.url` is a bearer credential — never shown to guests, and we open it
 * via the host's browser preference rather than rendering it as raw text.
 */
function ClaimWorkerNotice({ claimUrl }: { claimUrl: string | undefined }) {
  const navigate = useBbNavigate();
  const [copyState, setCopyState] = React.useState<"idle" | "copied" | "failed">("idle");

  const copyClaimUrl = React.useCallback(async () => {
    if (claimUrl === undefined) return;
    const clipboard = globalThis.navigator?.clipboard;
    if (clipboard === undefined) {
      setCopyState("failed");
      return;
    }
    try {
      await clipboard.writeText(claimUrl);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    window.setTimeout(() => setCopyState("idle"), FLASH_MS);
  }, [claimUrl]);

  // The claim URL is a bearer credential, so it is never rendered as text or
  // sent to guests. It is opened or copied only through an explicit owner action.
  if (claimUrl === undefined) return null;

  return (
    <p className="text-xs text-muted-foreground">
      bb-shared uses temporary Cloudflare workers to share your sessions. If
      you do not claim your worker, it will be cleaned up after 60 minutes and
      will need to be recreated, losing your shared links. {" "}
      <button
        type="button"
        onClick={() => navigate.openUrl(claimUrl)}
        className="font-semibold text-foreground underline underline-offset-2 hover:text-foreground/80"
      >
        Claim your worker
      </button>
      <span aria-hidden> · </span>
      <button
        type="button"
        onClick={() => void copyClaimUrl()}
        className="font-semibold text-foreground underline underline-offset-2 hover:text-foreground/80"
      >
        {copyState === "copied"
          ? "Copied"
          : copyState === "failed"
            ? "Couldn’t copy"
            : "Copy URL"}
      </button>
    </p>
  );
}

function WorkerHostname({ url }: { url: string | undefined }) {
  const navigate = useBbNavigate();
  if (url === undefined) return null;
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return null;
  }
  return (
    <p className="text-xs text-muted-foreground">
      Worker: {" "}
      <button
        type="button"
        onClick={() => navigate.openUrl(url)}
        className="font-mono text-foreground underline underline-offset-2 hover:text-foreground/80"
      >
        {hostname}
      </button>
    </p>
  );
}

function RecreateWorkerButton({
  online,
  onError,
}: {
  online: boolean;
  onError: (message: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const recreate = React.useCallback(async () => {
    setBusy(true);
    try {
      await rpc.call("recreateWorker", null);
      setConfirmOpen(false);
    }
    catch (err) { onError(errorText(err)); }
    finally { setBusy(false); }
  }, [onError, rpc]);

  const button = (
    <Button
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={online ? undefined : () => void recreate()}
      className="h-7 px-2 text-xs"
    >
      {busy ? "Recreating…" : "Recreate"}
    </Button>
  );

  if (!online) return button;

  return (
    <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
      <AlertDialogTrigger asChild>{button}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Recreate this worker?</AlertDialogTitle>
          <AlertDialogDescription>
            This worker is online. Recreating it gives you a new hostname, and
            while existing shared links will still work, we&apos;ll stop monitoring
            the old worker. The new worker will need to be claimed to stay
            online.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={(event) => {
              event.preventDefault();
              void recreate();
            }}
          >
            {busy ? "Recreating…" : "Recreate"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
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
          aria-label="Token label"
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
        title="Rename link"
      >
        {token.label}
      </button>
      {badge}
      <Button
        variant="ghost"
        size="icon"
        onClick={startEdit}
        className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
        aria-label={`Rename link ${token.label}`}
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
          ? "At least one thread on this link is write"
          : "Every thread on this link is read"
      }
    >
      {perm}
    </span>
  );
}

// ---------------------------------------------------------------------------
// One share row: thread title + a three-state perm segment (issue 35). The
// segment is the single control for the thread on this link: read / write
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
// Copy-URL note: the server holds each link's raw URL in memory for the
// session (issue 32), so `listTokens` returns `token.url` and every listed
// link is copyable until restart — no more session-only `mintedUrls` map or
// "shown once" disabled state.
// ---------------------------------------------------------------------------

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
          {/* `ButtonProps` omits `title`; the native tooltip rides the
              wrapping span instead. `token.url` is held in memory for the
              session, but a token whose raw bearer isn't cached comes back
              without one — copy is disabled with a plain explanation. */}
          <span
            title={
              token.url === undefined
                ? "Create the link again to copy it"
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
            aria-label={`Delete link ${token.label}`}
          >
            <HugeiconsIcon icon={Delete02Icon} className="size-4" aria-hidden />
          </Button>
        </div>
      </div>

      {token.shares.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No threads on this link yet.
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
            <AlertDialogTitle>Delete this link?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{token.label}&rdquo; and its {token.shares.length}{" "}
              {token.shares.length === 1 ? "share" : "shares"} stop working
              right away. Anyone using this link loses access.
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
  const navigate = useBbNavigate();
  const { tokens, error, refetch } = useTokens();
  const worker = useWorkerStatus();
  const claimUrl = useClaimUrl();

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
            <div className="flex items-center gap-2">
              <WorkerStatusPill
                state={worker.state}
                hasShares={(tokens?.length ?? 0) > 0}
                onOpenWorker={(url) => navigate.openUrl(url)}
              />
              {worker.state.kind === "ready" ? (
                <RecreateWorkerButton
                  online={worker.state.status.healthy}
                  onError={setActionError}
                />
              ) : null}
            </div>
          </div>
          {worker.state.kind === "ready" && !worker.state.status.healthy && worker.state.status.fault ? (
            <p className="text-xs text-destructive">{worker.state.status.fault}</p>
          ) : null}
          {flash !== null ? (
            <p className="text-xs text-muted-foreground" role="status">
              {flash}
            </p>
          ) : null}
          {actionError !== null ? (
            <p className="text-xs text-destructive">{actionError}</p>
          ) : null}
        </header>

        {/* Token list ------------------------------------------------------ */}
        <div className="pt-4">
          {error !== null ? (
            <div className="flex flex-col items-start gap-2">
              <p className="text-xs text-destructive">
                Couldn&rsquo;t load your links: {error}
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
            <p className="text-xs text-muted-foreground">Loading links…</p>
          ) : tokens.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No links yet. Use the Share button in any thread header to
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
            <WorkerHostname
              url={
                worker.state.kind === "ready"
                  ? worker.state.status.url
                  : undefined
              }
            />
            <ClaimWorkerNotice claimUrl={claimUrl} />
            <p className="text-xs text-muted-foreground">
              Shared thread secrets are not stored on disk for security, so
              shared thread state disappears when you restart bb or this
              plugin.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
