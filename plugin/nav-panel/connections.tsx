import * as React from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server.js";
import { REALTIME_CHANNELS } from "../lib/realtime-channels.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";

export interface ConnectionView {
  id: string;
  url: string;
  state: "connecting" | "ready" | "offline" | "incompatible";
  fault?: string;
  isDefault: boolean;
}

export function connectionLabel(connection: ConnectionView): string {
  const labels = { connecting: "Connecting…", ready: "Ready", offline: "Offline", incompatible: "Update required" };
  return labels[connection.state];
}

export function useConnections() {
  const rpc = useRpc<typeof rpcContract>();
  const [connections, setConnections] = React.useState<ConnectionView[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const request = React.useRef(0);
  const refetch = React.useCallback(() => {
    const current = ++request.current;
    rpc.call("listConnections", null).then((result) => {
      if (request.current !== current) return;
      setConnections(result.connections);
      setError(null);
    }).catch((error: unknown) => {
      if (request.current === current) setError(error instanceof Error ? error.message : String(error));
    });
  }, [rpc]);
  React.useEffect(() => { refetch(); return () => { request.current++; }; }, [refetch]);
  useRealtime(REALTIME_CHANNELS.workerChanged, refetch);
  return { connections, error, refetch };
}

export function ConnectionSummary({ connection }: { connection: ConnectionView }) {
  return <div className="min-w-0 text-xs">
    <p className="truncate font-mono" title={connection.url}>{new URL(connection.url).host}</p>
    <p role="status" className={connection.state === "ready" ? "text-muted-foreground" : "text-amber-600"}>
      {connectionLabel(connection)}{connection.isDefault ? " · Default" : ""}
    </p>
    {connection.fault ? <p className="text-destructive">{connection.fault}</p> : null}
  </div>;
}

function ClaimConnection({ id }: { id: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [claim, setClaim] = React.useState<{ url: string; expiresAt: number | null } | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    rpc.call("getClaimUrl", { id }).then((result) => { if (!cancelled) setClaim(result.claim); }).catch(() => {});
    return () => { cancelled = true; };
  }, [rpc, id]);
  if (!claim || (claim.expiresAt !== null && claim.expiresAt <= Date.now())) return null;
  return <div className="text-xs text-muted-foreground">
    Temporary deployments expire unless claimed. Already claimed? No further action is needed.{" "}
    <button type="button" className="underline" onClick={() => navigate.openUrl(claim.url)}>Claim deployment</button>
  </div>;
}

export function ConnectionsPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const { connections, error, refetch } = useConnections();
  const [url, setUrl] = React.useState("");
  const [secret, setSecret] = React.useState("");
  const [adding, setAdding] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [removing, setRemoving] = React.useState<string | null>(null);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setActionError(null);
    try { await action(); refetch(); }
    catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <section className="flex flex-col gap-3 border-b border-border/60 py-4" aria-label="Connections">
    <h2 className="text-sm font-semibold">Connections</h2>
    <p className="text-xs text-muted-foreground">Choose a default hostname for copied links. Invitations work on every connection while this machine is online.</p>
    {error ? <p role="alert" className="text-xs text-destructive">{error} <button type="button" onClick={refetch}>Retry</button></p> : null}
    {connections === null ? <p className="text-xs">Checking connections…</p> : connections.length === 0 ? <p className="text-xs text-muted-foreground">Deploy a connection or add an existing hostname below. Saved invitations become copyable as soon as a connection is added.</p> : <ul className="flex flex-col gap-2">
      {connections.map((connection) => <li key={connection.id} className="flex flex-col gap-2 rounded-md border border-border/60 p-3">
        <div className="flex items-center justify-between gap-2">
          <ConnectionSummary connection={connection} />
          <div className="flex gap-2">
            {!connection.isDefault ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => rpc.call("setDefaultConnection", { id: connection.id }))}>Use by default</Button> : null}
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRemoving(connection.id)}>Remove</Button>
          </div>
        </div>
        <ClaimConnection id={connection.id} />
        {removing === connection.id ? <div className="flex flex-col gap-2 text-xs">
          <p>Disconnect {new URL(connection.url).host}? Links using this hostname stop working. Invitations and other connections remain available.</p>
          <div className="flex gap-2"><Button size="sm" variant="destructive" disabled={busy} onClick={() => void run(async () => { await rpc.call("removeConnection", { id: connection.id }); setRemoving(null); })}>Disconnect and remove</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => setRemoving(null)}>Cancel</Button></div>
        </div> : null}
      </li>)}
    </ul>}
    <div className="flex gap-2">
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => rpc.call("deployConnection", null))}>{busy ? "Working…" : "Deploy connection"}</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setAdding(!adding); setSecret(""); }}>Add existing hostname</Button>
    </div>
    {adding ? <form className="flex flex-col gap-2" onSubmit={(event) => {
      event.preventDefault();
      void run(async () => {
        const pairingSecret = secret;
        setSecret("");
        await rpc.call("registerConnection", { url: url.trim(), tunnelSecret: pairingSecret });
        setUrl(""); setAdding(false);
      });
    }}>
      <label className="text-xs">Worker URL<Input type="url" placeholder="https://share.example.com" required value={url} disabled={busy} onChange={(event) => setUrl(event.target.value)} /></label>
      <label className="text-xs">Pairing secret<Input type="password" autoComplete="off" required value={secret} disabled={busy} onChange={(event) => setSecret(event.target.value)} /></label>
      <p className="text-xs text-muted-foreground">Use the secret configured on your Worker. BB verifies the tunnel before saving the connection.</p>
      <Button type="submit" size="sm" disabled={busy || !url.trim() || !secret}>{busy ? "Verifying…" : "Verify and add"}</Button>
    </form> : null}
    {actionError ? <p role="alert" className="text-xs text-destructive">{actionError}</p> : null}
  </section>;
}
