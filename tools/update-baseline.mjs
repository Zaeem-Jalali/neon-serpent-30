/* Regenerates tests/baseline-boards.json.
 *
 *   node tools/update-baseline.mjs "why this changed"
 *
 * Run this ONLY when a change is *meant* to alter level generation — a
 * rebalance, a new layout, a different wall budget. The whole point of the
 * baseline is that it fails loudly when generation drifts by accident, so
 * regenerating it casually would defeat the test.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createEngine } from "../src/engine.js";
import { LEVELS } from "../src/levels.js";
import { mulberry32, hashSeed } from "../src/utils.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "tests", "baseline-boards.json");

const SEEDS = ["campaign", "daily-2026-08-09", "daily-2026-12-25"];

const reason = process.argv.slice(2).join(" ").trim();
if (!reason) {
  console.error("Refusing to run without a reason.\n");
  console.error('  node tools/update-baseline.mjs "rebalanced tiers 3 and 4"');
  process.exit(1);
}

// Must stay identical to boardFingerprint in tests/engine.test.js.
function fnv1a(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function fingerprint(state) {
  return fnv1a(
    JSON.stringify({
      walls: [...state.walls].sort(),
      portals: state.portals.map((p) => [p.a.x, p.a.y, p.b.x, p.b.y]),
      hazards: state.hazards.map((h) => [h.x, h.y, h.axis, h.dir, h.speed, h.laneMin, h.laneMax]),
      enemies: state.enemySnakes.map((e) => [e.body.map((s) => [s.x, s.y]), e.dir, e.colorKey]),
      powerups: state.powerups.map((p) => [p.type, p.x, p.y, p.life]),
      food: state.food,
      snake: state.snake,
      stepMs: state.stepMs,
      goal: state.missionGoal,
      timer: state.timerLeft,
      mirror: state.mirror,
      bossCharges: (state.bossCharges || []).map((c) => [c.x, c.y])
    })
  );
}

const result = {
  _comment:
    "FNV-1a fingerprints of every generated board. Level generation is fully seeded, so these must match exactly after any refactor that claims to preserve behaviour. Regenerate deliberately with tools/update-baseline.mjs when a gameplay change is meant to alter generation.",
  _captured: reason,
  _fields: "walls, portals, hazards, enemies, powerups, food, snake, stepMs, missionGoal, timer, mirror, bossCharges"
};

for (const seed of SEEDS) {
  const rows = [];
  for (let i = 0; i < LEVELS.length; i++) {
    const engine = createEngine({});
    const { state } = engine;
    state.mode = seed === "campaign" ? "campaign" : "daily";
    state.seed = seed;
    state.rng = seed === "campaign" ? mulberry32(1) : mulberry32(hashSeed(seed));
    state.running = true;
    state.lives = 99;
    engine.loadLevel(i);
    rows.push(fingerprint(state));
  }
  result[seed] = rows;
}

writeFileSync(out, JSON.stringify(result, null, 2) + "\n", "utf8");
console.log(`Wrote ${out}`);
console.log(`Reason recorded: ${reason}`);
