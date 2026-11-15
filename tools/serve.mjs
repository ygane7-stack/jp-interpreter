// 맥 시험용 작은 서버: web/ 을 http://localhost:8787 로 보여 주고,
// /token 으로 오면 키체인의 암호(jpi-passcode)를 붙여 Supabase 함수에 대신 물어본다.
// → 시험하는 브라우저 화면에 암호를 칠 필요가 없다. 비밀값은 파일에 쓰지 않는다.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const FUNC = "https://trjsxwcekqmlnwfyswky.supabase.co/functions/v1/jp-interpreter-token";
const PORT = +process.env.PORT || 8787;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".png": "image/png" };

function pass() {
  try { return execFileSync("security", ["find-generic-password", "-s", "jpi-passcode", "-w"]).toString().trim(); }
  catch { return ""; }
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/token") {
    let body = ""; for await (const c of req) body += c;
    const r = await fetch(FUNC, { method: "POST", headers: { "content-type": "application/json", "x-jpi-pass": pass() }, body });
    res.writeHead(r.status, { "content-type": "application/json" }); res.end(await r.text()); return;
  }
  let p = decodeURIComponent(u.pathname);
  if (p === "/") p = "/index.html";
  const file = p.startsWith("/tests/") ? path.join(ROOT, p) : path.join(ROOT, "web", p);
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  try {
    const data = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(data);
  } catch { res.writeHead(404); res.end("not found"); }
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
