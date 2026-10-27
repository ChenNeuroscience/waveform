// Test-only static mount: verifies deployed assets under /waveform/.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
const root = resolve("dist"),
  prefix = "/waveform/";
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
};
createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (!pathname.startsWith(prefix)) {
    res.writeHead(404).end();
    return;
  }
  const file = resolve(root, decodeURIComponent(pathname.slice(prefix.length) || "index.html"));
  if (!file.startsWith(root + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      "content-type": types[extname(file)] || "application/octet-stream",
    });
    res.end(data);
  } catch {
    res.writeHead(404).end();
  }
}).listen(4174, "127.0.0.1", () => console.log("Prefix preview: http://127.0.0.1:4174/waveform/"));
