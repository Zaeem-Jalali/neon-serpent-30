const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const root = __dirname;
const port = process.env.PORT ? Number(process.env.PORT) : 4173;

const dataDir = path.join(root, "data");
const scoresFile = path.join(dataDir, "scores.json");

const MAX_BODY_BYTES = 4 * 1024;
const MAX_ENTRIES_PER_BOARD = 50;
const MAX_LEVEL = 30;
const MAX_SCORE = 10_000_000;
const SEED_PATTERN = /^[A-Za-z0-9:_-]{1,40}$/;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp"
};

/* ---------------------------------------------------------------------
 * Score storage. A single JSON file is plenty for a local leaderboard.
 * All writes funnel through a promise chain so concurrent posts cannot
 * interleave a read-modify-write and lose an entry.
 * ------------------------------------------------------------------ */
let writeChain = Promise.resolve();

const emptyBoard = () => ({ campaign: [], daily: {} });

async function readScores() {
  try {
    const raw = await fsp.readFile(scoresFile, "utf8");
    const parsed = JSON.parse(raw);
    return {
      campaign: Array.isArray(parsed.campaign) ? parsed.campaign : [],
      daily: parsed.daily && typeof parsed.daily === "object" ? parsed.daily : {}
    };
  } catch {
    return emptyBoard();
  }
}

async function writeScores(scores) {
  await fsp.mkdir(dataDir, { recursive: true });
  // Write to a temp file then rename, so a crash mid-write cannot corrupt
  // the board.
  const tmp = `${scoresFile}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(scores, null, 2), "utf8");
  await fsp.rename(tmp, scoresFile);
}

function sanitizeName(value) {
  if (typeof value !== "string") return null;
  // Strip control characters, collapse whitespace, cap the length.
  const cleaned = value
    .replace(new RegExp("[\\u0000-\\u001F\\u007F]", "g"), "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24);
  return cleaned || null;
}

function validateEntry(body) {
  const name = sanitizeName(body.name);
  if (!name) return { error: "A name is required." };

  const score = Number(body.score);
  if (!Number.isFinite(score) || score < 0 || score > MAX_SCORE) {
    return { error: "Score out of range." };
  }

  const level = Number(body.level);
  if (!Number.isFinite(level) || level < 1 || level > MAX_LEVEL) {
    return { error: "Level out of range." };
  }

  const mode = body.mode === "daily" ? "daily" : "campaign";
  const seed = mode === "daily" ? String(body.seed || "") : "campaign";
  if (mode === "daily" && !SEED_PATTERN.test(seed)) {
    return { error: "Invalid seed." };
  }

  return {
    entry: {
      name,
      score: Math.floor(score),
      level: Math.floor(level),
      at: new Date().toISOString()
    },
    mode,
    seed
  };
}

function boardFor(scores, mode, seed) {
  if (mode === "daily") {
    if (!Array.isArray(scores.daily[seed])) scores.daily[seed] = [];
    return scores.daily[seed];
  }
  return scores.campaign;
}

// Keeps one best run per name, highest score first.
function mergeEntry(board, entry) {
  const existing = board.findIndex((row) => row.name === entry.name);
  if (existing >= 0) {
    if (board[existing].score >= entry.score) {
      board.sort(compareEntries);
      return board.findIndex((row) => row.name === entry.name) + 1;
    }
    board.splice(existing, 1);
  }
  board.push(entry);
  board.sort(compareEntries);
  board.splice(MAX_ENTRIES_PER_BOARD);
  return board.findIndex((row) => row.name === entry.name && row.score === entry.score) + 1;
}

function compareEntries(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (b.level !== a.level) return b.level - a.level;
  return String(a.at).localeCompare(String(b.at));
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let aborted = false;
    const chunks = [];

    req.on("data", (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop buffering, but leave the socket open so the caller can still
        // send a real 413 instead of resetting the connection.
        aborted = true;
        chunks.length = 0;
        reject(Object.assign(new Error("Payload too large"), { code: "TOO_LARGE" }));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (!aborted) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

async function handleGetScores(res, url) {
  const mode = url.searchParams.get("mode") === "daily" ? "daily" : "campaign";
  const seed = mode === "daily" ? String(url.searchParams.get("seed") || "") : "campaign";
  if (mode === "daily" && !SEED_PATTERN.test(seed)) {
    sendJson(res, 400, { error: "Invalid seed." });
    return;
  }
  const scores = await readScores();
  const board = mode === "daily" ? scores.daily[seed] || [] : scores.campaign;
  sendJson(res, 200, { mode, seed, scores: board.slice(0, MAX_ENTRIES_PER_BOARD) });
}

async function handlePostScore(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 413, { error: "Payload too large." });
    // Drain whatever is still in flight so the socket closes cleanly.
    req.resume();
    return;
  }

  let body;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    sendJson(res, 400, { error: "Invalid JSON." });
    return;
  }

  const result = validateEntry(body);
  if (result.error) {
    sendJson(res, 400, { error: result.error });
    return;
  }

  // Serialize the read-modify-write against other in-flight posts.
  const task = writeChain.then(async () => {
    const scores = await readScores();
    const board = boardFor(scores, result.mode, result.seed);
    const rank = mergeEntry(board, result.entry);
    await writeScores(scores);
    return { rank, board };
  });
  writeChain = task.catch(() => {});

  try {
    const { rank, board } = await task;
    sendJson(res, 200, { ok: true, rank, scores: board });
  } catch {
    sendJson(res, 500, { error: "Could not save the score." });
  }
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const safePath = urlPath === "/" ? "/index.html" : urlPath;
  const resolvedRoot = path.resolve(root);
  const filePath = path.resolve(root, `.${safePath}`);
  const relative = path.relative(resolvedRoot, filePath);

  // Block traversal, dotfiles (.git), and the raw score store.
  const outsideRoot = relative.startsWith("..") || path.isAbsolute(relative);
  const hidden = relative.split(path.sep).some((part) => part.startsWith("."));
  const isDataDir = relative === "data" || relative.startsWith(`data${path.sep}`);

  if (outsideRoot || hidden || isDataDir) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

  if (url.pathname === "/api/scores") {
    if (req.method === "GET") {
      handleGetScores(res, url).catch(() => sendJson(res, 500, { error: "Server error." }));
      return;
    }
    if (req.method === "POST") {
      handlePostScore(req, res).catch(() => sendJson(res, 500, { error: "Server error." }));
      return;
    }
    res.writeHead(405, { Allow: "GET, POST" });
    res.end();
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    sendJson(res, 404, { error: "Unknown endpoint." });
    return;
  }

  serveStatic(req, res);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Neon Serpent 30 running at http://127.0.0.1:${port}`);
});
