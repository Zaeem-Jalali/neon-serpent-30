(function () {
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
  const GRID = { cols: 30, rows: 20 };
  const CHECKPOINT_EVERY = 5;
  const MAX_LIVES = 5;
  // Minimum number of cells the player must be able to reach from the spawn
  // point before a generated board is accepted as playable.
  const MIN_OPEN_CELLS = 60;

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

  const LEVELS = [
    { name: "Spark Start", desc: "Warm-up with a soft pace and a few anchored blocks.", speed: 200, target: 3, layout: "open", walls: 4, hazards: 0, enemies: 0, portals: 0, powerups: 1, timer: null, reverse: false, shrink: 0 },
    { name: "Neon Drift", desc: "A bright open lane with light obstacles and no boxed-in sections.", speed: 192, target: 4, layout: "boulevard", walls: 8, hazards: 0, enemies: 0, portals: 0, powerups: 1, timer: null, reverse: false, shrink: 0 },
    { name: "Byte Bloom", desc: "Lane walls appear and force cleaner turns.", speed: 186, target: 4, layout: "lanes", walls: 5, hazards: 0, enemies: 0, portals: 0, powerups: 1, timer: null, reverse: false, shrink: 0 },
    { name: "Prism Path", desc: "Cross-pattern walls create more dead ends.", speed: 180, target: 4, layout: "cross", walls: 4, hazards: 0, enemies: 0, portals: 0, powerups: 1, timer: null, reverse: false, shrink: 0 },
    { name: "Circuit Chase", desc: "Ring walls begin to squeeze the board.", speed: 174, target: 5, layout: "rings", walls: 5, hazards: 0, enemies: 0, portals: 0, powerups: 1, timer: null, reverse: false, shrink: 0 },
    { name: "Glitch Garden", desc: "The first drones enter. Watch the lanes.", speed: 170, target: 5, layout: "maze", walls: 8, hazards: 1, enemies: 0, portals: 0, powerups: 1, timer: null, reverse: false, shrink: 0 },
    { name: "Pulse Corridor", desc: "The maze tightens and the pace picks up.", speed: 166, target: 5, layout: "lanes", walls: 10, hazards: 1, enemies: 0, portals: 0, powerups: 1, timer: null, reverse: false, shrink: 0 },
    { name: "Voxel Vault", desc: "Fortress walls and a few safer openings.", speed: 162, target: 5, layout: "fortress", walls: 12, hazards: 1, enemies: 0, portals: 1, powerups: 1, timer: null, reverse: false, shrink: 0 },
    { name: "Laser Loop", desc: "Portals join the mix and make route planning matter.", speed: 158, target: 6, layout: "rings", walls: 12, hazards: 1, enemies: 0, portals: 1, powerups: 1, timer: null, reverse: false, shrink: 0 },
    { name: "Swap Storm", desc: "Controls flip. Your brain has to stay calm.", speed: 154, target: 6, layout: "chaos", walls: 10, hazards: 1, enemies: 0, portals: 1, powerups: 1, timer: 80, reverse: true, shrink: 0 },
    { name: "Cyber Garden", desc: "A rival snake appears and starts hunting you.", speed: 150, target: 6, layout: "maze", walls: 12, hazards: 1, enemies: 1, portals: 0, powerups: 1, timer: 75, reverse: false, shrink: 0 },
    { name: "Bluewire Bend", desc: "Hazards, enemy pressure, and a tighter lane count.", speed: 146, target: 6, layout: "cross", walls: 12, hazards: 2, enemies: 1, portals: 0, powerups: 1, timer: 75, reverse: false, shrink: 0 },
    { name: "Quantum Walk", desc: "Portals and hunters make each route a puzzle.", speed: 142, target: 6, layout: "labyrinth", walls: 14, hazards: 2, enemies: 1, portals: 1, powerups: 1, timer: 72, reverse: false, shrink: 0 },
    { name: "Neon Relay", desc: "Two drones now patrol the arena.", speed: 138, target: 6, layout: "fortress", walls: 14, hazards: 2, enemies: 1, portals: 1, powerups: 1, timer: 72, reverse: false, shrink: 0 },
    { name: "Signal Rift", desc: "Mirror routes and a more aggressive rival snake.", speed: 136, target: 7, layout: "mirror", walls: 14, hazards: 2, enemies: 1, portals: 1, powerups: 1, timer: 70, reverse: false, shrink: 0 },
    { name: "Byte Barrage", desc: "The board starts to feel crowded on purpose.", speed: 132, target: 7, layout: "maze", walls: 16, hazards: 2, enemies: 2, portals: 1, powerups: 1, timer: 68, reverse: false, shrink: 0 },
    { name: "Chrome Canal", desc: "Longer runs with a stricter countdown.", speed: 128, target: 7, layout: "lanes", walls: 16, hazards: 3, enemies: 2, portals: 1, powerups: 1, timer: 66, reverse: false, shrink: 0 },
    { name: "Prism Panic", desc: "The lane pattern is now almost a trap.", speed: 124, target: 7, layout: "rings", walls: 18, hazards: 3, enemies: 2, portals: 1, powerups: 1, timer: 64, reverse: false, shrink: 0 },
    { name: "Static Siege", desc: "Enemies and hazards overlap with less mercy.", speed: 120, target: 7, layout: "chaos", walls: 18, hazards: 3, enemies: 2, portals: 2, powerups: 1, timer: 62, reverse: false, shrink: 0 },
    { name: "Inversion", desc: "Reverse controls return alongside more pressure.", speed: 116, target: 7, layout: "labyrinth", walls: 18, hazards: 3, enemies: 2, portals: 2, powerups: 1, timer: 60, reverse: true, shrink: 0 },
    { name: "Data Dunes", desc: "The outer edge starts closing in over time.", speed: 112, target: 8, layout: "fortress", walls: 20, hazards: 3, enemies: 2, portals: 2, powerups: 1, timer: 58, reverse: false, shrink: 16 },
    { name: "Turbo Tangle", desc: "The arena shrinks and the hunters speed up.", speed: 108, target: 8, layout: "maze", walls: 20, hazards: 4, enemies: 2, portals: 2, powerups: 1, timer: 56, reverse: false, shrink: 14 },
    { name: "Omega Orbit", desc: "Ring barriers, a double portal set, and tight timing.", speed: 104, target: 8, layout: "rings", walls: 22, hazards: 4, enemies: 2, portals: 2, powerups: 1, timer: 54, reverse: false, shrink: 14 },
    { name: "Hyper Hive", desc: "More rival movement and fewer safe guesses.", speed: 100, target: 8, layout: "cross", walls: 22, hazards: 4, enemies: 3, portals: 2, powerups: 1, timer: 52, reverse: false, shrink: 12 },
    { name: "Synth Spiral", desc: "A spiral-like route pattern with lots of bad choices.", speed: 96, target: 8, layout: "spiral", walls: 24, hazards: 4, enemies: 3, portals: 2, powerups: 1, timer: 50, reverse: false, shrink: 12 },
    { name: "Neon Nexus", desc: "Three hunters, multiple drones, and a smaller safe zone.", speed: 92, target: 9, layout: "fortress", walls: 24, hazards: 4, enemies: 3, portals: 2, powerups: 1, timer: 48, reverse: false, shrink: 10 },
    { name: "Corrupt Core", desc: "The edges are unsafe and the board is no longer generous.", speed: 88, target: 9, layout: "chaos", walls: 24, hazards: 5, enemies: 3, portals: 2, powerups: 1, timer: 46, reverse: false, shrink: 10 },
    { name: "Overclock", desc: "Very fast movement with narrow lanes and hard turns.", speed: 84, target: 9, layout: "maze", walls: 26, hazards: 5, enemies: 3, portals: 2, powerups: 1, timer: 44, reverse: false, shrink: 8 },
    { name: "Final Grid", desc: "Almost everything is dangerous now.", speed: 80, target: 9, layout: "rings", walls: 26, hazards: 5, enemies: 3, portals: 2, powerups: 1, timer: 42, reverse: false, shrink: 8 },
    { name: "Singularity Prime", desc: "The final stage. Tight, hostile, and very little room for mistakes.", speed: 76, target: 10, layout: "boss", walls: 28, hazards: 6, enemies: 4, portals: 2, powerups: 1, timer: 40, reverse: true, shrink: 6 }
  ];

  /* Difficulty tiers. The boundaries follow where the game actually changes
     shape: drones and portals arrive by 8, rivals and timers by 16, the
     arena starts closing at 21, and the last six are the endurance run. */
  const TIERS = [
    {
      id: "easy",
      name: "Easy",
      from: 0,
      to: 7,
      blurb: "Learn the board. Gentle speeds, simple layouts, and the first drones and portals near the end."
    },
    {
      id: "hard",
      name: "Hard",
      from: 8,
      to: 15,
      blurb: "Portals, inverted controls, stage timers and the first rival snakes hunting you down."
    },
    {
      id: "super",
      name: "Super Hard",
      from: 16,
      to: 23,
      blurb: "Multiple rivals and drone packs, tighter countdowns, and from level 21 the arena starts closing in."
    },
    {
      id: "promax",
      name: "Hard Pro Max",
      from: 24,
      to: 29,
      blurb: "Spiral and fortress mazes, up to four rivals, a shrinking board and almost no margin for error."
    }
  ];

  function tierForLevel(levelIndex) {
    return TIERS.find((tier) => levelIndex >= tier.from && levelIndex <= tier.to) || TIERS[0];
  }

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
    stepMs: LEVELS[0].speed,
    accumulator: 0,
    tick: 0,
    levelTick: 0,
    mission: 0,
    missionGoal: LEVELS[0].target,
    missionClearBonus: 0,
    timerLeft: null,
    reverse: false,
    shrinkMargin: 0,
    currentLevel: null,
    snake: [],
    snakeDir: { x: 1, y: 0 },
    nextDir: { x: 1, y: 0 },
    grow: 0,
    food: null,
    powerups: [],
    portals: [],
    walls: new Set(),
    hazards: [],
    enemySnakes: [],
    floating: [],
    floatingSlowTicks: 0,
    bonusMultiplier: 1,
    shield: 0,
    particles: [],
    message: "Tap Start Game to begin.",
    viewWidth: 960,
    viewHeight: 640,
    pixelRatio: 1,
    palette: "neon",
    playerName: "",
    checkpoint: null,
    savedCheckpoint: null,
    leaderboardTab: "campaign",
    leaderboardOnline: true,
    // Highest level index the player has earned access to.
    unlockedLevel: 0,
    // Per level: { completed, best } keyed by level index.
    levelStats: {},
    // Practice mode makes every level clickable for testing.
    unlockAll: false,
    // Runs that do not start at level 1 stay off the leaderboard.
    runStartLevel: 0
  };

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
    const parts = [`${Math.round(1000 / level.speed)}/s`];
    if (level.hazards) parts.push(`${level.hazards} drone${level.hazards > 1 ? "s" : ""}`);
    if (level.enemies) parts.push(`${level.enemies} rival${level.enemies > 1 ? "s" : ""}`);
    if (level.portals) parts.push("portals");
    if (level.reverse) parts.push("inverted");
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

  function prepareDailySeed() {
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    state.seed = `daily-${stamp}`;
    seedLabel.textContent = stamp;
    challengeCode.textContent = state.seed;
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

  function resetRun() {
    state.score = 0;
    state.lives = 3;
    state.levelIndex = 0;
    state.accumulator = 0;
    state.tick = 0;
    state.running = true;
    state.over = false;
    state.won = false;
    state.particles = [];
    state.floating = [];
    state.checkpoint = null;
    reseedRun();
    loadLevel(state.runStartLevel || 0);
    refreshCheckpointButton();
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
      state.floating.push({
        text: "Checkpoint",
        x: state.snake[0]?.x ?? Math.floor(GRID.cols / 2),
        y: state.snake[0]?.y ?? Math.floor(GRID.rows / 2),
        color: COLORS.mint,
        life: 34
      });
      saveProgress();
    }
    refreshCheckpointButton();
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

  // Offers whichever checkpoint is further along: the one from this run, or
  // one carried over from a previous session.
  function bestCheckpoint() {
    const candidates = [state.checkpoint, state.savedCheckpoint]
      .filter((cp) => cp && typeof cp.level === "number");
    if (!candidates.length) return null;
    return candidates.reduce((best, cp) => (cp.level > best.level ? cp : best));
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
    state.floating = [];
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
    state.reverse = state.currentLevel.reverse;
    state.shrinkMargin = 0;
    state.snake = buildSnakeStart();
    state.snakeDir = { x: 1, y: 0 };
    state.nextDir = { x: 1, y: 0 };
    state.grow = 0;

    buildStaticMap(state.currentLevel);
    spawnPortals(state.currentLevel.portals);
    spawnHazards(state.currentLevel.hazards);
    spawnEnemies(state.currentLevel.enemies);
    spawnPowerups(state.currentLevel.powerups);
    ensurePlayableBoard();
    captureCheckpoint(levelIndex);
    updateLevelPanel();
    updateUI();
  }

  function buildLevel(levelIndex) {
    const base = LEVELS[levelIndex];
    const seedMix = hashSeed(`${state.seed}:${levelIndex + 1}`);
    const rng = mulberry32(seedMix);
    return {
      index: levelIndex + 1,
      name: base.name,
      desc: base.desc,
      speed: base.speed,
      target: base.target,
      layout: base.layout,
      walls: base.walls,
      hazards: base.hazards,
      enemies: base.enemies,
      portals: base.portals,
      powerups: base.powerups,
      timer: base.timer,
      reverse: base.reverse,
      shrink: base.shrink,
      rng
    };
  }

  function buildSnakeStart() {
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
      addRect(5, 4, 24, 15);
      addLine(8, 7, 21, 7);
      addLine(8, 12, 21, 12);
      addLine(8, 7, 8, 12);
      addLine(21, 7, 21, 12);
      carveGate(14, 7, 1);
      carveGate(14, 12, 1);
      carveGate(8, 10, 1);
      carveGate(21, 9, 1);
      scatterBlocks(level.walls - 8, rng, 3, 2);
    }

    // Ensure the start area stays playable.
    clearSafeZone(Math.floor(GRID.cols / 2), Math.floor(GRID.rows / 2), 3);
  }

  /* ------------------------------------------------------------------
   * Board validation. Randomised wall scattering can box the player in, so
   * after everything is placed we prove the start position has real room to
   * play and carve corridors until it does. Carving draws from the level's
   * own seeded RNG, so a Daily Rift board stays identical for every player.
   * --------------------------------------------------------------- */
  function ensurePlayableBoard() {
    clearSpawnArea();

    for (let attempt = 0; attempt < 200; attempt++) {
      const region = openRegionFromHead();
      if (region.size >= MIN_OPEN_CELLS) break;
      if (!carveFrontier(region)) break;
    }

    // Placed last so it can only ever land in the validated open region.
    spawnFood();
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

    for (const tileKey of region) {
      const [x, y] = tileKey.split(":").map(Number);
      for (const dir of dirs) {
        const nx = x + dir.x;
        const ny = y + dir.y;
        if (!insidePlayableArea(nx, ny)) continue;
        const neighbour = key(nx, ny);
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
    if (state.reverse) {
      dir = { x: -dir.x, y: -dir.y };
    }
    const current = state.snakeDir;
    const isReverse = current.x + dir.x === 0 && current.y + dir.y === 0;
    if (!isReverse) {
      state.nextDir = dir;
    }
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
      state.shrinkMargin = Math.min(Math.floor(Math.min(GRID.cols, GRID.rows) / 2) - 4, state.shrinkMargin + 1);
      if (state.shrinkMargin !== previous) {
        onArenaShrunk();
      }
    }

    movePowerups();

    // Safety net: the snake's own body (or a moved actor) can seal the core
    // off. Re-home it rather than let the stage stall out unwinnable.
    if (state.food && state.levelTick % 20 === 0 && !foodReachable()) {
      spawnFood();
    }

    if (!slowed || state.levelTick % 2 === 0) {
      moveHazards();
      if (state.paused || state.over || state.won) {
        return;
      }
      moveEnemies();
      if (state.paused || state.over || state.won) {
        return;
      }
    }

    const appliedDir = state.nextDir;
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
        spawnBurst(next.x, next.y, COLORS.shield);
        audio.play("shieldBreak");
      } else {
        loseLife(deathReason);
        return;
      }
    }

    state.snake.unshift(next);

    if (eating) {
      state.mission++;
      const multiplier = Math.max(1, state.bonusMultiplier || 1);
      state.score += (12 + state.levelIndex * 3) * multiplier;
      state.grow += 1 + Math.floor(state.levelIndex / 10);
      spawnBurst(next.x, next.y, COLORS.food);
      audio.play("eat");
      spawnFood();
      maybeSpawnBonus();
      state.bonusMultiplier = 1;
      if (state.mission >= state.missionGoal) {
        levelComplete();
        return;
      }
    }

    collectPowerups(next.x, next.y);

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

    updateHUD();
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

  function foodReachable() {
    if (!state.food) return true;
    const blocked = new Set(state.walls);
    for (const segment of state.snake.slice(1)) blocked.add(key(segment.x, segment.y));
    for (const hazard of state.hazards) blocked.add(key(hazard.x, hazard.y));
    const reachable = getReachableCells(Math.max(1, state.shrinkMargin + 1), blocked);
    return reachable.has(key(state.food.x, state.food.y));
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
          state.floating.push({ text: "Shield", x, y, color: COLORS.shield, life: 26 });
          spawnBurst(x, y, COLORS.shield);
          audio.play("shield");
          state.shield = 1;
        } else if (item.type === "slow") {
          state.score += 14;
          state.floating.push({ text: "Warp", x, y, color: COLORS.slow, life: 26 });
          spawnBurst(x, y, COLORS.slow);
          audio.play("slow");
          state.floatingSlowTicks = 20;
        } else if (item.type === "bonus") {
          state.score += 24;
          state.floating.push({ text: "Combo", x, y, color: COLORS.bonus, life: 26 });
          spawnBurst(x, y, COLORS.bonus);
          audio.play("bonus");
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
          audio.play("shieldBreak");
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
          audio.play("shieldBreak");
          enemy.body = enemy.body.slice(1);
          spawnBurst(head.x, head.y, COLORS.shield);
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
    spawnBurst(other.x, other.y, found.side === "a" ? COLORS.portalA : COLORS.portalB);
    audio.play("portal");
  }

  function hasShield() {
    return state.shield > 0;
  }

  function isInvulnerable() {
    return (state.graceTicks || 0) > 0;
  }

  function consumeShield() {
    state.shield = Math.max(0, (state.shield || 0) - 1);
    state.floating.push({ text: "Shield used", x: state.snake[0].x, y: state.snake[0].y, color: COLORS.shield, life: 30 });
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
    if (state.walls.has(key(cell.x, cell.y))) return "You hit an obstacle";
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
    recordLevelCleared(state.levelIndex, state.score);
    const clearedCount = state.levelIndex + 1;

    if (clearedCount >= LEVELS.length) {
      celebrateVictory();
      return;
    }

    state.message = `${state.currentLevel.name} cleared. Next level loading.`;
    spawnBurst(state.snake[0].x, state.snake[0].y, COLORS.mint);
    audio.play("levelUp");

    // An extra life every few levels keeps the back half of the ladder from
    // being decided entirely by mistakes made early on.
    if (clearedCount % CHECKPOINT_EVERY === 0 && state.lives < MAX_LIVES) {
      state.lives++;
      state.floating.push({
        text: "+1 Life",
        x: state.snake[0].x,
        y: state.snake[0].y,
        color: COLORS.mint,
        life: 36
      });
      audio.play("life");
    }

    saveProgress();
    if (levelSelect.classList.contains("is-open")) renderLevelSelect();
    loadLevel(state.levelIndex + 1);
  }

  function celebrateVictory() {
    state.won = true;
    state.running = false;
    state.paused = false;
    overlayKicker.textContent = "Victory";
    state.bestCampaign = Math.max(state.bestCampaign, state.score);
    if (state.mode === "daily") {
      state.bestDaily = Math.max(state.bestDaily, state.score);
    }
    audio.play("victory");
    saveProgress();
    overlay.classList.add("visible");
    overlayText.textContent = `You cleared all 30 levels with a score of ${formatNumber(state.score)}. That run belongs on the leaderboard.`;
    playBtn.textContent = "Play Again";
    challengeCode.textContent = state.seed;
    updateBestDisplay();
    refreshCheckpointButton();
    updateUI();
    submitRun(LEVELS.length);
  }

  function loseLife(reason) {
    state.lives -= 1;
    state.message = reason;
    spawnBurst(state.snake[0].x, state.snake[0].y, COLORS.red);
    audio.play("hit");
    if (state.lives > 0) {
      respawnCurrentLevel();
      overlayKicker.textContent = "Life lost";
      overlay.classList.add("visible");
      overlayText.textContent = `${reason}. You have ${state.lives} lives left. Tap resume or press play to continue from this stage.`;
      pauseBtn.textContent = "Resume";
      playBtn.textContent = "Resume";
      state.paused = true;
      saveProgress();
      updateUI();
      return;
    }
    gameOver(reason);
  }

  function gameOver(reason) {
    state.over = true;
    state.running = false;
    state.paused = false;
    overlayKicker.textContent = "Game over";
    state.bestCampaign = Math.max(state.bestCampaign, state.score);
    if (state.mode === "daily") {
      state.bestDaily = Math.max(state.bestDaily, state.score);
    }
    audio.play("gameOver");
    saveProgress();
    overlay.classList.add("visible");

    const cp = state.checkpoint;
    const checkpointNote = cp && cp.level > 0
      ? ` You can resume from the level ${cp.level + 1} checkpoint.`
      : "";
    overlayText.textContent = `${reason}. Final score: ${formatNumber(state.score)}.${checkpointNote}`;
    playBtn.textContent = "Try Again";

    updateBestDisplay();
    refreshCheckpointButton();
    updateUI();
    submitRun(state.levelIndex + 1);
  }

  function respawnCurrentLevel() {
    state.snake = buildSnakeStart();
    state.snakeDir = { x: 1, y: 0 };
    state.nextDir = { x: 1, y: 0 };
    state.grow = 0;
    state.shield = 0;
    state.floatingSlowTicks = 0;
    state.bonusMultiplier = 1;
    state.accumulator = 0;
    state.floating = [];
    state.particles = [];
    clearSpawnArea();
    // Brief invulnerability, otherwise a drone or rival parked on the spawn
    // point kills the player again the instant they come back.
    state.graceTicks = 14;
  }

  // Move anything lethal out of the respawn pocket so the player always gets
  // a fair moment to react.
  function clearSpawnArea() {
    const cx = Math.floor(GRID.cols / 2);
    const cy = Math.floor(GRID.rows / 2);
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
    if (state.currentLevel?.reverse) missionBits.push("Controls are inverted on this stage.");
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
      `Speed: ${Math.round(1000 / level.speed)} moves/sec`,
      `Layout: ${prettyLayout(level.layout)}`,
      `Drones: ${level.hazards}`,
      `Rival snakes: ${level.enemies}`,
      `Portals: ${level.portals}`,
      level.reverse ? "Inverted controls" : "Normal controls",
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

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function key(x, y) {
    return `${x}:${y}`;
  }

  function mulberry32(seed) {
    return function () {
      let t = (seed += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashSeed(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
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

  function insidePlayfield(x, y) {
    return x >= 0 && y >= 0 && x < GRID.cols && y < GRID.rows;
  }

  /* Test seam. tests/audit.js drives the game through this to verify every
     level generates a solvable board and survives a simulated run. */
  window.__neonDebug = {
    state,
    LEVELS,
    GRID,
    key,
    isBlocked,
    inShrinkZone,
    insidePlayableArea,
    getReachableCells,
    collisionReason,
    requestDirection,
    stepOnce: step,
    spawnFood,
    TIERS,
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
      return getReachableCells(Math.max(1, state.shrinkMargin + 1), blocked);
    }
  };
})();
