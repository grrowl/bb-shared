Status:
Type: task
Blocked by: 08

Worker response filters — intercept and reshape upstream JSON responses.

- `GET /api/v1/system/config`: strip `aiServices`, `keybindings`,
  `voiceTranscriptionEnabled`; keep theme + shell config.
- `GET /api/v1/sidebar-bootstrap`: filter `projects[].threads` to the
  token's shares; filter `sections` to allowed; replace `personalProject`
  with an empty-thread stub.
- `GET /api/v1/plugins`: return `{ plugins: [] }` (v0).
- `GET /api/v1/hosts`: return `[]`.
- `GET /api/v1/plugin-settings/*`: return empty.

Each filter takes upstream JSON + token scope + returns filtered JSON.
Unit tests per filter with realistic bb response fixtures.

Notes:

- Consumes the token-scope shape from 06's authz response; the
  interface is fixed in SPEC.md so no build dependency on 06 —
  parallelizable.
- **Share fixture capture with issue 11**: one snapshot of a live bb
  instance's responses + WS frames serves both this and the WS filter.
  Coordinate with 11's owner on fixture location.

## Comments

## Answer
