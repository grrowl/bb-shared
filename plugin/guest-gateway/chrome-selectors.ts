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

/**
 * DOM attribute the shim's client script sets on `<html>` to the CURRENT
 * thread's mode when that thread is read-only (issue 36). Read-only chrome
 * rules (`ChromeSelector.readOnly`) are scoped under this so they apply only on
 * a read thread — and, crucially, re-apply on client-side SPA route changes,
 * where no fresh document (and so no fresh server-injected CSS) is fetched. On
 * a write thread or an unknown thread the attribute is absent → composer shown.
 */
export const PERM_ROOT_ATTR = "data-bb-guest-perm";
/** Value written to {@link PERM_ROOT_ATTR} for a read-only thread. */
export const PERM_READ_FLAG = "read";

export interface ChromeSelector {
  /** Selector used in the injected `<style>`, scoped under the guest root. */
  readonly css: string;
  /** Stable substring the CI check greps for in the built SPA. */
  readonly probe: string;
  /** Human note: what this hides and where it lives in bb. */
  readonly note: string;
  /**
   * When true, this target is hidden only on a READ-ONLY thread (scoped under
   * {@link PERM_ROOT_ATTR}), not for every guest. Absent/false ⇒ owner-only
   * chrome hidden for the whole guest session regardless of thread perm.
   */
  readonly readOnly?: boolean;
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
  {
    css: '[data-app-composer]',
    probe: "data-app-composer",
    note: `Message composer shell (the whole prompt box). Hidden ONLY on a read-only thread (readOnly), so a write guest keeps it and a read guest sees the transcript with no message box (issue 36 / ux-refinement Surface 6). bb sets the attribute on the composer wrapper in FollowUpPromptBox.tsx.`,
    readOnly: true,
  },
];

/**
 * The CSS rule body. Owner-only selectors are scoped under the guest root and
 * hidden for the whole session; `readOnly` selectors (the composer) are scoped
 * ALSO under {@link PERM_ROOT_ATTR}, so they hide only on a read-only thread.
 * Emitted as one or two `display:none` rules (the read-only rule is omitted
 * when no `readOnly` selector is present, keeping the base shim identical).
 */
export function buildShimCss(
  selectors: readonly ChromeSelector[] = CHROME_SELECTORS,
): string {
  const ownerRoot = `[${GUEST_ROOT_ATTR}]`;
  const readRoot = `[${GUEST_ROOT_ATTR}][${PERM_ROOT_ATTR}="${PERM_READ_FLAG}"]`;
  const owner = selectors.filter((s) => !s.readOnly);
  const readOnly = selectors.filter((s) => s.readOnly);
  const rules: string[] = [];
  if (owner.length > 0) {
    const scoped = owner.map((s) => `${ownerRoot} ${s.css}`).join(",\n  ");
    rules.push(`${scoped} { display: none !important; }`);
  }
  if (readOnly.length > 0) {
    const scoped = readOnly.map((s) => `${readRoot} ${s.css}`).join(",\n  ");
    rules.push(`${scoped} { display: none !important; }`);
  }
  return rules.join("\n  ");
}

/**
 * JSON-encode the read-only thread ids for embedding inside the shim `<script>`.
 * `</script>` can appear only if a thread id contained `<` (it never does — bb
 * thread ids are `thr_<base32>`); `<`-escaping any `<` is belt-and-braces
 * against a `</script>` breakout regardless of what an id ever holds.
 */
function encodeReadThreads(readThreadIds: readonly string[]): string {
  return JSON.stringify(readThreadIds).replace(/</g, "\\u003c");
}

/**
 * The `<script>` the shim injects. It runs before the app boots and, on every
 * client-side route change (patched `pushState`/`replaceState`, plus
 * `popstate`/`hashchange`), re-evaluates the CURRENT thread's mode: it sets
 * {@link PERM_ROOT_ATTR}=`read` on `<html>` iff the thread in the URL is one of
 * `readThreadIds`, else removes it. This is what lets a read guest who
 * navigates client-side into a write thread get the composer back with no fresh
 * document. Unknown thread ⇒ attribute absent ⇒ composer shown (safe default).
 * Wrapped in try/catch and an IIFE so a malformed URL never throws into boot.
 */
export function buildShimScript(readThreadIds: readonly string[] = []): string {
  return (
    `<script>(function(){` +
    `var d=document.documentElement;` +
    `d.dataset.bbGuest=${JSON.stringify(GUEST_ROOT_FLAG)};` +
    `var r=new Set(${encodeReadThreads(readThreadIds)});` +
    `function apply(){try{` +
    `var m=/\\/threads\\/([^/?#]+)/.exec(location.pathname);` +
    `var t=m?decodeURIComponent(m[1]):null;` +
    `if(t&&r.has(t))d.setAttribute(${JSON.stringify(PERM_ROOT_ATTR)},${JSON.stringify(PERM_READ_FLAG)});` +
    `else d.removeAttribute(${JSON.stringify(PERM_ROOT_ATTR)});` +
    `}catch(e){}}` +
    `apply();` +
    `try{["pushState","replaceState"].forEach(function(n){` +
    `var o=history[n];if(typeof o==="function"){history[n]=function(){` +
    `var v=o.apply(this,arguments);apply();return v;};}});` +
    `addEventListener("popstate",apply);addEventListener("hashchange",apply);` +
    `}catch(e){}` +
    `})();</script>`
  );
}

/**
 * The full `<script>` + `<style>` block injected into `<head>`. The script
 * runs before the app boots, flags the document as a guest session, and keeps
 * the read-only-thread perm attribute in sync across client-side navigation;
 * the style hides owner-only chrome for the session and the composer on
 * read-only threads. `readThreadIds` is the set of the guest's read-only thread
 * ids (empty for the base shim — nothing thread-specific to hide).
 */
export function buildShimHtml(
  selectors: readonly ChromeSelector[] = CHROME_SELECTORS,
  readThreadIds: readonly string[] = [],
): string {
  return [
    buildShimScript(readThreadIds),
    `<style>`,
    `  ${buildShimCss(selectors)}`,
    `</style>`,
  ].join("\n");
}
