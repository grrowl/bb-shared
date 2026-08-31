/**
 * Small, standalone pages for browser navigations that cannot enter a shared
 * bb session. They deliberately have no dependencies on the bb app: these
 * responses are rendered by the worker before the tunnel reaches bb.
 */

function page(description: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Not found</title>
    <style>
      :root { color-scheme: light dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        background: #f8f8f7;
        color: #181817;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        width: min(100%, 27rem);
        border: 1px solid #e4e4e1;
        border-radius: 12px;
        padding: 24px;
        background: #fff;
        box-shadow: 0 1px 2px rgb(0 0 0 / 0.04);
      }
      h1 { margin: 0 0 8px; font-size: 18px; line-height: 1.35; font-weight: 600; }
      p { margin: 0; color: #6b6b68; font-size: 14px; line-height: 1.5; }
      @media (prefers-color-scheme: dark) {
        body { background: #171717; color: #f2f2f0; }
        main { border-color: #363634; background: #20201f; box-shadow: none; }
        p { color: #aaa9a5; }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Not found</h1>
      <p>${description}</p>
    </main>
  </body>
</html>`;
}

function htmlResponse(description: string): Response {
  return new Response(page(description), {
    status: 404,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/** A link was revoked or no longer grants access to the requested thread. */
export function sharedThreadNotFoundPage(): Response {
  return htmlResponse(
    "This shared thread is no longer available. Ask the person who shared it with you for a new link.",
  );
}

/** A bare worker URL was opened without a shared link. */
export function sharedLinkRequiredPage(): Response {
  return htmlResponse(
    "This worker only opens shared bb threads. Ask the person who shared it with you for a link.",
  );
}

/** Browser navigations advertise an HTML response; API and health probes do not. */
export function acceptsHtml(request: Request): boolean {
  return request.method === "GET" && request.headers.get("accept")?.includes("text/html") === true;
}
