import { createEngine } from "../src/engine.js";
import { LEVELS, GRID, MAX_SHRINK_MARGIN, playerMovesPerSec } from "../src/levels.js";
import { mulberry32, key } from "../src/utils.js";

function reachAt(levelIndex, margin) {
  const engine = createEngine({ emit: () => {} });
  const s = engine.state;
  s.mode = "campaign"; s.seed = "campaign"; s.rng = mulberry32(1); s.running = true; s.lives = 99;
  engine.loadLevel(levelIndex);
  const legal = (x, y) =>
    x > margin && y > margin && x < GRID.cols - 1 - margin && y < GRID.rows - 1 - margin &&
    !s.walls.has(key(x, y));
  const head = s.snake[0];
  if (!legal(head.x, head.y)) return 0;
  const seen = new Set([key(head.x, head.y)]);
  const q = [head];
  while (q.length) {
    const c = q.pop();
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = c.x + dx, ny = c.y + dy, k = key(nx, ny);
      if (seen.has(k) || !legal(nx, ny)) continue;
      seen.add(k); q.push({ x: nx, y: ny });
    }
  }
  return seen.size;
}

console.log("lvl name               marginReached  space  threats  space/threat");
for (let i = 20; i < LEVELS.length; i++) {
  const lv = LEVELS[i];
  // How far the arena actually closes before the stage timer expires.
  const ticks = lv.timer ? lv.timer * playerMovesPerSec(i) : Infinity;
  const reached = lv.shrink ? Math.min(MAX_SHRINK_MARGIN, Math.floor(ticks / lv.shrink)) : 0;
  const space = reachAt(i, reached);
  const threats = lv.hazards + lv.enemies * 2;
  const per = threats ? Math.round(space / threats) : space;
  const flag = threats >= 3 && per < 60 ? "  <-- still tight" : "";
  console.log(
    String(i+1).padStart(3), lv.name.padEnd(18),
    String(reached).padStart(9), String(space).padStart(8),
    String(threats).padStart(8), String(per).padStart(12), flag
  );
}
