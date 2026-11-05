// Minimal local server without the Netlify CLI: serves public/ and sends /api/* to the function.
// Usage: COACH_DB_URL=postgres://... PAYMENTS_MODE=fake node scripts/dev-server.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const { default: handler } = await import("../netlify/functions/api.mts");
const root = new URL("../public/", import.meta.url).pathname;
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json" };
const port = Number(process.env.PORT || 8888);

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname.startsWith("/api/")) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = await handler(new Request(url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body }));
    res.writeHead(r.status, Object.fromEntries(r.headers));
    return res.end(Buffer.from(await r.arrayBuffer()));
  }
  const file = normalize(join(root, url.pathname));
  try {
    if (!file.startsWith(root) || !extname(file)) throw 0;
    res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
    res.end(await readFile(file));
  } catch {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(await readFile(join(root, "index.html")));
  }
}).listen(port, () => console.log(`http://localhost:${port}`));
