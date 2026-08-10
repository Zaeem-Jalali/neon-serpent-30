/* Node test suite for the simulation core.
 *
 *   node --test tests/
 *
 * This runs with no browser and no DOM, which is the whole point of keeping
 * src/engine.js free of browser APIs. The board fingerprints are compared
 * against tests/baseline-boards.json, captured from the pre-modularisation
 * build — if generation drifts, these fail loudly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createEngine } from "../src/engine.js";
import { LEVELS, TIERS, GRID, tierForLevel, playerMovesPerSec, rivalMovesPerSec } from "../src/levels.js";
import { key, mulberry32, hashSeed } from "../src/utils.js";

const here = dirname(fileURLToPath(import.meta.url));
const baseline = JSON.parse(readFileSync(join(here, "baseline-boards.json"), "utf8"));

// Must stay identical to the fingerprint used to capture the baseline.
function fnv1a(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function boardFingerprint(state) {
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
      mirror: state.mirror
    })
  );
}

function engineAt(seed, levelIndex, events = []) {
  const engine = createEngine({ emit: (type, payload) => events.push({ type, payload }) });
  const { state } = engine;
  state.mode = seed === "campaign" ? "campaign" : "daily";
  state.seed = seed;
  state.rng = seed === "campaign" ? mulberry32(1) : mulberry32(hashSeed(seed));
  state.running = true;
  state.lives = 99;
  engine.loadLevel(levelIndex);
  return engine;
}

/* ------------------------------------------------------------------ */

test("engine imports and runs with no DOM present", () => {
  assert.equal(typeof globalThis.document, "undefined", "test must run without a DOM");
  assert.equal(typeof globalThis.window, "undefined", "test must run without a window");
  const engine = createEngine({});
  assert.ok(engine.state);
  assert.equal(typeof engine.step, "function");
});

test("level and tier data is well formed", () => {
  assert.equal(LEVELS.length, 30);
  assert.equal(TIERS.length, 4);

  // Tiers must cover every level exactly once, with no gaps or overlaps.
  const covered = new Set();
  for (const tier of TIERS) {
    for (let i = tier.from; i <= tier.to; i++) {
      assert.ok(!covered.has(i), `level ${i + 1} covered by two tiers`);
      covered.add(i);
    }
  }
  assert.equal(covered.size, LEVELS.length);
});

test("speed is constant within a tier and steps up between tiers", () => {
  const expected = [4, 5, 6, 7];
  TIERS.forEach((tier, index) => {
    assert.equal(tier.movesPerSec, expected[index], `${tier.name} speed`);
    for (let i = tier.from; i <= tier.to; i++) {
      assert.equal(playerMovesPerSec(i), expected[index], `level ${i + 1} speed`);
    }
  });
});

test("rival snakes exist only in the final tier, one per level, 2/sec slower", () => {
  const finalTier = TIERS[TIERS.length - 1];
  LEVELS.forEach((level, i) => {
    const inFinalTier = i >= finalTier.from && i <= finalTier.to;
    if (inFinalTier) {
      assert.equal(level.enemies, 1, `level ${i + 1} should have exactly one rival`);
      assert.equal(rivalMovesPerSec(i), playerMovesPerSec(i) - 2, `level ${i + 1} rival speed`);
    } else {
      assert.equal(level.enemies, 0, `level ${i + 1} should have no rivals`);
    }
  });
});

test("generated boards match the recorded baseline exactly", () => {
  for (const [seed, fingerprints] of Object.entries(baseline)) {
    if (seed.startsWith("_")) continue;
    for (let i = 0; i < LEVELS.length; i++) {
      const { state } = engineAt(seed, i);
      assert.equal(
        boardFingerprint(state),
        fingerprints[i],
        `${seed} level ${i + 1} board drifted from the baseline`
      );
    }
  }
});

test("the same seed always produces the same board", () => {
  for (const levelIndex of [0, 9, 20, 29]) {
    const a = boardFingerprint(engineAt("daily-2026-08-09", levelIndex).state);
    const b = boardFingerprint(engineAt("daily-2026-08-09", levelIndex).state);
    const c = boardFingerprint(engineAt("daily-2026-08-10", levelIndex).state);
    assert.equal(a, b, `level ${levelIndex + 1} not deterministic`);
    assert.notEqual(a, c, `level ${levelIndex + 1} identical across different seeds`);
  }
});

test("every level spawns a legal, reachable board", () => {
  for (const seed of ["campaign", "daily-2026-08-09", "daily-2026-12-25"]) {
    for (let i = 0; i < LEVELS.length; i++) {
      const engine = engineAt(seed, i);
      const { state } = engine;
      const where = `${seed} level ${i + 1}`;

      assert.ok(state.snake.length > 0, `${where}: no snake`);
      for (const seg of state.snake) {
        assert.ok(!state.walls.has(key(seg.x, seg.y)), `${where}: snake inside a wall`);
        assert.ok(engine.insidePlayableArea(seg.x, seg.y), `${where}: snake out of bounds`);
      }

      assert.ok(state.food, `${where}: no food spawned`);
      assert.ok(!state.walls.has(key(state.food.x, state.food.y)), `${where}: food inside a wall`);
      assert.ok(engine.insidePlayableArea(state.food.x, state.food.y), `${where}: food out of bounds`);
      assert.ok(!engine.inShrinkZone(state.food.x, state.food.y), `${where}: food in the shrink zone`);
      assert.ok(engine.foodReachable(), `${where}: food unreachable from the head`);

      for (const p of state.powerups) {
        assert.ok(!state.walls.has(key(p.x, p.y)), `${where}: powerup inside a wall`);
      }
      for (const h of state.hazards) {
        assert.ok(!state.walls.has(key(h.x, h.y)), `${where}: drone inside a wall`);
      }
      for (const portal of state.portals) {
        for (const node of [portal.a, portal.b]) {
          assert.ok(!state.walls.has(key(node.x, node.y)), `${where}: portal inside a wall`);
        }
      }
      for (const enemy of state.enemySnakes) {
        assert.ok(enemy.body.length > 0, `${where}: rival with an empty body`);
        for (const seg of enemy.body) {
          assert.ok(!state.walls.has(key(seg.x, seg.y)), `${where}: rival segment inside a wall`);
        }
      }

      assert.ok(state.hazards.length <= LEVELS[i].hazards, `${where}: too many drones`);
      assert.ok(state.enemySnakes.length <= LEVELS[i].enemies, `${where}: too many rivals`);
      assert.ok(state.portals.length <= LEVELS[i].portals, `${where}: too many portals`);
    }
  }
});

test("mirrored stages flip left/right only", () => {
  const engine = engineAt("campaign", 9); // Swap Storm
  const { state } = engine;
  assert.equal(state.mirror, true);

  const probe = (input, from) => {
    state.snakeDir = { ...from };
    state.nextDir = { ...from };
    engine.requestDirection(input);
    return state.nextDir;
  };

  assert.deepEqual(probe("left", { x: 0, y: -1 }), { x: 1, y: 0 }, "left should steer right");
  assert.deepEqual(probe("right", { x: 0, y: -1 }), { x: -1, y: 0 }, "right should steer left");
  assert.deepEqual(probe("up", { x: 1, y: 0 }), { x: 0, y: -1 }, "up should be unchanged");
  assert.deepEqual(probe("down", { x: 1, y: 0 }), { x: 0, y: 1 }, "down should be unchanged");
});

test("following your own tail is legal, but biting your body is not", () => {
  const engine = engineAt("campaign", 0);
  const { state } = engine;
  state.snake = [
    { x: 10, y: 10 },
    { x: 10, y: 11 },
    { x: 11, y: 11 },
    { x: 11, y: 10 }
  ];
  assert.equal(engine.collisionReason({ x: 11, y: 10 }, false), null, "tail cell frees up when not growing");
  assert.ok(engine.collisionReason({ x: 11, y: 10 }, true), "tail cell is fatal when growing into it");
  assert.ok(engine.collisionReason({ x: 10, y: 11 }, false), "mid-body is always fatal");
});

test("a simulated run never throws and reports events", () => {
  for (const seed of ["campaign", "daily-2026-08-09"]) {
    for (let i = 0; i < LEVELS.length; i++) {
      const events = [];
      const engine = engineAt(seed, i, events);
      const { state } = engine;

      for (let tick = 0; tick < 200; tick++) {
        if (state.timerLeft != null) state.timerLeft = 999;
        if (state.paused) state.paused = false;
        const head = state.snake[0];
        const dirs = [
          { n: "right", x: 1, y: 0 },
          { n: "down", x: 0, y: 1 },
          { n: "up", x: 0, y: -1 },
          { n: "left", x: -1, y: 0 }
        ];
        const safe = dirs.find((d) => !engine.isBlocked(head.x + d.x, head.y + d.y, false));
        if (safe) {
          const name = state.mirror
            ? { left: "right", right: "left" }[safe.n] || safe.n
            : safe.n;
          engine.requestDirection(name);
        }
        assert.doesNotThrow(() => engine.step(), `${seed} level ${i + 1} threw at tick ${tick}`);
        for (const seg of state.snake) {
          assert.ok(Number.isFinite(seg.x) && Number.isFinite(seg.y), `${seed} L${i + 1}: non-finite coords`);
        }
        if (state.over || state.won) break;
      }
    }
  }
});

test("the closing arena never strands the core", () => {
  // Data Dunes onwards shrink; the edge used to swallow the food and make the
  // stage unwinnable.
  for (const levelIndex of [20, 21, 22, 23, 24, 29]) {
    const engine = engineAt("campaign", levelIndex);
    const { state } = engine;
    let stranded = 0;

    for (let tick = 0; tick < 400; tick++) {
      if (state.timerLeft != null) state.timerLeft = 999;
      if (state.paused) state.paused = false;
      const head = state.snake[0];
      const dirs = [
        { n: "right", x: 1, y: 0 },
        { n: "down", x: 0, y: 1 },
        { n: "up", x: 0, y: -1 },
        { n: "left", x: -1, y: 0 }
      ];
      const safe = dirs.find((d) => !engine.isBlocked(head.x + d.x, head.y + d.y, false));
      if (safe) engine.requestDirection(safe.n);
      engine.step();
      if (state.over || state.won) break;
      if (state.food && engine.inShrinkZone(state.food.x, state.food.y)) stranded++;
    }

    assert.equal(stranded, 0, `level ${levelIndex + 1}: core was stranded in the shrink zone`);
  }
});
