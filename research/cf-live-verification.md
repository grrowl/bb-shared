# Cloudflare live verification notes

The anonymous temporary-account provisioning and worker upload path was verified
against the live Cloudflare API. A worker’s exact local identity probe is `GET
/` → `401 { "error": "token_missing" }`; Cloudflare’s workers.dev 404 HTML
response must not be accepted as that worker.

Owner observation also verified the lifecycle decision: claiming transfers the
temporary account and preserves its `workers.dev` hostname. bb-shared does not
authenticate to Cloudflare, receive a claim callback, or assert that a claim
completed. The retained implementation is documented in
`claim-confirmation.md`.
