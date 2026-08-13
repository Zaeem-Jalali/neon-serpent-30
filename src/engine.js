/* Simulation core.
 *
 * This module must never touch the DOM, the canvas, localStorage or any other
 * browser API. That constraint is what lets the same code run under Node for
 * the level audit, and it is what would make server-side replay validation
 * possible later.
 *
 * Anything the player should see or hear is reported through `emit` rather
 * than performed here: sounds, particle bursts, floating text, overlay state
 * changes and save requests. The presentation layer decides what to do with
 * them.
 */
import {
  LEVELS,
  TIERS,
  GRID,
  CHECKPOINT_EVERY,
  MAX_LIVES,
  MIN_OPEN_CELLS,
  MAX_SHRINK_MARGIN,
  BOSS_SHARDS_PER_CYCLE,
  BOSS_ARENA_HALF_SPAN,
  tierForLevel,
  playerMovesPerSec,
  rivalMovesPerSec
} from "./levels.js";
import { clamp, key, mulberry32, hashSeed } from "./utils.js";

export function createEngine({ emit = () => {} } = {}) {
  const state = {
    mode: "campaign",
    running: false,
    paused: false,
    over: false,
    won: false,
    levelIndex: 0,
    score: 0,
    lives: 3,
    bestCampaign: 0,
    bestDaily: 0,
    bestLevel: 1,
    seed: "campaign",
    rng: mulberry32(1),
    repairRng: mulberry32(1),
    stepMs: 1000 / TIERS[0].movesPerSec,
    accumulator: 0,
    tick: 0,
    levelTick: 0,
    mission: 0,
    missionGoal: LEVELS[0].target,
    missionClearBonus: 0,
    timerLeft: null,
    mirror: false,
    graceTicks: 0,
    enemyStepAccumulator: 0,
    shrinkMargin: 0,
    currentLevel: null,
    snake: [],
    snakeDir: { x: 1, y: 0 },
    nextDir: { x: 1, y: 0 },
    /* Turns entered faster than the tick rate. See requestDirection for why
       a single nextDir slot was not enough. */
    dirQueue: [],
    grow: 0,
    food: null,
    powerups: [],
    portals: [],
    walls: new Set(),
    hazards: [],
    enemySnakes: [],
    floatingSlowTicks: 0,
    bonusMultiplier: 1,
    shield: 0,
    message: "Tap Start Game to begin.",
    checkpoint: null,
    runStartLevel: 0,
    // null outside boss levels. See the "Boss encounters" section below.
    boss: null,
    bossCharges: [],
    bossCorePos: null
  };

  function loadLevel(levelIndex) {
    state.levelIndex = levelIndex;
    state.levelTick = 0;
    state.mission = 0;
    state.enemySnakes = [];
    state.hazards = [];
    state.portals = [];
    state.powerups = [];
    state.walls = new Set();
    state.food = null;
    state.boss = null;
    state.bossCharges = [];
    state.bossCorePos = null;
    emit("clearEffects");
    state.shield = 0;
    state.floatingSlowTicks = 0;
    state.bonusMultiplier = 1;
    state.graceTicks = 10;
    state.currentLevel = buildLevel(levelIndex);
    // Dedicated stream for board repair / relocation, kept out of state.rng.
    state.repairRng = mulberry32(hashSeed(`${state.seed}:repair:${levelIndex}`));
    state.stepMs = state.currentLevel.speed;
    state.missionGoal = state.currentLevel.target;
    state.missionClearBonus = 100 + levelIndex * 18;
    state.timerLeft = state.currentLevel.timer ?? null;
    state.mirror = state.currentLevel.mirror;
    state.shrinkMargin = 0;
    state.enemyStepAccumulator = 0;
    state.snake = buildSnakeStart();
    state.snakeDir = { x: 1, y: 0 };
    state.nextDir = { x: 1, y: 0 };
    state.dirQueue.length = 0;
    state.grow = 0;

    buildStaticMap(state.currentLevel);
    // Reserved before anything else spawns, so portals/hazards/powerups —
    // all placed via randomFreeCell, which avoids state.walls — never land
    // on top of the core.
    reserveBossCore(state.currentLevel);
    spawnPortals(state.currentLevel.portals);
    spawnHazards(state.currentLevel.hazards);
    spawnEnemies(state.currentLevel.enemies);
    spawnPowerups(state.currentLevel.powerups);
    ensurePlayableBoard();
    announceLevelModifiers();
    captureCheckpoint(levelIndex);
    emit("ui");
  }

  function buildLevel(levelIndex) {
    const base = LEVELS[levelIndex];
    const seedMix = hashSeed(`${state.seed}:${levelIndex + 1}`);
    const rng = mulberry32(seedMix);
    const tier = tierForLevel(levelIndex);
    return {
      index: levelIndex + 1,
      name: base.name,
      desc: base.desc,
      tier,
      movesPerSec: tier.movesPerSec,
      // Speed is uniform across a tier, so it is derived rather than stored.
      speed: 1000 / tier.movesPerSec,
      rivalMovesPerSec: rivalMovesPerSec(levelIndex),
      target: base.target,
      layout: base.layout,
      walls: base.walls,
      hazards: base.hazards,
      enemies: base.enemies,
      portals: base.portals,
      powerups: base.powerups,
      timer: base.timer,
      mirror: base.mirror,
      shrink: base.shrink,
      boss: base.boss || null,
      rng
    };
  }

  /* Boss stages put the player and the core on opposite sides of the arena's
     centre line rather than at true centre, so the fight opens with the whole
     room between you and the shield. bossArenaAnchors() is the single source
     of truth for both positions — buildStaticMap's safe-zone clearing and
     clearSpawnArea() both read the player's half from here too, so nothing
     drifts out of sync if the span constant ever changes. */
  function bossArenaAnchors() {
    const centerX = Math.floor(GRID.cols / 2);
    const centerY = Math.floor(GRID.rows / 2);
    return {
      player: { x: centerX - BOSS_ARENA_HALF_SPAN, y: centerY },
      core: { x: centerX + BOSS_ARENA_HALF_SPAN, y: centerY }
    };
  }

  function buildSnakeStart() {
    if (state.currentLevel?.boss) {
      const { player } = bossArenaAnchors();
      return [
        { x: player.x, y: player.y },
        { x: player.x - 1, y: player.y },
        { x: player.x - 2, y: player.y }
      ];
    }
    const startX = Math.floor(GRID.cols / 2);
    const startY = Math.floor(GRID.rows / 2);
    return [
      { x: startX, y: startY },
      { x: startX - 1, y: startY },
      { x: startX - 2, y: startY }
    ];
  }

  function buildStaticMap(level) {
    const rng = level.rng;
    const addWall = (x, y) => {
      if (insidePlayfield(x, y)) {
        state.walls.add(key(x, y));
      }
    };
    const addRect = (x1, y1, x2, y2) => {
      for (let x = x1; x <= x2; x++) {
        addWall(x, y1);
        addWall(x, y2);
      }
      for (let y = y1; y <= y2; y++) {
        addWall(x1, y);
        addWall(x2, y);
      }
    };
    const addLine = (x1, y1, x2, y2) => {
      if (x1 === x2) {
        const min = Math.min(y1, y2);
        const max = Math.max(y1, y2);
        for (let y = min; y <= max; y++) addWall(x1, y);
      } else if (y1 === y2) {
        const min = Math.min(x1, x2);
        const max = Math.max(x1, x2);
        for (let x = min; x <= max; x++) addWall(x, y1);
      }
    };

    addRect(0, 0, GRID.cols - 1, GRID.rows - 1);

    const centerX = Math.floor(GRID.cols / 2);
    const centerY = Math.floor(GRID.rows / 2);
    const layout = level.layout;

    const carveGate = (x, y, size = 1) => {
      for (let dx = -size; dx <= size; dx++) {
        for (let dy = -size; dy <= size; dy++) {
          state.walls.delete(key(x + dx, y + dy));
        }
      }
    };

    if (layout === "open") {
      scatterBlocks(level.walls, rng, 4, 3);
    } else if (layout === "boulevard") {
      const pillars = [
        [6, 5], [10, 5], [14, 5], [18, 5], [22, 5],
        [8, 9], [14, 9], [20, 9],
        [6, 13], [10, 13], [14, 13], [18, 13], [22, 13]
      ];
      for (const [x, y] of pillars) {
        addWall(x, y);
      }
    } else if (layout === "lanes") {
      addLine(4, 3, 25, 3);
      addLine(4, 16, 25, 16);
      addLine(7, 4, 7, 15);
      addLine(22, 4, 22, 15);
      carveGate(7, 9, 1);
      carveGate(22, 10, 1);
      scatterBlocks(level.walls - 8, rng, 3, 3);
    } else if (layout === "cross") {
      addLine(centerX, 2, centerX, GRID.rows - 3);
      addLine(3, centerY, GRID.cols - 4, centerY);
      carveGate(centerX, centerY - 4, 1);
      carveGate(centerX, centerY + 4, 1);
      carveGate(centerX - 5, centerY, 1);
      carveGate(centerX + 5, centerY, 1);
      scatterBlocks(level.walls - 10, rng, 3, 2);
    } else if (layout === "rings") {
      addRect(5, 4, 24, 15);
      addRect(9, 7, 20, 12);
      carveGate(14, 4, 1);
      carveGate(5, 9, 1);
      carveGate(24, 10, 1);
      carveGate(14, 15, 1);
      scatterBlocks(level.walls - 12, rng, 4, 2);
    } else if (layout === "maze") {
      for (let x = 4; x < GRID.cols - 4; x += 4) {
        for (let y = 2; y < GRID.rows - 2; y++) {
          if ((x + y) % 5 !== 0) addWall(x, y);
        }
      }
      carveGate(4, 8, 1);
      carveGate(8, 12, 1);
      carveGate(12, 6, 1);
      carveGate(16, 14, 1);
      carveGate(20, 8, 1);
      carveGate(24, 12, 1);
      scatterBlocks(level.walls - 14, rng, 2, 2);
    } else if (layout === "fortress") {
      addRect(7, 5, 22, 14);
      addRect(11, 8, 18, 11);
      carveGate(14, 5, 1);
      carveGate(7, 9, 1);
      carveGate(22, 10, 1);
      carveGate(14, 14, 1);
      scatterBlocks(level.walls - 16, rng, 3, 2);
    } else if (layout === "chaos") {
      scatterBlocks(level.walls, rng, 3, 4);
      addLine(6, 5, 12, 5);
      addLine(18, 14, 24, 14);
      addLine(11, 7, 11, 13);
      carveGate(11, 10, 1);
    } else if (layout === "labyrinth") {
      addLine(4, 4, 25, 4);
      addLine(4, 15, 25, 15);
      addLine(4, 4, 4, 15);
      addLine(25, 4, 25, 15);
      addLine(8, 6, 8, 13);
      addLine(12, 6, 12, 13);
      addLine(16, 6, 16, 13);
      addLine(20, 6, 20, 13);
      carveGate(8, 8, 1);
      carveGate(12, 11, 1);
      carveGate(16, 8, 1);
      carveGate(20, 11, 1);
      scatterBlocks(level.walls - 12, rng, 2, 2);
    } else if (layout === "mirror") {
      addRect(6, 5, 23, 14);
      addLine(9, 7, 9, 12);
      addLine(20, 7, 20, 12);
      addLine(11, 9, 18, 9);
      carveGate(9, 9, 1);
      carveGate(20, 10, 1);
      carveGate(14, 9, 1);
      scatterBlocks(level.walls - 12, rng, 3, 2);
    } else if (layout === "spiral") {
      let left = 5;
      let top = 4;
      let right = 24;
      let bottom = 15;
      while (left < right && top < bottom) {
        addLine(left, top, right, top);
        addLine(right, top, right, bottom);
        if (top + 2 <= bottom) addLine(right, bottom, left + 2, bottom);
        if (left + 2 <= right) addLine(left + 2, bottom, left + 2, top + 2);
        left += 4;
        top += 3;
        right -= 4;
        bottom -= 3;
      }
      carveGate(14, 8, 1);
      carveGate(18, 11, 1);
      scatterBlocks(level.walls - 10, rng, 2, 2);
    } else if (layout === "boss") {
      /* A single open room rather than the nested-box mazes used elsewhere.
         A boss fight needs a clear sightline to the core and room to dodge
         its attacks, not corridors to get lost navigating — the difficulty
         here comes from the encounter, not the architecture. Wide gates on
         all four sides, light scattered cover kept away from the direct
         line between spawn and core so it reads as an arena, not a maze. */
      addRect(4, 3, 25, 16);
      carveGate(4, 9, 1);
      carveGate(4, 10, 1);
      carveGate(25, 9, 1);
      carveGate(25, 10, 1);
      carveGate(14, 3, 1);
      carveGate(15, 3, 1);
      carveGate(14, 16, 1);
      carveGate(15, 16, 1);
      scatterBlocks(Math.max(0, level.walls - 4), rng, 1, 1);
    }

    // Ensure the start area stays playable. Anchored on the snake's actual
    // spawn point rather than assumed true-centre, since boss stages start
    // the player off-centre (see bossArenaAnchors()).
    const startAnchor = state.snake[0] || {
      x: Math.floor(GRID.cols / 2),
      y: Math.floor(GRID.rows / 2)
    };
    clearSafeZone(startAnchor.x, startAnchor.y, 3);
  }

  /* ------------------------------------------------------------------
   * Board validation. Randomised wall scattering can box the player in, so
   * after everything is placed we prove the start position has real room to
   * play and carve corridors until it does. Carving draws from the level's
   * own seeded RNG, so a Daily Rift board stays identical for every player.
   * --------------------------------------------------------------- */
  /* A mirrored stage should never be a surprise, so it is called out on the
     board itself as well as in the mission panel. */

  function announceLevelModifiers() {
    if (!state.currentLevel?.mirror) return;
    const head = state.snake[0] || { x: Math.floor(GRID.cols / 2), y: Math.floor(GRID.rows / 2) };
    emit("floating", { text: "◀ Left / right mirrored ▶", x: head.x, y: Math.max(2, head.y - 3), color: "slow", life: 90 });
  }

  function ensurePlayableBoard() {
    clearSpawnArea();

    // Budget scales with the target: reaching 200 open cells from a dense
    // board can need well over a hundred individual carves.
    for (let attempt = 0; attempt < MIN_OPEN_CELLS * 3; attempt++) {
      const region = openRegionFromHead();
      if (region.size >= MIN_OPEN_CELLS) break;
      if (!carveFrontier(region)) break;
    }

    // Placed last so it can only ever land in the validated open region.
    if (state.currentLevel?.boss) {
      spawnBoss(state.currentLevel.boss);
    } else {
      spawnFood();
    }
  }

  // Flood fill of the cells the snake can actually drive to, walls only.
  function openRegionFromHead() {
    const head = state.snake[0] || {
      x: Math.floor(GRID.cols / 2),
      y: Math.floor(GRID.rows / 2)
    };
    const blocked = new Set(state.walls);
    for (const segment of state.snake.slice(1)) blocked.add(key(segment.x, segment.y));

    const visited = new Set([key(head.x, head.y)]);
    const queue = [head];
    const dirs = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];

    while (queue.length) {
      const current = queue.shift();
      for (const dir of dirs) {
        const nx = current.x + dir.x;
        const ny = current.y + dir.y;
        if (!insidePlayableArea(nx, ny)) continue;
        if (inShrinkZone(nx, ny)) continue;
        const tileKey = key(nx, ny);
        if (visited.has(tileKey) || blocked.has(tileKey)) continue;
        visited.add(tileKey);
        queue.push({ x: nx, y: ny });
      }
    }
    return visited;
  }

  // Removes one wall touching the open region, widening it toward the rest of
  // the board. Never touches the outer boundary ring.
  function carveFrontier(region) {
    const dirs = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
    const candidates = [];
    // The boss's shielded core is placed as a single wall cell (see
    // reserveBossCore) and must never be carved open before the fight even
    // starts — the arena is already sized generously enough that carving
    // should rarely be needed on a boss stage at all.
    const protectedCell = state.bossCorePos ? key(state.bossCorePos.x, state.bossCorePos.y) : null;

    for (const tileKey of region) {
      const [x, y] = tileKey.split(":").map(Number);
      for (const dir of dirs) {
        const nx = x + dir.x;
        const ny = y + dir.y;
        if (!insidePlayableArea(nx, ny)) continue;
        const neighbour = key(nx, ny);
        if (neighbour === protectedCell) continue;
        if (state.walls.has(neighbour)) candidates.push(neighbour);
      }
    }

    if (!candidates.length) return false;
    const rng = state.repairRng || state.rng;
    state.walls.delete(candidates[Math.floor(rng() * candidates.length)]);
    return true;
  }

  function clearSafeZone(x, y, radius) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        state.walls.delete(key(x + dx, y + dy));
      }
    }
  }

  function scatterBlocks(count, rng, sizeMin, sizeMax) {
    // Most callers pass these the wrong way round (e.g. 4, 3), which made
    // `sizeMax - sizeMin + 1` zero or negative and pinned every blob to the
    // larger radius. Normalising keeps the level configs honest.
    const lo = Math.max(1, Math.min(sizeMin, sizeMax));
    const hi = Math.max(1, Math.max(sizeMin, sizeMax));
    const attempts = Math.max(0, count) * 8;

    for (let i = 0; i < attempts && count > 0; i++) {
      const x = 2 + Math.floor(rng() * (GRID.cols - 4));
      const y = 2 + Math.floor(rng() * (GRID.rows - 4));
      const size = lo + Math.floor(rng() * (hi - lo + 1));
      for (let dx = -size; dx <= size; dx++) {
        for (let dy = -size; dy <= size; dy++) {
          if (Math.abs(dx) + Math.abs(dy) <= size) {
            state.walls.add(key(x + dx, y + dy));
          }
        }
      }
      count--;
    }
  }

  function spawnPortals(count) {
    for (let i = 0; i < count; i++) {
      const a = randomFreeCell(2);
      const b = randomFreeCell(2, [a]);
      if (a && b) {
        state.portals.push({ a, b, phase: i % 2 });
      }
    }
  }

  // Threats must not materialise on the player's doorstep. Retries a few
  // times for a cell outside the spawn pocket before accepting anything.
  function randomFreeCellAwayFromSpawn(margin, keepOut = 5, rng = null) {
    const cx = Math.floor(GRID.cols / 2);
    const cy = Math.floor(GRID.rows / 2);
    for (let attempt = 0; attempt < 12; attempt++) {
      const cell = randomFreeCell(margin, [], true, true, rng);
      if (!cell) return null;
      if (Math.abs(cell.x - cx) > keepOut || Math.abs(cell.y - cy) > keepOut) return cell;
    }
    return randomFreeCell(margin, [], true, true, rng);
  }

  function spawnHazards(count) {
    for (let i = 0; i < count; i++) {
      const axis = i % 2 === 0 ? "horizontal" : "vertical";
      const pos = randomFreeCellAwayFromSpawn(2);
      if (!pos) continue;
      state.hazards.push({
        type: "drone",
        axis,
        x: pos.x,
        y: pos.y,
        dir: i % 2 === 0 ? 1 : -1,
        speed: 1 + Math.floor(i / 2),
        laneMin: axis === "horizontal" ? 3 + i : 2,
        laneMax: axis === "horizontal" ? GRID.cols - 4 : GRID.rows - 3,
        trail: []
      });
    }
  }

  /* Lays a rival's body out behind its head. The head is always on a free
     cell, but the trailing segments have to be checked too — writing them
     blind is what used to bury rival snakes inside walls. Picks the heading
     that fits the most segments and shortens the body if none fits fully. */

  function buildEnemyBody(pos, preferLeft) {
    const headings = [
      { x: -1, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: -1 },
      { x: 0, y: 1 }
    ];
    if (!preferLeft) headings.reverse();

    let dir = headings[0];
    let body = [{ x: pos.x, y: pos.y }];

    for (const heading of headings) {
      const candidate = [{ x: pos.x, y: pos.y }];
      for (let step = 1; step <= 2; step++) {
        const cell = { x: pos.x - heading.x * step, y: pos.y - heading.y * step };
        if (!insidePlayableArea(cell.x, cell.y)) break;
        if (isBlocked(cell.x, cell.y, false)) break;
        candidate.push(cell);
      }
      if (candidate.length > body.length) {
        body = candidate;
        dir = heading;
      }
      if (body.length === 3) break;
    }

    return { body, dir };
  }

  function spawnEnemies(count) {
    for (let i = 0; i < count; i++) {
      const pos = randomFreeCellAwayFromSpawn(3, 6);
      if (!pos) continue;

      const { body, dir } = buildEnemyBody(pos, i % 2 === 0);

      state.enemySnakes.push({
        id: i,
        body,
        dir,
        // Stored as a palette key, not a literal, so the colourblind toggle
        // recolours rivals that are already on the board.
        colorKey: i % 2 === 0 ? "enemy" : "enemyAlt",
        recharge: 0
      });
    }
  }

  function spawnPowerups(count) {
    const kinds = ["shield", "slow", "bonus"];
    for (let i = 0; i < count; i++) {
      const pos = randomFreeCell(2);
      if (!pos) continue;
      state.powerups.push({
        type: kinds[i % kinds.length],
        x: pos.x,
        y: pos.y,
        life: 30 + i * 6
      });
    }
  }

  /* Food placement relaxes its constraints step by step rather than falling
     back to a fixed cell, which used to be able to drop a core inside a wall
     or inside the shrink dead-zone on crowded late levels. */

  function spawnFood() {
    const avoidPowerups = state.powerups.map((p) => ({ x: p.x, y: p.y }));
    // Reachability is non-negotiable, so every attempt here disables the
    // "any free cell" fallback and we relax the other constraints instead.
    state.food = randomFreeCell(2, avoidPowerups, true, false)
      || randomFreeCell(1, avoidPowerups, true, false)
      || randomFreeCell(1, [], true, false)
      || findAnyOpenCell();

    /* Final guarantee. The attempts above use a deliberately conservative
       flood fill (it treats drones, portals and pickups as walls and ignores
       portal links), and the last-resort findAnyOpenCell will return an
       unreachable cell rather than nothing at all. So whatever came back, the
       core must still be somewhere the player can actually drive to. */
    if (state.food && !foodReachable()) {
      const rescued = pickReachableCell();
      if (rescued) state.food = rescued;
    }
  }

  // Last-ditch scan: every cell that is genuinely legal to stand on, preferring
  // the ones the snake can actually drive to. Returns null only if the board
  // has no legal cell at all, which callers must tolerate.
  function findAnyOpenCell() {
    const occupied = new Set(state.snake.map((s) => key(s.x, s.y)));
    const legal = [];
    for (let x = 1; x < GRID.cols - 1; x++) {
      for (let y = 1; y < GRID.rows - 1; y++) {
        if (occupied.has(key(x, y))) continue;
        if (isBlocked(x, y, true)) continue;
        legal.push({ x, y });
      }
    }
    if (!legal.length) return null;
    const reachable = getReachableCells(1, new Set([...state.walls, ...occupied]));
    const preferred = legal.filter((cell) => reachable.has(key(cell.x, cell.y)));
    const pool = preferred.length ? preferred : legal;
    return pool[Math.floor(state.rng() * pool.length)];
  }

  /* `rng` defaults to the run RNG, which drives the item sequence. Repair and
     relocation code passes state.repairRng instead so that fixing up a board
     never shifts where the next core spawns — two players on the same Daily
     Rift seed must not diverge just because one of them died more often. */

  function randomFreeCell(minMargin = 1, avoid = [], reachableOnly = true, allowUnreachableFallback = true, rng = null) {
    const pick = rng || state.rng;
    const margin = Math.max(minMargin, state.shrinkMargin + 1);
    const blocked = new Set([...state.walls, ...state.snake.map((s) => key(s.x, s.y))]);
    for (const enemy of state.enemySnakes) {
      for (const segment of enemy.body) blocked.add(key(segment.x, segment.y));
    }
    for (const portal of state.portals) {
      blocked.add(key(portal.a.x, portal.a.y));
      blocked.add(key(portal.b.x, portal.b.y));
    }
    for (const p of state.powerups) blocked.add(key(p.x, p.y));
    if (state.food) blocked.add(key(state.food.x, state.food.y));
    for (const h of state.hazards) blocked.add(key(h.x, h.y));
    for (const extra of avoid) {
      if (!extra) continue;
      blocked.add(key(extra.x, extra.y));
    }
    const reachable = reachableOnly ? getReachableCells(margin, blocked) : null;
    const safe = [];
    for (let x = margin; x < GRID.cols - margin; x++) {
      for (let y = margin; y < GRID.rows - margin; y++) {
        const tileKey = key(x, y);
        if (!blocked.has(tileKey) && (!reachable || reachable.has(tileKey))) safe.push({ x, y });
      }
    }
    // Callers that must guarantee reachability (food) opt out of this
    // fallback, which would otherwise hand back a walled-off cell.
    if (!safe.length && reachableOnly && allowUnreachableFallback) {
      for (let x = margin; x < GRID.cols - margin; x++) {
        for (let y = margin; y < GRID.rows - margin; y++) {
          const tileKey = key(x, y);
          if (!blocked.has(tileKey)) safe.push({ x, y });
        }
      }
    }
    if (!safe.length) return null;
    return safe[Math.floor(pick() * safe.length)];
  }

  function getReachableCells(margin, blocked) {
    const start = state.snake[0] || { x: Math.floor(GRID.cols / 2), y: Math.floor(GRID.rows / 2) };
    const queue = [{ x: start.x, y: start.y }];
    const visited = new Set([key(start.x, start.y)]);
    const directions = [
      { x: 1, y: 0 },
      { x: -1, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: -1 }
    ];

    while (queue.length) {
      const current = queue.shift();
      for (const dir of directions) {
        const nx = current.x + dir.x;
        const ny = current.y + dir.y;
        const tileKey = key(nx, ny);
        if (nx < margin || ny < margin || nx >= GRID.cols - margin || ny >= GRID.rows - margin) continue;
        if (visited.has(tileKey) || blocked.has(tileKey)) continue;
        visited.add(tileKey);
        queue.push({ x: nx, y: ny });
      }
    }

    return visited;
  }

  /* ------------------------------------------------------------------
   * Boss encounters
   *
   * Snake has no attack button, so a boss cannot be damaged the way one
   * would be in a genre that has one. It is damaged by the thing snake
   * already does: eating grows you, so eating is the weapon here too, not
   * just a means to an end.
   *
   * The loop: the core is shielded (a single wall cell — the multi-cell
   * structure the player sees is a cosmetic sprite drawn in the renderer,
   * not a hitbox). Charge shards appear; eating BOSS_SHARDS_PER_CYCLE of
   * them grows the snake and opens the shield for a short window. Step onto
   * the exposed core during that window to land a hit; miss the window and
   * it closes, resetting the cycle. Every shard eaten to fuel that window
   * also makes the snake longer, which eats into the room available to
   * dodge whatever the boss throws next — the same action is the reward and
   * the escalating risk, which is not something any button-driven genre's
   * "weapon" can do.
   *
   * Harder bosses do not get new rules, only a tighter exposed window and
   * an attack layered on top that reuses a mechanic the campaign already
   * taught: The Disruptor forces the same mirrored steering as a Hard-tier
   * stage, The Collapse pulses the same shrinking cage as an Extreme-tier
   * stage, and Singularity Prime alternates both while a hunting fragment —
   * an ordinary rival snake — chases throughout. A player who has cleared
   * the campaign has already been taught every individual piece of the
   * final boss; the fight is just all of them at once.
   * --------------------------------------------------------------- */
  const BOSS_DEFS = {
    warden: {
      exposedTicks: 40,
      attack: "none"
    },
    disruptor: {
      exposedTicks: 32,
      attack: "mirror",
      attackCooldown: 18,
      attackTelegraph: 6,
      attackDuration: 14
    },
    collapse: {
      exposedTicks: 26,
      attack: "shrink",
      // Rebalanced: 16/6/12 left the cage compressed for nearly as long as
      // it was open, at 6 moves/sec — barely any room to breathe between
      // pulses. 19/7/9 keeps the pulse itself shorter than the rest between
      // pulses, and the longer telegraph gives more real time to react.
      attackCooldown: 19,
      attackTelegraph: 7,
      attackDuration: 9,
      // Absolute margin during a pulse, not an increment — see beginBossAttack.
      // Boss levels configure shrink:0, so 0 is always the baseline to release
      // back to. The binding safety constraint is the player's own spawn tail
      // at (centre.x - BOSS_ARENA_HALF_SPAN - 2, centre.y), which tolerates a
      // margin of at most 5; 4 leaves a one-cell margin of error on that.
      shrinkTarget: 4
    },
    singularity: {
      // Rebalanced: 22 ticks at 7 moves/sec is ~3.1s to notice the core is
      // open, cross the arena and land the hit — too tight once a rival
      // snake is also loose on the board. 28 gives a genuinely playable
      // window without trivialising the fight.
      exposedTicks: 28,
      attack: "combo",
      // Same cadence rework as Collapse, scaled for the faster tier: more
      // rest between attacks, a shorter active window, longer telegraph.
      // The combo already strictly alternates mirror/shrink one at a time
      // (see updateBoss below) — this only slows the pace, it does not
      // change that a single restriction, never both, is ever active.
      attackCooldown: 23,
      attackTelegraph: 7,
      attackDuration: 9,
      shrinkTarget: 4
    }
  };

  // Reserves the core's cell as a wall before anything else spawns, so
  // portals, drones and powerups (all placed via randomFreeCell, which
  // already avoids state.walls) never land on top of it. Placed at true
  // centre, which is provably the safest possible cell against any shrink
  // pulse: it is farther from every edge than anywhere else on the board.
  function reserveBossCore(level) {
    if (!level.boss) {
      state.bossCorePos = null;
      return;
    }
    const { core } = bossArenaAnchors();
    state.bossCorePos = core;
    state.walls.add(key(core.x, core.y));
  }

  // Finalises the encounter once the board is otherwise validated: builds
  // the state.boss record and spawns the first cycle of charge shards.
  // Takes the place of spawnFood() in ensurePlayableBoard() for boss levels.
  function spawnBoss(bossId) {
    const def = BOSS_DEFS[bossId];
    state.boss = {
      id: bossId,
      def,
      hitsRequired: state.missionGoal,
      hitsTaken: 0,
      phase: "charging",
      core: state.bossCorePos,
      attackCooldown: def.attackCooldown || Infinity,
      attackTelegraphTicks: 0,
      attackActiveTicks: 0,
      attackKind: null,
      exposedTicksLeft: 0
    };
    state.bossCharges = [];
    state.food = null;
    spawnBossCharges(BOSS_SHARDS_PER_CYCLE);
  }

  function spawnBossCharges(count) {
    for (let i = 0; i < count; i++) {
      const avoid = state.bossCharges.map((c) => ({ x: c.x, y: c.y }));
      const pos = randomFreeCell(2, avoid);
      if (!pos) continue;
      state.bossCharges.push({ x: pos.x, y: pos.y });
    }
  }

  // Parallel to collectPowerups: growth and score come from the shard, the
  // overload progress comes from how many are left to clear this cycle.
  function collectBossCharges(x, y) {
    if (!state.boss) return;
    const index = state.bossCharges.findIndex((c) => c.x === x && c.y === y);
    if (index === -1) return;
    state.bossCharges.splice(index, 1);
    state.score += 20 + state.levelIndex * 2;
    state.grow += 2;
    emit("burst", { x, y, color: "bonus" });
    emit("sound", "bossCharge");
    if (state.bossCharges.length === 0) {
      openBossCore();
    }
  }

  function openBossCore() {
    const boss = state.boss;
    if (!boss) return;
    // A clean, focused window: whatever the boss was doing reverts the
    // instant the shield cracks, so landing the hit is never muddied by a
    // lingering mirror flip or a cage still mid-pulse.
    cancelBossAttack();
    boss.phase = "exposed";
    boss.exposedTicksLeft = boss.def.exposedTicks;
    state.walls.delete(key(boss.core.x, boss.core.y));
    state.food = { x: boss.core.x, y: boss.core.y };
    emit("sound", "bossPhaseOpen");
    emit("floating", { text: "CORE EXPOSED", x: boss.core.x, y: boss.core.y - 2, color: "food", life: 40 });
  }

  // Re-shields the core, whether the window closed because it was struck or
  // because the player missed it. hit=false is a real cost for whiffing: the
  // whole three-shard cycle has to be repeated.
  function closeBossCore(hit) {
    const boss = state.boss;
    if (!boss) return;
    boss.phase = "charging";
    state.walls.add(key(boss.core.x, boss.core.y));
    state.food = null;
    if (!hit) {
      emit("floating", { text: "Shield reformed", x: boss.core.x, y: boss.core.y - 2, color: "hazard", life: 34 });
    }
    spawnBossCharges(BOSS_SHARDS_PER_CYCLE);
  }

  // Called from the eating branch of step() when the cell just entered is
  // the boss's exposed core. Growth is deliberately NOT applied here — it
  // already came from the charge shards that opened this window, so a hit
  // is a tag, not a meal.
  function handleBossHit() {
    const boss = state.boss;
    boss.hitsTaken++;
    const multiplier = Math.max(1, state.bonusMultiplier || 1);
    state.score += (150 + state.levelIndex * 10) * multiplier;
    state.bonusMultiplier = 1;
    emit("burst", { x: boss.core.x, y: boss.core.y, color: "bonus" });
    emit("sound", "bossHit");
    emit("shake", { strength: 6, ticks: 10 });
    emit("flash", { color: "#ffffff", ticks: 6 });

    if (boss.hitsTaken >= boss.hitsRequired) {
      boss.phase = "defeated";
      emit("sound", "bossDefeated");
      emit("shake", { strength: 12, ticks: 22 });
      emit("burst", { x: boss.core.x, y: boss.core.y, color: "mint" });
      emit("floating", { text: "CORE DESTROYED", x: boss.core.x, y: boss.core.y - 2, color: "mint", life: 50 });
      // The wall stays down and the fight is over; levelComplete() (driven
      // by the same state.mission check every other level uses) handles the
      // rest immediately after this returns.
    } else {
      closeBossCore(true);
    }
  }

  /* Per-tick boss update: advances the exposed-window countdown and the
     attack cycle. Called once per step(), before movement is resolved, and
     is a complete no-op once the boss is defeated or on non-boss levels. */
  function updateBoss() {
    const boss = state.boss;
    if (!boss || boss.phase === "defeated") return;

    if (boss.phase === "exposed") {
      boss.exposedTicksLeft--;
      if (boss.exposedTicksLeft <= 0) {
        closeBossCore(false);
      }
      return;
    }

    // Attacks only run while the shield is up, and never on the tutorial boss.
    if (boss.def.attack === "none") return;

    if (boss.attackActiveTicks > 0) {
      boss.attackActiveTicks--;
      if (boss.attackActiveTicks === 0) endBossAttack();
      return;
    }

    if (boss.attackTelegraphTicks > 0) {
      boss.attackTelegraphTicks--;
      if (boss.attackTelegraphTicks === 0) beginBossAttack();
      return;
    }

    boss.attackCooldown--;
    if (boss.attackCooldown <= 0) {
      boss.attackCooldown = boss.def.attackCooldown;
      boss.attackTelegraphTicks = boss.def.attackTelegraph;
      const kind = boss.def.attack === "combo"
        ? (boss.attackKind === "mirror" ? "shrink" : "mirror")
        : boss.def.attack;
      boss.attackKind = kind;
      const label = kind === "mirror" ? "◆ Controls flipping ◆" : "▲ Cage compressing ▲";
      /* `life` decays in real animation frames (~1 per 16.7ms) regardless of
         how fast the game itself is ticking, but the telegraph is specified
         in GAME ticks — and a tick is worth less real time on faster tiers.
         A flat multiplier undershot badly at higher speeds: on Singularity
         Prime the 6-tick window is only ~860ms of real time, and the banner
         was vanishing in ~300ms, well before a player could act on it. Sized
         here off the actual step duration, with a buffer so the text is
         still legible for a beat after the window itself opens. */
      const telegraphMs = boss.def.attackTelegraph * (state.stepMs || 200);
      emit("floating", { text: label, x: boss.core.x - BOSS_ARENA_HALF_SPAN, y: boss.core.y - 3, color: "slow", life: telegraphMs / 16.6667 + 20 });
      emit("sound", "bossAttackWarn");
    }
  }

  function beginBossAttack() {
    const boss = state.boss;
    boss.attackActiveTicks = boss.def.attackDuration;
    if (boss.attackKind === "mirror") {
      state.mirror = true;
    } else if (boss.attackKind === "shrink") {
      // Set to an absolute, pre-verified-safe target rather than adding to
      // whatever the margin currently is — additive boosts ratchet upward
      // across repeated pulses with nothing to bring them back down, which
      // is how an earlier version of this reached margin 8 (unsafe for both
      // the core and the player's own spawn tail) and never released.
      if (boss.def.shrinkTarget !== state.shrinkMargin) {
        state.shrinkMargin = boss.def.shrinkTarget;
        onArenaShrunk();
      }
    }
    emit("sound", "bossPhaseOpen");
  }

  function endBossAttack() {
    const boss = state.boss;
    if (boss.attackKind === "mirror") {
      state.mirror = state.currentLevel?.mirror || false;
    } else if (boss.attackKind === "shrink") {
      // Boss levels configure shrink:0, so the cage's resting state is
      // always fully open — there is no passive baseline to fall back to.
      state.shrinkMargin = 0;
    }
  }

  // Forces any in-flight attack to end immediately, used when the core opens
  // and when the player dies mid-fight — neither should leave the arena in a
  // half-reverted state.
  function cancelBossAttack() {
    const boss = state.boss;
    if (!boss) return;
    if (boss.attackActiveTicks > 0) {
      endBossAttack();
    }
    boss.attackActiveTicks = 0;
    boss.attackTelegraphTicks = 0;
  }

  /* How many un-applied turns may be buffered.
   *
   * This used to be a single `nextDir` slot, which dropped real input in two
   * distinct ways at speed (both reproduced against this engine, not
   * theorised):
   *
   *   1. Two turns entered inside one tick coalesced — pressing up then
   *      right quickly left only `right` set, and the up turn simply never
   *      happened.
   *   2. The reverse check compared against `snakeDir`, the direction
   *      currently APPLIED, rather than the last one queued. Moving right,
   *      pressing down-then-left had the left rejected as a reverse, even
   *      though once `down` lands it is an ordinary turn.
   *
   * Both read to a player as "the controls dropped my input", which is
   * exactly the complaint at Nightmare's 7 moves/sec where a tick is 143ms.
   * A depth of 2 covers a genuine quick double-turn (round a corner and
   * immediately again) without letting a mashed key buffer up a long tail of
   * moves the player has since changed their mind about.
   */
  const MAX_QUEUED_TURNS = 2;

  function requestDirection(dirName) {
    if (!state.running || state.paused || state.over || state.won) return;
    const mapping = {
      up: { x: 0, y: -1 },
      down: { x: 0, y: 1 },
      left: { x: -1, y: 0 },
      right: { x: 1, y: 0 }
    };
    let dir = mapping[dirName];
    if (!dir) return;
    /* Mirrored stages swap left and right but leave up and down alone.
       Flipping both axes (the old behaviour) meant every single input had to
       be mentally reversed, which read as unfair rather than interesting. */
    if (state.mirror) {
      // `+ 0` normalises the -0 that negating 0 produces, which would
      // otherwise leak a negative zero into the stored direction.
      dir = { x: -dir.x + 0, y: dir.y };
    }
    if (state.dirQueue.length >= MAX_QUEUED_TURNS) return;

    // Validate against the last turn the player has already asked for, not
    // the one currently applied — that is what makes a chained turn legal.
    const previous = state.dirQueue.length
      ? state.dirQueue[state.dirQueue.length - 1]
      : state.snakeDir;
    const isReverse = previous.x + dir.x === 0 && previous.y + dir.y === 0;
    const isSame = previous.x === dir.x && previous.y === dir.y;
    if (isReverse || isSame) return;

    state.dirQueue.push(dir);
    // Kept in sync so anything reading nextDir (rendering, tests, the debug
    // harness) still sees the turn that will actually be applied next.
    state.nextDir = state.dirQueue[0];
  }


  function step() {
    if (state.paused || state.over || state.won) return;
    const level = state.currentLevel;
    state.tick++;
    state.levelTick++;
    const slowed = state.floatingSlowTicks > 0;
    if (state.floatingSlowTicks > 0) {
      state.floatingSlowTicks--;
    }
    if (state.graceTicks > 0) {
      state.graceTicks--;
    }
    if (state.bonusMultiplier > 1 && state.tick % 2 === 0) {
      state.bonusMultiplier = Math.max(1, state.bonusMultiplier - 1);
    }
    if (state.timerLeft != null) {
      state.timerLeft = Math.max(0, state.timerLeft - state.stepMs / 1000);
      if (state.timerLeft <= 0) {
        loseLife("Time expired");
        return;
      }
    }

    if (level.shrink && state.levelTick % level.shrink === 0) {
      const previous = state.shrinkMargin;
      state.shrinkMargin = Math.min(MAX_SHRINK_MARGIN, state.shrinkMargin + 1);
      if (state.shrinkMargin !== previous) {
        onArenaShrunk();
      }
    }

    movePowerups();
    updateBoss();
    if (state.paused || state.over || state.won) {
      return;
    }

    if (!slowed || state.levelTick % 2 === 0) {
      moveHazards();
      if (state.paused || state.over || state.won) {
        return;
      }
    }

    /* Rivals run on their own clock rather than one move per player step, so
       they can be held a fixed number of steps per second behind the player.
       The accumulator carries the fractional remainder between ticks. */
    if (state.enemySnakes.length) {
      const ratio = (state.currentLevel.rivalMovesPerSec || 1) / (state.currentLevel.movesPerSec || 1);
      state.enemyStepAccumulator += slowed ? ratio * 0.5 : ratio;
      while (state.enemyStepAccumulator >= 1) {
        state.enemyStepAccumulator -= 1;
        moveEnemies();
        if (state.paused || state.over || state.won) {
          return;
        }
      }
    }

    // Consume one buffered turn per step, so a quick double-turn plays back
    // over two ticks instead of the second overwriting the first.
    const appliedDir = state.dirQueue.length ? state.dirQueue.shift() : state.nextDir;
    state.nextDir = state.dirQueue.length ? state.dirQueue[0] : appliedDir;
    state.snakeDir = appliedDir;
    const head = state.snake[0];
    const next = {
      x: head.x + appliedDir.x,
      y: head.y + appliedDir.y
    };

    const eating = !!state.food && next.x === state.food.x && next.y === state.food.y;
    // The tail frees its cell on this same tick unless the snake is growing,
    // so chasing your own tail is legal — it used to be an instant death.
    const willGrow = state.grow > 0 || eating;
    const deathReason = collisionReason(next, willGrow);

    if (deathReason) {
      if (hasShield()) {
        consumeShield();
        emit("burst", { x: next.x, y: next.y, color: "shield" });
        emit("sound", "shieldBreak");
      } else {
        loseLife(deathReason);
        return;
      }
    }

    state.snake.unshift(next);

    // On a boss level, state.food only ever exists during the exposed
    // window and only ever equals the core's position — so eating it here
    // can only mean the core was just struck.
    const isBossHit = eating && !!state.boss;

    if (eating) {
      state.mission++;
      if (isBossHit) {
        handleBossHit();
      } else {
        const multiplier = Math.max(1, state.bonusMultiplier || 1);
        state.score += (12 + state.levelIndex * 3) * multiplier;
        state.grow += 1 + Math.floor(state.levelIndex / 10);
        emit("burst", { x: next.x, y: next.y, color: "food" });
        emit("sound", "eat");
        spawnFood();
        maybeSpawnBonus();
        state.bonusMultiplier = 1;
      }
      if (state.mission >= state.missionGoal) {
        levelComplete();
        return;
      }
    }

    collectPowerups(next.x, next.y);
    collectBossCharges(next.x, next.y);

    if (state.grow > 0) {
      state.grow--;
    } else {
      state.snake.pop();
    }

    const portal = portalAt(next.x, next.y);
    if (portal) {
      teleportSnake(portal, next);
    }

    if (state.levelIndex === LEVELS.length - 1 && state.mission >= state.missionGoal) {
      celebrateVictory();
    }

    /* Safety net, run last so it sees the board as the player will: the snake
       has already moved and possibly eaten. Either of those can seal the core
       into a pocket that cannot be entered — the body pinches a corridor, or a
       replacement core lands across a wall. Checking before the move meant a
       stranded core survived a whole tick before anyone noticed.
       A flood fill over 600 cells is nothing next to a stage that cannot be
       finished.
       Skipped on boss levels: state.food there is the boss's own core, at a
       fixed position by design, and relocating it would break the encounter
       rather than fix anything. The arena is generous enough (see
       bossArenaAnchors) that the only realistic way to wall it off is the
       player coiling their own body around it, which is a self-inflicted
       problem the safety net was never meant to solve. */
    if (state.food && !state.boss && !foodReachable()) {
      relocateFood();
    }

    emit("ui");
  }

  /* The closing edge used to swallow whatever was standing in it. Food caught
     that way became permanently unreachable and the stage turned into an
     unwinnable stall, so everything the edge overtakes is evacuated here. */

  function onArenaShrunk() {
    if (state.food && inShrinkZone(state.food.x, state.food.y)) {
      spawnFood();
    }

    // Pickups are simply lost — they are optional and time-limited anyway.
    state.powerups = state.powerups.filter((item) => !inShrinkZone(item.x, item.y));

    for (const hazard of state.hazards) {
      if (!inShrinkZone(hazard.x, hazard.y)) continue;
      const spot = randomFreeCell(state.shrinkMargin + 1, [], true, true, state.repairRng);
      if (spot) {
        hazard.x = spot.x;
        hazard.y = spot.y;
      }
      // Keep patrol bounds inside the surviving arena.
      hazard.laneMin = Math.max(hazard.laneMin, state.shrinkMargin + 1);
      const limit = hazard.axis === "horizontal" ? GRID.cols : GRID.rows;
      hazard.laneMax = Math.min(hazard.laneMax, limit - 2 - state.shrinkMargin);
      if (hazard.laneMax < hazard.laneMin) {
        hazard.laneMax = hazard.laneMin;
      }
    }

    for (const enemy of state.enemySnakes) {
      if (!enemy.body.some((seg) => inShrinkZone(seg.x, seg.y))) continue;
      const spot = randomFreeCell(state.shrinkMargin + 1, [], true, true, state.repairRng);
      if (!spot) {
        // Nowhere left to put it; retire the rival rather than strand it.
        enemy.body = [];
        continue;
      }
      const rebuilt = buildEnemyBody(spot, (enemy.dir?.x ?? -1) < 0);
      enemy.body = rebuilt.body;
      enemy.dir = rebuilt.dir;
    }
    state.enemySnakes = state.enemySnakes.filter((enemy) => enemy.body.length > 0);
  }

  /* Can the player still get to the core?
   *
   * Only permanent obstacles count: walls, the snake's own body and the closed
   * border. Drones and rivals are deliberately NOT treated as blockers — they
   * move on, and counting them would relocate the core every time one happened
   * to sit in a corridor, which reads as the core teleporting for no reason.
   *
   * Portals are counted as connections, so a pocket served only by a portal is
   * correctly considered reachable. */
  function foodReachable() {
    if (!state.food) return true;
    const reachable = reachableCellsFromHead();
    return reachable === null || reachable.has(key(state.food.x, state.food.y));
  }

  function reachableCellsFromHead() {
    const head = state.snake[0];
    if (!head) return null;

    const blocked = new Set(state.walls);
    for (const segment of state.snake.slice(1)) blocked.add(key(segment.x, segment.y));

    const links = new Map();
    for (const portal of state.portals) {
      links.set(key(portal.a.x, portal.a.y), portal.b);
      links.set(key(portal.b.x, portal.b.y), portal.a);
    }

    const seen = new Set([key(head.x, head.y)]);
    const queue = [head];
    const dirs = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];

    const visit = (cell) => {
      const tileKey = key(cell.x, cell.y);
      if (seen.has(tileKey) || blocked.has(tileKey)) return;
      if (!insidePlayableArea(cell.x, cell.y)) return;
      if (inShrinkZone(cell.x, cell.y)) return;
      seen.add(tileKey);
      queue.push(cell);
      const twin = links.get(tileKey);
      if (twin) visit(twin);
    };

    while (queue.length) {
      const current = queue.shift();
      for (const dir of dirs) visit({ x: current.x + dir.x, y: current.y + dir.y });
    }

    return seen;
  }

  // A legal, currently-reachable cell, or null if the snake is boxed in.
  function pickReachableCell() {
    const reachable = reachableCellsFromHead();
    if (!reachable) return null;
    const occupied = new Set(state.snake.map((s) => key(s.x, s.y)));
    const pool = [];
    for (const tileKey of reachable) {
      if (occupied.has(tileKey)) continue;
      const [x, y] = tileKey.split(":").map(Number);
      if (isBlocked(x, y, true)) continue;
      pool.push({ x, y });
    }
    if (!pool.length) return null;
    return pool[Math.floor(state.rng() * pool.length)];
  }

  /* Moves a stranded core somewhere the player can actually get to. Announced
     so it does not look like the core randomly teleported. */
  function relocateFood() {
    const previous = state.food;
    spawnFood();
    if (state.food && previous && (state.food.x !== previous.x || state.food.y !== previous.y)) {
      emit("burst", { x: state.food.x, y: state.food.y, color: "food" });
      emit("floating", {
        text: "Core moved",
        x: state.food.x,
        y: state.food.y,
        color: "food",
        life: 30
      });
    }
  }

  function movePowerups() {
    for (let i = state.powerups.length - 1; i >= 0; i--) {
      const item = state.powerups[i];
      item.life--;
      if (item.life <= 0) {
        state.powerups.splice(i, 1);
      }
    }
  }

  function maybeSpawnBonus() {
    const roll = state.currentLevel.rng();
    const chance = Math.max(0.15, 0.42 - state.levelIndex * 0.01);
    if (roll < chance && state.powerups.length < 2) {
      const pos = randomFreeCell(2);
      if (!pos) return;
      const kinds = ["shield", "slow", "bonus"];
      state.powerups.push({
        type: kinds[Math.floor(state.currentLevel.rng() * kinds.length)],
        x: pos.x,
        y: pos.y,
        life: 32
      });
    }
  }

  function collectPowerups(x, y) {
    for (let i = state.powerups.length - 1; i >= 0; i--) {
      const item = state.powerups[i];
      if (item.x === x && item.y === y) {
        if (item.type === "shield") {
          state.score += 10;
          emit("floating", { text: "Shield", x, y, color: "shield", life: 26 });
          emit("burst", { x: x, y: y, color: "shield" });
          emit("sound", "shield");
          state.shield = 1;
        } else if (item.type === "slow") {
          state.score += 14;
          emit("floating", { text: "Warp", x, y, color: "slow", life: 26 });
          emit("burst", { x: x, y: y, color: "slow" });
          emit("sound", "slow");
          state.floatingSlowTicks = 20;
        } else if (item.type === "bonus") {
          state.score += 24;
          emit("floating", { text: "Combo", x, y, color: "bonus", life: 26 });
          emit("burst", { x: x, y: y, color: "bonus" });
          emit("sound", "bonus");
          state.bonusMultiplier = 2;
        }
        state.powerups.splice(i, 1);
      }
    }
  }

  function moveHazards() {
    for (const hazard of state.hazards) {
      if (hazard.axis === "horizontal") {
        if (state.levelTick % hazard.speed === 0) {
          hazard.x += hazard.dir;
          if (hazard.x <= hazard.laneMin || hazard.x >= hazard.laneMax) {
            hazard.dir *= -1;
          }
        }
      } else {
        if (state.levelTick % hazard.speed === 0) {
          hazard.y += hazard.dir;
          if (hazard.y <= hazard.laneMin || hazard.y >= hazard.laneMax) {
            hazard.dir *= -1;
          }
        }
      }
      if (isInvulnerable()) continue;
      if (state.snake.some((segment) => segment.x === hazard.x && segment.y === hazard.y)) {
        if (hasShield()) {
          consumeShield();
          emit("sound", "shieldBreak");
        } else {
          loseLife("A drone clipped your snake");
          return;
        }
      }
    }
  }

  function moveEnemies() {
    // Enemies that have been whittled away by shield hits are retired here so
    // the movement loop never dereferences an empty body.
    state.enemySnakes = state.enemySnakes.filter((enemy) => enemy.body.length > 0);
    for (const enemy of state.enemySnakes) {
      const head = enemy.body[0];
      const options = [
        { x: 1, y: 0 },
        { x: -1, y: 0 },
        { x: 0, y: 1 },
        { x: 0, y: -1 }
      ];
      const scored = options
        .map((dir) => {
          const next = { x: head.x + dir.x, y: head.y + dir.y };
          const dist = Math.abs(next.x - state.snake[0].x) + Math.abs(next.y - state.snake[0].y);
          const blocked = isBlocked(next.x, next.y, true) || (dir.x === -enemy.dir.x && dir.y === -enemy.dir.y);
          return { dir, next, dist, blocked };
        })
        .filter((choice) => !choice.blocked)
        .sort((a, b) => a.dist - b.dist);
      const picked = scored[0] || {
        dir: enemy.dir,
        next: { x: head.x + enemy.dir.x, y: head.y + enemy.dir.y }
      };
      enemy.dir = picked.dir;
      enemy.body.unshift(picked.next);
      enemy.body.pop();

      // Snapshot before testing: a shield hit shortens the rival, and mutating
      // the array we are iterating used to skip segments.
      const segments = enemy.body.slice();
      const overlaps = !isInvulnerable() && segments.some((segment) =>
        state.snake.some((s) => s.x === segment.x && s.y === segment.y));

      if (overlaps) {
        if (hasShield()) {
          consumeShield();
          emit("sound", "shieldBreak");
          enemy.body = enemy.body.slice(1);
          emit("burst", { x: head.x, y: head.y, color: "shield" });
        } else {
          loseLife("A rival snake caught you");
          return;
        }
      }
    }

    state.enemySnakes = state.enemySnakes.filter((enemy) => enemy.body.length > 0);
  }

  function portalAt(x, y) {
    for (const portal of state.portals) {
      if (portal.a.x === x && portal.a.y === y) return { portal, side: "a" };
      if (portal.b.x === x && portal.b.y === y) return { portal, side: "b" };
    }
    return null;
  }

  function teleportSnake(found, entryPos) {
    const other = found.side === "a" ? found.portal.b : found.portal.a;
    const delta = {
      x: other.x - entryPos.x,
      y: other.y - entryPos.y
    };
    state.snake = state.snake.map((seg) => ({
      x: clamp(seg.x + delta.x, 1, GRID.cols - 2),
      y: clamp(seg.y + delta.y, 1, GRID.rows - 2)
    }));
    emit("burst", { x: other.x, y: other.y, color: found.side === "a" ? "portalA" : "portalB" });
    emit("sound", "portal");
  }

  function hasShield() {
    return state.shield > 0;
  }

  function isInvulnerable() {
    return (state.graceTicks || 0) > 0;
  }

  function consumeShield() {
    state.shield = Math.max(0, (state.shield || 0) - 1);
    emit("floating", { text: "Shield used", x: state.snake[0].x, y: state.snake[0].y, color: "shield", life: 30 });
  }

  function hitsSelf(head) {
    for (let i = 1; i < state.snake.length; i++) {
      if (state.snake[i].x === head.x && state.snake[i].y === head.y) return true;
    }
    return false;
  }

  /* Single source of truth for "why did the player just die". Returns the
     message to show, or null when the cell is safe to enter. */

  function collisionReason(cell, willGrow) {
    if (!insidePlayableArea(cell.x, cell.y)) return "You hit the outer wall";
    if (state.walls.has(key(cell.x, cell.y))) {
      // Only reachable when the shield is actually up: openBossCore() removes
      // the core from state.walls for the exposed window, so this can never
      // fire on the one tick it would be wrong to.
      if (state.boss && cell.x === state.boss.core.x && cell.y === state.boss.core.y) {
        return "The shielded core repels you — it is not open yet";
      }
      return "You hit an obstacle";
    }
    if (inShrinkZone(cell.x, cell.y)) return "The closing edge caught you";

    // Terrain still kills during the respawn grace window; moving threats do not.
    if (!isInvulnerable()) {
      for (const hazard of state.hazards) {
        if (hazard.x === cell.x && hazard.y === cell.y) return "A drone clipped your snake";
      }
      for (const enemy of state.enemySnakes) {
        for (const segment of enemy.body) {
          if (segment.x === cell.x && segment.y === cell.y) return "A rival snake caught you";
        }
      }
    }
    const tailIndex = state.snake.length - 1;
    for (let i = 0; i < state.snake.length; i++) {
      if (!willGrow && i === tailIndex) continue;
      const segment = state.snake[i];
      if (segment.x === cell.x && segment.y === cell.y) return "You crossed your own body";
    }
    return null;
  }

  function inShrinkZone(x, y) {
    const margin = state.shrinkMargin;
    if (margin <= 0) return false;
    return x <= margin || x >= GRID.cols - 1 - margin || y <= margin || y >= GRID.rows - 1 - margin;
  }

  function isBlocked(x, y, ignoreActors) {
    if (!insidePlayableArea(x, y)) return true;
    if (state.walls.has(key(x, y))) return true;
    if (inShrinkZone(x, y)) return true;
    for (const hazard of state.hazards) {
      if (hazard.x === x && hazard.y === y) return true;
    }
    if (!ignoreActors) {
      for (const segment of state.snake) {
        if (segment.x === x && segment.y === y) return true;
      }
      for (const enemy of state.enemySnakes) {
        for (const segment of enemy.body) {
          if (segment.x === x && segment.y === y) return true;
        }
      }
    }
    return false;
  }

  function insidePlayableArea(x, y) {
    return x >= 1 && x < GRID.cols - 1 && y >= 1 && y < GRID.rows - 1;
  }



  function levelComplete() {
    state.score += state.missionClearBonus;
    state.bestLevel = Math.max(state.bestLevel, state.levelIndex + 2);
    const clearedCount = state.levelIndex + 1;
    emit("levelCleared", { levelIndex: state.levelIndex, score: state.score });

    if (clearedCount >= LEVELS.length) {
      celebrateVictory();
      return;
    }

    state.message = `${state.currentLevel.name} cleared. Next level loading.`;
    emit("burst", { x: state.snake[0].x, y: state.snake[0].y, color: "mint" });
    emit("sound", "levelUp");

    // An extra life every few levels keeps the back half of the ladder from
    // being decided entirely by mistakes made early on.
    if (clearedCount % CHECKPOINT_EVERY === 0 && state.lives < MAX_LIVES) {
      state.lives++;
      emit("floating", {
        text: "+1 Life",
        x: state.snake[0].x,
        y: state.snake[0].y,
        color: "mint",
        life: 36
      });
      emit("sound", "life");
    }

    emit("save");
    loadLevel(state.levelIndex + 1);
  }

  function celebrateVictory() {
    state.won = true;
    state.running = false;
    state.paused = false;
    state.bestCampaign = Math.max(state.bestCampaign, state.score);
    if (state.mode === "daily") {
      state.bestDaily = Math.max(state.bestDaily, state.score);
    }
    emit("sound", "victory");
    emit("save");
    emit("victory", { score: state.score, levelReached: LEVELS.length });
    emit("ui");
  }

  function loseLife(reason) {
    state.lives -= 1;
    state.message = reason;
    emit("burst", { x: state.snake[0].x, y: state.snake[0].y, color: "red" });
    emit("sound", "hit");
    if (state.lives > 0) {
      respawnCurrentLevel();
      state.paused = true;
      emit("save");
      emit("lifeLost", { reason, lives: state.lives });
      emit("ui");
      return;
    }
    gameOver(reason);
  }

  function gameOver(reason) {
    state.over = true;
    state.running = false;
    state.paused = false;
    state.bestCampaign = Math.max(state.bestCampaign, state.score);
    if (state.mode === "daily") {
      state.bestDaily = Math.max(state.bestDaily, state.score);
    }
    emit("sound", "gameOver");
    emit("save");
    emit("gameOver", {
      reason,
      score: state.score,
      levelReached: state.levelIndex + 1,
      checkpoint: state.checkpoint
    });
    emit("ui");
  }


  function respawnCurrentLevel() {
    state.snake = buildSnakeStart();
    state.snakeDir = { x: 1, y: 0 };
    state.nextDir = { x: 1, y: 0 };
    state.dirQueue.length = 0;
    state.grow = 0;
    state.shield = 0;
    state.floatingSlowTicks = 0;
    state.bonusMultiplier = 1;
    state.accumulator = 0;
    emit("clearEffects");
    clearSpawnArea();

    /* A mid-fight death always hands back a clean, fully-charged cycle:
       cancel whatever attack was active (nobody should respawn with controls
       still flipped from a life they already lost), and if the core happened
       to be open, close it and deal a fresh set of shards rather than resume
       a window that may be mostly spent. hitsTaken is untouched — dying does
       not undo damage already landed on the boss, same as normal levels never
       take back cores already collected on a death. */
    if (state.boss && state.boss.phase !== "defeated") {
      cancelBossAttack();
      if (state.boss.phase === "exposed") {
        closeBossCore(false);
      }
    }

    /* Re-validate the core against the new spawn position. Respawning moves
       the snake right across the board, so a core that was reachable from
       wherever it died may be sealed off from the centre — and if the player
       died *because* they were boxed in, the core was very likely relocated
       into that same pocket moments earlier. Without this the stage can come
       back unwinnable. Skipped on boss levels for the same reason step()
       skips it: the core's position is fixed by design, not relocatable. */
    if (state.food && !state.boss && !foodReachable()) {
      relocateFood();
    }

    // Brief invulnerability, otherwise a drone or rival parked on the spawn
    // point kills the player again the instant they come back.
    state.graceTicks = 14;
  }

  // Move anything lethal out of the respawn pocket so the player always gets
  // a fair moment to react.
  function clearSpawnArea() {
    // Anchored on wherever the snake actually is, not assumed true-centre —
    // boss stages spawn the player off-centre (see bossArenaAnchors()), and
    // state.snake is always set by buildSnakeStart() before this runs.
    const anchor = state.snake[0] || {
      x: Math.floor(GRID.cols / 2),
      y: Math.floor(GRID.rows / 2)
    };
    const cx = anchor.x;
    const cy = anchor.y;
    const radius = 3;
    const nearSpawn = (x, y) => Math.abs(x - cx) <= radius && Math.abs(y - cy) <= radius;

    for (const hazard of state.hazards) {
      if (!nearSpawn(hazard.x, hazard.y)) continue;
      const spot = randomFreeCell(2, [], true, true, state.repairRng);
      if (spot) {
        hazard.x = spot.x;
        hazard.y = spot.y;
      }
    }

    for (const enemy of state.enemySnakes) {
      if (!enemy.body.some((seg) => nearSpawn(seg.x, seg.y))) continue;
      const spot = randomFreeCellAwayFromSpawn(3, radius + 2, state.repairRng);
      if (!spot) continue;
      const rebuilt = buildEnemyBody(spot, (enemy.dir?.x ?? -1) < 0);
      enemy.body = rebuilt.body;
      enemy.dir = rebuilt.dir;
    }
  }

  /* Purely cosmetic, so this deliberately uses Math.random rather than the
     seeded RNG. Drawing particles from state.rng would let the number of
     visual effects shift where food spawns, which would make two players on
     the same Daily Rift seed diverge. */

  function insidePlayfield(x, y) {
    return x >= 0 && y >= 0 && x < GRID.cols && y < GRID.rows;
  }



  function resetRun() {
    state.score = 0;
    state.lives = 3;
    state.levelIndex = 0;
    state.accumulator = 0;
    state.tick = 0;
    state.running = true;
    state.over = false;
    state.won = false;
    emit("clearEffects");
    state.checkpoint = null;
    reseedRun();
    loadLevel(state.runStartLevel || 0);
  }

  function reseedRun() {
    if (state.mode === "daily") {
      prepareDailySeed();
      state.rng = mulberry32(hashSeed(state.seed));
    } else {
      state.seed = "campaign";
      state.rng = mulberry32(1);
    }
  }

  /* Checkpoints land on every 5th level. Losing your last life rewinds to the
     most recent one instead of throwing away a 25-level run. */

  function isCheckpointLevel(levelIndex) {
    // The level a run starts on always counts, so a practice run that begins
    // mid-ladder still has somewhere to fall back to.
    return levelIndex % CHECKPOINT_EVERY === 0 || levelIndex === state.runStartLevel;
  }

  function captureCheckpoint(levelIndex) {
    if (!isCheckpointLevel(levelIndex)) return;
    state.checkpoint = {
      level: levelIndex,
      score: state.score,
      lives: state.lives,
      mode: state.mode,
      seed: state.seed
    };
    if (levelIndex > 0) {
      emit("floating", { text: "Checkpoint", x: state.snake[0]?.x ?? Math.floor(GRID.cols / 2), y: state.snake[0]?.y ?? Math.floor(GRID.rows / 2), color: "mint", life: 34 });
      emit("save");
    }
  }

  // Offers whichever checkpoint is further along: the one from this run, or
  // one carried over from a previous session.
  function bestCheckpoint() {
    const candidates = [state.checkpoint, state.savedCheckpoint]
      .filter((cp) => cp && typeof cp.level === "number");
    if (!candidates.length) return null;
    return candidates.reduce((best, cp) => (cp.level > best.level ? cp : best));
  }

  /* A leftover from the original module split touched seedLabel/challengeCode
     DOM elements directly here, which do not exist in this module's scope —
     engine.js and main.js are separate closures. That crashed the instant a
     real player picked Daily Rift and hit Start ("seedLabel is not defined"),
     invisibly, because every test and debug helper sets state.seed directly
     and never calls this function. The label already updates correctly on its
     own: loadLevel() emits "ui" right after this runs, and main.js's
     updateHUD() reads state.seed from there. */
  function prepareDailySeed() {
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    state.seed = `daily-${stamp}`;
  }

  return {
    state,
    loadLevel,
    step,
    requestDirection,
    resetRun,
    reseedRun,
    prepareDailySeed,
    bestCheckpoint,
    captureCheckpoint,
    // Exposed for the audit harness and for tooling.
    isBlocked,
    inShrinkZone,
    insidePlayableArea,
    insidePlayfield,
    getReachableCells,
    collisionReason,
    spawnFood,
    foodReachable,
    hasShield,
    isInvulnerable
  };
}
