Status:
Type: task
Blocked by: 08

Rewrite the SPA's index.html on delivery to guests, injecting a small
script + style that hides owner-only chrome.

- Set `document.documentElement.dataset.bbGuest = "1"`.
- CSS hides:
  - `[data-testid="app-sidebar-primary-actions"]`
  - `[aria-label="Settings"]`
  - `.plugin-nav-sidebar-items` (plugin nav rows)
  - `[aria-label="New thread"]`
- Selector list pinned in a constants file; audited against SPA build.
- Only rewrites HTML responses (Content-Type text/html).
- Only for guest requests (has valid token).

Ship a CI check that greps the **built bb SPA** (from a pinned bb-repo
checkout — track the bb version in a `BB_VERSION` file in this repo)
for each selector, to catch drift across bb version bumps. Fails CI if
a selector disappears.

## Comments

## Answer
