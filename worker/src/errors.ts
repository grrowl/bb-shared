/**
 * Small JSON error helper.
 *
 * The SPEC's scope-enforcement layer (issues 09/10) uses `{ error: "scope" }`
 * as the failure body; this scaffold answers 401 for token failures and 403
 * for tunnel / secret failures. Bodies are short and machine-readable — the
 * SPA never renders them, they surface in test logs and network panels.
 */

export interface ErrorBody {
  error: string;
  detail?: string;
}

export function jsonError(status: number, body: ErrorBody): Response {
  return new Response(JSON.stringify(body) + "\n", {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
