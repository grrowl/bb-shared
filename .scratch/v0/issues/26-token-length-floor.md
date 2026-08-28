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

## Answer
