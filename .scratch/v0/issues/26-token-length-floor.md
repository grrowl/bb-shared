Status: open
Type: hardening
Severity: low
Blocked by:
Found by: post-v0 adversarial review (2026-08-28)

Token regex floor is looser than the mint width.

`worker/src/token.ts:32` accepts `bbsh_[A-Za-z0-9_-]{32,64}`, but tokens are
minted at 32 bytes = 43 chars (`plugin/authz/token-store.ts:109`). The 32-char
floor would accept a 24-byte (~144-bit) token. Nothing mints those, so it is
not currently exploitable — filing only so the regex isn't mistaken for the
bearer-entropy guarantee.

## Fix direction

Tighten the accepted width to exactly what mint produces (43 chars, or a tight
`{43,64}` if a future longer token is anticipated). Cheap, closes the gap
between "what we mint" and "what we accept".

## Comments

Deferred (2026-08-28). The fix (tighten `TOKEN_RE` to `{43,64}` in
`worker/src/token.ts`) is one line, but the worker test fixtures use 32-char and
40-char tokens as valid across `token.test.ts`, `response-filters.test.ts`,
`ws-frame-filter.test.ts`, and `authz.test.ts`, so tightening the floor churns
those fixtures. Not worth the change/risk for a non-exploitable LOW while other
work is in flight. Left open; do it with the next worker-test pass and bump the
fixtures to 43 chars.

## Answer
