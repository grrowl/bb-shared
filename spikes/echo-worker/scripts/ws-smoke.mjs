// Tiny WS smoke test. Usage:
//   BASE_WS=ws://127.0.0.1:8787 node scripts/ws-smoke.mjs
// or against a deployed URL:
//   BASE_WS=wss://bb-shared-echo.<sub>.workers.dev node scripts/ws-smoke.mjs
//
// Requires Node 22+ (built-in WebSocket) or `npm i -D ws` and swap the import.

const base = process.env.BASE_WS ?? "ws://127.0.0.1:8787";
const url = `${base.replace(/\/$/, "")}/ws`;

const ws = new WebSocket(url);

const timeout = setTimeout(() => {
  console.error(`timeout waiting on ${url}`);
  process.exit(1);
}, 5000);

ws.addEventListener("open", () => {
  ws.send("hello");
});

ws.addEventListener("message", (event) => {
  clearTimeout(timeout);
  const got = String(event.data);
  console.log(`recv: ${got}`);
  if (got !== "echo: hello") {
    console.error(`unexpected reply: ${got}`);
    process.exit(1);
  }
  ws.close();
  process.exit(0);
});

ws.addEventListener("error", (event) => {
  clearTimeout(timeout);
  console.error("ws error:", event);
  process.exit(1);
});
