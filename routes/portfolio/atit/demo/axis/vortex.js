// The vortex face, the same one the Waveshare board draws (firmware/waveshare-amoled-1.8/src/vortex.cpp):
// dots on three spiral arms that spin slowly when idle, pull inward and go green to listen, spin
// fast and violet to think, and open and pulse with the voice to speak. Looks and colours are
// copied from the firmware so a browser and a board look like the same thing. The specification
// is docs/face.md; change it, this file and vortex.cpp together.

import { ICONS, ICON_DOTS, ICON_HOLE, ICON_MS, ICON_PEN, ICON_SIZE, ICON_TINTS, SHAPE_DOT, SHAPE_DOTS_MIN, SHAPE_HALO, SHAPE_SIZE, iconDots } from "./icons.js";

/** How an icon is shown while thinking: not at all, drawn with a pen at the core, or made of the face's own dots. */
export const ICON_STYLES = ["off", "line", "dots"];

const SIZE = 240; // the firmware's drawing size; everything below is in its units
const ARMS = 3;
const DOTS_PER_ARM = 26;
const MAX_RADIUS = SIZE / 2 - 14;
const KEYS = ["spin", "radius", "twist", "pulse", "pulseHz", "wander", "sparkle", "dot", "r", "g", "b", "wave", "tilt"];

// `wave` is how far the arms sway (radians at the tip) and `tilt` how far the figure is tipped away; most looks use neither.
const look = (spin, radius, twist, pulse, pulseHz, wander, sparkle, dot, r, g, b, wave = 0, tilt = 0) => ({ spin, radius, twist, pulse, pulseHz, wander, sparkle, dot, r, g, b, wave, tilt });

/** The fields of a look, in the order docs/face.md lists them. */
export const LOOK_FIELDS = KEYS;

// Idle picks among these at random, so it does not look like a loop.
export const IDLE = [
  ["calm", look(0.5, 0.85, 0.9, 0.03, 0.25, 0, 0, 1.0, 0.1, 0.78, 0.95)],
  ["breathe", look(0.35, 0.8, 0.8, 0.2, 0.18, 0, 0, 1.1, 0.15, 0.6, 1.0)],
  ["unwind", look(-0.4, 0.95, 1.25, 0.04, 0.3, 0, 0, 0.9, 0.2, 0.85, 0.8)],
  ["open", look(0.8, 1.0, 0.45, 0.05, 0.3, 0, 0, 1.2, 0.05, 0.7, 1.0)],
  ["curl", look(1.1, 0.58, 1.7, 0.05, 0.4, 0, 0, 0.9, 0.3, 0.55, 1.0)],
  ["drift", look(0.45, 0.75, 1.0, 0.04, 0.25, 14, 0, 1.0, 0.1, 0.85, 0.85)],
  ["shimmer", look(0.3, 0.88, 1.1, 0.03, 0.25, 0, 0.035, 1.0, 0.35, 0.75, 1.0)],
  ["galaxy", look(0.6, 0.95, 1.15, 0.03, 0.25, 0, 0.012, 0.95, 0.4, 0.65, 1, 0, 0.55)],
  ["tendril", look(0.25, 0.9, 0.7, 0.04, 0.3, 0, 0, 1, 0.1, 0.9, 0.75, 0.45, 0)],
  ["bloom", look(0.2, 0.7, 0.35, 0.14, 0.22, 0, 0, 1.6, 0.25, 0.7, 1, 0, 0)],
  ["pinwheel", look(1.4, 0.92, 0.18, 0.03, 0.3, 0, 0, 0.8, 0.1, 0.8, 1, 0, 0)],
  ["deep", look(0.28, 0.66, 1.4, 0.1, 0.15, 8, 0, 1.15, 0.1, 0.4, 1, 0.2, 0.25)],
  ["orbit", look(0.9, 1, 0.5, 0.03, 0.3, 0, 0, 1.1, 0.15, 0.75, 0.95, 0, 0.45)],
  ["sway", look(0.1, 0.85, 0.95, 0.05, 0.2, 0, 0, 1, 0.2, 0.85, 0.9, 0.7, 0)],
];

export const LOOKS = {
  setup: look(0.3, 0.7, 0.9, 0.1, 0.3, 0, 0, 1.0, 1.0, 0.65, 0.1),
  offline: look(0.18, 0.55, 1.1, 0.03, 0.2, 0, 0, 0.9, 0.3, 0.34, 0.42),
  listening: look(1.6, 0.45, 1.8, 0.08, 1.2, 0, 0, 1.2, 0.15, 1.0, 0.55),
  thinking: look(4.6, 0.78, 1.3, 0.05, 0.9, 0, 0.02, 0.9, 0.62, 0.4, 1.0),
  speaking: look(1.1, 0.78, 0.75, 0.22, 2.4, 0, 0, 1.2, 0.55, 0.95, 1.0),
  error: look(0.15, 0.62, 0.7, 0.12, 0.5, 5, 0, 1.0, 1.0, 0.18, 0.12),
};

/**
 * Looks for a run that is held up while the face is thinking: the agent says why, and the face shows
 * it by how it moves, with no icon. docs/face.md section 9.
 */
export const HELD = {
  compacting: look(0.9, 0.42, 2.4, 0.14, 0.5, 0, 0, 1.0, 0.35, 0.55, 1.0),
  retrying: look(-2.2, 0.7, 1.0, 0.1, 1.6, 0, 0, 1.0, 1.0, 0.7, 0.25),
};

export class Vortex {
  /** Draws into `canvas` until stopped. Modes: setup, offline, idle, listening, thinking, speaking, error. */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.mode = "offline";
    this.now = { ...LOOKS.offline };
    this.target = { ...LOOKS.offline };
    this.idleIndex = 0;
    this.idleRemaining = 0;
    this.phase = 0;
    this.pulsePhase = 0;
    this.wanderPhase = 0;
    this.wavePhase = 0;
    this.tiltPhase = 0;
    this.level = -1;
    // What the agent is doing while it thinks, as an icon in the middle; and how far it has faded in.
    this.icon = undefined;
    this.iconShown = 0;
    this.iconStyle = "dots";
    this.iconMs = ICON_MS;
    this.iconDots = ICON_DOTS;
    this.flowPhase = 0;
    this.flash = new Float32Array(ARMS * DOTS_PER_ARM);
    this.last = 0;
    // Someone who asked for less motion gets the same face, turning slowly and without sparkle.
    this.calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    this.frame = this.frame.bind(this);
    requestAnimationFrame(this.frame);
  }

  /**
   * Shows one look and stays on it, for a viewer: no drifting between idle looks. `mode` decides how
   * the look is drawn (easing speed, the larger core while listening, whether a voice level is used).
   */
  hold(look, mode = "idle") {
    this.mode = mode;
    this.held = true;
    this.target = { ...look };
  }

  /** Stops drawing for good, when the canvas is taken off the page. */
  stop() {
    this.stopped = true;
  }

  setMode(mode) {
    this.held = false;
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === "idle") this.pickIdle();
    else this.target = { ...(LOOKS[mode] ?? LOOKS.offline) };
  }

  /**
   * The kind of work to show in the middle while thinking (a name from icons.js), or nothing.
   * A name this face has no icon for is nothing.
   */
  setIcon(name) {
    const known = name && ICONS[name] ? name : undefined;
    if (known) {
      // The one on show stays drawn while it fades, so only a new one replaces it.
      this.iconStrokes = ICONS[known];
      this.iconPoints = iconDots(known);
      this.iconTint = ICON_TINTS[known] ?? [1, 1, 1];
    }
    this.icon = known;
  }

  /**
   * What Axis says the agent is doing while it thinks (`doing` on a `turn`): a kind of tool, shown
   * as an icon; a reason its run is held up, shown as a look; or nothing, which is plain thinking.
   */
  setDoing(name) {
    const held = name ? HELD[name] : undefined;
    this.setIcon(held ? undefined : name);
    if (this.mode === "thinking" && !this.held) this.target = { ...(held ?? LOOKS.thinking) };
  }

  /** How icons are shown: "off", "line" or "dots" (the `toolIcons` setting). Anything else is "dots". */
  setIconStyle(style) {
    this.iconStyle = ICON_STYLES.includes(style) ? style : "dots";
  }

  /**
   * How long an icon takes to form and to go, in milliseconds (the `toolIconMs` setting), and how many
   * of the dots draw a dot shape (`toolIconDots`). Anything that is not a number leaves the usual.
   */
  setIconTuning(ms, dots) {
    this.iconMs = Number.isFinite(Number(ms)) && ms !== null && ms !== "" ? Math.min(3000, Math.max(150, Number(ms))) : ICON_MS;
    this.iconDots = Number.isFinite(Number(dots)) && dots !== null && dots !== "" ? Math.min(ICON_DOTS, Math.max(SHAPE_DOTS_MIN, Math.round(Number(dots)))) : ICON_DOTS;
  }

  /** Loudness of the voice, 0 to 1. Negative: not known, the face pulses on its own. */
  setLevel(level) {
    this.level = level;
  }

  /**
   * Idle looks to leave out, as a list of names or one string with commas (the `idleLooksOff` setting).
   * Names it does not know are ignored, and if every look is named the first one stays, so there is always one.
   */
  setIdleOff(names) {
    const off = new Set((Array.isArray(names) ? names : String(names ?? "").split(",")).map((n) => String(n).trim().toLowerCase()).filter(Boolean));
    this.idleOn = IDLE.map(([name], index) => (off.has(name) ? -1 : index)).filter((index) => index >= 0);
    if (!this.idleOn.length) this.idleOn = [0];
    // A look just switched off should not stay on screen until its time runs out.
    if (this.mode === "idle" && !this.held && !this.idleOn.includes(this.idleIndex)) this.pickIdle();
  }

  pickIdle() {
    const on = this.idleOn ?? IDLE.map((_, index) => index);
    let next = this.idleIndex;
    // Never the same look twice in a row, unless it is the only one left on.
    while (next === this.idleIndex || !on.includes(next)) {
      next = on[Math.floor(Math.random() * on.length)];
      if (on.length === 1) break;
    }
    this.idleIndex = next;
    this.idleRemaining = 7 + Math.random() * 10;
    this.target = { ...IDLE[next][1] };
  }

  frame(time) {
    if (this.stopped) return;
    requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, this.last ? (time - this.last) / 1000 : 0);
    this.last = time;
    this.fit();
    this.draw(dt);
  }

  /** Keeps the drawing sharp at whatever size and pixel density the page gives the canvas. */
  fit() {
    const ratio = window.devicePixelRatio || 1;
    const side = Math.round(this.canvas.clientWidth * ratio);
    if (side && (this.canvas.width !== side || this.canvas.height !== side)) {
      this.canvas.width = side;
      this.canvas.height = side;
    }
  }

  draw(dt) {
    const { ctx, canvas } = this;
    if (this.mode === "idle" && !this.held) {
      this.idleRemaining -= dt;
      if (this.idleRemaining <= 0) this.pickIdle();
    }
    // Leaving idle should feel immediate; drifting between idle looks should not.
    const rate = this.mode === "idle" ? 1.2 : 5.0;
    const k = 1 - Math.exp(-dt * rate);
    for (const key of KEYS) this.now[key] += (this.target[key] - this.now[key]) * k;
    const now = this.now;
    // The icon is only ever there while thinking, and comes and goes quickly.
    const wantIcon = this.mode === "thinking" && this.icon && this.iconStyle !== "off" ? 1 : 0;
    // Easing covers all but the last sixtieth in 4.2 time constants: that is when it counts as there.
    this.iconShown += (wantIcon - this.iconShown) * (1 - Math.exp((-dt * 4.2 * 1000) / this.iconMs));
    // Easing never quite arrives; close enough is there, or a speck of the core would stay for good.
    const eye = this.iconShown < 0.01 ? 0 : this.iconShown > 0.985 ? 1 : this.iconShown;
    // The style on show stays the one drawn while it fades, like the icon itself.
    if (wantIcon) this.iconDrawnStyle = this.iconStyle;
    const asDots = this.iconDrawnStyle === "dots" && this.iconPoints;
    // Drawn with a pen, the arms stand back from the centre to leave it room. Made of dots, the arms are the icon.
    const hole = asDots ? 0 : ICON_HOLE * eye;
    this.flowPhase += 5 * dt;
    // A dot shape breathes with the figure and sways a little, so it never sits still.
    const shapeUnit = (SHAPE_SIZE / 24) * (1 + 0.05 * Math.sin(this.pulsePhase));
    const sway = 0.07 * Math.sin(this.wavePhase), swayCos = Math.cos(sway), swaySin = Math.sin(sway);
    const tint = this.iconTint ?? [1, 1, 1];
    const shapeColor = [0, 1, 2].map((c) => (0.55 + [now.r, now.g, now.b][c] * 0.45) * 0.6 + tint[c] * 0.4);

    const motion = this.calm ? 0.3 : 1;
    this.phase += now.spin * dt * motion;
    this.pulsePhase += now.pulseHz * 2 * Math.PI * dt * motion;
    this.wanderPhase += 0.6 * dt * motion;
    this.wavePhase += 1.3 * dt * motion;
    this.tiltPhase += 0.15 * dt * motion;

    // With a known loudness, the voice drives the size instead of a sine wave.
    const voiced = (this.mode === "speaking" || this.mode === "listening") && this.level >= 0;
    const voiceSwell = this.mode === "listening" ? 0.4 : now.pulse;
    const cx = SIZE / 2 + now.wander * Math.sin(this.wanderPhase);
    const cy = SIZE / 2 + now.wander * Math.sin(this.wanderPhase * 1.7 + 1);

    // A tipped figure is squashed along one axis, and that axis turns slowly.
    const axisCos = Math.cos(this.tiltPhase), axisSin = Math.sin(this.tiltPhase), squash = 1 - now.tilt;

    const scale = canvas.width / SIZE;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    // Overlapping dots add up to light, the way they glow on the board's panel.
    ctx.globalCompositeOperation = "lighter";

    const color = (r, g, b) => `rgb(${clamp(r) * 255 | 0},${clamp(g) * 255 | 0},${clamp(b) * 255 | 0})`;
    for (let arm = 0; arm < ARMS; arm++) {
      // Outer dots first, so the bright inner ones are drawn on top.
      for (let i = DOTS_PER_ARM - 1; i >= 0; i--) {
        const t = (i + 1) / DOTS_PER_ARM;
        const at = arm * DOTS_PER_ARM + i;
        if (!this.calm && now.sparkle > 0 && Math.random() < now.sparkle) this.flash[at] = 1;
        this.flash[at] *= 0.86;
        const spark = this.flash[at];

        const swell = voiced ? voiceSwell * this.level : now.pulse * Math.sin(this.pulsePhase - t * 3);
        // The arms take turns along an icon's strokes, the inner dots first. With fewer dots in the
        // shape than there are, the outer ones stand off in a ring round it and go on turning.
        const n = i * ARMS + arm;
        const inShape = asDots && n < this.iconDots;
        const room = asDots ? (inShape ? 0 : SHAPE_HALO * eye) : hole;
        const reach = MAX_RADIUS * now.radius * (1 + swell);
        const radius = room + Math.max(0, reach - room) * Math.pow(t, 0.85);
        // The sway runs out along the arm like a wave, and is widest at the tip.
        const angle = this.phase + arm * ((2 * Math.PI) / ARMS) - now.twist * 2 * Math.PI * t + now.wave * t * Math.sin(this.wavePhase - t * 7);
        const glow = Math.min(1, 1 - 0.72 * t + spark);
        const x = radius * Math.cos(angle), y = radius * Math.sin(angle);
        const along = x * axisCos + y * axisSin, across = (y * axisCos - x * axisSin) * squash;
        let px = cx + along * axisCos - across * axisSin, py = cy + along * axisSin + across * axisCos;
        let size = now.dot * (1.4 + 4.2 * t);
        let red = now.r * glow + spark * 0.5, green = now.g * glow + spark * 0.5, blue = now.b * glow + spark * 0.5;
        if (inShape && eye > 0) {
          // Each dot of the shape has a place on the icon, spread evenly over its strokes. It goes there
          // by the straight way, and a wave of light runs along the strokes once it has arrived.
          const at = Math.floor((n * ICON_DOTS) / this.iconDots);
          const ix = (this.iconPoints[at * 2] - 12) * shapeUnit, iy = (this.iconPoints[at * 2 + 1] - 12) * shapeUnit;
          px += (SIZE / 2 + ix * swayCos - iy * swaySin - px) * eye;
          py += (SIZE / 2 + ix * swaySin + iy * swayCos - py) * eye;
          size += (SHAPE_DOT - size) * eye;
          const lit = 0.62 + 0.38 * Math.sin(this.flowPhase - at * 0.33) + spark * 0.5;
          red += (shapeColor[0] * lit - red) * eye;
          green += (shapeColor[1] * lit - green) * eye;
          blue += (shapeColor[2] * lit - blue) * eye;
        }
        ctx.fillStyle = color(red, green, blue);
        ctx.beginPath();
        ctx.arc(px, py, size, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
    const core = 7 + (this.mode === "listening" ? 6 : 3) * (voiced ? this.level : Math.sin(this.pulsePhase));
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = color(0.55 + now.r * 0.45, 0.55 + now.g * 0.45, 0.55 + now.b * 0.45);
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, core * (1 - eye)), 0, 2 * Math.PI);
    if (eye < 1) ctx.fill();
    if (eye > 0 && !asDots) {
      // The icon takes the core's place and its colour, breathing a little with the figure.
      const size = ICON_SIZE * (1 + 0.04 * Math.sin(this.pulsePhase)), unit = size / 24;
      ctx.globalAlpha = eye;
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = ICON_PEN;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      for (const stroke of this.iconStrokes ?? []) {
        for (let i = 0; i < stroke.length; i += 2) {
          const x = cx + (stroke[i] - 12) * unit, y = cy + (stroke[i + 1] - 12) * unit;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
}

const clamp = (v) => Math.min(1, Math.max(0, v));
