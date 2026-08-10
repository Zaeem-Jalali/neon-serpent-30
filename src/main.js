/* Presentation layer: rendering, audio, DOM, storage and input.
 *
 * All simulation lives in ./engine.js, which this module drives and listens to.
 * Anything the player should see or hear arrives here as an engine event
 * rather than the engine reaching into the DOM itself.
 */
import { createEngine } from "./engine.js";
import {
  LEVELS,
  TIERS,
  GRID,
  CHECKPOINT_EVERY,
  MAX_LIVES,
  tierForLevel,
  playerMovesPerSec,
  rivalMovesPerSec
} from "./levels.js";
import { clamp, key, mulberry32, hashSeed } from "./utils.js";

/* ---------------------------------------------------------------------
 * Engine wiring
 *
 * The engine reports everything the player should see or hear through
 * `emit`. Translating those events into sound, particles and DOM changes is
 * this module's job — the engine never reaches across the boundary itself.
 * ------------------------------------------------------------------ */
const engine = createEngine({ emit: handleEngineEvent });

const {
  loadLevel,
  step,
  requestDirection,
  resetRun,
  reseedRun,
  prepareDailySeed,
  bestCheckpoint,
  isInvulnerable
} = engine;

// The engine owns the simulation half of the state. The presentation fields
// are attached to the same object so the UI code below reads unchanged.
const state = Object.assign(engine.state, {
  viewWidth: 960,
  viewHeight: 640,
  pixelRatio: 1,
  palette: "neon",
  soundEnabled: true,
  playerName: "",
  savedCheckpoint: null,
  leaderboardTab: "campaign",
  leaderboardOnline: true,
  unlockedLevel: 0,
  levelStats: {},
  unlockAll: false,
  // Purely visual, owned here rather than by the engine.
  floating: [],
  particles: []
});

function handleEngineEvent(type, payload) {
  switch (type) {
    case "sound":
      audio.play(payload);
      break;
    case "burst":
      spawnBurst(payload.x, payload.y, COLORS[payload.color] || COLORS.cyan);
      break;
    case "floating":
      state.floating.push({ ...payload, color: COLORS[payload.color] || COLORS.text });
      break;
    case "clearEffects":
      state.floating.length = 0;
      state.particles.length = 0;
      break;
    case "ui":
      updateUI();
      break;
    case "save":
      saveProgress();
      break;
    case "levelCleared":
      recordLevelCleared(payload.levelIndex, payload.score);
      if (levelSelect.classList.contains("is-open")) renderLevelSelect();
      break;
    case "lifeLost":
      onLifeLost(payload);
      break;
    case "gameOver":
      onGameOver(payload);
      break;
    case "victory":
      onVictory(payload);
      break;
    default:
      break;
  }
}

function onLifeLost({ reason, lives }) {
  overlayKicker.textContent = "Life lost";
  overlay.classList.add("visible");
  overlayText.textContent = `${reason}. You have ${lives} lives left. Tap resume or press play to continue from this stage.`;
  pauseBtn.textContent = "Resume";
  playBtn.textContent = "Resume";
}

function onGameOver({ reason, score, levelReached, checkpoint }) {
  overlayKicker.textContent = "Game over";
  overlay.classList.add("visible");

  const note = checkpoint && checkpoint.level > 0
    ? ` You can resume from the level ${checkpoint.level + 1} checkpoint.`
    : "";
  overlayText.textContent = `${reason}. Final score: ${formatNumber(score)}.${note}`;
  playBtn.textContent = "Try Again";

  updateBestDisplay();
  refreshCheckpointButton();
  submitRun(levelReached);
}

function onVictory({ score, levelReached }) {
  overlayKicker.textContent = "Victory";
  overlay.classList.add("visible");
  overlayText.textContent = `You cleared all 30 levels with a score of ${formatNumber(score)}. That run belongs on the leaderboard.`;
  playBtn.textContent = "Play Again";
  challengeCode.textContent = state.seed;

  updateBestDisplay();
  refreshCheckpointButton();
  submitRun(levelReached);
}

  const canvas = document.getElementById("gameCanvas");
  const ctx = canvas.getContext("2d");

  const overlay = document.getElementById("overlay");
  const overlayKicker = overlay.querySelector(".overlay-kicker");
  const overlayText = document.getElementById("overlayText");
  const levelLabel = document.getElementById("levelLabel");
  const scoreLabel = document.getElementById("scoreLabel");
  const livesLabel = document.getElementById("livesLabel");
  const seedLabel = document.getElementById("seedLabel");
  const levelName = document.getElementById("levelName");
  const levelDesc = document.getElementById("levelDesc");
  const modifierList = document.getElementById("modifierList");
  const missionText = document.getElementById("missionText");
  const missionFill = document.getElementById("missionFill");
  const timerText = document.getElementById("timerText");
  const challengeCode = document.getElementById("challengeCode");
  const bestCampaign = document.getElementById("bestCampaign");
  const bestDaily = document.getElementById("bestDaily");
  const bestLevel = document.getElementById("bestLevel");
  const checkpointLabel = document.getElementById("checkpointLabel");

  const campaignBtn = document.getElementById("campaignBtn");
  const dailyBtn = document.getElementById("dailyBtn");
  const pauseBtn = document.getElementById("pauseBtn");
  const restartBtn = document.getElementById("restartBtn");
  const playBtn = document.getElementById("playBtn");
  const copyCodeBtn = document.getElementById("copyCodeBtn");
  const dailyCopyBtn = document.getElementById("dailyCopyBtn");
  const soundBtn = document.getElementById("soundBtn");
  const paletteBtn = document.getElementById("paletteBtn");
  const checkpointBtn = document.getElementById("checkpointBtn");
  const leaderboardList = document.getElementById("leaderboardList");
  const lbCampaignTab = document.getElementById("lbCampaignTab");
  const lbDailyTab = document.getElementById("lbDailyTab");
  const lbStatus = document.getElementById("lbStatus");
  const playerNameInput = document.getElementById("playerName");
  const saveNameBtn = document.getElementById("saveNameBtn");
  const levelsBtn = document.getElementById("levelsBtn");
  const overlayLevelsBtn = document.getElementById("overlayLevelsBtn");
  const levelSelect = document.getElementById("levelSelect");
  const lsTiers = document.getElementById("lsTiers");
  const lsProgress = document.getElementById("lsProgress");
  const lsCloseBtn = document.getElementById("lsCloseBtn");
  const unlockAllToggle = document.getElementById("unlockAllToggle");

  const storageKey = "neon-serpent-save-v1";

  const PALETTES = {
    neon: {
      cyan: "#57f8ff",
      mint: "#63ff95",
      red: "#ff5d76",
      snake: ["#57f8ff", "#63ff95"],
      snakeGlow: "rgba(87, 248, 255, 0.35)",
      food: "#63ff95",
      shield: "#57f8ff",
      slow: "#ffd56a",
      bonus: "#ff6bd6",
      hazard: "#ff5d76",
      enemy: "#a98bff",
      enemyAlt: "#ff6bd6",
      portalA: "#57f8ff",
      portalB: "#ff6bd6",
      wall: "rgba(148, 185, 255, 0.18)",
      wallEdge: "rgba(87, 248, 255, 0.3)",
      wallFillA: "rgba(87, 248, 255, 0.20)",
      wallFillB: "rgba(255, 107, 214, 0.12)",
      bg1: "#060b14",
      bg2: "#0a1424",
      grid: "rgba(87, 248, 255, 0.06)",
      text: "#edf7ff",
      shadow: "rgba(0, 0, 0, 0.35)"
    },
    // Okabe-Ito derived. Every hue here stays separable under protanopia,
    // deuteranopia and tritanopia; shapes carry the rest of the meaning.
    accessible: {
      cyan: "#56b4e9",
      mint: "#009e73",
      red: "#d55e00",
      snake: ["#56b4e9", "#0072b2"],
      snakeGlow: "rgba(86, 180, 233, 0.35)",
      food: "#009e73",
      shield: "#56b4e9",
      slow: "#e69f00",
      bonus: "#f0e442",
      hazard: "#d55e00",
      enemy: "#cc79a7",
      enemyAlt: "#e69f00",
      portalA: "#56b4e9",
      portalB: "#f0e442",
      wall: "rgba(220, 224, 230, 0.18)",
      wallEdge: "rgba(240, 244, 250, 0.34)",
      wallFillA: "rgba(240, 244, 250, 0.18)",
      wallFillB: "rgba(180, 190, 205, 0.10)",
      bg1: "#05080c",
      bg2: "#0d141c",
      grid: "rgba(255, 255, 255, 0.06)",
      text: "#f2f6fa",
      shadow: "rgba(0, 0, 0, 0.35)"
    }
  };

  let COLORS = PALETTES.neon;

  function applyPalette(name) {
    const paletteName = PALETTES[name] ? name : "neon";
    COLORS = PALETTES[paletteName];
    state.palette = paletteName;
    document.body.classList.toggle("palette-accessible", paletteName === "accessible");
    paletteBtn.textContent = paletteName === "accessible" ? "Colourblind-safe" : "Neon palette";
    paletteBtn.setAttribute("aria-pressed", paletteName === "accessible" ? "true" : "false");
  }

  /* ---------------------------------------------------------------------
   * Audio. Everything is synthesised with the Web Audio API so the game
   * stays a dependency-free set of static files. The context is created
   * lazily on the first gesture because browsers block autoplay.
   * ------------------------------------------------------------------ */
  const audio = {
    ctx: null,
    master: null,
    enabled: true,
    noiseBuffer: null,

    init() {
      if (this.ctx) {
        this.resume();
        return;
      }
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      try {
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.22;
        this.master.connect(this.ctx.destination);
      } catch {
        this.ctx = null;
      }
    },

    resume() {
      if (this.ctx && this.ctx.state === "suspended") {
        this.ctx.resume().catch(() => {});
      }
    },

    tone(freq, delay, duration, type = "square", peak = 0.3, endFreq = null) {
      if (!this.ctx || !this.enabled) return;
      const now = this.ctx.currentTime + delay;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, now);
      if (endFreq != null) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(1, endFreq), now + duration);
      }
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(peak, now + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
      osc.connect(gain).connect(this.master);
      osc.start(now);
      osc.stop(now + duration + 0.02);
    },

    noise(delay, duration, peak = 0.22) {
      if (!this.ctx || !this.enabled) return;
      if (!this.noiseBuffer) {
        const frames = Math.floor(this.ctx.sampleRate * 0.4);
        const buffer = this.ctx.createBuffer(1, frames, this.ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
        this.noiseBuffer = buffer;
      }
      const now = this.ctx.currentTime + delay;
      const src = this.ctx.createBufferSource();
      const gain = this.ctx.createGain();
      const filter = this.ctx.createBiquadFilter();
      src.buffer = this.noiseBuffer;
      filter.type = "bandpass";
      filter.frequency.setValueAtTime(1400, now);
      gain.gain.setValueAtTime(peak, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
      src.connect(filter).connect(gain).connect(this.master);
      src.start(now);
      src.stop(now + duration + 0.02);
    },

    play(name) {
      if (!this.enabled) return;
      this.init();
      if (!this.ctx) return;
      switch (name) {
        case "eat":
          this.tone(660, 0, 0.07, "square", 0.26);
          this.tone(990, 0.06, 0.09, "square", 0.2);
          break;
        case "shield":
          this.tone(523, 0, 0.1, "triangle", 0.26);
          this.tone(784, 0.08, 0.14, "triangle", 0.24);
          break;
        case "slow":
          this.tone(880, 0, 0.28, "sine", 0.26, 330);
          break;
        case "bonus":
          this.tone(523, 0, 0.08, "square", 0.22);
          this.tone(659, 0.07, 0.08, "square", 0.22);
          this.tone(1047, 0.14, 0.16, "square", 0.24);
          break;
        case "portal":
          this.tone(220, 0, 0.26, "sawtooth", 0.18, 1100);
          break;
        case "shieldBreak":
          this.noise(0, 0.22, 0.26);
          this.tone(180, 0, 0.24, "square", 0.22, 90);
          break;
        case "life":
          this.tone(659, 0, 0.1, "triangle", 0.26);
          this.tone(880, 0.09, 0.1, "triangle", 0.26);
          this.tone(1319, 0.18, 0.2, "triangle", 0.28);
          break;
        case "levelUp":
          this.tone(523, 0, 0.1, "square", 0.24);
          this.tone(659, 0.09, 0.1, "square", 0.24);
          this.tone(784, 0.18, 0.1, "square", 0.24);
          this.tone(1047, 0.27, 0.26, "square", 0.28);
          break;
        case "hit":
          this.noise(0, 0.16, 0.2);
          this.tone(300, 0, 0.36, "sawtooth", 0.28, 80);
          break;
        case "gameOver":
          this.tone(392, 0, 0.22, "sawtooth", 0.24);
          this.tone(330, 0.2, 0.24, "sawtooth", 0.24);
          this.tone(262, 0.42, 0.28, "sawtooth", 0.24);
          this.tone(196, 0.68, 0.6, "sawtooth", 0.26);
          break;
        case "victory":
          [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone(f, i * 0.11, 0.24, "square", 0.26));
          this.tone(1568, 0.6, 0.7, "triangle", 0.3);
          break;
        case "ui":
          this.tone(440, 0, 0.05, "sine", 0.16);
          break;
        default:
          break;
      }
    }
  };

  /* Movement speed is a property of the tier, not the level: it is constant
     across a category so difficulty comes from the layout, drones, portals,
     timers and the closing arena rather than from a creeping tempo.
     Rival snakes belong to the final tier only. */





  /* ------------------------------------------------------------------
   * Bootstrap: restore preferences, wire input, then start the loop.
   * --------------------------------------------------------------- */
  loadSave();
  applyPalette(state.palette);
  soundBtn.textContent = state.soundEnabled === false ? "Sound off" : "Sound on";
  audio.enabled = state.soundEnabled !== false;
  soundBtn.setAttribute("aria-pressed", audio.enabled ? "true" : "false");
  playerNameInput.value = state.playerName;
  unlockAllToggle.checked = state.unlockAll;
  updateBestDisplay();
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);
  window.addEventListener("keydown", onKeyDown);
  setupSwipeControls();

  document.querySelectorAll("[data-dir]").forEach((button) => {
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      audio.init();
      const dir = button.getAttribute("data-dir");
      requestDirection(dir);
    });
  });

  playBtn.addEventListener("click", () => {
    audio.init();
    audio.play("ui");
    startFlow();
  });
  campaignBtn.addEventListener("click", () => setMode("campaign"));
  dailyBtn.addEventListener("click", () => setMode("daily"));
  pauseBtn.addEventListener("click", togglePause);
  restartBtn.addEventListener("click", () => {
    audio.play("ui");
    restartCurrent();
  });
  copyCodeBtn.addEventListener("click", copyChallengeCode);
  dailyCopyBtn.addEventListener("click", copyChallengeCode);
  checkpointBtn.addEventListener("click", resumeFromCheckpoint);
  soundBtn.addEventListener("click", toggleSound);
  paletteBtn.addEventListener("click", togglePalette);
  saveNameBtn.addEventListener("click", savePlayerName);
  playerNameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") savePlayerName();
  });
  lbCampaignTab.addEventListener("click", () => setLeaderboardTab("campaign"));
  lbDailyTab.addEventListener("click", () => setLeaderboardTab("daily"));
  levelsBtn.addEventListener("click", openLevelSelect);
  overlayLevelsBtn.addEventListener("click", openLevelSelect);
  lsCloseBtn.addEventListener("click", closeLevelSelect);
  levelSelect.addEventListener("click", (event) => {
    // Click-outside dismiss.
    if (event.target === levelSelect) closeLevelSelect();
  });
  unlockAllToggle.addEventListener("change", () => {
    state.unlockAll = unlockAllToggle.checked;
    savePreferences();
    renderLevelSelect();
    audio.play("ui");
  });

  state.running = false;
  state.paused = false;
  state.over = false;
  state.won = false;
  loadLevel(0);
  overlay.classList.add("visible");
  refreshCheckpointButton();
  updateUI();
  refreshLeaderboard();
  requestAnimationFrame(loop);

  /* ------------------------------------------------------------------
   * Level select
   * --------------------------------------------------------------- */
  function isLevelUnlocked(levelIndex) {
    return state.unlockAll || levelIndex <= state.unlockedLevel;
  }

  function levelStat(levelIndex) {
    return state.levelStats[levelIndex] || { completed: false, best: 0 };
  }

  function openLevelSelect() {
    audio.init();
    audio.play("ui");
    unlockAllToggle.checked = state.unlockAll;
    renderLevelSelect();
    levelSelect.classList.add("is-open");
    // Pause a live run so the board is not ticking away behind the dialog.
    if (state.running && !state.paused && !state.over && !state.won) {
      togglePause();
    }
    lsCloseBtn.focus();
  }

  function closeLevelSelect() {
    levelSelect.classList.remove("is-open");
  }

  function renderLevelSelect() {
    const unlockedCount = state.unlockAll
      ? LEVELS.length
      : Math.min(LEVELS.length, state.unlockedLevel + 1);
    const clearedCount = Object.values(state.levelStats).filter((s) => s.completed).length;

    lsProgress.textContent = state.unlockAll
      ? `Practice mode — all ${LEVELS.length} levels open · ${clearedCount} cleared`
      : `${unlockedCount} of ${LEVELS.length} unlocked · ${clearedCount} cleared`;

    lsTiers.innerHTML = "";

    for (const tier of TIERS) {
      const section = document.createElement("section");
      section.className = "ls-tier";
      section.style.setProperty("--tier-color", `var(--tier-${tier.id})`);

      const head = document.createElement("header");
      head.className = "ls-tier-head";

      const title = document.createElement("h3");
      title.textContent = tier.name;

      const range = document.createElement("span");
      range.className = "ls-tier-range";
      range.textContent = `Levels ${tier.from + 1}–${tier.to + 1}`;

      const total = tier.to - tier.from + 1;
      let done = 0;
      for (let i = tier.from; i <= tier.to; i++) {
        if (levelStat(i).completed) done++;
      }
      const count = document.createElement("span");
      count.className = "ls-tier-count";
      count.textContent = `${done}/${total} cleared`;

      head.append(title, range, count);

      const blurb = document.createElement("p");
      blurb.className = "ls-tier-blurb";
      blurb.textContent = tier.blurb;

      const grid = document.createElement("div");
      grid.className = "ls-grid";
      for (let i = tier.from; i <= tier.to; i++) {
        grid.appendChild(buildLevelCard(i));
      }

      section.append(head, blurb, grid);
      lsTiers.appendChild(section);
    }
  }

  function buildLevelCard(levelIndex) {
    const level = LEVELS[levelIndex];
    const stat = levelStat(levelIndex);
    const unlocked = isLevelUnlocked(levelIndex);
    const earned = levelIndex <= state.unlockedLevel;
    const isNext = !stat.completed && earned;

    const card = document.createElement("button");
    card.type = "button";
    card.className = "ls-card";
    card.disabled = !unlocked;
    if (stat.completed) card.classList.add("is-done");
    if (isNext) card.classList.add("is-next");
    // Dashed border marks a level only reachable because practice mode is on.
    if (unlocked && !earned) card.classList.add("is-practice");

    const top = document.createElement("div");
    top.className = "ls-card-top";

    const num = document.createElement("span");
    num.className = "ls-num";
    num.textContent = `Level ${levelIndex + 1}`;

    const badge = document.createElement("span");
    badge.className = "ls-badge";
    badge.textContent = !unlocked ? "🔒" : stat.completed ? "✓" : isNext ? "▶" : "◇";

    top.append(num, badge);

    const name = document.createElement("span");
    name.className = "ls-card-name";
    name.textContent = level.name;

    const meta = document.createElement("span");
    meta.className = "ls-card-meta";
    meta.textContent = describeLevel(levelIndex);

    card.append(top, name, meta);

    if (stat.best > 0) {
      const best = document.createElement("span");
      best.className = "ls-card-meta";
      best.textContent = `Best ${formatNumber(stat.best)}`;
      card.appendChild(best);
    }

    card.title = unlocked
      ? `${level.name} — ${level.desc}`
      : `Locked. Clear level ${levelIndex} to unlock.`;

    if (unlocked) {
      card.addEventListener("click", () => startAtLevel(levelIndex));
    }
    return card;
  }

  // Compact one-line summary of what makes a level distinct.
  function describeLevel(levelIndex) {
    const level = LEVELS[levelIndex];
    const parts = [`${playerMovesPerSec(levelIndex)}/s`];
    if (level.hazards) parts.push(`${level.hazards} drone${level.hazards > 1 ? "s" : ""}`);
    if (level.enemies) {
      parts.push(`${level.enemies} rival${level.enemies > 1 ? "s" : ""} @ ${rivalMovesPerSec(levelIndex)}/s`);
    }
    if (level.portals) parts.push("portals");
    if (level.mirror) parts.push("mirrored L/R");
    if (level.timer) parts.push(`${level.timer}s`);
    if (level.shrink) parts.push("shrinking");
    return parts.join(" · ");
  }

  function startAtLevel(levelIndex) {
    if (!isLevelUnlocked(levelIndex)) return;
    audio.init();
    audio.play("ui");
    closeLevelSelect();

    if (state.mode !== "campaign") setMode("campaign");

    state.runStartLevel = levelIndex;
    resetRun();
    state.running = true;
    state.paused = false;
    overlay.classList.remove("visible");
    overlayKicker.textContent = "Live run";
    pauseBtn.textContent = "Pause";
    playBtn.textContent = "Start Game";
    state.message = levelIndex === 0
      ? "Good luck. Stay in motion."
      : `Practice run from level ${levelIndex + 1}. This one will not be posted.`;
    updateUI();
  }

  function recordLevelCleared(levelIndex, scoreAtClear) {
    const previous = levelStat(levelIndex);
    state.levelStats[levelIndex] = {
      completed: true,
      best: Math.max(previous.best || 0, Math.floor(scoreAtClear))
    };
    // Each level unlocks exactly the next one.
    if (levelIndex + 1 < LEVELS.length) {
      state.unlockedLevel = Math.max(state.unlockedLevel, levelIndex + 1);
    }
  }

  function isPracticeRun() {
    return state.runStartLevel > 0;
  }

  function toggleSound() {
    audio.enabled = !audio.enabled;
    state.soundEnabled = audio.enabled;
    soundBtn.textContent = audio.enabled ? "Sound on" : "Sound off";
    soundBtn.setAttribute("aria-pressed", audio.enabled ? "true" : "false");
    if (audio.enabled) {
      audio.init();
      audio.play("ui");
    }
    savePreferences();
  }

  function togglePalette() {
    applyPalette(state.palette === "accessible" ? "neon" : "accessible");
    audio.play("ui");
    savePreferences();
  }

  /* Swipe-to-steer. A short press falls through to the old tap-to-start
     behaviour; anything past the threshold is read as a direction. */
  function setupSwipeControls() {
    const SWIPE_MIN = 24;
    let startX = 0;
    let startY = 0;
    let tracking = false;

    canvas.addEventListener("pointerdown", (event) => {
      audio.init();
      tracking = true;
      startX = event.clientX;
      startY = event.clientY;
      canvas.setPointerCapture?.(event.pointerId);
    });

    canvas.addEventListener("pointermove", (event) => {
      if (!tracking) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (Math.abs(dx) < SWIPE_MIN && Math.abs(dy) < SWIPE_MIN) return;
      // Consume the gesture and re-anchor so a long drag can chain turns.
      if (Math.abs(dx) > Math.abs(dy)) {
        requestDirection(dx > 0 ? "right" : "left");
      } else {
        requestDirection(dy > 0 ? "down" : "up");
      }
      startX = event.clientX;
      startY = event.clientY;
    });

    const endGesture = (event) => {
      if (!tracking) return;
      tracking = false;
      canvas.releasePointerCapture?.(event.pointerId);
      const moved = Math.abs(event.clientX - startX) + Math.abs(event.clientY - startY);
      if (moved < SWIPE_MIN && (!state.running || state.over || state.won || state.paused)) {
        startFlow();
      }
    };

    canvas.addEventListener("pointerup", endGesture);
    canvas.addEventListener("pointercancel", endGesture);
  }

  function startFlow() {
    audio.init();
    if (state.running && state.paused && !state.over && !state.won) {
      resumeCurrent();
      return;
    }
    resetRun();
    state.running = true;
    state.paused = false;
    overlayKicker.textContent = "Live run";
    overlay.classList.remove("visible");
    pauseBtn.textContent = "Pause";
    playBtn.textContent = "Start Game";
    state.message = "Good luck. Stay in motion.";
    updateUI();
  }

  function resumeCurrent() {
    state.paused = false;
    overlayKicker.textContent = "Live run";
    overlay.classList.remove("visible");
    pauseBtn.textContent = "Pause";
    playBtn.textContent = "Start Game";
    overlayText.textContent = "Collect neon cores, dodge drones, survive portals, and clear all 30 levels.";
    state.message = "Run resumed.";
    updateUI();
  }

  function setMode(mode) {
    state.mode = mode;
    campaignBtn.classList.toggle("active", mode === "campaign");
    dailyBtn.classList.toggle("active", mode === "daily");
    if (mode === "daily") {
      prepareDailySeed();
      state.message = "Daily Rift selected. This seed is shared for the day.";
    } else {
      state.seed = "campaign";
      seedLabel.textContent = "Campaign";
      challengeCode.textContent = "Campaign mode";
      state.message = "Campaign ladder selected. Clear all 30 levels.";
    }
    updateUI();
    if (state.running) {
      restartCurrent();
    }
  }


  function restartCurrent() {
    resetRun();
    state.running = true;
    state.paused = false;
    state.over = false;
    state.won = false;
    overlay.classList.remove("visible");
    pauseBtn.textContent = "Pause";
    updateUI();
  }




  function resumeFromCheckpoint() {
    const cp = bestCheckpoint();
    if (!cp) return;
    audio.init();
    audio.play("ui");
    if (cp.mode && cp.mode !== state.mode) {
      setMode(cp.mode);
    }
    reseedRun();
    state.score = cp.score || 0;
    state.lives = Math.max(1, cp.lives || 1);
    state.accumulator = 0;
    state.tick = 0;
    state.running = true;
    state.paused = false;
    state.over = false;
    state.won = false;
    state.particles = [];
    state.floating = [];
    state.checkpoint = { ...cp, mode: state.mode, seed: state.seed };
    loadLevel(cp.level || 0);
    overlay.classList.remove("visible");
    overlayKicker.textContent = "Live run";
    pauseBtn.textContent = "Pause";
    playBtn.textContent = "Start Game";
    state.message = `Resumed at level ${(cp.level || 0) + 1}.`;
    refreshCheckpointButton();
    updateUI();
  }


  function refreshCheckpointButton() {
    const cp = bestCheckpoint();
    const canResume = !!cp && cp.level > 0 && !state.running;
    checkpointBtn.classList.toggle("is-hidden", !canResume);
    if (canResume) {
      checkpointBtn.textContent = `Resume at level ${cp.level + 1}`;
    }
    checkpointLabel.textContent = String((state.checkpoint ? state.checkpoint.level : 0) + 1);
  }


















  function onKeyDown(event) {
    // Never steal keystrokes from the leaderboard name field.
    const target = event.target;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
      return;
    }

    const keyName = event.key.toLowerCase();
    audio.init();

    if (keyName === "escape") {
      closeLevelSelect();
      return;
    }
    if (keyName === "l") {
      if (levelSelect.classList.contains("is-open")) closeLevelSelect();
      else openLevelSelect();
      return;
    }
    // Everything below steers or controls a run, which the dialog blocks.
    if (levelSelect.classList.contains("is-open")) return;

    if (keyName === " " || keyName === "p") {
      event.preventDefault();
      togglePause();
      return;
    }
    if (keyName === "r") {
      restartCurrent();
      return;
    }
    if (keyName === "m") {
      toggleSound();
      return;
    }
    if (keyName === "c") {
      togglePalette();
      return;
    }
    if (keyName === "enter" && !state.running) {
      startFlow();
      return;
    }
    const map = {
      arrowup: "up",
      w: "up",
      arrowdown: "down",
      s: "down",
      arrowleft: "left",
      a: "left",
      arrowright: "right",
      d: "right"
    };
    if (map[keyName]) {
      event.preventDefault();
      requestDirection(map[keyName]);
    }
  }

  function togglePause() {
    if (!state.running || state.over || state.won) return;
    state.paused = !state.paused;
    pauseBtn.textContent = state.paused ? "Resume" : "Pause";
    overlayKicker.textContent = state.paused ? "Paused" : "Live run";
    overlay.classList.toggle("visible", state.paused);
    overlayText.textContent = state.paused ? "Game paused. Resume when you’re ready." : "Collect neon cores, dodge drones, survive portals, and clear all 30 levels.";
    playBtn.textContent = state.paused ? "Resume" : "Start Game";
  }






















  function spawnBurst(x, y, color) {
    const cell = cellSize();
    const ox = Math.floor((state.viewWidth - GRID.cols * cell) / 2);
    const oy = Math.floor((state.viewHeight - GRID.rows * cell) / 2);
    for (let i = 0; i < 10; i++) {
      state.particles.push({
        x: ox + (x + 0.5) * cell,
        y: oy + (y + 0.5) * cell,
        vx: (Math.random() - 0.5) * 5,
        vy: (Math.random() - 0.5) * 5,
        color,
        life: 18 + Math.floor(Math.random() * 12),
        size: 2 + Math.random() * 4
      });
    }
    state.floating.push({ text: "+", x, y, color, life: 18 });
  }

  function loop(timestamp) {
    if (!state.lastTime) state.lastTime = timestamp;
    const dt = timestamp - state.lastTime;
    state.lastTime = timestamp;

    if (state.running && !state.paused && !state.over && !state.won) {
      state.accumulator += dt;
      while (state.accumulator >= state.stepMs) {
        state.accumulator -= state.stepMs;
        step();
        if (state.paused || state.over || state.won) break;
      }
    }

    updateFloating(dt);
    draw();
    requestAnimationFrame(loop);
  }

  function updateFloating(dt) {
    const scale = dt / 16.6667;
    state.floating = state.floating.filter((item) => {
      item.life -= scale;
      item.y -= 0.06 * scale;
      return item.life > 0;
    });
    state.particles = state.particles.filter((particle) => {
      particle.life -= scale;
      particle.x += particle.vx * scale;
      particle.y += particle.vy * scale;
      particle.vy += 0.02 * scale;
      return particle.life > 0;
    });
  }

  function draw() {
    const w = state.viewWidth;
    const h = state.viewHeight;
    const cell = cellSize();
    const ox = Math.floor((w - GRID.cols * cell) / 2);
    const oy = Math.floor((h - GRID.rows * cell) / 2);

    ctx.clearRect(0, 0, w, h);
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, COLORS.bg1);
    bg.addColorStop(1, COLORS.bg2);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    drawGrid(ox, oy, cell);
    drawWalls(ox, oy, cell);
    drawPortals(ox, oy, cell);
    drawHazards(ox, oy, cell);
    drawPowerups(ox, oy, cell);
    drawFood(ox, oy, cell);
    drawEnemies(ox, oy, cell);
    drawSnake(ox, oy, cell);
    drawParticles();
    drawFloating(ox, oy, cell);
    drawShrinkMask(ox, oy, cell);

    if (state.running && !state.paused && !state.over && !state.won) {
      overlay.classList.remove("visible");
    }
  }

  function drawGrid(ox, oy, cell) {
    ctx.save();
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    for (let x = 0; x <= GRID.cols; x++) {
      ctx.beginPath();
      ctx.moveTo(ox + x * cell, oy);
      ctx.lineTo(ox + x * cell, oy + GRID.rows * cell);
      ctx.stroke();
    }
    for (let y = 0; y <= GRID.rows; y++) {
      ctx.beginPath();
      ctx.moveTo(ox, oy + y * cell);
      ctx.lineTo(ox + GRID.cols * cell, oy + y * cell);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawWalls(ox, oy, cell) {
    ctx.save();
    for (const tile of state.walls) {
      const [x, y] = tile.split(":").map(Number);
      if (x < 0 || y < 0 || x >= GRID.cols || y >= GRID.rows) continue;
      const px = ox + x * cell;
      const py = oy + y * cell;
      const grd = ctx.createLinearGradient(px, py, px + cell, py + cell);
      grd.addColorStop(0, COLORS.wallFillA);
      grd.addColorStop(1, COLORS.wallFillB);
      ctx.fillStyle = grd;
      roundRect(px + 1, py + 1, cell - 2, cell - 2, cell * 0.22);
      ctx.fill();
      ctx.strokeStyle = COLORS.wallEdge;
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawPortals(ox, oy, cell) {
    ctx.save();
    for (const portal of state.portals) {
      drawPortalNode(portal.a, COLORS.portalA, ox, oy, cell, "a");
      drawPortalNode(portal.b, COLORS.portalB, ox, oy, cell, "b");
    }
    ctx.restore();
  }

  /* ------------------------------------------------------------------
   * Shape primitives. Each entity type gets a silhouette of its own so the
   * board stays legible for colourblind players and in greyscale.
   * --------------------------------------------------------------- */
  function tracePolygon(cx, cy, radius, sides, rotation = 0) {
    ctx.beginPath();
    for (let i = 0; i < sides; i++) {
      const angle = rotation + (i / sides) * Math.PI * 2;
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  function traceStar(cx, cy, outer, inner, points = 5, rotation = -Math.PI / 2) {
    ctx.beginPath();
    for (let i = 0; i < points * 2; i++) {
      const radius = i % 2 === 0 ? outer : inner;
      const angle = rotation + (i / (points * 2)) * Math.PI * 2;
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  function drawPortalNode(pos, color, ox, oy, cell, variant) {
    const px = ox + pos.x * cell + cell / 2;
    const py = oy + pos.y * cell + cell / 2;
    const spin = state.tick * 0.06;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 16;
    ctx.lineWidth = Math.max(2, cell * 0.09);

    // Outer ring for both ends, then a distinct inner mark per end.
    ctx.beginPath();
    ctx.arc(px, py, cell * 0.3, 0, Math.PI * 2);
    ctx.stroke();

    if (variant === "a") {
      // Four spokes.
      for (let i = 0; i < 4; i++) {
        const angle = spin + (i / 4) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(px + Math.cos(angle) * cell * 0.1, py + Math.sin(angle) * cell * 0.1);
        ctx.lineTo(px + Math.cos(angle) * cell * 0.26, py + Math.sin(angle) * cell * 0.26);
        ctx.stroke();
      }
    } else {
      // Concentric ring plus a solid core.
      ctx.beginPath();
      ctx.arc(px, py, cell * 0.17, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(px, py, cell * 0.06, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawHazards(ox, oy, cell) {
    ctx.save();
    for (const hazard of state.hazards) {
      const px = ox + hazard.x * cell + cell / 2;
      const py = oy + hazard.y * cell + cell / 2;
      const spin = state.tick * 0.12;
      ctx.fillStyle = COLORS.hazard;
      ctx.strokeStyle = COLORS.hazard;
      ctx.shadowColor = COLORS.hazard;
      ctx.shadowBlur = 14;
      // Spiked diamond: unmistakable against the rounded pickups.
      traceStar(px, py, cell * 0.4, cell * 0.16, 4, spin);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawPowerups(ox, oy, cell) {
    ctx.save();
    for (const item of state.powerups) {
      const px = ox + item.x * cell + cell / 2;
      const py = oy + item.y * cell + cell / 2;
      const color = item.type === "shield" ? COLORS.shield : item.type === "slow" ? COLORS.slow : COLORS.bonus;
      // Blink out the last few ticks of life as an expiry warning.
      const expiring = item.life <= 8 && Math.floor(state.tick / 2) % 2 === 0;
      ctx.globalAlpha = expiring ? 0.35 : 1;
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 18;

      if (item.type === "shield") {
        tracePolygon(px, py, cell * 0.3, 6, Math.PI / 6);
      } else if (item.type === "slow") {
        tracePolygon(px, py, cell * 0.32, 3, -Math.PI / 2);
      } else {
        traceStar(px, py, cell * 0.34, cell * 0.15, 5);
      }
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  function drawFood(ox, oy, cell) {
    if (!state.food) return;
    const px = ox + state.food.x * cell + cell / 2;
    const py = oy + state.food.y * cell + cell / 2;
    const pulse = 1 + Math.sin(state.tick * 0.25) * 0.08;
    ctx.save();
    ctx.shadowColor = COLORS.food;
    ctx.shadowBlur = 22;
    ctx.fillStyle = COLORS.food;
    ctx.beginPath();
    ctx.arc(px, py, cell * 0.22 * pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.beginPath();
    ctx.arc(px - 3, py - 4, cell * 0.07, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawSnake(ox, oy, cell) {
    const segments = state.snake;
    ctx.save();
    // Blink while the respawn grace window is open so the state is legible.
    if (isInvulnerable() && Math.floor(state.tick / 2) % 2 === 0) {
      ctx.globalAlpha = 0.45;
    }
    for (let i = segments.length - 1; i >= 0; i--) {
      const segment = segments[i];
      const px = ox + segment.x * cell;
      const py = oy + segment.y * cell;
      const head = i === 0;
      const grad = ctx.createLinearGradient(px, py, px + cell, py + cell);
      grad.addColorStop(0, head ? "#ffffff" : COLORS.snake[0]);
      grad.addColorStop(1, head ? COLORS.snake[0] : COLORS.snake[1]);
      ctx.shadowColor = COLORS.snakeGlow;
      ctx.shadowBlur = head ? 18 : 10;
      ctx.fillStyle = grad;
      roundRect(px + 1.5, py + 1.5, cell - 3, cell - 3, cell * 0.28);
      ctx.fill();
      if (head) {
        ctx.shadowBlur = 0;
        ctx.fillStyle = "rgba(0,0,0,0.36)";
        ctx.beginPath();
        ctx.arc(px + cell * 0.35, py + cell * 0.38, cell * 0.06, 0, Math.PI * 2);
        ctx.arc(px + cell * 0.65, py + cell * 0.38, cell * 0.06, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawEnemies(ox, oy, cell) {
    ctx.save();
    for (const enemy of state.enemySnakes) {
      const color = COLORS[enemy.colorKey] || COLORS.enemy;
      for (let i = enemy.body.length - 1; i >= 0; i--) {
        const segment = enemy.body[i];
        const px = ox + segment.x * cell;
        const py = oy + segment.y * cell;
        ctx.shadowColor = color;
        ctx.shadowBlur = i === 0 ? 18 : 10;
        ctx.fillStyle = i === 0 ? "#ffffff" : color;
        // Hard corners keep rivals readable against the player's rounded body.
        roundRect(px + 2, py + 2, cell - 4, cell - 4, cell * 0.06);
        ctx.fill();

        if (i === 0) {
          // Chevron pointing the way the rival is heading.
          ctx.shadowBlur = 0;
          ctx.strokeStyle = color;
          ctx.lineWidth = Math.max(2, cell * 0.1);
          const cx = px + cell / 2;
          const cy = py + cell / 2;
          const r = cell * 0.2;
          const dx = enemy.dir.x;
          const dy = enemy.dir.y;
          ctx.beginPath();
          ctx.moveTo(cx - r * dy - r * dx, cy - r * dx - r * dy);
          ctx.lineTo(cx + r * dx, cy + r * dy);
          ctx.lineTo(cx + r * dy - r * dx, cy + r * dx - r * dy);
          ctx.stroke();
        } else {
          // Diagonal stripe so the body never reads as the player's tail.
          ctx.shadowBlur = 0;
          ctx.strokeStyle = "rgba(0, 0, 0, 0.38)";
          ctx.lineWidth = Math.max(1.5, cell * 0.09);
          ctx.beginPath();
          ctx.moveTo(px + cell * 0.24, py + cell * 0.76);
          ctx.lineTo(px + cell * 0.76, py + cell * 0.24);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  function drawParticles() {
    ctx.save();
    for (const p of state.particles) {
      ctx.globalAlpha = Math.max(0, p.life / 30);
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 12;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawFloating(ox, oy, cell) {
    ctx.save();
    ctx.font = `700 ${Math.max(14, cell * 0.4)}px Bahnschrift, Trebuchet MS, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const item of state.floating) {
      const px = ox + item.x * cell + cell / 2;
      const py = oy + item.y * cell + cell / 2 - (30 - item.life) * 0.5;
      ctx.globalAlpha = Math.max(0, item.life / 24);
      ctx.fillStyle = item.color;
      ctx.shadowColor = item.color;
      ctx.shadowBlur = 12;
      ctx.fillText(item.text, px, py);
    }
    ctx.restore();
  }

  function drawShrinkMask(ox, oy, cell) {
    if (!state.shrinkMargin) return;
    ctx.save();
    ctx.fillStyle = "rgba(255, 93, 118, 0.06)";
    const margin = state.shrinkMargin * cell;
    ctx.fillRect(ox, oy, GRID.cols * cell, margin);
    ctx.fillRect(ox, oy + GRID.rows * cell - margin, GRID.cols * cell, margin);
    ctx.fillRect(ox, oy, margin, GRID.rows * cell);
    ctx.fillRect(ox + GRID.cols * cell - margin, oy, margin, GRID.rows * cell);
    ctx.strokeStyle = "rgba(255, 93, 118, 0.35)";
    ctx.lineWidth = 2;
    ctx.strokeRect(ox + margin, oy + margin, GRID.cols * cell - margin * 2, GRID.rows * cell - margin * 2);
    ctx.restore();
  }

  function roundRect(x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  }

  function cellSize() {
    const availableW = state.viewWidth * 0.92;
    const availableH = state.viewHeight * 0.92;
    return Math.floor(Math.min(availableW / GRID.cols, availableH / GRID.rows));
  }

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const scale = Math.max(1, window.devicePixelRatio || 1);
    state.viewWidth = rect.width;
    state.viewHeight = rect.height;
    state.pixelRatio = scale;
    canvas.width = Math.floor(rect.width * scale);
    canvas.height = Math.floor(rect.height * scale);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
  }

  function updateHUD() {
    levelLabel.textContent = state.levelIndex + 1;
    scoreLabel.textContent = formatNumber(state.score);
    livesLabel.textContent = String(state.lives);
    if (state.mode === "daily") {
      challengeCode.textContent = state.seed;
      seedLabel.textContent = state.seed.replace("daily-", "");
    } else {
      challengeCode.textContent = "Campaign mode";
      seedLabel.textContent = "Campaign";
    }
    const timerValue = state.timerLeft == null ? "No time limit on this stage." : `${Math.ceil(state.timerLeft)}s remaining.`;
    timerText.textContent = timerValue;
    const missionBits = [`Collect ${state.missionGoal} cores to unlock the next level.`];
    if (state.currentLevel?.mirror) missionBits.push("Left and right are mirrored on this stage — up and down are normal.");
    if (isPracticeRun()) missionBits.push(`Practice run from level ${state.runStartLevel + 1} — not posted.`);
    missionText.textContent = missionBits.join(" ");
    const progress = Math.max(0, Math.min(1, state.missionGoal ? state.mission / state.missionGoal : 0));
    missionFill.style.width = `${Math.floor(progress * 100)}%`;
  }

  function updateLevelPanel() {
    const level = state.currentLevel || LEVELS[0];
    levelName.textContent = level.name;
    levelDesc.textContent = level.desc;
    modifierList.innerHTML = "";
    const modifiers = [
      `Tier: ${tierForLevel(state.levelIndex).name}`,
      `Speed: ${playerMovesPerSec(state.levelIndex)} moves/sec`,
      `Layout: ${prettyLayout(level.layout)}`,
      `Drones: ${level.hazards}`,
      level.enemies
        ? `Rival snakes: ${level.enemies} at ${rivalMovesPerSec(state.levelIndex)} moves/sec`
        : "Rival snakes: none",
      `Portals: ${level.portals}`,
      level.mirror ? "Mirrored left/right" : "Normal controls",
      level.timer ? `Timer: ${level.timer}s` : "No stage timer",
      level.shrink ? `Arena shrinks every ${level.shrink} ticks` : "Stable arena"
    ];
    for (const item of modifiers) {
      const li = document.createElement("li");
      li.textContent = item;
      modifierList.appendChild(li);
    }
    // Mission copy is owned by updateHUD, which also appends the inverted-
    // controls and practice-run notices. Setting it here would clobber them.
  }

  function updateUI() {
    updateHUD();
    updateLevelPanel();
    refreshCheckpointButton();
    bestCampaign.textContent = formatNumber(state.bestCampaign);
    bestDaily.textContent = formatNumber(state.bestDaily);
    bestLevel.textContent = String(state.bestLevel);
    if (state.mode === "daily") {
      challengeCode.textContent = state.seed;
      seedLabel.textContent = state.seed.replace("daily-", "");
    } else {
      challengeCode.textContent = "Campaign mode";
      seedLabel.textContent = "Campaign";
    }
  }

  function updateBestDisplay() {
    const data = readSave();
    state.bestCampaign = data.bestCampaign || 0;
    state.bestDaily = data.bestDaily || 0;
    state.bestLevel = data.bestLevel || 1;
    bestCampaign.textContent = formatNumber(state.bestCampaign);
    bestDaily.textContent = formatNumber(state.bestDaily);
    bestLevel.textContent = String(state.bestLevel);
  }

  function prettyLayout(layout) {
    return layout
      .replace(/([A-Z])/g, " $1")
      .replace(/^./, (c) => c.toUpperCase());
  }

  function formatNumber(value) {
    return Math.max(0, Math.floor(value)).toLocaleString();
  }





  function saveProgress() {
    const previous = readSave();
    const snapshot = {
      ...previous,
      bestCampaign: Math.max(state.bestCampaign, state.score, previous.bestCampaign || 0),
      bestDaily: Math.max(state.bestDaily, previous.bestDaily || 0),
      bestLevel: Math.max(state.bestLevel, state.levelIndex + 1, previous.bestLevel || 1),
      palette: state.palette,
      soundEnabled: state.soundEnabled !== false,
      playerName: state.playerName || "",
      checkpoint: state.checkpoint && state.checkpoint.level > 0 ? state.checkpoint : previous.checkpoint || null,
      unlockedLevel: Math.max(state.unlockedLevel, previous.unlockedLevel || 0),
      levelStats: mergeLevelStats(previous.levelStats, state.levelStats),
      unlockAll: !!state.unlockAll
    };
    writeSave(snapshot);
    updateBestDisplay();
  }

  // Union of stored and in-memory per-level records, keeping the better score.
  function mergeLevelStats(stored, current) {
    const merged = {};
    for (const source of [stored || {}, current || {}]) {
      for (const [levelIndex, stat] of Object.entries(source)) {
        if (!stat || typeof stat !== "object") continue;
        const existing = merged[levelIndex] || { completed: false, best: 0 };
        merged[levelIndex] = {
          completed: existing.completed || !!stat.completed,
          best: Math.max(existing.best || 0, Number(stat.best) || 0)
        };
      }
    }
    return merged;
  }

  // Preferences persist immediately; they must not wait on a run ending.
  function savePreferences() {
    const previous = readSave();
    writeSave({
      ...previous,
      palette: state.palette,
      soundEnabled: state.soundEnabled !== false,
      playerName: state.playerName || "",
      unlockAll: !!state.unlockAll
    });
  }

  function loadSave() {
    const data = readSave();
    state.bestCampaign = data.bestCampaign || 0;
    state.bestDaily = data.bestDaily || 0;
    state.bestLevel = data.bestLevel || 1;
    state.palette = PALETTES[data.palette] ? data.palette : "neon";
    state.soundEnabled = data.soundEnabled !== false;
    state.playerName = typeof data.playerName === "string" ? data.playerName.slice(0, 24) : "";
    state.savedCheckpoint = data.checkpoint && typeof data.checkpoint.level === "number"
      ? data.checkpoint
      : null;

    const unlocked = Number(data.unlockedLevel);
    state.unlockedLevel = Number.isFinite(unlocked)
      ? Math.max(0, Math.min(LEVELS.length - 1, Math.floor(unlocked)))
      : 0;
    state.levelStats = mergeLevelStats(data.levelStats, {});
    state.unlockAll = !!data.unlockAll;
  }

  function readSave() {
    try {
      const parsed = JSON.parse(localStorage.getItem(storageKey) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeSave(snapshot) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(snapshot));
    } catch {
      // Private-browsing quota errors must never break the run in progress.
    }
  }

  /* ------------------------------------------------------------------
   * Leaderboard client. Every call degrades silently: opening index.html
   * straight off disk has no server, and the game must stay fully playable.
   * --------------------------------------------------------------- */
  function savePlayerName() {
    const cleaned = playerNameInput.value.replace(/\s+/g, " ").trim().slice(0, 24);
    state.playerName = cleaned;
    playerNameInput.value = cleaned;
    savePreferences();
    audio.play("ui");
    lbStatus.textContent = cleaned
      ? `Runs will post as "${cleaned}".`
      : "Set a name and finished runs post automatically.";
  }

  function setLeaderboardTab(tab) {
    state.leaderboardTab = tab;
    lbCampaignTab.classList.toggle("active", tab === "campaign");
    lbDailyTab.classList.toggle("active", tab === "daily");
    refreshLeaderboard();
  }

  function currentDailySeed() {
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    return `daily-${stamp}`;
  }

  async function refreshLeaderboard() {
    const tab = state.leaderboardTab;
    const params = new URLSearchParams({ mode: tab });
    if (tab === "daily") params.set("seed", currentDailySeed());

    try {
      const res = await fetch(`api/scores?${params.toString()}`, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      state.leaderboardOnline = true;
      renderLeaderboard(Array.isArray(data.scores) ? data.scores : []);
    } catch {
      state.leaderboardOnline = false;
      leaderboardList.innerHTML = "";
      const li = document.createElement("li");
      li.className = "lb-empty";
      li.textContent = "Offline — run server.js to enable the shared leaderboard.";
      leaderboardList.appendChild(li);
    }
  }

  function renderLeaderboard(scores) {
    leaderboardList.innerHTML = "";
    if (!scores.length) {
      const li = document.createElement("li");
      li.className = "lb-empty";
      li.textContent = "No runs posted yet. Be the first.";
      leaderboardList.appendChild(li);
      return;
    }
    scores.forEach((entry, index) => {
      const li = document.createElement("li");
      if (state.playerName && entry.name === state.playerName) li.classList.add("is-you");

      const rank = document.createElement("span");
      rank.className = "lb-rank";
      rank.textContent = `${index + 1}.`;

      const name = document.createElement("span");
      name.className = "lb-name";
      // textContent, never innerHTML: names come from other players.
      name.textContent = entry.name;

      const score = document.createElement("span");
      score.className = "lb-score";
      score.textContent = formatNumber(entry.score);
      const detail = document.createElement("small");
      detail.textContent = `level ${entry.level}`;
      score.appendChild(detail);

      li.append(rank, name, score);
      leaderboardList.appendChild(li);
    });
  }

  async function submitRun(levelReached) {
    // Only full runs from level 1 count, otherwise starting at level 29 would
    // post a score that nobody could compare against.
    if (isPracticeRun()) {
      lbStatus.textContent = `Practice run from level ${state.runStartLevel + 1} — not posted to the leaderboard.`;
      return;
    }
    if (!state.playerName) {
      lbStatus.textContent = "Set a name above to post this run to the leaderboard.";
      return;
    }
    if (state.score <= 0) return;

    const payload = {
      name: state.playerName,
      score: Math.floor(state.score),
      level: Math.max(1, Math.min(LEVELS.length, Math.floor(levelReached))),
      mode: state.mode,
      seed: state.mode === "daily" ? state.seed : "campaign"
    };

    try {
      const res = await fetch("api/scores", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      state.leaderboardOnline = true;
      lbStatus.textContent = data.rank
        ? `Posted — you are #${data.rank} on the ${payload.mode} board.`
        : "Run posted to the leaderboard.";
      setLeaderboardTab(payload.mode);
    } catch {
      state.leaderboardOnline = false;
      lbStatus.textContent = "Could not reach the leaderboard. Your local bests are still saved.";
    }
  }

  async function copyChallengeCode() {
    const text = state.mode === "daily" ? state.seed : "Campaign mode";
    try {
      await navigator.clipboard.writeText(text);
      state.message = "Challenge code copied.";
      overlayText.textContent = state.mode === "daily"
        ? `Daily code copied: ${text}`
        : "Campaign mode does not use a share code.";
      overlay.classList.add("visible");
      setTimeout(() => {
        if (state.running && !state.paused && !state.over && !state.won) {
          overlay.classList.remove("visible");
        }
      }, 1200);
    } catch {
      state.message = "Clipboard unavailable in this browser.";
      overlay.classList.add("visible");
      overlayText.textContent = `Clipboard unavailable. Daily code: ${text}`;
    }
  }


/* Test seam. tests/audit.js drives the game through this to verify every level
   generates a solvable board and survives a simulated run.
   Gated behind ?debug=1 so it is not part of the public surface area of a
   deployed build — it can jump levels, set lives and rewrite state.

   The Node suite in tests/engine.test.js imports the engine directly and does
   not need this; it exists so the audit can also be run against the real
   rendered game in a browser. */
const debugEnabled = (() => {
  try {
    return new URLSearchParams(window.location.search).get("debug") === "1";
  } catch {
    return false;
  }
})();

if (debugEnabled) {
  window.__neonDebug = {
    engine,
    state,
    LEVELS,
    TIERS,
    GRID,
    key,
    isBlocked: engine.isBlocked,
    inShrinkZone: engine.inShrinkZone,
    insidePlayableArea: engine.insidePlayableArea,
    getReachableCells: engine.getReachableCells,
    collisionReason: engine.collisionReason,
    requestDirection,
    stepOnce: step,
    spawnFood: engine.spawnFood,
    isLevelUnlocked,
    startAtLevel,
    renderLevelSelect,
    openLevelSelect,
    closeLevelSelect,
    setSeed(seed) {
      state.mode = seed === "campaign" ? "campaign" : "daily";
      state.seed = seed;
      state.rng = seed === "campaign" ? mulberry32(1) : mulberry32(hashSeed(seed));
    },
    jumpTo(levelIndex) {
      state.running = true;
      state.paused = false;
      state.over = false;
      state.won = false;
      state.lives = 99;
      loadLevel(levelIndex);
    },
    reachableFromHead() {
      const blocked = new Set([...state.walls, ...state.snake.slice(1).map((s) => key(s.x, s.y))]);
      for (const hazard of state.hazards) blocked.add(key(hazard.x, hazard.y));
      for (const enemy of state.enemySnakes) {
        for (const segment of enemy.body) blocked.add(key(segment.x, segment.y));
      }
      return engine.getReachableCells(Math.max(1, state.shrinkMargin + 1), blocked);
    }
  };
}
