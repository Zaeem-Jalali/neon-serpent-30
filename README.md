# Neon Serpent 30

A modern, deliberately hard snake game: 30 handcrafted levels with drones, portals,
rival snakes, shrinking arenas, inverted controls and stage timers.

No build step, no dependencies — plain HTML, CSS and JavaScript.

## Run

Open `index.html` directly in a browser for the single-player game.

To also get the shared leaderboard:

```bash
node server.js
```

Then visit <http://127.0.0.1:4173>. Without the server the game is fully playable;
the leaderboard panel just reports that it is offline.

## Controls

| Input | Action |
| --- | --- |
| Arrow keys / WASD | Steer |
| Swipe on the board | Steer (touch devices) |
| On-screen D-pad | Steer |
| Space or `P` | Pause / resume |
| `R` | Restart |
| `L` | Open / close level select |
| `Esc` | Close level select |
| `M` | Mute / unmute |
| `C` | Toggle the colourblind-safe palette |

## Difficulty tiers

Speed is a property of the tier, held constant across every level in it, so
difficulty comes from the layout, drones, portals, timers and the closing arena
rather than from a tempo that creeps up level by level.

| Tier | Levels | Speed | What arrives |
| --- | --- | --- | --- |
| Easy | 1–8 | 4 moves/sec | Simple layouts, then the first drone and portal pair |
| Hard | 9–16 | 5 moves/sec | Portals, stage timers, drone pairs, one mirrored stage |
| Super Hard | 17–24 | 6 moves/sec | Drone packs, tight countdowns, closing arena from 21 |
| Hard Pro Max | 25–30 | 7 moves/sec | Rival snakes, spiral and fortress mazes, minimal margin |

**Rival snakes appear only in Hard Pro Max**, and always move
`RIVAL_SPEED_DELTA` (2) steps per second slower than the player — 5/sec against
your 7/sec. They run on their own accumulator rather than one move per player
step, so the gap holds exactly regardless of tier speed.

**Mirrored stages** (levels 10, 20 and 30) swap left and right but leave up and
down alone. Flipping both axes meant every input had to be mentally reversed,
which read as unfair rather than interesting; mirroring one axis keeps the idea
while staying playable. Each mirrored stage announces itself on the board and in
the mission panel.

## Features

- **Level select** (the *Levels* button, or `L`) showing all 30 levels by tier,
  each with its speed, drone/rival counts and modifiers. Levels unlock one at a
  time as you clear the previous one, and cleared levels keep a per-level best.
- **Practice mode** — a toggle in the level select opens every level immediately
  so any stage can be tested in isolation. Runs that do not start from level 1
  are kept out of the leaderboard, so practice cannot inflate the board.
- **30 levels** with obstacles, drones, portals, rivals, timers and a closing
  arena layered in gradually across the four tiers.
- **Checkpoints every 5 levels.** Losing your last life rewinds to the most recent
  checkpoint with the score you had entering it, rather than discarding the run.
  Clearing every 5th level also grants an extra life, capped at 5.
- **Daily Rift** — a date-derived seed so everyone gets the same 30 boards and can
  compare scores. Layout generation is fully deterministic per seed.
- **Audio** — all sound effects are synthesised with the Web Audio API, so there
  are no asset files. The context is created on first input to respect autoplay
  policy.
- **Accessibility** — every entity has a distinct silhouette (circle core,
  hexagon shield, triangle time-warp, star bonus, spiked-diamond drone, striped
  square rivals, ringed portals), so the board never depends on colour alone. An
  Okabe-Ito colourblind-safe palette is one keypress away.
- **Leaderboard** — optional local server keeps the best run per name for the
  campaign and for each daily seed.

## Layout

| File | Purpose |
| --- | --- |
| `index.html` | Markup and panel structure |
| `styles.css` | Styling, both palettes, responsive rules |
| `game.js` | Game loop, level generation, rendering, audio, persistence |
| `server.js` | Static file server plus the `/api/scores` leaderboard |
| `tests/audit.js` | Level audit harness (see below) |

Scores post to `data/scores.json`, which is created on demand and git-ignored.

## Testing

`tests/audit.js` drives the real game through the `window.__neonDebug` seam and
checks every level of every seed: that nothing spawns inside a wall or out of
bounds, that the core is always reachable from the snake's head, that the closing
arena never strands it, and that a simulated run never throws.

With the server running, open the game and in the browser console:

```javascript
const s = document.createElement('script');
s.src = 'tests/audit.js';
document.head.appendChild(s);
```

then:

```javascript
runAudit({ seeds: ['campaign', 'daily-2026-08-09'], ticks: 1500 })
```

A clean result is `issues: []` and `threw: 0`. The `notCleared` list is only a
measure of how far the built-in greedy autopilot got — it is not a failure
signal, since that bot plays far worse than a person.
