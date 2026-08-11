/* Reachability probe.
 *
 *   node tools/reachability-probe.mjs
 *
 * The engine guarantees the core is reachable when it spawns, and re-homes it
 * if a periodic check finds it stranded. This probe asks the stricter question:
 * across a whole simulated run, is there EVER a tick where the core cannot be
 * reached from the snake's head?
 *
 * It also isolates the case that worries me most: the arena closing does not
 * have to swallow the core to orphan it — it only has to sever the corridor
 * leading to it.
 */
import { createEngine } from "../src/engine.js";
import { LEVELS, GRID } from "../src/levels.js";
import { mulberry32, hashSeed } from "../src/utils.js";

const SEEDS = ["campaign", "daily-2026-08-09", "daily-2026-12-25"];
const TICKS = 900;

/* Below this many reachable cells the snake has boxed itself in and is about
   to die regardless of where the core is. Those are not level defects. */
const SELF_TRAP_CELLS = 25;

function engineAt(seed, levelIndex) {
  const engine = createEngine({});
  const { state } = engine;
  state.mode = seed === "campaign" ? "campaign" : "daily";
  state.seed = seed;
  state.rng = seed === "campaign" ? mulberry32(1) : mulberry32(hashSeed(seed));
  state.running = true;
  state.lives = 99;
  engine.loadLevel(levelIndex);
  return engine;
}

/* True reachability over the obstacles that actually persist: walls, the
   closed-off border, and the snake's own body. Hazards and rivals move, so
   they are not treated as permanent blockers.
 *
 * Portals are modelled as extra edges: stepping onto one end puts the head on
 * the other, so a region served only by a portal is genuinely reachable. A
 * probe that ignored them would report false failures on every portal level.
 */
function reachInfo(engine, { usePortals = true } = {}) {
  const { state } = engine;
  const head = state.snake[0];
  if (!state.food || !head) return { ok: true, region: 0 };

  const blocked = new Set(state.walls);
  for (const seg of state.snake.slice(1)) blocked.add(`${seg.x}:${seg.y}`);

  // Portal endpoint -> its twin.
  const links = new Map();
  if (usePortals) {
    for (const p of state.portals) {
      links.set(`${p.a.x}:${p.a.y}`, p.b);
      links.set(`${p.b.x}:${p.b.y}`, p.a);
    }
  }

  const seen = new Set([`${head.x}:${head.y}`]);
  const queue = [head];
  const dirs = [
    { x: 1, y: 0 },
    { x: -1, y: 0 },
    { x: 0, y: 1 },
    { x: 0, y: -1 }
  ];

  const visit = (cell) => {
    const k = `${cell.x}:${cell.y}`;
    if (seen.has(k) || blocked.has(k)) return;
    if (cell.x < 1 || cell.y < 1 || cell.x >= GRID.cols - 1 || cell.y >= GRID.rows - 1) return;
    if (engine.inShrinkZone(cell.x, cell.y)) return;
    seen.add(k);
    queue.push(cell);
    const twin = links.get(k);
    if (twin) visit(twin);
  };

  while (queue.length) {
    const cur = queue.shift();
    for (const d of dirs) visit({ x: cur.x + d.x, y: cur.y + d.y });
  }
  return { ok: seen.has(`${state.food.x}:${state.food.y}`), region: seen.size };
}

function autopilot(engine) {
  const { state } = engine;
  const head = state.snake[0];
  const dirs = [
    { n: "right", x: 1, y: 0 },
    { n: "down", x: 0, y: 1 },
    { n: "up", x: 0, y: -1 },
    { n: "left", x: -1, y: 0 }
  ];
  const safe = dirs.find((d) => !engine.isBlocked(head.x + d.x, head.y + d.y, false));
  if (!safe) return;
  const name = state.mirror ? { left: "right", right: "left" }[safe.n] || safe.n : safe.n;
  engine.requestDirection(name);
}

const failures = [];
let totalTicks = 0;
let unreachableTicks = 0;
let worstStreak = 0;
let dumped = false;

// Renders the board at the moment of failure so the cause is visible rather
// than inferred.
function dumpBoard(engine, label) {
  const { state } = engine;
  const blocked = new Set(state.walls);
  for (const seg of state.snake.slice(1)) blocked.add(`${seg.x}:${seg.y}`);
  const links = new Map();
  for (const p of state.portals) {
    links.set(`${p.a.x}:${p.a.y}`, p.b);
    links.set(`${p.b.x}:${p.b.y}`, p.a);
  }
  const head = state.snake[0];
  const seen = new Set([`${head.x}:${head.y}`]);
  const queue = [head];
  const visit = (c) => {
    const k = `${c.x}:${c.y}`;
    if (seen.has(k) || blocked.has(k)) return;
    if (c.x < 1 || c.y < 1 || c.x >= GRID.cols - 1 || c.y >= GRID.rows - 1) return;
    if (engine.inShrinkZone(c.x, c.y)) return;
    seen.add(k);
    queue.push(c);
    const t = links.get(k);
    if (t) visit(t);
  };
  while (queue.length) {
    const c = queue.shift();
    for (const d of [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }]) {
      visit({ x: c.x + d.x, y: c.y + d.y });
    }
  }

  const body = new Set(state.snake.map((p) => `${p.x}:${p.y}`));
  console.log(`\n=== ${label} ===`);
  console.log(`head ${JSON.stringify(head)}  len ${state.snake.length}  food ${JSON.stringify(state.food)}  margin ${state.shrinkMargin}`);
  console.log(`region from head: ${seen.size} cells`);
  console.log("'.' reachable   ' ' cut off   F core   H head   o body   # wall   X drone   O portal\n");
  for (let y = 0; y < GRID.rows; y++) {
    let line = "";
    for (let x = 0; x < GRID.cols; x++) {
      const k = `${x}:${y}`;
      if (state.food && state.food.x === x && state.food.y === y) line += "F";
      else if (head.x === x && head.y === y) line += "H";
      else if (body.has(k)) line += "o";
      else if (state.walls.has(k)) line += "#";
      else if (state.hazards.some((h) => h.x === x && h.y === y)) line += "X";
      else if (links.has(k)) line += "O";
      else if (engine.inShrinkZone(x, y)) line += "~";
      else if (seen.has(k)) line += ".";
      else line += " ";
    }
    console.log(line);
  }
}

for (const seed of SEEDS) {
  for (let i = 0; i < LEVELS.length; i++) {
    const engine = engineAt(seed, i);
    const { state } = engine;
    let streak = 0;
    let lastMargin = state.shrinkMargin;

    for (let tick = 0; tick < TICKS; tick++) {
      if (state.timerLeft != null) state.timerLeft = 999;
      if (state.paused) state.paused = false;

      autopilot(engine);
      engine.step();
      totalTicks++;
      if (state.over || state.won) break;

      const shrankThisTick = state.shrinkMargin !== lastMargin;
      lastMargin = state.shrinkMargin;

      const info = reachInfo(engine);
      if (!info.ok) {
        unreachableTicks++;
        streak++;
        worstStreak = Math.max(worstStreak, streak);
        if (streak === 1) {
          /* Two very different things look identical to a naive check:
             - the snake has driven itself into a pocket, so almost nothing is
               reachable and it is about to die. That is the player's (or the
               greedy bot's) mistake, not a level defect.
             - the board itself is partitioned: the head sits in a large open
               region and the core is in a different one. That is unfair.
             Region size separates them. */
          const selfTrapped = info.region <= SELF_TRAP_CELLS;
          if (!selfTrapped && !dumped) {
            dumped = true;
            dumpBoard(engine, `${seed} L${i + 1} ${LEVELS[i].name} @ tick ${tick}`);
          }
          failures.push({
            seed,
            level: i + 1,
            name: LEVELS[i].name,
            tick,
            afterShrink: shrankThisTick,
            margin: state.shrinkMargin,
            snakeLength: state.snake.length,
            portals: state.portals.length,
            region: info.region,
            selfTrapped
          });
        }
      } else {
        streak = 0;
      }
    }
  }
}

console.log(`Ticks simulated:      ${totalTicks}`);
console.log(`Ticks core stranded:  ${unreachableTicks}`);
console.log(`Longest stranded run: ${worstStreak} ticks`);
console.log(`Distinct incidents:   ${failures.length}`);

const selfTraps = failures.filter((f) => f.selfTrapped);
const partitions = failures.filter((f) => !f.selfTrapped);

console.log(`\nSnake boxed itself in:  ${selfTraps.length}  (not a level defect)`);
console.log(`Board partitioned core: ${partitions.length}  (unfair — the core cannot be won)`);

if (partitions.length) {
  const byLevel = new Map();
  for (const f of partitions) {
    const key = `L${String(f.level).padStart(2, "0")} ${f.name}`;
    const row = byLevel.get(key) || { count: 0, portals: f.portals, maxRegion: 0, margins: new Set() };
    row.count++;
    row.maxRegion = Math.max(row.maxRegion, f.region);
    row.margins.add(f.margin);
    byLevel.set(key, row);
  }
  console.log("\nGenuine partitions by level:");
  for (const [key, row] of [...byLevel.entries()].sort()) {
    console.log(
      `  ${key.padEnd(26)} ${String(row.count).padStart(4)}x  portals=${row.portals}  headRegion<=${row.maxRegion}  margins={${[...row.margins].join(",")}}`
    );
  }
  const afterShrink = partitions.filter((f) => f.afterShrink).length;
  console.log(`\n${afterShrink} of them began on a shrink tick.`);
  process.exitCode = 1;
} else {
  console.log("\nNo level ever partitioned the core away from the player.");
}
