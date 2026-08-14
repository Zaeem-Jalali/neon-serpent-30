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
  BOSS_SHARDS_PER_CYCLE,
  tierForLevel,
  playerMovesPerSec,
  rivalMovesPerSec
} from "./levels.js";
import { clamp, key, mulberry32, hashSeed } from "./utils.js";
import { isSupabaseConfigured } from "./supabaseConfig.js";
import {
  onAuthChange,
  getCurrentUser,
  restoreSession,
  signInWithGoogle,
  signInAsGuest,
  signOutCloud,
  setCloudDisplayName,
  syncLevelProgress,
  fetchCloudLevelProgress,
  postRunToCloud,
  fetchCloudLeaderboard
} from "./cloudSync.js";

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
  skinIndex: 0,
  dailyHistory: [],
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
  particles: [],
  shakeTicks: 0,
  shakeStrength: 0,
  flashTicks: 0,
  flashColor: "#ffffff"
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
    case "shake":
      // Additive rather than replaced: a hit landed right as another effect
      // was fading should feel more emphatic, not reset the punch.
      state.shakeTicks = Math.max(state.shakeTicks, payload.ticks);
      state.shakeStrength = Math.max(state.shakeStrength, payload.strength);
      break;
    case "flash":
      state.flashTicks = Math.max(state.flashTicks, payload.ticks);
      state.flashColor = payload.color;
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

/* The pause control is an icon button in the game bar now, so it carries a
   glyph rather than the words "Pause"/"Resume", which would overflow a 42px
   square. The accessible name still says which it is. */
function setPauseButton(paused) {
  pauseBtn.textContent = paused ? "▶" : "❚❚";
  pauseBtn.setAttribute("aria-label", paused ? "Resume" : "Pause");
}

function onLifeLost({ reason, lives }) {
  overlayKicker.textContent = "Life lost";
  if (overlayTitle) overlayTitle.textContent = "Shake it off";
  overlay.classList.add("visible");
  overlayText.textContent = `${reason}. You have ${lives} lives left. Tap resume or press play to continue from this stage.`;
  setPauseButton(true);
  playBtn.textContent = "Resume";
}

function onGameOver({ reason, score, levelReached, checkpoint }) {
  overlayKicker.textContent = "Game over";
  if (overlayTitle) overlayTitle.textContent = "The grid wins this one";
  overlay.classList.add("visible");

  const note = checkpoint && checkpoint.level > 0
    ? ` You can resume from the level ${checkpoint.level + 1} checkpoint.`
    : "";
  overlayText.textContent = `${reason}. Final score: ${formatNumber(score)}.${note}`;
  playBtn.textContent = "Try Again";

  updateBestDisplay();
  refreshCheckpointButton();
  recordDailyRun(score, levelReached);
  submitRun(levelReached);
}

function onVictory({ score, levelReached }) {
  overlayKicker.textContent = "Victory";
  if (overlayTitle) overlayTitle.textContent = "All 30 cleared";
  overlay.classList.add("visible");
  overlayText.textContent = `You cleared all 30 levels with a score of ${formatNumber(score)}. That run belongs on the leaderboard.`;
  playBtn.textContent = "Play Again";
  challengeCode.textContent = state.seed;

  updateBestDisplay();
  refreshCheckpointButton();
  recordDailyRun(score, levelReached);
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
  const overlayExitBtn = document.getElementById("overlayExitBtn");
  const shareBtn = document.getElementById("shareBtn");
  const shareCodeBtn = document.getElementById("shareCodeBtn");
  const soundBtn = document.getElementById("soundBtn");
  const paletteBtn = document.getElementById("paletteBtn");
  const skinSwatch = document.getElementById("skinSwatch");
  const skinName = document.getElementById("skinName");
  const skinShuffleBtn = document.getElementById("skinShuffleBtn");
  const skinResetBtn = document.getElementById("skinResetBtn");
  const dailyHistoryList = document.getElementById("dailyHistoryList");

  // Screens, drawer and the rest of the app shell.
  const welcomeScreen = document.getElementById("welcomeScreen");
  const welcomeGreeting = document.getElementById("welcomeGreeting");
  const enterBtn = document.getElementById("enterBtn");
  const consentRow = document.getElementById("consentRow");
  const consentCheck = document.getElementById("consentCheck");
  const overlayCloseBtn = document.getElementById("overlayCloseBtn");
  const exitGameBtn = document.getElementById("exitGameBtn");
  const authScreen = document.getElementById("authScreen");
  const authGoogleBtn = document.getElementById("authGoogleBtn");
  const authGuestBtn = document.getElementById("authGuestBtn");
  const authSkipBtn = document.getElementById("authSkipBtn");
  const authStatus = document.getElementById("authStatus");
  const gameScreen = document.getElementById("gameScreen");
  const navToggle = document.getElementById("navToggle");
  const navDrawer = document.getElementById("navDrawer");
  const navScrim = document.getElementById("navScrim");
  const navClose = document.getElementById("navClose");
  const drawerWho = document.getElementById("drawerWho");
  const profileAvatar = document.getElementById("profileAvatar");
  const profileName = document.getElementById("profileName");
  const fullscreenBtn = document.getElementById("fullscreenBtn");
  const fullscreenBtn2 = document.getElementById("fullscreenBtn2");
  const missionTicker = document.getElementById("missionTicker");
  const overlayTitle = document.getElementById("overlayTitle");
  const drawerTabs = [
    { btn: document.getElementById("tabPlayBtn"), panel: document.getElementById("tabPlay") },
    { btn: document.getElementById("tabStatsBtn"), panel: document.getElementById("tabStats") },
    { btn: document.getElementById("tabSettingsBtn"), panel: document.getElementById("tabSettings") }
  ];

  const accountPanel = document.getElementById("accountPanel");
  const accountStatus = document.getElementById("accountStatus");
  const accountActions = document.getElementById("accountActions");
  const signInGoogleBtn = document.getElementById("signInGoogleBtn");
  const signInGuestBtn = document.getElementById("signInGuestBtn");
  const signOutBtn = document.getElementById("signOutBtn");
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
    // The "Default" skin has no colours of its own — it mirrors whichever
    // palette is active — so switching palettes must refresh its swatch too.
    if (state.skinIndex === 0) applySkin(0);
  }

  /* Cosmetic snake skins, layered on top of whichever palette is active.
   * Index 0 always means "use the active palette's own snake colours" —
   * shuffle never lands there, so Shuffle always visibly changes something,
   * and Reset always has one unambiguous colour to return to. Deliberately
   * separate from PALETTES: food/hazard/portal colours carry accessibility
   * meaning and must stay tied to the palette, but the snake's own body is
   * pure decoration, so it is safe to let players pick it independently. */
  const SKINS = [
    { name: "Default", colors: null, glow: null },
    { name: "Solar", colors: ["#ffd56a", "#ff6bd6"], glow: "rgba(255, 213, 106, 0.35)" },
    { name: "Venom", colors: ["#63ff95", "#009e73"], glow: "rgba(99, 255, 149, 0.35)" },
    { name: "Ice", colors: ["#bfeeff", "#57f8ff"], glow: "rgba(191, 238, 255, 0.35)" },
    { name: "Ember", colors: ["#ff5d76", "#ffd56a"], glow: "rgba(255, 93, 118, 0.35)" },
    { name: "Violet", colors: ["#a98bff", "#ff6bd6"], glow: "rgba(169, 139, 255, 0.35)" },
    { name: "Mono", colors: ["#f2f6fa", "#9db3c8"], glow: "rgba(242, 246, 250, 0.3)" }
  ];

  function activeSnakeColors() {
    const skin = SKINS[state.skinIndex] || SKINS[0];
    return skin.colors || COLORS.snake;
  }

  function activeSnakeGlow() {
    const skin = SKINS[state.skinIndex] || SKINS[0];
    return skin.glow || COLORS.snakeGlow;
  }

  function applySkin(index) {
    const clamped = SKINS[index] ? index : 0;
    state.skinIndex = clamped;
    const skin = SKINS[clamped];
    const colors = skin.colors || COLORS.snake;
    skinSwatch.style.background = `linear-gradient(135deg, ${colors[0]}, ${colors[1]})`;
    skinName.textContent = skin.name;
  }

  function shuffleSkin() {
    // Skip index 0 (Default) so Shuffle always produces a visible change,
    // and skip the current skin so repeated taps never look like a no-op.
    const pool = SKINS.map((_, i) => i).filter((i) => i !== 0 && i !== state.skinIndex);
    const next = pool[Math.floor(Math.random() * pool.length)];
    applySkin(next);
    savePreferences();
    audio.play("ui");
  }

  function resetSkin() {
    applySkin(0);
    savePreferences();
    audio.play("ui");
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
        case "bossCharge":
          this.tone(740, 0, 0.05, "triangle", 0.2);
          this.tone(1180, 0.045, 0.07, "triangle", 0.18);
          break;
        case "bossPhaseOpen":
          this.tone(220, 0, 0.32, "sawtooth", 0.2, 880);
          this.noise(0.04, 0.18, 0.12);
          break;
        case "bossAttackWarn":
          this.tone(600, 0, 0.08, "square", 0.2);
          this.tone(600, 0.16, 0.08, "square", 0.2);
          break;
        case "bossHit":
          this.noise(0, 0.24, 0.3);
          this.tone(160, 0, 0.3, "square", 0.32, 60);
          this.tone(880, 0.02, 0.1, "square", 0.2);
          break;
        case "bossDefeated":
          this.noise(0, 0.4, 0.34);
          [196, 262, 330, 392, 523, 659].forEach((f, i) => this.tone(f, i * 0.08, 0.3, "square", 0.28));
          this.tone(1046, 0.5, 0.8, "triangle", 0.32);
          break;
        case "rivalDown":
          // A descending sweep under a bright hit, so it reads as something
          // being destroyed rather than something being collected.
          this.noise(0, 0.3, 0.26);
          this.tone(880, 0, 0.28, "sawtooth", 0.24, 120);
          this.tone(1320, 0.04, 0.12, "square", 0.18);
          this.tone(660, 0.16, 0.22, "triangle", 0.2);
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
   * App shell: screens, drawer, fullscreen.
   *
   * The game used to be one long scrolling page with every panel stacked
   * down the right. Now it is three screens (welcome -> auth -> game) with
   * everything else behind a single drawer, which is what makes it read as
   * an app rather than a document.
   * --------------------------------------------------------------- */
  const SCREENS = { welcome: welcomeScreen, auth: authScreen, game: gameScreen };
  let activeScreen = "welcome";

  function showScreen(name) {
    const next = SCREENS[name];
    if (!next || activeScreen === name) return;
    const current = SCREENS[activeScreen];
    if (current) {
      current.classList.add("is-leaving");
      current.classList.remove("is-active");
      setTimeout(() => current.classList.remove("is-leaving"), 450);
    }
    next.classList.add("is-active");
    activeScreen = name;
    // The game dialog is a viewport-level element that starts out carrying
    // the `visible` class, so its CSS is keyed to this attribute to stop it
    // covering the welcome and sign-in screens.
    document.body.dataset.screen = name;
    // The canvas has no layout while its screen is hidden, so it must be
    // re-measured once the game screen is actually on-screen — otherwise it
    // keeps whatever size it had (often none) and draws blank.
    if (name === "game") requestAnimationFrame(resizeCanvas);
  }

  /* Rotating welcome lines. Deliberately a bit cocky — the game is hard,
     and the greeting sets expectations while being fun about it. */
  const GREETINGS = [
    "30 levels. 4 bosses. Roughly 400 chances to blame the controls.",
    "The snake gets longer. The room gets smaller. Good luck with that.",
    "Somewhere in here is a rival snake that has never heard of mercy.",
    "Rule one: don't bite yourself. You'd be amazed how often rule one loses.",
    "Every level is handmade. Every death is entirely your own work.",
    "Fair warning: tier four moves faster than your good intentions.",
    "You've played snake before. You have not played this snake before.",
    "The grid is patient. The drones are not. Let's begin.",
    "Deep breath. The first eight levels are the friendly ones.",
    "Yes, the arena closes in. No, it will not wait for you."
  ];

  function pickGreeting() {
    welcomeGreeting.textContent = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
  }

  function openDrawer() {
    document.body.classList.add("nav-open");
    navDrawer.setAttribute("aria-hidden", "false");
    navToggle.setAttribute("aria-expanded", "true");
    // A run should not keep going behind a menu the player is reading.
    if (state.running && !state.paused && !state.over && !state.won) togglePause();
  }

  function closeDrawer() {
    document.body.classList.remove("nav-open");
    navDrawer.setAttribute("aria-hidden", "true");
    navToggle.setAttribute("aria-expanded", "false");
  }

  function toggleDrawer() {
    audio.play("ui");
    if (document.body.classList.contains("nav-open")) closeDrawer();
    else openDrawer();
  }

  function selectTab(index) {
    drawerTabs.forEach((tab, i) => {
      const on = i === index;
      tab.btn.classList.toggle("active", on);
      tab.btn.setAttribute("aria-selected", on ? "true" : "false");
      tab.panel.classList.toggle("is-active", on);
    });
    audio.play("ui");
  }

  function isFullscreen() {
    return Boolean(document.fullscreenElement || document.webkitFullscreenElement);
  }

  /* Requested on the game screen rather than <body> so the drawer and the
     level-select dialog — both fixed-position siblings — stay usable.
     Prefixed calls are for older iOS Safari, which is also the platform
     most likely to actually want this. */
  function toggleFullscreen() {
    audio.play("ui");
    if (isFullscreen()) {
      (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document);
      return;
    }
    const el = gameScreen;
    const request = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!request) {
      // iOS Safari on iPhone has no Fullscreen API at all; installing the
      // PWA to the home screen is the real fullscreen route there.
      authStatus.textContent = "";
      return;
    }
    request.call(el).catch(() => {});
  }

  // Entering or leaving fullscreen changes the canvas box without firing a
  // window resize on every browser, so re-measure explicitly.
  document.addEventListener("fullscreenchange", () => requestAnimationFrame(resizeCanvas));
  document.addEventListener("webkitfullscreenchange", () => requestAnimationFrame(resizeCanvas));

  /* Consent gate.
   *
   * The agreement has to be an explicit act, not something inferred from
   * playing, so Enter stays disabled until the box is ticked. The answer is
   * remembered so returning players are not asked on every visit, and the
   * consent version is stored alongside it: if the policy materially
   * changes, bumping this asks everyone again rather than silently relying
   * on an agreement to a document that no longer exists.
   */
  const CONSENT_KEY = "neon-serpent-consent-v1";

  function hasConsented() {
    try {
      return localStorage.getItem(CONSENT_KEY) === "1";
    } catch {
      // Private browsing with storage blocked: treat as not consented, ask
      // each session rather than assuming agreement.
      return false;
    }
  }

  function recordConsent() {
    try {
      localStorage.setItem(CONSENT_KEY, "1");
    } catch {
      // Non-fatal — they can still play, they will just be asked again.
    }
  }

  function syncConsentUI() {
    const on = consentCheck.checked;
    enterBtn.disabled = !on;
    consentRow.classList.toggle("is-checked", on);
  }

  function exitToWelcome() {
    audio.play("ui");
    closeDrawer();
    if (isFullscreen()) {
      (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document);
    }
    // Bank whatever the run earned before leaving, then stop it so the game
    // is not still ticking behind the welcome screen.
    saveProgress();
    state.running = false;
    state.paused = false;
    overlay.classList.remove("visible");
    showScreen("welcome");
    pickGreeting();
  }

  function updateProfileUI(user) {
    const name = state.playerName || (user && !user.is_anonymous ? "Signed in" : "Guest");
    drawerWho.textContent = user
      ? (user.is_anonymous ? `${name} · guest` : name)
      : "Playing locally";
    profileName.textContent = name;
    profileAvatar.textContent = (state.playerName || "?").trim().charAt(0).toUpperCase() || "◉";
  }

  /* ------------------------------------------------------------------
   * Bootstrap: restore preferences, wire input, then start the loop.
   * --------------------------------------------------------------- */
  loadSave();
  applyPalette(state.palette);
  applySkin(state.skinIndex);
  renderDailyHistory();
  pickGreeting();
  updateProfileUI(null);
  document.body.dataset.screen = "welcome";
  // Returning players keep their answer; first-timers must tick the box.
  consentCheck.checked = hasConsented();
  syncConsentUI();
  initAccountUI();
  soundBtn.textContent = state.soundEnabled === false ? "Sound off" : "Sound on";
  audio.enabled = state.soundEnabled !== false;
  soundBtn.setAttribute("aria-pressed", audio.enabled ? "true" : "false");
  playerNameInput.value = state.playerName;
  unlockAllToggle.checked = state.unlockAll;
  updateBestDisplay();
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);

  /* The canvas resizes for reasons that never fire a window resize event:
     the overlay opening and closing, panels changing height, a phone's URL
     bar collapsing, entering fullscreen, the drawer sliding over it. Those
     left the backing store at its old size while CSS scaled the element —
     a stretched or blank board until something else happened to trigger a
     resize. Observing the element itself covers every one of those cases. */
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => resizeCanvas()).observe(canvas);
  }

  /* Coming back from a hidden tab: drop the stale timestamp so the next
     frame measures from now rather than from whenever the tab was last
     visible, and re-measure the canvas, which some mobile browsers resize
     while backgrounded. Pairs with MAX_FRAME_DELTA_MS in loop(). */
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    state.lastTime = 0;
    state.accumulator = 0;
    resizeCanvas();
  });
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
  overlayExitBtn.addEventListener("click", exitToWelcome);
  shareBtn.addEventListener("click", shareGame);
  shareCodeBtn.addEventListener("click", shareGame);
  checkpointBtn.addEventListener("click", resumeFromCheckpoint);
  soundBtn.addEventListener("click", toggleSound);
  paletteBtn.addEventListener("click", togglePalette);
  skinShuffleBtn.addEventListener("click", shuffleSkin);
  skinResetBtn.addEventListener("click", resetSkin);

  /* ---- app shell wiring ---- */
  consentCheck.addEventListener("change", syncConsentUI);

  // The disabled button swallows clicks, so the nudge is driven from the
  // wrapper. Without this, tapping a dead button explains nothing.
  consentRow.parentElement.addEventListener("click", (event) => {
    if (!enterBtn.disabled || !enterBtn.contains(event.target)) return;
    consentRow.classList.remove("nudge");
    void consentRow.offsetWidth;
    consentRow.classList.add("nudge");
  });

  enterBtn.addEventListener("click", () => {
    if (!consentCheck.checked) return;
    audio.init();
    audio.play("ui");
    recordConsent();
    // Someone with a session already does not need to be asked again.
    showScreen(isSupabaseConfigured && !getCurrentUser() ? "auth" : "game");
  });

  overlayCloseBtn.addEventListener("click", () => {
    audio.play("ui");
    overlay.classList.remove("visible");
  });

  exitGameBtn.addEventListener("click", exitToWelcome);

  authGoogleBtn.addEventListener("click", async () => {
    audio.play("ui");
    authStatus.textContent = "Redirecting to Google…";
    const { error } = await signInWithGoogle();
    if (error) authStatus.textContent = `Could not start Google sign-in: ${error}`;
  });

  authGuestBtn.addEventListener("click", async () => {
    audio.play("ui");
    authStatus.textContent = "Signing in…";
    const { error } = await signInAsGuest();
    if (error) {
      authStatus.textContent = `Could not sign in: ${error}`;
      return;
    }
    showScreen("game");
  });

  authSkipBtn.addEventListener("click", () => {
    audio.play("ui");
    showScreen("game");
  });

  navToggle.addEventListener("click", toggleDrawer);
  navClose.addEventListener("click", () => {
    audio.play("ui");
    closeDrawer();
  });
  navScrim.addEventListener("click", closeDrawer);
  drawerTabs.forEach((tab, i) => tab.btn.addEventListener("click", () => selectTab(i)));

  fullscreenBtn.addEventListener("click", toggleFullscreen);
  fullscreenBtn2.addEventListener("click", toggleFullscreen);

  // Choosing a level or restarting from inside the drawer should hand the
  // player straight back to the board rather than leaving the menu open
  // over the thing they just asked to see.
  levelsBtn.addEventListener("click", closeDrawer);
  restartBtn.addEventListener("click", closeDrawer);
  campaignBtn.addEventListener("click", closeDrawer);
  dailyBtn.addEventListener("click", closeDrawer);
  signInGoogleBtn.addEventListener("click", async () => {
    audio.play("ui");
    accountStatus.textContent = "Redirecting to Google…";
    const { error } = await signInWithGoogle();
    if (error) accountStatus.textContent = `Could not start Google sign-in: ${error}`;
  });
  signInGuestBtn.addEventListener("click", async () => {
    audio.play("ui");
    accountStatus.textContent = "Signing in…";
    const { error } = await signInAsGuest();
    if (error) accountStatus.textContent = `Could not sign in: ${error}`;
  });
  signOutBtn.addEventListener("click", async () => {
    audio.play("ui");
    await signOutCloud();
  });
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
    if (level.boss) card.classList.add("is-boss");
    // Dashed border marks a level only reachable because practice mode is on.
    if (unlocked && !earned) card.classList.add("is-practice");

    const top = document.createElement("div");
    top.className = "ls-card-top";

    const num = document.createElement("span");
    num.className = "ls-num";
    num.textContent = level.boss ? `☠ Level ${levelIndex + 1}` : `Level ${levelIndex + 1}`;

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
    if (level.boss) {
      const parts = [`${playerMovesPerSec(levelIndex)}/s`, `${level.target} hits`];
      if (level.enemies) parts.push(`hunting fragment @ ${rivalMovesPerSec(levelIndex)}/s`);
      if (level.hazards) parts.push(`${level.hazards} drone${level.hazards > 1 ? "s" : ""}`);
      return parts.join(" · ");
    }
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
    setPauseButton(false);
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
    if (getCurrentUser()) syncLevelProgress(state.levelStats);
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
    setPauseButton(false);
    playBtn.textContent = "Start Game";
    state.message = "Good luck. Stay in motion.";
    updateUI();
  }

  function resumeCurrent() {
    state.paused = false;
    overlayKicker.textContent = "Live run";
    overlay.classList.remove("visible");
    setPauseButton(false);
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
    setPauseButton(false);
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
    setPauseButton(false);
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
    setPauseButton(state.paused);
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

  /* Longest frame gap the fixed-step catch-up below will honour.
   *
   * requestAnimationFrame stops firing while a tab is hidden (switching
   * apps on a phone, locking the screen, answering a message), so the first
   * frame back can report a gap of many seconds. Feeding that straight into
   * the accumulator ran hundreds of simulation steps inside a single frame:
   * the page locked up for a beat and the snake effectively teleported —
   * usually into a wall. That is the "jams / loses visibility after a game"
   * report. Clamping to ~4 frames keeps genuine catch-up for an ordinary
   * dropped frame while making a long absence a pause rather than a
   * fast-forward. */
  const MAX_FRAME_DELTA_MS = 64;

  function loop(timestamp) {
    if (!state.lastTime) state.lastTime = timestamp;
    const dt = Math.min(timestamp - state.lastTime, MAX_FRAME_DELTA_MS);
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
    syncCanvasSize();
    draw();
    requestAnimationFrame(loop);
  }

  /* Safety net for the canvas backing store.
   *
   * ResizeObserver handles this properly and covers the cases a window
   * resize event misses (overlay opening, drawer sliding, fullscreen, a
   * phone's URL bar collapsing). This is the belt to that braces: if the
   * observer is unsupported, throttled, or simply never delivers, a stale
   * backing store means a blank or stretched board with no way to recover
   * short of another resize — which is exactly the failure being fixed.
   * Checked a few times a second rather than every frame, since reading
   * layout forces a reflow. */
  let sizeCheckCountdown = 0;

  function syncCanvasSize() {
    if (--sizeCheckCountdown > 0) return;
    sizeCheckCountdown = 30;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    if (Math.abs(rect.width - state.viewWidth) > 1 || Math.abs(rect.height - state.viewHeight) > 1) {
      resizeCanvas();
    }
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
    if (state.shakeTicks > 0) state.shakeTicks = Math.max(0, state.shakeTicks - scale);
    if (state.flashTicks > 0) state.flashTicks = Math.max(0, state.flashTicks - scale);
  }

  function draw() {
    const w = state.viewWidth;
    const h = state.viewHeight;
    const cell = cellSize();
    let ox = Math.floor((w - GRID.cols * cell) / 2);
    let oy = Math.floor((h - GRID.rows * cell) / 2);

    // A boss hit landing shakes the whole board briefly. Decays with
    // shakeTicks, so it settles to nothing on its own without needing a
    // separate cleanup step.
    if (state.shakeTicks > 0) {
      const power = state.shakeStrength * (state.shakeTicks / 10);
      ox += Math.round((Math.random() - 0.5) * power);
      oy += Math.round((Math.random() - 0.5) * power);
    }

    ctx.clearRect(0, 0, w, h);
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, COLORS.bg1);
    bg.addColorStop(1, COLORS.bg2);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    drawGrid(ox, oy, cell);
    drawWalls(ox, oy, cell);
    drawBoss(ox, oy, cell);
    drawBossCharges(ox, oy, cell);
    drawPortals(ox, oy, cell);
    drawHazards(ox, oy, cell);
    drawPowerups(ox, oy, cell);
    drawFood(ox, oy, cell);
    drawEnemies(ox, oy, cell);
    drawSnake(ox, oy, cell);
    drawParticles();
    drawFloating(ox, oy, cell);
    drawShrinkMask(ox, oy, cell);

    if (state.flashTicks > 0) {
      ctx.save();
      ctx.globalAlpha = Math.min(0.6, state.flashTicks / 6) * 0.6;
      ctx.fillStyle = state.flashColor;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }

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

  /* The boss's hitbox is a single grid cell (see reserveBossCore in
     engine.js) but the sprite spans several cells' worth of pixels — the
     collision model stays simple while the fight still looks like it is
     against something enormous. Two counter-rotating rings plus a core
     whose colour and pulse rate carry the phase: red and slow while
     shielded, brightening as shards are fed in, mint and fast the instant
     it cracks open. */
  function drawBoss(ox, oy, cell) {
    const boss = state.boss;
    if (!boss || boss.phase === "defeated") return;

    const cx = ox + boss.core.x * cell + cell / 2;
    const cy = oy + boss.core.y * cell + cell / 2;
    const charging = boss.phase === "charging";
    const chargeProgress = 1 - state.bossCharges.length / BOSS_SHARDS_PER_CYCLE;
    const attacking = boss.attackActiveTicks > 0;
    const telegraphing = boss.attackTelegraphTicks > 0;

    const shellColor = charging ? COLORS.hazard : COLORS.food;
    const ringColor = telegraphing || attacking ? COLORS.slow : shellColor;
    const pulseSpeed = charging ? 0.05 + chargeProgress * 0.12 : 0.24;
    const pulse = 1 + Math.sin(state.tick * pulseSpeed) * (charging ? 0.06 : 0.14);

    ctx.save();

    // Outer hex shell, rotating clockwise. Its radius breathes with the
    // charge cycle so filling the meter reads as the shield straining.
    const outerRadius = cell * (1.35 + chargeProgress * 0.12) * pulse;
    ctx.strokeStyle = ringColor;
    ctx.shadowColor = ringColor;
    ctx.shadowBlur = telegraphing ? 26 : 16;
    ctx.lineWidth = Math.max(2, cell * 0.08);
    tracePolygon(cx, cy, outerRadius, 6, state.tick * 0.025);
    ctx.stroke();

    // Inner ring, counter-rotating — the "scanline" layer.
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = Math.max(1.5, cell * 0.05);
    tracePolygon(cx, cy, cell * 0.95, 8, -state.tick * 0.045);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // A short arc sweeping around the shell reinforces the "scanning"
    // read even when nothing else is animating.
    ctx.beginPath();
    const sweep = state.tick * 0.08;
    ctx.arc(cx, cy, cell * 1.15, sweep, sweep + Math.PI * 0.35);
    ctx.stroke();

    // While the shield is up, its own core marker; drawFood() already draws
    // the exposed marker (state.food is the core position during that
    // window), so this only needs to cover the closed state.
    if (charging) {
      ctx.shadowBlur = 20;
      ctx.fillStyle = shellColor;
      ctx.globalAlpha = 0.55 + chargeProgress * 0.45;
      ctx.beginPath();
      ctx.arc(cx, cy, cell * (0.16 + chargeProgress * 0.08) * pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }

  // Charge shards: a faceted diamond distinct from every other pickup shape
  // already in use, coloured to match the boss's own palette so their
  // purpose reads as "feeds the boss fight" rather than a generic bonus.
  function drawBossCharges(ox, oy, cell) {
    for (const shard of state.bossCharges) {
      const px = ox + shard.x * cell + cell / 2;
      const py = oy + shard.y * cell + cell / 2;
      const pulse = 1 + Math.sin(state.tick * 0.2 + shard.x) * 0.1;
      ctx.save();
      ctx.fillStyle = COLORS.bonus;
      ctx.strokeStyle = COLORS.bonus;
      ctx.shadowColor = COLORS.bonus;
      ctx.shadowBlur = 16;
      tracePolygon(px, py, cell * 0.26 * pulse, 4, state.tick * 0.03);
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.6;
      tracePolygon(px, py, cell * 0.4 * pulse, 4, state.tick * 0.03);
      ctx.stroke();
      ctx.restore();
    }
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
    const snakeColors = activeSnakeColors();
    const snakeGlow = activeSnakeGlow();
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
      grad.addColorStop(0, head ? "#ffffff" : snakeColors[0]);
      grad.addColorStop(1, head ? snakeColors[0] : snakeColors[1]);
      ctx.shadowColor = snakeGlow;
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

    /* inShrinkZone blocks cells 0..margin inclusive, so the lethal band is
       margin + 1 cells deep. Shading only `margin` drew the cage one cell too
       large on every side: the ring just inside the line looked safe but
       killed you, and a core on the first legal cell appeared to sit outside
       the cage. The mask must mirror the collision rule exactly. */
    const band = (state.shrinkMargin + 1) * cell;
    const boardW = GRID.cols * cell;
    const boardH = GRID.rows * cell;

    ctx.fillRect(ox, oy, boardW, band);
    ctx.fillRect(ox, oy + boardH - band, boardW, band);
    ctx.fillRect(ox, oy, band, boardH);
    ctx.fillRect(ox + boardW - band, oy, band, boardH);

    ctx.strokeStyle = "rgba(255, 93, 118, 0.35)";
    ctx.lineWidth = 2;
    ctx.strokeRect(ox + band, oy + band, boardW - band * 2, boardH - band * 2);
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
    /* The inset used to be 8%, which on a phone was the difference between
       10px and 11px cells — a tenth of the board, given the shell now hugs
       the grid's own 3:2 shape instead of sitting inside a larger box. 4%
       still keeps the board clear of the shell's 22px rounded corners. */
    const availableW = state.viewWidth * 0.96;
    const availableH = state.viewHeight * 0.96;
    return Math.floor(Math.min(availableW / GRID.cols, availableH / GRID.rows));
  }

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    /* A zero-size rect means the canvas is not laid out yet or is currently
       hidden (a drawer covering it, a screen not shown yet). Writing 0 into
       canvas.width wipes the backing store and leaves a blank board even
       after the element comes back, so keep the last good size instead —
       the ResizeObserver below fires again with real numbers the moment it
       has them. */
    if (rect.width < 1 || rect.height < 1) return;

    const scale = Math.max(1, window.devicePixelRatio || 1);
    state.viewWidth = rect.width;
    state.viewHeight = rect.height;
    state.pixelRatio = scale;
    canvas.width = Math.floor(rect.width * scale);
    canvas.height = Math.floor(rect.height * scale);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
  }

  // Describes whichever half of the boss loop is currently live, so the
  // mission panel always says something actionable rather than a static
  // "defeat the boss" the whole fight.
  function bossMissionLine() {
    const boss = state.boss;
    if (!boss) return "";
    const remaining = boss.hitsRequired - boss.hitsTaken;
    if (boss.phase === "exposed") {
      return `CORE EXPOSED — reach it before the shield reforms! (${remaining} hit${remaining === 1 ? "" : "s"} left)`;
    }
    const eaten = BOSS_SHARDS_PER_CYCLE - state.bossCharges.length;
    return `Feed the core ${eaten}/${BOSS_SHARDS_PER_CYCLE} charge shards to crack the shield. ${remaining} hit${remaining === 1 ? "" : "s"} to win.`;
  }

  let lastShownScore = 0;

  function updateHUD() {
    levelLabel.textContent = state.levelIndex + 1;

    const scoreText = formatNumber(state.score);
    if (scoreLabel.textContent !== scoreText) {
      scoreLabel.textContent = scoreText;
      // Only celebrate going up — losing a life should not look like a win.
      if (state.score > lastShownScore) {
        scoreLabel.classList.remove("bump");
        // Reading offsetWidth forces the class removal to take effect before
        // it is re-added, which is what lets the animation retrigger on
        // consecutive pickups instead of only playing once.
        void scoreLabel.offsetWidth;
        scoreLabel.classList.add("bump");
      }
      lastShownScore = state.score;
    }

    livesLabel.textContent = String(state.lives);
    if (state.mode === "daily") {
      challengeCode.textContent = state.seed;
      seedLabel.textContent = state.seed.replace("daily-", "");
    } else {
      challengeCode.textContent = "Campaign mode";
      seedLabel.textContent = "Campaign";
    }
    const timerValue = state.currentLevel?.boss
      ? "No stage timer — the boss sets the pace."
      : state.timerLeft == null
        ? "No time limit on this stage."
        : `${Math.ceil(state.timerLeft)}s remaining.`;
    timerText.textContent = timerValue;

    const missionBits = state.boss
      ? [bossMissionLine()]
      : [`Collect ${state.missionGoal} cores to unlock the next level.`];
    if (state.currentLevel?.mirror) missionBits.push("Left and right are mirrored on this stage — up and down are normal.");
    if (isPracticeRun()) missionBits.push(`Practice run from level ${state.runStartLevel + 1} — not posted.`);
    missionText.textContent = missionBits.join(" ");
    // The ticker under the board is the only mission copy visible while the
    // drawer is closed, which is most of the time.
    missionTicker.textContent = state.boss
      ? bossMissionLine()
      : `${missionBits[0]}${state.timerLeft != null ? ` · ${Math.ceil(state.timerLeft)}s` : ""}`;
    const progress = Math.max(0, Math.min(1, state.missionGoal ? state.mission / state.missionGoal : 0));
    missionFill.style.width = `${Math.floor(progress * 100)}%`;
  }

  const BOSS_ATTACK_LABELS = {
    none: "None — this fight is the tutorial for the loop itself",
    mirror: "Periodically flips left/right while the shield is up",
    shrink: "Periodically compresses the cage, then releases it",
    combo: "Alternates flipped steering and cage compression, plus a hunting fragment"
  };

  function updateLevelPanel() {
    const level = state.currentLevel || LEVELS[0];
    levelName.textContent = level.name;
    levelDesc.textContent = level.desc;
    modifierList.innerHTML = "";

    const modifiers = level.boss
      ? [
          `Tier: ${tierForLevel(state.levelIndex).name}`,
          `Speed: ${playerMovesPerSec(state.levelIndex)} moves/sec`,
          `Hits to defeat: ${state.missionGoal}`,
          `Charge shards per cycle: ${BOSS_SHARDS_PER_CYCLE}`,
          `Attack: ${BOSS_ATTACK_LABELS[state.boss?.def.attack] || BOSS_ATTACK_LABELS[level.boss] || "—"}`,
          level.enemies ? `Hunting fragment: 1 at ${rivalMovesPerSec(state.levelIndex)} moves/sec` : "Hunting fragment: none",
          `Ambient drones: ${level.hazards}`
        ]
      : [
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
      skinIndex: state.skinIndex,
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
      skinIndex: state.skinIndex,
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
    const skinIdx = Number(data.skinIndex);
    state.skinIndex = Number.isInteger(skinIdx) && SKINS[skinIdx] ? skinIdx : 0;
    state.dailyHistory = Array.isArray(data.dailyHistory) ? data.dailyHistory : [];
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
    if (getCurrentUser()) setCloudDisplayName(cleaned);
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

  // Supabase first when a project is configured — it works on a static
  // deploy with no server.js, which is where the game actually lives once
  // hosted. /api/scores stays as the fallback for local development without
  // a Supabase project set up, and for the (unlikely) case the Supabase
  // fetch itself fails.
  async function refreshLeaderboard() {
    const tab = state.leaderboardTab;
    const seed = tab === "daily" ? currentDailySeed() : "campaign";

    if (isSupabaseConfigured) {
      const cloudScores = await fetchCloudLeaderboard(tab, seed);
      if (cloudScores) {
        state.leaderboardOnline = true;
        renderLeaderboard(cloudScores);
        return;
      }
    }

    const params = new URLSearchParams({ mode: tab, seed });
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
      li.textContent = isSupabaseConfigured
        ? "Could not reach the leaderboard."
        : "Offline — run server.js to enable the shared leaderboard.";
      leaderboardList.appendChild(li);
    }
  }

  // Reconciles local campaign progress with the cloud in both directions:
  // pulls down anything cleared on another device (merged via the same
  // "higher wins" rule as mergeLevelStats, so it can only ever gain ground),
  // then pushes the merged result back up so both sides agree. Runs once
  // per sign-in; incremental per-level pushes happen from
  // recordLevelCleared instead of re-running this whole reconciliation.
  async function syncProgressWithCloud() {
    const cloudStats = await fetchCloudLevelProgress();
    if (cloudStats) {
      state.levelStats = mergeLevelStats(state.levelStats, cloudStats);
      saveProgress();
      if (levelSelect.classList.contains("is-open")) renderLevelSelect();
    }
    syncLevelProgress(state.levelStats);
  }

  function initAccountUI() {
    if (!isSupabaseConfigured) return;
    accountPanel.classList.remove("is-hidden");
    restoreSession();
    onAuthChange((user) => {
      if (user) {
        accountStatus.textContent = user.is_anonymous
          ? "Playing as a guest — sign in with Google any time to keep this progress."
          : `Signed in${user.email ? ` as ${user.email}` : ""}.`;
        accountActions.classList.add("is-hidden");
        signOutBtn.classList.remove("is-hidden");
        syncProgressWithCloud();
        // Returning from the Google redirect lands back on the welcome
        // screen with a live session; carry straight on to the game rather
        // than asking someone who just signed in to sign in again.
        if (activeScreen === "auth") showScreen("game");
      } else {
        accountStatus.textContent = "Playing locally — sign in to sync progress across devices and post to the live leaderboard.";
        accountActions.classList.remove("is-hidden");
        signOutBtn.classList.add("is-hidden");
      }
      updateProfileUI(user);
      refreshLeaderboard();
    });
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

  function renderDailyHistory() {
    dailyHistoryList.innerHTML = "";
    const history = state.dailyHistory || [];
    if (!history.length) {
      const li = document.createElement("li");
      li.className = "lb-empty";
      li.textContent = "No Daily Rift runs yet.";
      dailyHistoryList.appendChild(li);
      return;
    }
    history.slice(0, 5).forEach((entry) => {
      const li = document.createElement("li");

      const date = document.createElement("span");
      date.className = "lb-rank";
      // "daily-2026-08-12" -> "08-12": full ISO date is too wide for the
      // narrow rank column this reuses from the leaderboard list styling.
      date.textContent = entry.seed.replace("daily-", "").slice(5);

      const level = document.createElement("span");
      level.className = "lb-name";
      level.textContent = `Level ${entry.level}`;

      const score = document.createElement("span");
      score.className = "lb-score";
      score.textContent = formatNumber(entry.score);

      li.append(date, level, score);
      dailyHistoryList.appendChild(li);
    });
  }

  // Local-only history, independent of the online leaderboard: one entry per
  // daily seed (one per day), keeping the better of two attempts on the same
  // day rather than appending duplicates. Recorded for every daily run that
  // scores above zero, including practice runs that never hit the leaderboard.
  function recordDailyRun(score, levelReached) {
    if (state.mode !== "daily" || score <= 0) return;
    const previous = readSave();
    const history = Array.isArray(previous.dailyHistory) ? previous.dailyHistory.slice() : [];
    const entry = {
      seed: state.seed,
      score: Math.floor(score),
      level: Math.max(1, Math.min(LEVELS.length, Math.floor(levelReached)))
    };
    const existingIndex = history.findIndex((item) => item.seed === entry.seed);
    if (existingIndex !== -1) {
      if (entry.score > history[existingIndex].score) history[existingIndex] = entry;
    } else {
      history.unshift(entry);
    }
    history.sort((a, b) => b.seed.localeCompare(a.seed));
    const trimmed = history.slice(0, 10);
    writeSave({ ...previous, dailyHistory: trimmed });
    state.dailyHistory = trimmed;
    renderDailyHistory();
  }

  // Web Share API when the platform has it (mobile browsers, mostly), with a
  // clipboard-copy fallback everywhere else — mirrors Google Snake's share
  // button, which behaves the same way. Message adapts to context: a daily
  // code invites a friend to beat it, anything else brags about the score.
  async function shareGame() {
    const url = location.href.split("#")[0];
    const isDaily = state.mode === "daily";
    const text = isDaily
      ? `Beat my Daily Rift run on Neon Serpent 30 — code ${state.seed}, score ${formatNumber(state.score)}.`
      : `I scored ${formatNumber(state.score)} on Neon Serpent 30 (level ${state.levelIndex + 1}). Can you beat it?`;

    if (navigator.share) {
      try {
        await navigator.share({ title: "Neon Serpent 30", text, url });
        return;
      } catch {
        // Cancelled or unsupported mid-call — fall through to clipboard.
      }
    }
    try {
      await navigator.clipboard.writeText(`${text} ${url}`);
      state.message = "Share text copied to clipboard.";
      overlayText.textContent = "Share text copied to clipboard — paste it anywhere.";
      overlay.classList.add("visible");
      setTimeout(() => {
        if (state.running && !state.paused && !state.over && !state.won) {
          overlay.classList.remove("visible");
        }
      }, 1200);
    } catch {
      overlayText.textContent = `Clipboard unavailable. ${text} ${url}`;
      overlay.classList.add("visible");
    }
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

    const score = Math.floor(state.score);
    const level = Math.max(1, Math.min(LEVELS.length, Math.floor(levelReached)));
    const mode = state.mode;
    const seed = mode === "daily" ? state.seed : "campaign";

    // Cloud path: only once actually signed in, so an anonymous local
    // preference name never quietly attaches to a fabricated identity. Local
    // /api/scores stays the only path when Supabase isn't configured at all
    // (or has no live user yet), same behaviour as before this existed.
    if (isSupabaseConfigured && getCurrentUser()) {
      const { posted, error } = await postRunToCloud({
        mode,
        seed,
        score,
        level,
        startedLevel: state.runStartLevel
      });
      state.leaderboardOnline = posted;
      lbStatus.textContent = posted
        ? "Run posted to the leaderboard."
        : `Could not post the run${error ? `: ${error}` : "."}`;
      if (posted) setLeaderboardTab(mode);
      return;
    }

    const payload = { name: state.playerName, score, level, mode, seed };

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
