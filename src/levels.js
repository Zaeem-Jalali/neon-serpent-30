/* Level and tier data. Pure data plus the helpers that derive speed from a
 * tier — no browser APIs, so this is importable from Node and from the server.
 */

export const GRID = { cols: 30, rows: 20 };
export const CHECKPOINT_EVERY = 5;
export const MAX_LIVES = 5;
/* Minimum number of cells the player must be able to reach from the spawn
 * point before a generated board is accepted as playable.
 *
 * This was 60, which only prevented "unwinnable" — it happily allowed closets.
 * Measured boards were coming out at 86 reachable cells out of 600 (level 27)
 * and 92 (level 30), which is not a level so much as a corridor. 200 leaves
 * room to actually manoeuvre. */
export const MIN_OPEN_CELLS = 200;

/* How far the closing arena may ever advance from each edge.
 *
 * This was effectively 6, which collapsed the board to 16x6 = 96 cells with
 * the walls still inside it. Level 30 reached that floor 5 seconds into a
 * 40-second stage and then asked for 10 cores. A cap of 3 leaves 22x12 = 264
 * cells, which is tight without being arithmetically impossible. */
export const MAX_SHRINK_MARGIN = 3;

// Rivals always move this many steps per second slower than the player.
export const RIVAL_SPEED_DELTA = 2;

/* How many charge shards must be eaten before a boss's shielded core opens.
 * Constant across all four bosses on purpose: the encounter's rhythm should
 * be something a player recognises immediately in the second boss because
 * they learned it in the first. Difficulty escalates through the exposed
 * window shrinking and the attacks layered on top, not through relearning
 * the core loop each time. */
export const BOSS_SHARDS_PER_CYCLE = 3;

/* Player and core sit on opposite sides of the arena's centre line, far
 * enough apart that neither the spawn-clearing radius nor a shrink-pulse
 * attack can ever reach the other. See BOSS_DEFS in engine.js for the rest
 * of each encounter's tuning (exposed window, attack cadence). */
export const BOSS_ARENA_HALF_SPAN = 7;

export const LEVELS = [
  // --- Easy (4 moves/sec) ---
  { name: "Spark Start", desc: "Warm-up with a soft pace and a few anchored blocks.", target: 3, layout: "open", walls: 4, hazards: 0, enemies: 0, portals: 0, powerups: 1, timer: null, mirror: false, shrink: 0 },
  { name: "Neon Drift", desc: "A bright open lane with light obstacles and no boxed-in sections.", target: 4, layout: "boulevard", walls: 8, hazards: 0, enemies: 0, portals: 0, powerups: 1, timer: null, mirror: false, shrink: 0 },
  { name: "Byte Bloom", desc: "Lane walls appear and force cleaner turns.", target: 4, layout: "lanes", walls: 5, hazards: 0, enemies: 0, portals: 0, powerups: 1, timer: null, mirror: false, shrink: 0 },
  { name: "Prism Path", desc: "Cross-pattern walls create more dead ends.", target: 4, layout: "cross", walls: 4, hazards: 0, enemies: 0, portals: 0, powerups: 1, timer: null, mirror: false, shrink: 0 },
  { name: "Circuit Chase", desc: "Ring walls begin to squeeze the board.", target: 5, layout: "rings", walls: 5, hazards: 0, enemies: 0, portals: 0, powerups: 1, timer: null, mirror: false, shrink: 0 },
  { name: "Glitch Garden", desc: "The first drone enters. Watch the lanes.", target: 5, layout: "maze", walls: 8, hazards: 1, enemies: 0, portals: 0, powerups: 1, timer: null, mirror: false, shrink: 0 },
  { name: "Pulse Corridor", desc: "The maze tightens while the drone keeps patrolling.", target: 5, layout: "lanes", walls: 10, hazards: 1, enemies: 0, portals: 0, powerups: 1, timer: null, mirror: false, shrink: 0 },
  { name: "The Warden", desc: "A shielded core blocks the way. Feed it charge shards, then strike the instant it cracks open.", target: 2, layout: "boss", walls: 8, hazards: 0, enemies: 0, portals: 0, powerups: 0, timer: null, mirror: false, shrink: 0, boss: "warden" },

  // --- Hard (5 moves/sec) ---
  { name: "Laser Loop", desc: "Portals join the mix and make route planning matter.", target: 6, layout: "rings", walls: 12, hazards: 1, enemies: 0, portals: 1, powerups: 1, timer: null, mirror: false, shrink: 0 },
  { name: "Swap Storm", desc: "Left and right are mirrored. Up and down still behave.", target: 6, layout: "chaos", walls: 10, hazards: 1, enemies: 0, portals: 1, powerups: 1, timer: 80, mirror: true, shrink: 0 },
  { name: "Cyber Garden", desc: "A tighter maze and a countdown that keeps you moving.", target: 6, layout: "maze", walls: 12, hazards: 1, enemies: 0, portals: 0, powerups: 1, timer: 75, mirror: false, shrink: 0 },
  { name: "Bluewire Bend", desc: "Two drones and a narrower set of lanes.", target: 6, layout: "cross", walls: 12, hazards: 2, enemies: 0, portals: 0, powerups: 1, timer: 75, mirror: false, shrink: 0 },
  { name: "Quantum Walk", desc: "Portals and drones turn every route into a puzzle.", target: 6, layout: "labyrinth", walls: 14, hazards: 2, enemies: 0, portals: 1, powerups: 1, timer: 72, mirror: false, shrink: 0 },
  { name: "Neon Relay", desc: "Two drones patrol a fortress with narrow gates.", target: 6, layout: "fortress", walls: 14, hazards: 2, enemies: 0, portals: 1, powerups: 1, timer: 72, mirror: false, shrink: 0 },
  { name: "Signal Rift", desc: "Mirrored routes and a stricter clock.", target: 7, layout: "mirror", walls: 14, hazards: 2, enemies: 0, portals: 1, powerups: 1, timer: 70, mirror: false, shrink: 0 },
  { name: "The Disruptor", desc: "Same shielded core — except it flips your steering mid-fight, without warning twice.", target: 3, layout: "boss", walls: 10, hazards: 1, enemies: 0, portals: 0, powerups: 0, timer: null, mirror: false, shrink: 0, boss: "disruptor" },

  /* --- Extreme (6 moves/sec) ---
     Rebalanced: wall counts roughly halved, drone counts cut, timers loosened
     and the shrink slowed. The old numbers left several boards under 120
     reachable cells before the arena even started closing. */
  { name: "Chrome Canal", desc: "Longer runs with a stricter countdown.", target: 6, layout: "lanes", walls: 12, hazards: 2, enemies: 0, portals: 1, powerups: 1, timer: 70, mirror: false, shrink: 0 },
  { name: "Prism Panic", desc: "Ring lanes that reward planning your exit early.", target: 6, layout: "rings", walls: 12, hazards: 2, enemies: 0, portals: 1, powerups: 1, timer: 70, mirror: false, shrink: 0 },
  { name: "Static Siege", desc: "Scattered cover and drones on patrol.", target: 6, layout: "chaos", walls: 9, hazards: 2, enemies: 0, portals: 1, powerups: 1, timer: 68, mirror: false, shrink: 0 },
  { name: "Inversion", desc: "Mirrored steering returns, on a cleaner board.", target: 6, layout: "labyrinth", walls: 12, hazards: 2, enemies: 0, portals: 1, powerups: 1, timer: 68, mirror: true, shrink: 0 },
  { name: "Data Dunes", desc: "The outer edge starts closing in over time.", target: 7, layout: "fortress", walls: 12, hazards: 2, enemies: 0, portals: 1, powerups: 1, timer: 68, mirror: false, shrink: 88 },
  { name: "Turbo Tangle", desc: "The arena shrinks while the drones keep patrolling.", target: 7, layout: "maze", walls: 12, hazards: 3, enemies: 0, portals: 1, powerups: 1, timer: 66, mirror: false, shrink: 86 },
  { name: "Omega Orbit", desc: "Ring barriers, a double portal set, and steady timing.", target: 7, layout: "rings", walls: 14, hazards: 3, enemies: 0, portals: 2, powerups: 1, timer: 66, mirror: false, shrink: 86 },
  { name: "The Collapse", desc: "The core is guarded by a cage that breathes — compressing on its own rhythm, not a steady march.", target: 4, layout: "boss", walls: 10, hazards: 2, enemies: 0, portals: 1, powerups: 1, timer: null, mirror: false, shrink: 0, boss: "collapse" },

  /* --- Nightmare (7 moves/sec, one rival snake) ---
     The pressure here should come from speed and the single hunter, not from
     burying the board in walls and drones. */
  { name: "Synth Spiral", desc: "A rival snake arrives. It moves slower than you — use that.", target: 7, layout: "spiral", walls: 14, hazards: 3, enemies: 1, portals: 2, powerups: 1, timer: 62, mirror: false, shrink: 94 },
  { name: "Neon Nexus", desc: "One rival, patrolling drones, and a shrinking safe zone.", target: 7, layout: "fortress", walls: 14, hazards: 3, enemies: 1, portals: 2, powerups: 1, timer: 62, mirror: false, shrink: 92 },
  { name: "Corrupt Core", desc: "Open ground, but the edges are closing and nothing is idle.", target: 8, layout: "chaos", walls: 9, hazards: 4, enemies: 1, portals: 2, powerups: 1, timer: 62, mirror: false, shrink: 92 },
  { name: "Overclock", desc: "Narrow lanes, hard turns, and a rival cutting you off.", target: 8, layout: "maze", walls: 16, hazards: 4, enemies: 1, portals: 2, powerups: 1, timer: 60, mirror: false, shrink: 90 },
  { name: "Final Grid", desc: "Every system at once, on ground you can still read.", target: 8, layout: "rings", walls: 16, hazards: 4, enemies: 1, portals: 2, powerups: 1, timer: 60, mirror: false, shrink: 90 },
  { name: "Singularity Prime", desc: "Everything you have learned, at once: a shielded core, a compressing cage, flipped steering, and a fragment that hunts you while you work.", target: 5, layout: "boss", walls: 12, hazards: 2, enemies: 1, portals: 2, powerups: 1, timer: null, mirror: false, shrink: 0, boss: "singularity" }
];

/* Difficulty tiers. The boundaries follow where the game actually changes
   shape: drones arrive by 6, portals and timers by 10, the arena starts
   closing at 21, and each tier ends with a boss guarding the way to the next
   one. */

export const TIERS = [
  {
    id: "easy",
    name: "Easy",
    from: 0,
    to: 7,
    movesPerSec: 4,
    blurb: "A steady 4 moves per second the whole way. Learn the board: simple layouts, then the first drone — and a boss to close it out."
  },
  {
    id: "hard",
    name: "Hard",
    from: 8,
    to: 15,
    movesPerSec: 5,
    blurb: "A steady 5 moves per second. Portals, stage timers, drone pairs, one stage with mirrored steering, and a boss that flips your controls without asking."
  },
  {
    id: "super",
    name: "Extreme",
    from: 16,
    to: 23,
    movesPerSec: 6,
    blurb: "A steady 6 moves per second. Drone packs, tight countdowns, from level 21 the arena starts closing in, and a boss whose cage breathes on its own rhythm."
  },
  {
    id: "promax",
    name: "Nightmare",
    from: 24,
    to: 29,
    movesPerSec: 7,
    blurb: "A steady 7 moves per second, and the only tier with a rival snake — a single hunter, moving 2 steps per second slower than you. Ends with everything the campaign taught you, at once."
  }
];


export function tierForLevel(levelIndex) {
  return TIERS.find((tier) => levelIndex >= tier.from && levelIndex <= tier.to) || TIERS[0];
}

export function playerMovesPerSec(levelIndex) {
  return tierForLevel(levelIndex).movesPerSec;
}

export function rivalMovesPerSec(levelIndex) {
  return Math.max(1, playerMovesPerSec(levelIndex) - RIVAL_SPEED_DELTA);
}

