# Cloudflare claim observation and lifecycle decision

Status: accepted product decision.

Live owner observation: claiming a temporary Cloudflare deployment transfers the
entire temporary account and preserves the deployed worker's `workers.dev`
hostname. The owner performs that Cloudflare-dashboard action; bb-shared has no
claim-status API and must never report that it knows the action completed.

There is deliberately no Cloudflare OAuth integration. The local durable record
contains only the worker endpoint, tunnel secret, claim bearer/expiry, and
deployment metadata. Temporary API tokens and account ids exist only during
provisioning/upload.

The claim bearer is owner-only and hidden after expiry. Expiry does not decide
whether an endpoint is usable. A saved endpoint is reused precisely when `GET
/` returns `401` JSON `{ "error": "token_missing" }`. On every other result,
including the workers.dev 404 HTML page, it is Offline while its record remains
for periodic recovery. This is true without shares and after restarts.

Only **Recreate worker** may provision a replacement. It preserves the old
record/tunnel until the new endpoint is provisioned and durably saved. A new
hostname leaves copied links pointing at the old worker; an old claimed worker
is not deleted and requires manual Cloudflare cleanup when desired.

Legacy OAuth records are migrated once only when their saved endpoint and tunnel
secret validate. The compatible new record is written before the OAuth record is
purged. Unusable or unreadable legacy data is retained/quarantined for recovery,
never silently deleted or overwritten.

The removed OAuth subsystem no longer has a safely configured client identity
with which to revoke legacy refresh grants. Migration purges local grant bytes
after the endpoint record is safely written; owners who previously connected
Cloudflare should revoke the old app grant manually in Cloudflare.
