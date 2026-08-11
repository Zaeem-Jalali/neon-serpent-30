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
import { LEVELS, TIERS, GRID, BOSS_SHARDS_PER_CYCLE, BOSS_ARENA_HALF_SPAN, tierForLevel, playerMovesPerSec, rivalMovesPerSec } from "../src/levels.js";
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
      mirror: state.mirror,
      // The core's own position is already covered by walls (it is reserved
      // there at spawn), but the charge shards are a separate array.
      bossCharges: (state.bossCharges || []).map((c) => [c.x, c.y])
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

test("starting a Daily Rift run through the real public API does not throw", () => {
  /* Regression test. prepareDailySeed() used to write straight to seedLabel
     and challengeCode DOM elements that only exist in main.js's separate
     module scope, so this crashed the instant a real player picked Daily
     Rift and hit Start — invisibly, because every other test and the debug
     harness set state.seed directly and never went through resetRun(). */
  const engine = createEngine({});
  engine.state.mode = "daily";
  assert.doesNotThrow(() => engine.resetRun());
  assert.match(engine.state.seed, /^daily-\d{4}-\d{2}-\d{2}$/);
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

      if (LEVELS[i].boss) {
        // Boss levels have no ambient food — state.food is only ever set
        // while the core is exposed, which it is not at spawn. The core and
        // its charge shards are the boss-level equivalent of this check.
        assert.equal(state.food, null, `${where}: boss level spawned with ambient food`);
        assert.ok(state.boss, `${where}: boss level has no boss state`);
        assert.ok(state.bossCorePos, `${where}: boss level has no reserved core position`);
        assert.ok(state.walls.has(key(state.bossCorePos.x, state.bossCorePos.y)), `${where}: boss core is not shielded at spawn`);
        assert.equal(state.bossCharges.length, BOSS_SHARDS_PER_CYCLE, `${where}: wrong number of charge shards`);
        for (const shard of state.bossCharges) {
          assert.ok(!state.walls.has(key(shard.x, shard.y)), `${where}: charge shard inside a wall`);
          assert.ok(engine.insidePlayableArea(shard.x, shard.y), `${where}: charge shard out of bounds`);
        }
      } else {
        assert.ok(state.food, `${where}: no food spawned`);
        assert.ok(!state.walls.has(key(state.food.x, state.food.y)), `${where}: food inside a wall`);
        assert.ok(engine.insidePlayableArea(state.food.x, state.food.y), `${where}: food out of bounds`);
        assert.ok(!engine.inShrinkZone(state.food.x, state.food.y), `${where}: food in the shrink zone`);
        assert.ok(engine.foodReachable(), `${where}: food unreachable from the head`);
      }

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

test("the board never partitions the core away from the player", () => {
  /* Distinct from "the core spawned somewhere legal". This plays each level
     out and asks, every single tick, whether the core is still reachable —
     walls, the snake's own body and the closing arena all considered, with
     portals counted as connections.
   *
   * A snake that has driven into a dead end is NOT a level defect: you are
   * allowed to trap yourself. Those are separated out by region size, since a
   * boxed-in snake can reach almost nothing regardless of where the core is. */
  const SELF_TRAP_CELLS = 25;
  const partitions = [];

  const reach = (engine) => {
    const { state } = engine;
    const head = state.snake[0];
    const blocked = new Set(state.walls);
    for (const seg of state.snake.slice(1)) blocked.add(key(seg.x, seg.y));

    const links = new Map();
    for (const p of state.portals) {
      links.set(key(p.a.x, p.a.y), p.b);
      links.set(key(p.b.x, p.b.y), p.a);
    }

    const seen = new Set([key(head.x, head.y)]);
    const queue = [head];
    const visit = (c) => {
      const k = key(c.x, c.y);
      if (seen.has(k) || blocked.has(k)) return;
      if (!engine.insidePlayableArea(c.x, c.y)) return;
      if (engine.inShrinkZone(c.x, c.y)) return;
      seen.add(k);
      queue.push(c);
      const twin = links.get(k);
      if (twin) visit(twin);
    };
    while (queue.length) {
      const cur = queue.shift();
      for (const d of [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }]) {
        visit({ x: cur.x + d.x, y: cur.y + d.y });
      }
    }
    return seen;
  };

  for (const seed of ["campaign", "daily-2026-08-09"]) {
    for (let i = 0; i < LEVELS.length; i++) {
      const engine = engineAt(seed, i);
      const { state } = engine;

      for (let tick = 0; tick < 300; tick++) {
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
          engine.requestDirection(
            state.mirror ? { left: "right", right: "left" }[safe.n] || safe.n : safe.n
          );
        }
        engine.step();
        if (state.over || state.won) break;
        if (!state.food) continue;

        const seen = reach(engine);
        const stranded = !seen.has(key(state.food.x, state.food.y));
        if (stranded && seen.size > SELF_TRAP_CELLS) {
          partitions.push(`${seed} L${i + 1} tick ${tick} (head could reach ${seen.size} cells)`);
        }
      }
    }
  }

  assert.deepEqual(partitions, [], "core was sealed off from a player who was not trapped");
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

/* ------------------------------------------------------------------
 * Boss encounters (levels 8, 16, 24, 30)
 * --------------------------------------------------------------- */

const BOSS_LEVELS = { warden: 7, disruptor: 15, collapse: 23, singularity: 29 };

// Places the head immediately before a target cell, facing it, and steps
// once — the same "walk onto X" primitive every boss test needs, without
// depending on a working pathfinder to reach across the arena.
function stepOnto(engine, target) {
  const { state } = engine;
  state.snake = [
    { x: target.x - 1, y: target.y },
    { x: target.x - 2, y: target.y },
    { x: target.x - 3, y: target.y }
  ];
  state.snakeDir = { x: 1, y: 0 };
  engine.requestDirection("right");
  engine.step();
}

function eatAllCharges(engine) {
  const { state } = engine;
  for (const shard of [...state.bossCharges]) stepOnto(engine, shard);
}

function runClear(state) {
  if (state.timerLeft != null) state.timerLeft = 999;
  if (state.paused) state.paused = false;
}

test("boss levels are exactly 8, 16, 24 and 30, and no others", () => {
  const bossIndices = LEVELS.map((l, i) => (l.boss ? i : null)).filter((i) => i !== null);
  assert.deepEqual(bossIndices, [7, 15, 23, 29]);
  assert.deepEqual(
    LEVELS.filter((l) => l.boss).map((l) => l.boss),
    ["warden", "disruptor", "collapse", "singularity"]
  );
});

test("a boss opens after exactly BOSS_SHARDS_PER_CYCLE shards and can be defeated", () => {
  for (const [id, levelIndex] of Object.entries(BOSS_LEVELS)) {
    const engine = engineAt("campaign", levelIndex);
    const { state } = engine;
    // This test drives the core open/hit/re-shield cycle directly by
    // teleporting onto shards and the core rather than navigating to them, so
    // an ambient drone or the hunting fragment wandering into the snake's
    // teleported position between cycles would be an artifact of that
    // shortcut, not a real failure — the drones and rival get their own
    // dedicated, lighter-weight coverage elsewhere in this file.
    state.hazards = [];
    state.enemySnakes = [];
    const core = { ...state.boss.core };
    const hitsRequired = state.boss.hitsRequired;
    assert.equal(hitsRequired, LEVELS[levelIndex].target, `${id}: hitsRequired should equal the level's target`);

    for (let hit = 1; hit <= hitsRequired; hit++) {
      assert.equal(state.boss.phase, "charging", `${id}: should be charging before cycle ${hit}`);
      assert.equal(state.bossCharges.length, BOSS_SHARDS_PER_CYCLE, `${id}: wrong shard count at cycle ${hit}`);

      eatAllCharges(engine);
      assert.equal(state.boss.phase, "exposed", `${id}: should open after eating all shards (cycle ${hit})`);
      assert.deepEqual(state.food, core, `${id}: exposed food should be the core`);

      const missionBefore = state.mission;
      stepOnto(engine, core);

      if (hit < hitsRequired) {
        assert.equal(state.mission, missionBefore + 1, `${id}: hit should count toward the mission`);
        assert.equal(state.boss.hitsTaken, hit, `${id}: hitsTaken after hit ${hit}`);
        assert.equal(state.boss.phase, "charging", `${id}: should re-shield after a non-lethal hit`);
        assert.ok(state.walls.has(key(core.x, core.y)), `${id}: core should be re-shielded`);
      } else if (levelIndex + 1 >= LEVELS.length) {
        // Singularity Prime is the last level in the game — its lethal hit
        // wins the run outright rather than loading a next level.
        assert.equal(state.won, true, `${id}: defeating the final boss should win the run`);
        assert.equal(state.levelIndex, levelIndex, `${id}: the final level index should not change on victory`);
      } else {
        // The lethal hit's mission++ is immediately overwritten by
        // loadLevel() resetting state.mission for the next level, so that is
        // not checked here — the transition below is the real assertion.
        assert.equal(state.levelIndex, levelIndex + 1, `${id}: lethal hit should advance to the next level`);
        assert.equal(state.boss, null, `${id}: boss state should be cleared after defeat`);
      }
    }
  }
});

test("missing the exposed window re-shields the core and costs the whole cycle", () => {
  const engine = engineAt("campaign", BOSS_LEVELS.warden);
  const { state } = engine;
  const core = { ...state.boss.core };
  eatAllCharges(engine);
  assert.equal(state.boss.phase, "exposed");

  // Wander safely (never touching the core) and let the window time out.
  // An alternating up/down request does not actually oscillate —
  // requestDirection rejects an exact reversal of the current heading, so
  // after the first turn it just travels straight into whatever is there —
  // so this picks any currently-safe direction each tick instead, the same
  // proven pattern used elsewhere in this file.
  let deaths = 0;
  for (let i = 0; i < state.boss.def.exposedTicks + 2; i++) {
    runClear(state);
    if (state.lives < 99) deaths++; // sanity: this test must not rely on dying
    const head = state.snake[0];
    const dirs = [
      { n: "right", x: 1, y: 0 },
      { n: "down", x: 0, y: 1 },
      { n: "up", x: 0, y: -1 },
      { n: "left", x: -1, y: 0 }
    ];
    const safe = dirs
      .filter((d) => !(d.x === core.x - head.x && d.y === core.y - head.y)) // never step onto the core
      .find((d) => !engine.isBlocked(head.x + d.x, head.y + d.y, false));
    if (safe) engine.requestDirection(safe.n);
    engine.step();
  }

  assert.equal(deaths, 0, "this test is only meaningful if the player survived the whole window");
  assert.equal(state.boss.phase, "charging", "window should have closed on timeout, not on a death");
  assert.equal(state.boss.hitsTaken, 0, "a miss must not count as a hit");
  assert.ok(state.walls.has(key(core.x, core.y)), "core should be re-shielded after a miss");
  assert.equal(state.bossCharges.length, BOSS_SHARDS_PER_CYCLE, "a fresh cycle of shards should have spawned");
});

test("touching a closed boss core is fatal but does not throw", () => {
  const engine = engineAt("campaign", BOSS_LEVELS.warden);
  const { state } = engine;
  const core = { ...state.boss.core };
  const reason = engine.collisionReason(core, false);
  assert.match(reason, /shield/i);

  const livesBefore = state.lives;
  stepOnto(engine, core);
  assert.equal(state.lives, livesBefore - 1, "walking into the closed core should cost a life");
});

test("The Disruptor's mirror attack always reverts, and only fires while charging", () => {
  const engine = engineAt("campaign", BOSS_LEVELS.disruptor);
  const { state } = engine;
  assert.equal(state.currentLevel.mirror, false, "base level config should not be statically mirrored");

  state.snake = [{ x: 15, y: 10 }, { x: 14, y: 10 }, { x: 13, y: 10 }];
  state.snakeDir = { x: 1, y: 0 };
  state.nextDir = { x: 1, y: 0 };
  let sawMirror = false;
  let maxStreak = 0;
  let streak = 0;
  for (let i = 0; i < 60; i++) {
    runClear(state);
    engine.step();
    if (state.mirror) {
      sawMirror = true;
      streak++;
      maxStreak = Math.max(maxStreak, streak);
    } else {
      streak = 0;
    }
  }
  assert.ok(sawMirror, "the mirror attack should fire within 60 ticks");
  assert.ok(maxStreak <= state.boss.def.attackDuration, "a mirror pulse should never outlast its configured duration");
});

test("The Collapse's shrink attack never exceeds a safe margin and always releases", () => {
  for (const [id, levelIndex] of [["collapse", BOSS_LEVELS.collapse], ["singularity", BOSS_LEVELS.singularity]]) {
    const engine = engineAt("campaign", levelIndex);
    const { state } = engine;
    const core = state.boss.core;
    const spawnTail = { x: core.x - 2 * BOSS_ARENA_HALF_SPAN + 2, y: core.y };

    // This test is about the shrink-pulse math staying within safe bounds,
    // not about surviving the rest of the encounter — Singularity Prime's
    // ambient drones and hunting fragment are cleared so a stray death can't
    // interrupt a telegraphed pulse mid-count and starve it out, which is a
    // real thing that can legitimately happen in a chaotic real fight (an
    // attack cancels on death by design) but has nothing to do with what is
    // being verified here.
    state.hazards = [];
    state.enemySnakes = [];

    // The attack's whole point is to threaten a player who is not paying
    // attention to its telegraph, so a bot that only reacts to the CURRENT
    // margin can legitimately wander into a band that becomes lethal a few
    // ticks later — that is the attack working as designed, not a bug, but
    // it is not what this test is trying to measure. Planning against the
    // worst-case margin the whole time sidesteps needing real telegraph-
    // reading logic while still leaving the actual thing under test —
    // whether the margin itself ever exceeds shrinkTarget and always
    // releases — fully exercised.
    const worstCaseMargin = state.boss.def.shrinkTarget;
    const dangerZone = (x, y) =>
      x <= worstCaseMargin || x >= GRID.cols - 1 - worstCaseMargin || y <= worstCaseMargin || y >= GRID.rows - 1 - worstCaseMargin;

    let maxMargin = 0;
    let shrinkDeaths = 0;
    for (let i = 0; i < 140; i++) {
      runClear(state);
      const messageBefore = state.message;
      const head = state.snake[0];
      const dirs = [
        { n: "right", x: 1, y: 0 },
        { n: "down", x: 0, y: 1 },
        { n: "up", x: 0, y: -1 },
        { n: "left", x: -1, y: 0 }
      ];
      const safe = dirs.find((d) => !engine.isBlocked(head.x + d.x, head.y + d.y, false) && !dangerZone(head.x + d.x, head.y + d.y));
      if (safe) engine.requestDirection(safe.n);
      engine.step();
      // The bot is a dumb "first safe direction, preferring right" walker —
      // it can (and near L30's denser wall scatter, does) wander into an
      // ordinary wall pillar on its own, which is a test-bot limitation, not
      // a shrink defect. What must never happen is dying specifically to the
      // shrink zone once it has been avoided by construction above.
      if (state.message !== messageBefore && /closing edge/i.test(state.message)) shrinkDeaths++;
      maxMargin = Math.max(maxMargin, state.shrinkMargin);
      assert.ok(!engine.inShrinkZone(core.x, core.y), `${id}: core must stay outside the shrink zone at tick ${i}`);
      assert.ok(!engine.inShrinkZone(spawnTail.x, spawnTail.y), `${id}: spawn tail must stay safe at tick ${i}`);
    }
    assert.equal(shrinkDeaths, 0, `${id}: the shrink zone itself must never be what kills a player who is avoiding it`);
    assert.ok(maxMargin > 0, `${id}: a shrink pulse should have fired within 140 ticks`);
    assert.equal(maxMargin, worstCaseMargin, `${id}: margin should reach exactly its configured target, no more`);
    assert.equal(state.shrinkMargin, 0, `${id}: margin should always release back to the resting baseline`);
  }
});

test("an attack in progress is force-cancelled the instant the core opens", () => {
  const engine = engineAt("campaign", BOSS_LEVELS.collapse);
  const { state } = engine;
  state.snake = [{ x: 15, y: 10 }, { x: 14, y: 10 }, { x: 13, y: 10 }];
  state.snakeDir = { x: 1, y: 0 };
  state.nextDir = { x: 1, y: 0 };

  let i = 0;
  for (; i < 200 && state.shrinkMargin === 0; i++) {
    runClear(state);
    engine.step();
  }
  assert.ok(state.shrinkMargin > 0, "precondition: a pulse should be active");

  eatAllCharges(engine);
  assert.equal(state.boss.phase, "exposed");
  assert.equal(state.shrinkMargin, 0, "opening the core mid-pulse should immediately release the cage");
});

test("Singularity Prime's hunting fragment is a normal rival at the tier's rival speed", () => {
  const engine = engineAt("campaign", BOSS_LEVELS.singularity);
  const { state } = engine;
  assert.equal(state.enemySnakes.length, 1);
  assert.equal(state.currentLevel.rivalMovesPerSec, playerMovesPerSec(BOSS_LEVELS.singularity) - 2);
});

test("dying mid-fight keeps hitsTaken but always hands back a fresh, clean cycle", () => {
  const engine = engineAt("campaign", BOSS_LEVELS.disruptor);
  const { state } = engine;
  const core = { ...state.boss.core };

  eatAllCharges(engine);
  stepOnto(engine, core); // one hit landed
  assert.equal(state.boss.hitsTaken, 1);

  eatAllCharges(engine); // re-open, then die while it is open
  assert.equal(state.boss.phase, "exposed");
  state.snake = [{ x: 1, y: 1 }, { x: 1, y: 2 }, { x: 1, y: 3 }];
  state.snakeDir = { x: 0, y: -1 };
  state.nextDir = { x: 0, y: -1 };
  state.lives = 3;
  engine.step(); // walks into the outer wall and dies

  assert.equal(state.lives, 2, "precondition: should have lost a life");
  assert.equal(state.boss.hitsTaken, 1, "hits already landed must survive a death");
  assert.equal(state.boss.phase, "charging", "a mid-fight death should always hand back a closed, fresh cycle");
  assert.equal(state.mirror, false, "no attack should be left active after respawning");
  assert.equal(state.food, null);
  assert.equal(state.bossCharges.length, BOSS_SHARDS_PER_CYCLE);
  assert.deepEqual(state.snake[0], { x: state.boss.core.x - 2 * BOSS_ARENA_HALF_SPAN, y: state.boss.core.y });
});
