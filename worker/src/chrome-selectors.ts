/**
 * Owner-only chrome selectors — single source of truth for the guest shim.
 *
 * The chrome-shim stage (`stages/chrome-shim.ts`) injects a `<style>` built
 * from these into every guest HTML response so the SPA hides UI a guest must
 * not use. The CI selector-pin (`scripts/check-chrome-selectors.mjs`) reads
 * this file and greps each `probe` against a built bb SPA, so a bb version
 * bump that renames or removes one of these targets fails CI instead of
 * silently un-hiding owner chrome.
 *
 * Each entry carries two strings for two different consumers:
 *   - `css`   — the selector used inside the injected `<style>` block.
 *   - `probe` — the stable substring the CI check greps for in the built SPA.
 *               For `data-testid` selectors this is the testid value; for
 *               `aria-label` selectors it is the label text. Kept separate
 *               because a CSS selector like `[data-testid="x"]` never appears
 *               verbatim in minified JS — only the value `"x"` does.
 *
 * ─── Divergence from issue 12's literal selector list (verified against the
 *     bb checkout at commit 31a190d, `BB_VERSION`) ──────────────────────────
 *   - Ticket said `.plugin-nav-sidebar-items` (a CSS *class*). bb renders this
 *     as `data-testid="plugin-nav-sidebar-items"` (PluginNavSidebarItems.tsx),
 *     NOT a class — a class selector would match nothing and silently hide no
 *     plugin nav rows. Corrected to the attribute selector.
 *   - Ticket said `[aria-label="Settings"]` (exact). bb's Settings button
 *     aria-label is dynamic — `"Settings (⌘,)"` whenever a keyboard shortcut
 *     is bound (AppSidebar.tsx), so an exact match fails in the common case.
 *     Corrected to a `^=` prefix match. `New thread` gets the same treatment
 *     for its shortcut/split-view label variants.
 */

/** DOM attribute the shim sets on `<html>` to scope every rule to guests. */
export const GUEST_ROOT_ATTR = "data-bb-guest";
/** Value written to {@link GUEST_ROOT_ATTR} (`dataset.bbGuest = "1"`). */
export const GUEST_ROOT_FLAG = "1";

export interface ChromeSelector {
  /** Selector used in the injected `<style>`, scoped under the guest root. */
  readonly css: string;
  /** Stable substring the CI check greps for in the built SPA. */
  readonly probe: string;
  /** Human note: what this hides and where it lives in bb. */
  readonly note: string;
}

export const CHROME_SELECTORS: readonly ChromeSelector[] = [
  {
    css: '[data-testid="app-sidebar-primary-actions"]',
    probe: "app-sidebar-primary-actions",
    note: `Sidebar primary action buttons (New thread / Search). AppSidebar.tsx.`,
  },
  {
    css: '[aria-label^="Settings"]',
    probe: "Settings",
    note: `Settings button in the sidebar footer. aria-label is dynamic (carries a shortcut suffix when bound), so prefix match, not exact. AppSidebar.tsx.`,
  },
  {
    css: '[data-testid="plugin-nav-sidebar-items"]',
    probe: "plugin-nav-sidebar-items",
    note: `Plugin nav rows. Rendered as a data-testid, NOT a class. PluginNavSidebarItems.tsx.`,
  },
  {
    css: '[aria-label^="New thread"]',
    probe: "New thread",
    note: `New-thread button(s). aria-label may carry a shortcut/split-view suffix, so prefix match. ProjectList.tsx.`,
  },
];

/** The CSS rule body: every selector scoped under the guest root, hidden. */
export function buildShimCss(
  selectors: readonly ChromeSelector[] = CHROME_SELECTORS,
): string {
  const scoped = selectors
    .map((s) => `[${GUEST_ROOT_ATTR}] ${s.css}`)
    .join(",\n  ");
  return `${scoped} { display: none !important; }`;
}

/**
 * The full `<script>` + `<style>` block injected into `<head>`. The script
 * runs before the app boots and flags the document as a guest session; the
 * style hides owner-only chrome for that session only.
 */
export function buildShimHtml(
  selectors: readonly ChromeSelector[] = CHROME_SELECTORS,
): string {
  return [
    `<script>document.documentElement.dataset.bbGuest = "${GUEST_ROOT_FLAG}"</script>`,
    `<style>`,
    `  ${buildShimCss(selectors)}`,
    `</style>`,
  ].join("\n");
}
