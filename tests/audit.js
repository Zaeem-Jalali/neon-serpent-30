/* Level audit harness.
 *
 * Loaded manually in the browser console (or by the automated check in
 * tests/run-audit.md) against a running copy of the game. It drives the game
 * through window.__neonDebug, so it exercises the real generation and step
 * code rather than a reimplementation of it.
 *
 *   const report = await runAudit();
 */
(function () {
  const D = window.__neonDebug;
  if (!D) {
    console.error("__neonDebug missing — is game.js loaded?");
    return;
  }

  const { state, LEVELS, GRID, key } = D;

  function cellsOf(list) {
    return list.map((item) => ({ x: item.x, y: item.y }));
  }

  function isFinitePoint(p) {
    return p && Number.isFinite(p.x) && Number.isFinite(p.y);
  }

  // ---- static checks -------------------------------------------------
  function auditPlacement(levelIndex, issues) {
    const label = `L${levelIndex + 1}`;
    const walls = state.walls;

    if (!state.snake.length) issues.push(`${label}: snake has no segments`);
    for (const seg of state.snake) {
      if (walls.has(key(seg.x, seg.y))) issues.push(`${label}: snake spawned inside a wall`);
      if (!D.insidePlayableArea(seg.x, seg.y)) issues.push(`${label}: snake spawned out of bounds`);
    }

    if (!state.food) {
      issues.push(`${label}: no food spawned`);
    } else {
      if (!isFinitePoint(state.food)) issues.push(`${label}: food has non-finite coords`);
      if (walls.has(key(state.food.x, state.food.y))) issues.push(`${label}: food spawned inside a wall`);
      if (!D.insidePlayableArea(state.food.x, state.food.y)) issues.push(`${label}: food out of bounds`);
      if (D.inShrinkZone(state.food.x, state.food.y)) issues.push(`${label}: food inside shrink dead-zone`);
      const reachable = D.reachableFromHead();
      if (!reachable.has(key(state.food.x, state.food.y))) {
        issues.push(`${label}: food unreachable from the snake head`);
      }
    }

    for (const p of cellsOf(state.powerups)) {
      if (walls.has(key(p.x, p.y))) issues.push(`${label}: powerup inside a wall`);
    }
    for (const h of cellsOf(state.hazards)) {
      if (walls.has(key(h.x, h.y))) issues.push(`${label}: drone spawned inside a wall`);
    }
    for (const portal of state.portals) {
      for (const node of [portal.a, portal.b]) {
        if (walls.has(key(node.x, node.y))) issues.push(`${label}: portal node inside a wall`);
        if (!D.insidePlayableArea(node.x, node.y)) issues.push(`${label}: portal node out of bounds`);
      }
    }
    for (const enemy of state.enemySnakes) {
      if (!enemy.body.length) issues.push(`${label}: rival snake spawned with an empty body`);
      for (const seg of enemy.body) {
        if (walls.has(key(seg.x, seg.y))) issues.push(`${label}: rival segment inside a wall`);
      }
    }

    const config = LEVELS[levelIndex];
    if (state.hazards.length > config.hazards) issues.push(`${label}: too many drones`);
    if (state.enemySnakes.length > config.enemies) issues.push(`${label}: too many rivals`);
    if (state.portals.length > config.portals) issues.push(`${label}: too many portals`);
  }

  // ---- simulated play -------------------------------------------------
  // Greedy BFS autopilot: walks toward the food, preferring any safe cell when
  // no path exists. Good enough to prove the engine does not throw.
  function planDirection() {
    const head = state.snake[0];
    if (!head || !state.food) return null;

    const dirs = [
      { name: "up", x: 0, y: -1 },
      { name: "down", x: 0, y: 1 },
      { name: "left", x: -1, y: 0 },
      { name: "right", x: 1, y: 0 }
    ];

    const start = key(head.x, head.y);
    const goal = key(state.food.x, state.food.y);
    const prev = new Map([[start, null]]);
    const queue = [head];

    while (queue.length) {
      const cur = queue.shift();
      if (key(cur.x, cur.y) === goal) break;
      for (const d of dirs) {
        const nx = cur.x + d.x;
        const ny = cur.y + d.y;
        const k = key(nx, ny);
        if (prev.has(k)) continue;
        if (D.isBlocked(nx, ny, false) && k !== goal) continue;
        prev.set(k, { from: key(cur.x, cur.y), dir: d });
        queue.push({ x: nx, y: ny });
      }
    }

    let chosen = null;
    if (prev.has(goal)) {
      let node = goal;
      while (prev.get(node) && prev.get(node).from !== start) node = prev.get(node).from;
      chosen = prev.get(node) ? prev.get(node).dir : null;
    }

    if (!chosen) {
      chosen = dirs.find((d) => !D.isBlocked(head.x + d.x, head.y + d.y, false)) || null;
    }
    if (!chosen) return null;

    // requestDirection applies the mirroring itself, so pre-mirror to cancel it
    // out and keep the autopilot steering true on mirrored stages. Only the
    // horizontal axis is flipped.
    if (state.mirror) {
      const mirrored = { left: "right", right: "left" };
      return mirrored[chosen.name] || chosen.name;
    }
    return chosen.name;
  }

  function simulate(levelIndex, ticks, issues) {
    const label = `L${levelIndex + 1}`;
    const startLevel = state.levelIndex;
    const startLives = state.lives;
    let cleared = false;
    let ticksUsed = 0;
    let timedOut = false;
    let stranded = 0;

    for (let i = 0; i < ticks; i++) {
      ticksUsed = i + 1;
      // The stage timer is wall-clock driven, so a stepped simulation would
      // always expire before it can finish. Hold it open and judge the level
      // on whether the mission itself is completable.
      if (state.timerLeft != null) {
        if (state.timerLeft <= 0) timedOut = true;
        state.timerLeft = 999;
      }

      const dir = planDirection();
      if (dir) D.requestDirection(dir);
      try {
        D.stepOnce();
      } catch (err) {
        issues.push(`${label}: threw during step ${i} — ${err && err.message}`);
        return { cleared: false, threw: true, ticksUsed, deaths: 0, mission: 0, timedOut };
      }
      // Clearing the final level ends the run in victory rather than
      // advancing levelIndex, so both count as cleared.
      if (state.levelIndex !== startLevel || state.won) {
        cleared = true;
        break;
      }
      if (state.over) break;
      for (const seg of state.snake) {
        if (!Number.isFinite(seg.x) || !Number.isFinite(seg.y)) {
          issues.push(`${label}: snake coords went non-finite at tick ${i}`);
          return { cleared: false, threw: true, ticksUsed, deaths: 0, mission: 0, timedOut };
        }
      }
      // The core must never sit somewhere the player can no longer get to —
      // the closing arena edge used to swallow it and stall the stage.
      if (state.food && i % 25 === 0) {
        if (D.inShrinkZone(state.food.x, state.food.y)) {
          stranded++;
        } else if (state.walls.has(key(state.food.x, state.food.y))) {
          stranded++;
        }
      }

      // loseLife pauses the run; un-pause so the simulation keeps going.
      if (state.paused) state.paused = false;
    }

    if (stranded > 0) {
      issues.push(`${label}: core was stranded out of play on ${stranded} sampled ticks`);
    }

    return {
      cleared,
      threw: false,
      ticksUsed,
      deaths: startLives - state.lives,
      mission: state.mission,
      goal: state.missionGoal,
      timedOut,
      stranded
    };
  }

  window.runAudit = function runAudit(options) {
    const opts = Object.assign({ seeds: ["campaign", "daily-2026-08-09"], ticks: 900 }, options || {});
    const issues = [];
    const summary = [];

    for (const seed of opts.seeds) {
      for (let i = 0; i < LEVELS.length; i++) {
        D.setSeed(seed);
        D.jumpTo(i);
        auditPlacement(i, issues);

        D.setSeed(seed);
        D.jumpTo(i);
        const sim = simulate(i, opts.ticks, issues);
        summary.push({
          seed,
          level: i + 1,
          name: LEVELS[i].name,
          cleared: sim.cleared,
          threw: sim.threw,
          deaths: sim.deaths,
          mission: sim.mission,
          goal: sim.goal,
          ticksUsed: sim.ticksUsed
        });
      }
    }

    const notCleared = summary.filter((row) => !row.cleared && !row.threw);
    return {
      grid: `${GRID.cols}x${GRID.rows}`,
      levels: LEVELS.length,
      seeds: opts.seeds,
      totalRuns: summary.length,
      clearedRuns: summary.filter((r) => r.cleared).length,
      threwRuns: summary.filter((r) => r.threw).length,
      totalDeaths: summary.reduce((sum, r) => sum + (r.deaths || 0), 0),
      notCleared: notCleared.map((r) => `${r.seed} L${r.level} ${r.name} (${r.mission}/${r.goal} cores, ${r.deaths} deaths)`),
      summary,
      issues
    };
  };

  console.log("audit harness ready — call runAudit()");
})();
