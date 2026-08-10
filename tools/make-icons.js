/* Generates every PNG asset the site needs: PWA icons, the Apple touch icon,
 * favicons and the Open Graph social card.
 *
 *   node tools/make-icons.js
 *
 * Written against Node's built-in zlib only — no dependencies, no build step,
 * and the output is committed so hosting stays a matter of uploading files.
 * Keeping this as code rather than binary blobs means the artwork can be
 * re-tuned when the palette changes.
 */
const zlib = require("node:zlib");
const fs = require("node:fs");
const path = require("node:path");

const OUT_DIR = path.join(__dirname, "..", "assets");

/* ---------------------------------------------------------------- PNG ---- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(canvas) {
  const { width, height, data } = canvas;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Raw scanlines, each prefixed with filter type 0 (None).
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

/* ------------------------------------------------------------- canvas ---- */

function createCanvas(width, height) {
  return { width, height, data: Buffer.alloc(width * height * 4) };
}

// Source-over alpha compositing for a single pixel.
function blend(canvas, x, y, [r, g, b, a]) {
  if (a <= 0) return;
  const px = Math.floor(x);
  const py = Math.floor(y);
  if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return;
  const i = (py * canvas.width + px) * 4;
  const d = canvas.data;
  const sa = a;
  const da = d[i + 3] / 255;
  const outA = sa + da * (1 - sa);
  if (outA <= 0) {
    d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0;
    return;
  }
  d[i] = (r * sa + d[i] * da * (1 - sa)) / outA;
  d[i + 1] = (g * sa + d[i + 1] * da * (1 - sa)) / outA;
  d[i + 2] = (b * sa + d[i + 2] * da * (1 - sa)) / outA;
  d[i + 3] = outA * 255;
}

function hex(color, alpha = 1) {
  const n = parseInt(color.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, alpha];
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function verticalGradient(canvas, topHex, bottomHex) {
  const top = hex(topHex);
  const bottom = hex(bottomHex);
  for (let y = 0; y < canvas.height; y++) {
    const t = y / Math.max(1, canvas.height - 1);
    const c = [lerp(top[0], bottom[0], t), lerp(top[1], bottom[1], t), lerp(top[2], bottom[2], t), 1];
    for (let x = 0; x < canvas.width; x++) blend(canvas, x, y, c);
  }
}

function fillRect(canvas, x, y, w, h, color) {
  for (let py = Math.floor(y); py < Math.ceil(y + h); py++) {
    for (let px = Math.floor(x); px < Math.ceil(x + w); px++) {
      blend(canvas, px, py, color);
    }
  }
}

// Anti-aliased rounded rectangle via a signed distance field.
function fillRoundRect(canvas, x, y, w, h, radius, color) {
  const r = Math.min(radius, w / 2, h / 2);
  const x0 = Math.floor(x) - 1;
  const y0 = Math.floor(y) - 1;
  const x1 = Math.ceil(x + w) + 1;
  const y1 = Math.ceil(y + h) + 1;
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const cx = px + 0.5;
      const cy = py + 0.5;
      const dx = Math.max(x + r - cx, 0, cx - (x + w - r));
      const dy = Math.max(y + r - cy, 0, cy - (y + h - r));
      const dist = Math.hypot(dx, dy) - r;
      const cover = Math.min(1, Math.max(0, 0.5 - dist));
      if (cover > 0) blend(canvas, px, py, [color[0], color[1], color[2], color[3] * cover]);
    }
  }
}

function fillCircle(canvas, cx, cy, radius, color) {
  for (let py = Math.floor(cy - radius) - 1; py <= Math.ceil(cy + radius) + 1; py++) {
    for (let px = Math.floor(cx - radius) - 1; px <= Math.ceil(cx + radius) + 1; px++) {
      const dist = Math.hypot(px + 0.5 - cx, py + 0.5 - cy) - radius;
      const cover = Math.min(1, Math.max(0, 0.5 - dist));
      if (cover > 0) blend(canvas, px, py, [color[0], color[1], color[2], color[3] * cover]);
    }
  }
}

// Soft radial falloff, used to fake the canvas glow the game draws with shadowBlur.
function glow(canvas, cx, cy, radius, color, strength = 0.5) {
  for (let py = Math.floor(cy - radius); py <= Math.ceil(cy + radius); py++) {
    for (let px = Math.floor(cx - radius); px <= Math.ceil(cx + radius); px++) {
      const d = Math.hypot(px + 0.5 - cx, py + 0.5 - cy) / radius;
      if (d >= 1) continue;
      const falloff = (1 - d) ** 2 * strength;
      blend(canvas, px, py, [color[0], color[1], color[2], falloff]);
    }
  }
}

// Four-pointed spiked star — the drone silhouette from the game.
function fillSpike(canvas, cx, cy, outer, inner, color) {
  const pts = [];
  for (let i = 0; i < 8; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  fillPolygon(canvas, pts, color);
}

function fillPolygon(canvas, pts, color) {
  const ys = pts.map((p) => p[1]);
  const y0 = Math.floor(Math.min(...ys));
  const y1 = Math.ceil(Math.max(...ys));
  for (let py = y0; py <= y1; py++) {
    // Supersample 3 rows per pixel for cheap vertical anti-aliasing.
    const coverage = new Map();
    for (let sub = 0; sub < 3; sub++) {
      const sy = py + (sub + 0.5) / 3;
      const xs = [];
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i];
        const [bx, by] = pts[(i + 1) % pts.length];
        if (ay === by) continue;
        if (sy >= Math.min(ay, by) && sy < Math.max(ay, by)) {
          xs.push(ax + ((sy - ay) / (by - ay)) * (bx - ax));
        }
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        for (let px = Math.floor(xs[i]); px <= Math.ceil(xs[i + 1]); px++) {
          const overlap = Math.min(px + 1, xs[i + 1]) - Math.max(px, xs[i]);
          if (overlap > 0) coverage.set(px, (coverage.get(px) || 0) + overlap / 3);
        }
      }
    }
    for (const [px, cov] of coverage) {
      blend(canvas, px, py, [color[0], color[1], color[2], color[3] * Math.min(1, cov)]);
    }
  }
}

/* --------------------------------------------------------------- font ---- */
/* 5x7 bitmap glyphs, only the characters the social card actually needs. */
const FONT = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  N: ["10001", "11001", "10101", "10101", "10011", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "·": ["00000", "00000", "00000", "00100", "00000", "00000", "00000"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"]
};

function textWidth(text, scale, spacing) {
  return text.length * (5 * scale + spacing) - spacing;
}

function drawText(canvas, text, x, y, scale, color, spacing = scale) {
  let cursor = x;
  for (const ch of text.toUpperCase()) {
    const glyph = FONT[ch];
    if (glyph) {
      for (let gy = 0; gy < 7; gy++) {
        for (let gx = 0; gx < 5; gx++) {
          if (glyph[gy][gx] === "1") {
            fillRect(canvas, cursor + gx * scale, y + gy * scale, scale, scale, color);
          }
        }
      }
    }
    cursor += 5 * scale + spacing;
  }
}

/* ------------------------------------------------------------- artwork --- */

const PALETTE = {
  bgTop: "#0b1a2e",
  bgBottom: "#050a12",
  grid: "#57f8ff",
  snakeHead: "#8afcff",
  snakeBody: "#57f8ff",
  snakeTail: "#63ff95",
  food: "#63ff95",
  drone: "#ff5d76",
  portal: "#ff6bd6",
  text: "#edf7ff",
  muted: "#9db3c8"
};

/* The icon is the game board in miniature: faint grid, a coiled snake and a
   core. `inset` pulls the artwork into the maskable safe zone. */
function drawIcon(size, { inset = 0 } = {}) {
  const canvas = createCanvas(size, size);
  verticalGradient(canvas, PALETTE.bgTop, PALETTE.bgBottom);

  // A 5x5 board fills the tile far better than a sparse 7x7, which matters
  // most at favicon sizes where the shape has to survive 16px.
  const pad = 0.09 + inset;
  const area = size * (1 - pad * 2);
  const origin = size * pad;
  const cells = 5;
  const cell = area / cells;
  const at = (i) => origin + i * cell;
  const line = Math.max(1, size / 300);

  for (let i = 0; i <= cells; i++) {
    fillRect(canvas, at(i), origin, line, area, hex(PALETTE.grid, 0.08));
    fillRect(canvas, origin, at(i), area, line, hex(PALETTE.grid, 0.08));
  }

  // Snake laid out as an L, centred on the board so the tile reads balanced.
  const body = [
    { c: [0, 3], color: PALETTE.snakeTail },
    { c: [1, 3], color: PALETTE.snakeTail },
    { c: [2, 3], color: PALETTE.snakeBody },
    { c: [2, 2], color: PALETTE.snakeBody },
    { c: [2, 1], color: PALETTE.snakeHead }
  ];

  for (const seg of body) {
    const [cx, cy] = seg.c;
    glow(canvas, at(cx) + cell / 2, at(cy) + cell / 2, cell * 1.05, hex(seg.color), 0.32);
  }
  for (const seg of body) {
    const [cx, cy] = seg.c;
    const gap = cell * 0.09;
    fillRoundRect(canvas, at(cx) + gap, at(cy) + gap, cell - gap * 2, cell - gap * 2, cell * 0.3, hex(seg.color));
  }

  // Eyes on the head, only when there are enough pixels to land them.
  if (size >= 96) {
    const hx = at(2) + cell / 2;
    const hy = at(1) + cell / 2;
    fillCircle(canvas, hx - cell * 0.17, hy - cell * 0.04, cell * 0.08, hex("#05121c"));
    fillCircle(canvas, hx + cell * 0.17, hy - cell * 0.04, cell * 0.08, hex("#05121c"));
  }

  // The core it is chasing.
  const fx = at(4) + cell / 2;
  const fy = at(1) + cell / 2;
  glow(canvas, fx, fy, cell * 1.25, hex(PALETTE.food), 0.5);
  fillCircle(canvas, fx, fy, cell * 0.27, hex(PALETTE.food));

  return canvas;
}

/* Two panels: type on the left, a miniature board on the right. Every text
   run is fitted to its column so nothing can overflow if the copy changes. */
function drawSocialCard(width = 1200, height = 630) {
  const canvas = createCanvas(width, height);
  verticalGradient(canvas, PALETTE.bgTop, PALETTE.bgBottom);

  const bgCell = 42;
  for (let x = 0; x <= width; x += bgCell) fillRect(canvas, x, 0, 1, height, hex(PALETTE.grid, 0.05));
  for (let y = 0; y <= height; y += bgCell) fillRect(canvas, 0, y, width, 1, hex(PALETTE.grid, 0.05));

  glow(canvas, width * 0.08, height * 0.12, 320, hex(PALETTE.grid), 0.14);
  glow(canvas, width * 0.95, height * 0.9, 360, hex(PALETTE.portal), 0.12);

  const TEXT_X = 84;
  const TEXT_MAX = 620;

  // Shrink the scale until the run fits its column.
  const fit = (text, preferred, spacingRatio) => {
    let scale = preferred;
    while (scale > 1 && textWidth(text, scale, scale * spacingRatio) > TEXT_MAX) scale -= 0.5;
    return scale;
  };

  const line1 = "NEON";
  const line2 = "SERPENT 30";
  const sub = "30 LEVELS · FOUR TIERS · ONE RIVAL";

  const titleScale = Math.min(fit(line1, 13, 0.55), fit(line2, 13, 0.55));
  const subScale = fit(sub, 5, 0.8);

  const titleLine = 7 * titleScale;
  const blockTop = 176;
  const line2Y = blockTop + titleLine + 22;
  const subY = line2Y + titleLine + 44;

  drawText(canvas, line1, TEXT_X, blockTop, titleScale, hex(PALETTE.text), titleScale * 0.55);
  drawText(canvas, line2, TEXT_X, line2Y, titleScale, hex(PALETTE.text), titleScale * 0.55);
  drawText(canvas, sub, TEXT_X, subY, subScale, hex(PALETTE.grid), subScale * 0.8);

  fillRoundRect(canvas, TEXT_X, subY + 7 * subScale + 34, 240, 6, 3, hex(PALETTE.food, 0.6));

  /* --- board vignette, right panel --- */
  const cols = 7;
  const rows = 7;
  const cell = 46;
  const boardW = cols * cell;
  const boardH = rows * cell;
  const bx = width - boardW - 96;
  const by = (height - boardH) / 2;

  fillRoundRect(canvas, bx - 20, by - 20, boardW + 40, boardH + 40, 26, hex("#0a1524", 0.75));
  for (let i = 0; i <= cols; i++) fillRect(canvas, bx + i * cell, by, 1, boardH, hex(PALETTE.grid, 0.1));
  for (let i = 0; i <= rows; i++) fillRect(canvas, bx, by + i * cell, boardW, 1, hex(PALETTE.grid, 0.1));

  const at = (gx, gy) => [bx + gx * cell, by + gy * cell];

  const snake = [
    { c: [1, 5], color: PALETTE.snakeTail },
    { c: [2, 5], color: PALETTE.snakeTail },
    { c: [3, 5], color: PALETTE.snakeBody },
    { c: [3, 4], color: PALETTE.snakeBody },
    { c: [3, 3], color: PALETTE.snakeBody },
    { c: [4, 3], color: PALETTE.snakeHead }
  ];
  for (const seg of snake) {
    const [x, y] = at(seg.c[0], seg.c[1]);
    glow(canvas, x + cell / 2, y + cell / 2, cell * 1.15, hex(seg.color), 0.3);
  }
  for (const seg of snake) {
    const [x, y] = at(seg.c[0], seg.c[1]);
    fillRoundRect(canvas, x + 5, y + 5, cell - 10, cell - 10, cell * 0.3, hex(seg.color));
  }
  const [hx, hy] = at(4, 3);
  fillCircle(canvas, hx + cell * 0.34, hy + cell * 0.42, cell * 0.07, hex("#05121c"));
  fillCircle(canvas, hx + cell * 0.66, hy + cell * 0.42, cell * 0.07, hex("#05121c"));

  const [fx, fy] = at(6, 1);
  glow(canvas, fx + cell / 2, fy + cell / 2, cell * 1.4, hex(PALETTE.food), 0.55);
  fillCircle(canvas, fx + cell / 2, fy + cell / 2, cell * 0.26, hex(PALETTE.food));

  const [dx, dy] = at(1, 2);
  glow(canvas, dx + cell / 2, dy + cell / 2, cell * 1.2, hex(PALETTE.drone), 0.42);
  fillSpike(canvas, dx + cell / 2, dy + cell / 2, cell * 0.42, cell * 0.16, hex(PALETTE.drone));

  const [px, py] = at(5, 6);
  glow(canvas, px + cell / 2, py + cell / 2, cell * 1.2, hex(PALETTE.portal), 0.4);
  fillCircle(canvas, px + cell / 2, py + cell / 2, cell * 0.3, hex(PALETTE.portal));
  fillCircle(canvas, px + cell / 2, py + cell / 2, cell * 0.17, hex("#0a1524"));

  return canvas;
}

/* ---------------------------------------------------------------- run ---- */

function write(name, canvas) {
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, encodePng(canvas));
  const kb = (fs.statSync(file).size / 1024).toFixed(1);
  console.log(`  ${name.padEnd(28)} ${canvas.width}x${canvas.height}  ${kb} KB`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
console.log("Generating assets:");
write("icon-192.png", drawIcon(192));
write("icon-512.png", drawIcon(512));
write("icon-maskable-512.png", drawIcon(512, { inset: 0.14 }));
write("apple-touch-icon.png", drawIcon(180));
write("favicon-32.png", drawIcon(32));
write("favicon-16.png", drawIcon(16));
write("og-image.png", drawSocialCard());
console.log("Done.");
