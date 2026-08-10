/* Difficulty report. Uses the real engine to measure what each level actually
 * asks of a player, rather than guessing from the config table.
 *   node tools/difficulty-report.mjs
 */
import { createEngine } from "../src/engine.js";
import { LEVELS, playerMovesPerSec, GRID, MAX_SHRINK_MARGIN } from "../src/levels.js";
import { mulberry32, hashSeed } from "../src/utils.js";

function boardAt(seed, i) {
  const e = createEngine({});
  const s = e.state;
  s.mode = seed === "campaign" ? "campaign" : "daily";
  s.seed = seed;
  s.rng = seed === "campaign" ? mulberry32(1) : mulberry32(hashSeed(seed));
  s.running = true;
  s.lives = 99;
  e.loadLevel(i);
  return { e, s };
}

const pad = (v, n) => String(v).padEnd(n);
console.log(
  pad("lvl", 4), pad("name", 19), pad("spd", 4), pad("open", 5), pad("drone", 6),
  pad("timer", 6), pad("cores", 6), pad("moves", 6), pad("mv/core", 8),
  pad("s->minArena", 12), pad("minArena", 9)
);

for (let i = 0; i < 30; i++) {
  const L = LEVELS[i];
  const { e, s } = boardAt("campaign", i);
  const mps = playerMovesPerSec(i);
  const blocked = new Set([...s.walls, ...s.snake.slice(1).map((x) => `${x.x}:${x.y}`)]);
  const open = e.getReachableCells(1, blocked).size;
  const moves = L.timer ? Math.floor(L.timer * mps) : null;
  const perCore = moves ? (moves / L.target).toFixed(1) : "-";
  // The margin grows by 1 every L.shrink ticks and caps at MAX_SHRINK_MARGIN.
  // A margin of m makes cells 0..m lethal, so the surviving arena is
  // (cols - 2(m+1)) x (rows - 2(m+1)) before walls are subtracted.
  const secsToMin = L.shrink ? ((MAX_SHRINK_MARGIN * L.shrink) / mps).toFixed(1) : "-";
  const span = (n) => n - 2 * (MAX_SHRINK_MARGIN + 1);
  const minArena = L.shrink ? span(GRID.cols) * span(GRID.rows) : open;

  console.log(
    pad(i + 1, 4), pad(L.name, 19), pad(mps, 4), pad(open, 5), pad(L.hazards, 6),
    pad(L.timer ?? "-", 6), pad(L.target, 6), pad(moves ?? "-", 6), pad(perCore, 8),
    pad(secsToMin, 12), pad(minArena, 9)
  );
}
