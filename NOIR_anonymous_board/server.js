const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "posts.json");
const MAX_BODY = 8_000;
const MAX_POSTS = 2_000;
const ALLOWED_TTLS = new Set([60 * 60, 24 * 60 * 60, 3 * 24 * 60 * 60, 7 * 24 * 60 * 60]);
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 5;
const rateMap = new Map();

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "[]", "utf8");

function loadPosts() {
  try {
    const value = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}
function savePosts(posts) {
  const temp = DATA_FILE + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(posts, null, 2), "utf8");
  fs.renameSync(temp, DATA_FILE);
}
function cleanExpired() {
  const now = Date.now();
  const posts = loadPosts().filter(p => p.expiresAt > now && !p.hidden);
  if (posts.length > MAX_POSTS) posts.splice(0, posts.length - MAX_POSTS);
  savePosts(posts);
  return posts;
}
function send(res, status, data, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
    ...headers
  });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
      if (Buffer.byteLength(data) > MAX_BODY) {
        reject(new Error("BODY_TOO_LARGE"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); }
      catch { reject(new Error("BAD_JSON")); }
    });
    req.on("error", reject);
  });
}
function clientKey(req) {
  // Do not trust X-Forwarded-For unless a trusted reverse proxy is configured.
  return crypto.createHash("sha256").update(req.socket.remoteAddress || "unknown").digest("hex");
}
function rateLimited(req) {
  const key = clientKey(req);
  const now = Date.now();
  const recent = (rateMap.get(key) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) { rateMap.set(key, recent); return true; }
  recent.push(now);
  rateMap.set(key, recent);
  return false;
}
function safePost(p) {
  return {
    id: p.id,
    text: p.text,
    createdAt: p.createdAt,
    expiresAt: p.expiresAt,
    ttlSeconds: p.ttlSeconds,
    reports: p.reports || 0
  };
}
const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/api/posts") {
    const posts = cleanExpired().sort((a, b) => b.createdAt - a.createdAt).map(safePost);
    return send(res, 200, { posts, serverTime: Date.now() });
  }

  if (req.method === "POST" && url.pathname === "/api/posts") {
    if (rateLimited(req)) return send(res, 429, { error: "Слишком часто. Попробуйте через минуту." }, { "Retry-After": "60" });
    let body;
    try { body = await readBody(req); }
    catch (e) { return send(res, e.message === "BODY_TOO_LARGE" ? 413 : 400, { error: "Не удалось прочитать сообщение." }); }

    const text = typeof body.text === "string" ? body.text.trim() : "";
    const ttlSeconds = Number(body.ttlSeconds);
    if (text.length < 1 || text.length > 1000) return send(res, 400, { error: "Сообщение должно содержать от 1 до 1000 символов." });
    if (!ALLOWED_TTLS.has(ttlSeconds)) return send(res, 400, { error: "Выберите допустимый срок жизни сообщения." });

    const posts = cleanExpired();
    const now = Date.now();
    const post = {
      id: crypto.randomUUID(),
      text,
      createdAt: now,
      expiresAt: now + ttlSeconds * 1000,
      ttlSeconds,
      reports: 0,
      reporterKeys: [],
      hidden: false
    };
    posts.unshift(post);
    if (posts.length > MAX_POSTS) posts.length = MAX_POSTS;
    savePosts(posts);
    return send(res, 201, { post: safePost(post) });
  }

  const reportMatch = url.pathname.match(/^\/api\/posts\/([a-f0-9-]+)\/report$/i);
  if (req.method === "POST" && reportMatch) {
    if (rateLimited(req)) return send(res, 429, { error: "Слишком часто. Попробуйте позже." });
    const posts = cleanExpired();
    const post = posts.find(p => p.id === reportMatch[1]);
    if (!post) return send(res, 404, { error: "Сообщение уже удалено или не найдено." });
    const key = clientKey(req);
    post.reporterKeys ||= [];
    if (!post.reporterKeys.includes(key)) {
      post.reporterKeys.push(key);
      post.reports = (post.reports || 0) + 1;
      // Hide after several unique reports; a production service should add human review.
      if (post.reports >= 5) post.hidden = true;
      savePosts(posts);
    }
    return send(res, 200, { ok: true, hidden: post.hidden });
  }

  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Метод не поддерживается." });
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const target = path.resolve(ROOT, "." + pathname);
  if (!target.startsWith(ROOT + path.sep) || ![".html", ".css", ".js", ".svg"].includes(path.extname(target))) {
    res.writeHead(403); return res.end("Forbidden");
  }
  fs.readFile(target, (err, content) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("Not found"); }
    res.writeHead(200, {
      "Content-Type": mime[path.extname(target)] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'"
    });
    if (req.method === "HEAD") return res.end();
    res.end(content);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Blackglass Board запущена: http://localhost:${PORT}`);
});
