// bb-plugin-shared — the token management console (issue 16).
//
// Registered as the `navPanel` at `/plugins/shared/tokens` (see `app.tsx`).
// It is the full-fidelity counterpart to issue 15's quick-share popover:
//
// - Tokens are listed grouped by token (each a card). Per token: an inline-
//   renameable label (`renameToken`), the share list (one row per thread with
//   a perm chip), per-row remove / upgrade (read→write) / downgrade
//   (write→read), a copy-URL action, and delete-token behind an `AlertDialog`
//   confirm.
// - The header carries a "Mint new" button and a live worker-status pill that
//   calls `getWorkerStatus` — a stub in v0 (issue 07 fills it), so a
//   "not implemented" rejection is handled gracefully as an "offline" pill.
//   When the status carries CF `claim` data the pill area surfaces the
//   claim.url nudge inline; otherwise a placeholder explains it.
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
  Link04Icon,
  PencilEdit02Icon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";

import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
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

// `getWorkerStatus` is stubbed to throw "not implemented" until issue 07 wires
// the CF deploy pipeline; its message is matched loosely so the pill can render
// an honest "not deployed yet" state instead of an error.
const NOT_IMPLEMENTED_RE = /not implemented/i;

const FLASH_MS = 1500;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Worker status. The RPC contract's `WorkerStatus` is `{ url?, healthy }`; the
// SPEC's persisted worker record additionally carries `claim: { url, ... }`
// (SPEC §"Worker lifecycle"). Issue 07 may widen the wire shape to include it,
// so we read `claim` defensively off the response rather than depend on it —
// today the call rejects (stub) and neither field is present.
// ---------------------------------------------------------------------------

interface WorkerStatusView {
  url?: string;
  healthy: boolean;
  claim?: { url?: string };
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

function WorkerStatusPill({ state }: { state: WorkerState }) {
  const { label, dotClass, title } = describeWorker(state);
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/40 px-2.5 py-1 text-xs text-muted-foreground"
      title={title}
      role="status"
    >
      <span className={cn("size-2 rounded-full", dotClass)} aria-hidden />
      {label}
    </span>
  );
}

function describeWorker(state: WorkerState): {
  label: string;
  dotClass: string;
  title: string;
} {
  switch (state.kind) {
    case "loading":
      return {
        label: "Checking worker…",
        dotClass: "bg-muted-foreground/50 animate-pulse",
        title: "Contacting the share worker",
      };
    case "not-deployed":
      return {
        label: "Worker not deployed",
        dotClass: "bg-muted-foreground/50",
        title:
          "The Cloudflare worker deploys lazily on first mint (issue 07). No worker is live yet.",
      };
    case "error":
      return {
        label: "Worker unreachable",
        dotClass: "bg-destructive",
        title: state.message,
      };
    case "ready":
      return state.status.healthy
        ? {
            label: "Worker healthy",
            dotClass: "bg-emerald-500",
            title: state.status.url ?? "Worker is healthy",
          }
        : {
            label: "Worker unhealthy",
            dotClass: "bg-amber-500",
            title: state.status.url ?? "Worker reachable but unhealthy",
          };
  }
}

/**
 * The claim-URL nudge. SPEC §"Worker lifecycle": unclaimed CF temp accounts
 * self-destruct after 60 min; the owner UI surfaces `claim.url` so they can
 * keep the worker alive. `claim.url` is a bearer credential — never shown to
 * guests, and we open it via the host's browser preference rather than
 * rendering it as raw copyable text.
 */
function WorkerClaimNudge({ state }: { state: WorkerState }) {
  const navigate = useBbNavigate();
  const claimUrl =
    state.kind === "ready" ? state.status.claim?.url : undefined;

  if (claimUrl === undefined) {
    return (
      <p className="text-xs text-muted-foreground">
        No claim link yet — one appears here once a worker is deployed, letting
        you keep it alive past its 60-minute trial.
      </p>
    );
  }

  return (
    <p className="text-xs text-muted-foreground">
      Unclaimed workers expire after 60 minutes.{" "}
      <button
        type="button"
        onClick={() => navigate.openUrl(claimUrl)}
        className="font-medium text-foreground underline underline-offset-2 hover:text-foreground/80"
      >
        Claim this worker
      </button>{" "}
      to keep your share links working.
    </p>
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
}: {
  token: Token;
  onRenamed: () => void;
  onError: (message: string) => void;
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
    );
  }

  return (
    <button
      type="button"
      onClick={startEdit}
      className="group inline-flex items-center gap-1.5 rounded-sm text-sm font-medium hover:text-foreground"
      title="Rename token"
    >
      <span className="truncate">{token.label}</span>
      <HugeiconsIcon
        icon={PencilEdit02Icon}
        className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
        aria-hidden
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// One share row: thread + perm chip + remove / upgrade / downgrade.
//
// Only `thread_id` is available (the RPC contract carries no thread title), so
// the id doubles as the display name and links to the thread. A friendlier
// name would need a thread-lookup RPC that v0's contract does not expose.
// ---------------------------------------------------------------------------

function PermChip({ perm }: { perm: Perm }) {
  return (
    <span
      className={cn(
        "rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        perm === "write"
          ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
          : "bg-muted text-muted-foreground",
      )}
    >
      {perm}
    </span>
  );
}

function ShareRow({
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

  const toggleTarget: Perm = share.perm === "write" ? "read" : "write";

  return (
    <li className="flex items-center justify-between gap-2 rounded-md border border-border/50 bg-background/30 px-2 py-1.5">
      <button
        type="button"
        onClick={() => navigate.toThread(share.thread_id)}
        className="min-w-0 truncate text-left font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
        title={`Open thread ${share.thread_id}`}
      >
        {share.thread_id}
      </button>
      <span className="flex shrink-0 items-center gap-1.5">
        <PermChip perm={share.perm} />
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() =>
            void run(() =>
              rpc.call("updateShare", {
                token_id: tokenId,
                thread_id: share.thread_id,
                perm: toggleTarget,
              }),
            )
          }
          className="h-7 px-2 text-xs"
          aria-label={
            toggleTarget === "write"
              ? "Upgrade to write"
              : "Downgrade to read"
          }
        >
          {toggleTarget === "write" ? "Upgrade" : "Downgrade"}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          disabled={busy}
          onClick={() =>
            void run(() =>
              rpc.call("removeShare", {
                token_id: tokenId,
                thread_id: share.thread_id,
              }),
            )
          }
          className="size-7 text-muted-foreground hover:text-destructive"
          aria-label="Remove thread from token"
        >
          <HugeiconsIcon icon={Delete02Icon} className="size-3.5" aria-hidden />
        </Button>
      </span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// One token card.
//
// Copy-URL note: `listTokens` never returns the raw bearer (SPEC §"Data
// model" — only its HMAC is persisted, the raw token is returned once from
// `mintToken`). So the guest URL is only recoverable for tokens minted in this
// session; `mintedUrls` carries those. For pre-existing tokens the button is
// disabled with an explanation rather than fabricating a URL.
// ---------------------------------------------------------------------------

function TokenCard({
  token,
  mintedUrl,
  onChanged,
  onFlash,
  onError,
}: {
  token: Token;
  mintedUrl: string | undefined;
  onChanged: () => void;
  onFlash: (message: string) => void;
  onError: (message: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  const copyUrl = React.useCallback(async () => {
    if (mintedUrl === undefined) return;
    const clipboard = globalThis.navigator?.clipboard;
    if (clipboard !== undefined) {
      try {
        await clipboard.writeText(mintedUrl);
        onFlash("Link copied");
        return;
      } catch {
        // fall through to surfacing the URL
      }
    }
    onFlash(mintedUrl);
  }, [mintedUrl, onFlash]);

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
        <RenameableLabel token={token} onRenamed={onChanged} onError={onError} />
        <div className="flex shrink-0 items-center gap-1">
          {/* `ButtonProps` omits `title`; the native tooltip rides the
              wrapping span instead. */}
          <span
            title={
              mintedUrl === undefined
                ? "The guest URL is only shown once, at mint time — re-mint to get a fresh link."
                : "Copy the guest URL"
            }
          >
            <Button
              variant="outline"
              size="sm"
              disabled={mintedUrl === undefined}
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
            aria-label={`Delete token ${token.label}`}
          >
            <HugeiconsIcon icon={Delete02Icon} className="size-4" aria-hidden />
          </Button>
        </div>
      </div>

      {token.shares.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No threads shared on this token yet.
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
            <AlertDialogTitle>Delete token?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{token.label}&rdquo; and its {token.shares.length}{" "}
              {token.shares.length === 1 ? "share" : "shares"} will be revoked
              immediately. Any guest URL for this token stops working.
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
  const rpc = useRpc<typeof rpcContract>();
  const { tokens, error, refetch } = useTokens();
  const worker = useWorkerStatus();

  const [flash, setFlash] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [minting, setMinting] = React.useState(false);
  // tokenId → guest URL captured at mint time (see TokenCard copy-URL note).
  const [mintedUrls, setMintedUrls] = React.useState<Map<string, string>>(
    () => new Map(),
  );

  const showFlash = React.useCallback((message: string) => {
    setFlash(message);
    window.setTimeout(() => {
      setFlash((current) => (current === message ? null : current));
    }, FLASH_MS);
  }, []);

  const handleMint = React.useCallback(async () => {
    setMinting(true);
    setActionError(null);
    try {
      const { token, url } = await rpc.call("mintToken", {});
      setMintedUrls((prev) => {
        const next = new Map(prev);
        next.set(token.id, url);
        return next;
      });
      const clipboard = globalThis.navigator?.clipboard;
      if (clipboard !== undefined) {
        try {
          await clipboard.writeText(url);
          showFlash("New token minted — link copied");
        } catch {
          showFlash(url);
        }
      } else {
        showFlash(url);
      }
      refetch();
    } catch (err: unknown) {
      setActionError(errorText(err));
    } finally {
      setMinting(false);
    }
  }, [rpc, showFlash, refetch]);

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border min-h-full w-full max-w-3xl px-4 pb-6 pt-4 md:px-5">
        {/* Header ---------------------------------------------------------- */}
        <header className="flex flex-col gap-3 border-b border-border/60 pb-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <HugeiconsIcon
                icon={Link04Icon}
                className="size-4 text-muted-foreground"
                aria-hidden
              />
              <h1 className="text-sm font-semibold">Shared threads</h1>
            </div>
            <div className="flex items-center gap-2">
              <WorkerStatusPill state={worker.state} />
              <Button
                variant="default"
                size="sm"
                disabled={minting}
                onClick={() => void handleMint()}
                className="h-8 gap-1.5 px-3 text-xs"
              >
                <HugeiconsIcon
                  icon={PlusSignIcon}
                  className="size-3.5"
                  aria-hidden
                />
                {minting ? "Minting…" : "Mint new"}
              </Button>
            </div>
          </div>
          <WorkerClaimNudge state={worker.state} />
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
                Couldn&rsquo;t load tokens: {error}
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
            <p className="text-xs text-muted-foreground">Loading tokens…</p>
          ) : tokens.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No tokens yet. Mint one above, or use the Share button in any
              thread header.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {tokens.map((token) => (
                <TokenCard
                  key={token.id}
                  token={token}
                  mintedUrl={mintedUrls.get(token.id)}
                  onChanged={refetch}
                  onFlash={showFlash}
                  onError={setActionError}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
