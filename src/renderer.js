/**
 * Generative canvas renderer for the synesthesia artwork.
 *
 * Philosophy:
 *  - The music is the composer; the renderer is the instrument.
 *  - Audio features (bass, mids, treble, energy, onsets, brightness, warmth)
 *    drive *what* appears, *how it moves*, and *what color* it wears.
 *  - A per-track seed keeps each piece visually identifiable across replays.
 *  - The output is painterly and evolving, not a static waveform dump.
 *
 * Visual vocabulary (chosen for emotional resonance with sound):
 *  - Warm, low-frequency energy → broad, glowing color fields and soft blooms.
 *  - Bright, high-frequency content → sparkle, grain, thin strokes, halos.
 *  - Sudden onsets (beats) → pulses, flares, ripples, particles.
 *  - Energy / loudness → scale, saturation, motion intensity.
 *  - Brightness → overall lightness and hue spread.
 *  - Warmth → hue bias toward warm or cool.
 *
 * The renderer maintains its own internal state so the artwork keeps changing
 * even on a loop, while remaining tied to the audio frame stream.
 */

const Renderer = (() => {
  /** @type {HTMLCanvasElement | null} */
  let canvas = null;
  /** @type {CanvasRenderingContext2D | null} */
  let ctx = null;

  /** Internal animation state. */
  const state = {
    t: 0,            // accumulated "art time" (independent of audio, but faster/slower with energy)
    phase: 0,
    particles: [],
    blooms: [],
    strokes: [],
    pulse: 0,
    seed: 0,
    hueBase: 0,
    hueSpread: 0,
    bg: { r: 0, g: 0, b: 0 },
    palette: [],
  };

  /** Current audio frame forwarded from the pipeline. */
  const audio = {
    energy: 0,
    bass: 0,
    mid: 0,
    treble: 0,
    onsets: 0,
    brightness: 0,
    warmth: 0,
    loudness: 0,
  };

  /** Per-track features. */
  const features = {
    bpm: 0,
    energy: 0.5,
    brightness: 0.5,
    warmth: 0.5,
    spectralCentroid: 0.5,
    duration: 0,
  };

  /** Callbacks. */
  /** @type {((hueBase: number, hueSpread: number, palette: string[]) => void) | null} */
  let onPalette = null;

  /** @type {((stats: Stats) => void) | null} */
  let onStats = null;

  /** @type {(() => void) | null} */
  let onStart = null;

  /** Shared random with a seed so each track is reproducible. */
  let rng = Math.random;

  function setCallbacks({ onPalette: op, onStats: os, onStart: ost }) {
    if (op) onPalette = op;
    if (os) onStats = os;
    if (ost) onStart = ost;
  }

  function seedRng(s) {
    // Simple mulberry32.
    let a = s | 0;
    rng = () => {
      a |= 0; a = a + 0x6d2b79f5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // ---- Setup ----

  function attach(c) {
    canvas = c;
    ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: false });
    if (!ctx) throw new Error("Canvas 2d context unavailable");
    // Ensure high-DPI crispness without changing internal coordinate space.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.width;
    const h = canvas.height;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.scale(dpr, dpr);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
  }

  function clear() {
    if (!ctx || !canvas) return;
    const w = canvas.width / (Math.min(window.devicePixelRatio || 1, 2) || 1);
    const h = canvas.height / (Math.min(window.devicePixelRatio || 1, 2) || 1);
    ctx.clearRect(0, 0, w, h);
    state.particles = [];
    state.blooms = [];
    state.strokes = [];
    state.t = 0;
    state.phase = 0;
    state.pulse = 0;
  }

  // ---- Palette from audio ----

  function derivePalette() {
    // Build a small color signature from the audio signature.
    // hueBase: core color family influenced by warmth and spectral centroid.
    // hueSpread: how far colors wander from the base.
    const warmth = clamp01(features.warmth);
    const centroid = clamp01(features.spectralCentroid);
    const brightness = clamp01(features.brightness);

    // Map warmth to a warm/cool pivot.
    const warmHue = 12;   // orange-ish
    const coolHue = 230;  // blue-ish
    const neutralHue = 280; // violet-ish

    let hueBase;
    if (warmth > 0.6) {
      hueBase = warmHue + (1 - warmth) * (neutralHue - warmHue);
    } else if (warmth < 0.4) {
      hueBase = coolHue + warmth * (neutralHue - coolHue);
    } else {
      hueBase = neutralHue;
    }

    // Spectral centroid shifts hue a bit toward the "bright" side.
    hueBase = (hueBase + centroid * 30) % 360;

    // Hue spread grows with brightness and treble.
    const spread = 30 + brightness * 120 + clamp01(features.treble || audio.treble) * 80;

    // Saturation and lightness base.
    const saturation = 55 + brightness * 30;
    const lightnessBase = 35 + brightness * 35;

    // Build 5 swatches.
    const palette = [];
    const count = 5;
    for (let i = 0; i < count; i++) {
      const phi = (i / count) * Math.PI * 2;
      const h = (hueBase + Math.cos(phi) * spread * 0.5 + Math.sin(phi * 1.7) * spread * 0.3 + 360) % 360;
      const s = saturation + Math.sin(phi * 2) * 10;
      const l = lightnessBase + Math.sin(phi * 1.3 + 1) * 18;
      palette.push(hsl(h, clamp01(s / 100) * 100, clamp01(l / 100) * 100));
    }

    // Background: a very dark tint of the base hue.
    state.bg = hslToRgb((hueBase + 180) % 360, 15, 4 + brightness * 4);

    state.hueBase = hueBase;
    state.hueSpread = spread;
    state.palette = palette;

    if (onPalette) onPalette(hueBase, spread, palette);
  }

  // ---- Main render loop ----

  function frame() {
    if (!ctx || !canvas) return;

    const w = canvas.width / (Math.min(window.devicePixelRatio || 1, 2) || 1);
    const h = canvas.height / (Math.min(window.devicePixelRatio || 1, 2) || 1);

    // Advance art time; energy speeds it up so lively music = faster motion.
    const speed = 0.5 + clamp01(audio.energy || features.energy) * 1.2;
    state.t += 0.016 * speed;
    state.phase += 0.016 * (0.4 + audio.treble * 1.2);

    // Paint a fresh dark-ish ground each frame (semi-transparent to create trails).
    // We use a dark ground with low alpha to let motion smear create atmosphere.
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = `rgb(${state.bg.r},${state.bg.g},${state.bg.b})`;
    ctx.fillRect(0, 0, w, h);

    // Onset pulse: a brief bright flare on strong onsets.
    const onset = clamp01(audio.onsets || 0);
    if (onset > 0.35) {
      state.pulse = onset;
    } else {
      state.pulse *= 0.92;
    }
    paintPulse(ctx, w, h, state.pulse);

    // Update and draw particle system (always a few particles; onsets spawn bursts).
    updateParticles();
    drawParticles(ctx, w, h);

    // Blooms: slow glowing color fields from bass.
    updateBlooms(ctx, w, h);

    // Strokes: fine line work from treble/brightness.
    updateStrokes(ctx, w, h);

    // Occasional background drift: slow color-field washes.
    paintWash(ctx, w, h);

    // Subtle grain to feel like film/ink.
    paintGrain(ctx, w, h, clamp01(audio.brightness || features.brightness));

    // Stats for UI.
    if (onStats) {
      const bpm = features.bpm || 0;
      onStats({
        bpm,
        energy: Math.round(clamp01(audio.energy || features.energy) * 100),
        brightness: Math.round(clamp01(audio.brightness || features.brightness) * 100),
        warmth: Math.round(clamp01(audio.warmth || features.warmth) * 100),
      });
    }

    requestAnimationFrame(frame);
  }

  // ---- Painting primitives ----

  function paintPulse(ctx, w, h, p) {
    if (p < 0.05) return;
    const r = Math.min(w, h) * (0.2 + p * 0.4) * (0.6 + audio.bass * 0.6);
    const cx = w * (0.5 + Math.sin(state.t * 0.5) * 0.15);
    const cy = h * (0.5 + Math.cos(state.t * 0.42) * 0.15);

    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    const [hue, sat, lig] = paletteSample(0);
    grad.addColorStop(0, `hsla(${hue},${sat}%,${lig + 20}%,${p * 0.5})`);
    grad.addColorStop(0.5, `hsla(${hue},${sat}%,${lig}%,${p * 0.25})`);
    grad.addColorStop(1, `hsla(${hue},${sat}%,${lig}%,0)`);

    ctx.globalCompositeOperation = "screen";
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "source-over";
  }

  function updateParticles() {
    const baseCount = 18;
    const extra = Math.floor(clamp01(audio.bass || 0) * 40) + Math.floor(clamp01(audio.onsets || 0) * 25);
    const target = Math.min(220, baseCount + extra);

    while (state.particles.length < target) {
      spawnParticle();
    }
    if (state.particles.length > target) {
      state.particles.splice(target);
    }

    // Move & age.
    for (let i = state.particles.length - 1; i >= 0; i--) {
      const p = state.particles[i];
      p.life -= 0.012 * (0.6 + audio.energy * 0.8);
      p.x += p.vx * 0.06;
      p.y += p.vy * 0.06;
      p.vx *= 0.98;
      p.vy *= 0.98;
      p.vy += 0.002; // gentle drift
      p.phase += 0.05;

      if (p.life <= 0) {
        state.particles.splice(i, 1);
      }
    }
  }

  function spawnParticle() {
    const w = canvas.width / (Math.min(window.devicePixelRatio || 1, 2) || 1);
    const h = canvas.height / (Math.min(window.devicePixelRatio || 1, 2) || 1);
    const [hue, sat, lig] = paletteSample(Math.floor(rng() * state.palette.length));

    const bornFromOnset = rng() < clamp01(audio.onsets || 0) * 0.8;
    const nearCenter = bornFromOnset;

    state.particles.push({
      x: nearCenter
        ? w * (0.5 + (rng() - 0.5) * 0.25)
        : rng() * w,
      y: nearCenter
        ? h * (0.5 + (rng() - 0.5) * 0.25)
        : (rng() * h),
      vx: (rng() - 0.5) * (bornFromOnset ? 0.6 : 0.25) * (0.5 + audio.treble * 2),
      vy: (rng() - 0.5) * (bornFromOnset ? 0.6 : 0.2) * (0.5 + audio.treble * 2) - 0.1,
      size: 1.5 + rng() * (3 + audio.treble * 8),
      hue,
      sat,
      lig,
      life: 0.4 + rng() * 0.6 + audio.energy * 0.4,
      maxLife: 1.0,
      phase: rng() * Math.PI * 2,
      alpha: bornFromOnset ? 0.9 : 0.4 + rng() * 0.4,
      shape: rng() < 0.3 ? "spark" : "dot",
    });
  }

  function drawParticles(ctx, w, h) {
    ctx.globalCompositeOperation = "screen";
    const bass = clamp01(audio.bass || 0);

    for (const p of state.particles) {
      const alpha = p.alpha * Math.max(0, p.life / p.maxLife);
      if (alpha < 0.01) continue;

      const size = p.size * (0.6 + bass * 0.6);
      ctx.fillStyle = `hsla(${p.hue},${p.sat}%,${p.lig}%,${alpha})`;
      ctx.strokeStyle = `hsla(${p.hue},${p.sat}%,${p.lig + 12}%,${alpha * 0.6})`;

      if (p.shape === "spark" && p.size > 3) {
        ctx.lineWidth = Math.max(0.4, size * 0.4);
        const angle = p.phase + state.t * 2;
        const len = size * 2.4;
        ctx.beginPath();
        ctx.moveTo(p.x - Math.cos(angle) * len, p.y - Math.sin(angle) * len);
        ctx.lineTo(p.x + Math.cos(angle) * len, p.y + Math.sin(angle) * len);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(0.4, size), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalCompositeOperation = "source-over";
  }

  function updateBlooms(ctx, w, h) {
    // Blooms are broad soft color fields, driven mainly by bass + energy.
    const target = Math.min(14, 3 + Math.floor(clamp01(audio.bass || 0) * 10) + Math.floor(clamp01(audio.energy || 0) * 4));

    while (state.blooms.length < target) {
      state.blooms.push(makeBloom());
    }
    if (state.blooms.length > target) {
      state.blooms.splice(target);
    }

    // Age blooms; long lived with slow drift.
    for (let i = state.blooms.length - 1; i >= 0; i--) {
      const b = state.blooms[i];
      b.life -= 0.0015;
      b.x += Math.sin(state.t * b.driftFreq + b.phase) * 0.3;
      b.y += Math.cos(state.t * b.driftFreq * 0.7 + b.phase) * 0.3;
      b.pulse += (clamp01(audio.bass || 0) - b.pulse) * 0.1;
      b.size += (b.targetSize - b.size) * 0.02;

      if (b.life <= 0) {
        state.blooms.splice(i, 1);
      }
    }

    // Draw blooms.
    ctx.globalCompositeOperation = "screen";
    for (const b of state.blooms) {
      const alpha = Math.max(0, b.life) * (0.25 + b.pulse * 0.3);
      if (alpha < 0.01) continue;
      const r = b.size * (1 + b.pulse * 0.8);

      const grad = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, r);
      grad.addColorStop(0, `hsla(${b.hue},${b.sat}%,${b.lig + 18}%,${alpha * 0.7})`);
      grad.addColorStop(0.5, `hsla(${b.hue},${b.sat}%,${b.lig}%,${alpha * 0.3})`);
      grad.addColorStop(1, `hsla(${b.hue},${b.sat}%,${b.lig}%,0)`);

      ctx.fillStyle = grad;
      ctx.fillRect(b.x - r, b.y - r, r * 2, r * 2);
    }
    ctx.globalCompositeOperation = "source-over";
  }

  function makeBloom() {
    const w = canvas.width / (Math.min(window.devicePixelRatio || 1, 2) || 1);
    const h = canvas.height / (Math.min(window.devicePixelRatio || 1, 2) || 1);
    const idx = Math.floor(rng() * state.palette.length);
    const [hue, sat, lig] = paletteSample(idx);
    return {
      x: w * (0.1 + rng() * 0.8),
      y: h * (0.1 + rng() * 0.8),
      hue,
      sat,
      lig,
      size: 60 + rng() * 140,
      targetSize: 60 + rng() * 140,
      life: 0.6 + rng() * 0.4,
      maxLife: 1.0,
      phase: rng() * Math.PI * 2,
      driftFreq: 0.2 + rng() * 0.3,
      pulse: 0,
    };
  }

  function updateStrokes(ctx, w, h) {
    // Strokes are fine lines that respond to treble / brightness / onsets.
    const target = Math.min(80, 12 + Math.floor(clamp01(audio.treble || 0) * 60) + Math.floor(clamp01(audio.onsets || 0) * 30));

    while (state.strokes.length < target) {
      state.strokes.push(makeStroke());
    }
    if (state.strokes.length > target) {
      state.strokes.splice(target);
    }

    for (let i = state.strokes.length - 1; i >= 0; i--) {
      const s = state.strokes[i];
      s.life -= 0.008 * (0.5 + audio.energy * 0.8);
      s.x += s.vx * 0.05;
      s.y += s.vy * 0.05;
      s.vx += (Math.sin(state.t * s.freq + s.phase) * 0.004);
      s.vy += (Math.cos(state.t * s.freq * 0.8 + s.phase) * 0.004);
      s.vx *= 0.985;
      s.vy *= 0.985;

      s.trail.push({ x: s.x, y: s.y });
      if (s.trail.length > s.maxTrail) s.trail.shift();

      if (s.life <= 0) {
        state.strokes.splice(i, 1);
      }
    }

    // Draw strokes.
    ctx.globalCompositeOperation = "screen";
    for (const s of state.strokes) {
      const alpha = Math.max(0, s.life / s.maxLife) * s.alphaBase;
      if (alpha < 0.01 || s.trail.length < 2) continue;

      ctx.lineWidth = Math.max(0.3, s.width * (0.6 + alpha * 0.8));
      ctx.strokeStyle = `hsla(${s.hue},${s.sat}%,${s.lig}%,${alpha})`;
      ctx.beginPath();
      ctx.moveTo(s.trail[0].x, s.trail[0].y);
      for (let i = 1; i < s.trail.length; i++) {
        ctx.lineTo(s.trail[i].x, s.trail[i].y);
      }
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  function makeStroke() {
    const w = canvas.width / (Math.min(window.devicePixelRatio || 1, 2) || 1);
    const h = canvas.height / (Math.min(window.devicePixelRatio || 1, 2) || 1);
    const idx = Math.floor(rng() * state.palette.length);
    const [hue, sat, lig] = paletteSample(idx);
    const bright = clamp01(audio.brightness || 0.5);
    return {
      x: rng() * w,
      y: rng() * h,
      vx: (rng() - 0.5) * (0.2 + bright * 0.6),
      vy: (rng() - 0.5) * (0.2 + bright * 0.6) - 0.05,
      hue,
      sat,
      lig: lig + bright * 15,
      width: 0.4 + rng() * (0.8 + bright * 2.2),
      life: 0.5 + rng() * 0.5 + bright * 0.4,
      maxLife: 1.0,
      phase: rng() * Math.PI * 2,
      freq: 0.4 + rng() * 1.2,
      alphaBase: 0.2 + rng() * 0.4,
      trail: [{ x: rng() * w, y: rng() * h }],
      maxTrail: 18 + Math.floor(bright * 20),
    };
  }

  function paintWash(ctx, w, h) {
    // Very slow drifty color wash underneath everything.
    ctx.globalCompositeOperation = "overlay";
    ctx.globalAlpha = 0.04 + audio.energy * 0.03;

    const [hue, sat, lig] = paletteSample(Math.floor((state.t * 0.1) % state.palette.length));
    const cx = w * (0.5 + Math.sin(state.t * 0.05) * 0.4);
    const cy = h * (0.5 + Math.cos(state.t * 0.043) * 0.4);
    const r = Math.max(w, h) * 0.8;

    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, `hsla(${hue},${sat}%,${lig + 20}%,0.4)`);
    grad.addColorStop(1, `hsla(${hue},${sat}%,${lig}%,0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
  }

  function paintGrain(ctx, w, h, brightness) {
    // Subtle film grain; more visible on bright pieces.
    const density = 0.012 + brightness * 0.025;
    ctx.globalCompositeOperation = "overlay";
    ctx.globalAlpha = 0.04 + brightness * 0.05;

    // Only paint a small random subset each frame for performance + flicker.
    const span = Math.floor(w * h * density);
    for (let i = 0; i < span; i++) {
      const x = Math.floor(rng() * w);
      const y = Math.floor(rng() * h);
      const v = rng();
      const bright = (v - 0.5) * 22;
      ctx.fillStyle = `rgba(255,255,255,${bright > 0 ? bright / 255 : 0})`;
      ctx.fillRect(x, y, 1, 1);
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
  }

  // ---- Utilities ----

  function paletteSample(idx) {
    if (!state.palette.length) return [0, 0, 0];
    const i = ((idx % state.palette.length) + state.palette.length) % state.palette.length;
    return state.palette[i];
  }

  function hsl(h, s, l) {
    // Returns [h, s, l] stored as CSS-friendly numbers.
    return [((h % 360) + 360) % 360, Math.max(0, Math.min(100, s)), Math.max(0, Math.min(100, l))];
  }

  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360;
    s = Math.max(0, Math.min(100, s)) / 100;
    l = Math.max(0, Math.min(100, l)) / 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return [
      Math.round((r + m) * 255),
      Math.round((g + m) * 255),
      Math.round((b + m) * 255),
    ];
  }

  function clamp01(v) {
    return Math.max(0, Math.min(1, v));
  }

  // ---- Public API ----

  function setAudioFrame(f) {
    audio.energy = f.energy;
    audio.bass = f.bass;
    audio.mid = f.mid;
    audio.treble = f.treble;
    audio.onsets = f.onsets;
    audio.brightness = f.brightness;
    audio.warmth = f.warmth;
    audio.loudness = f.loudness;
  }

  function setFeatures(f) {
    features.bpm = f.bpm || 0;
    features.energy = f.energy ?? 0.5;
    features.brightness = f.brightness ?? 0.5;
    features.warmth = f.warmth ?? 0.5;
    features.spectralCentroid = f.spectralCentroid ?? 0.5;
    features.duration = f.duration || 0;
  }

  function reseed(seed) {
    state.seed = seed;
    seedRng(seed);
    state.particles = [];
    state.blooms = [];
    state.strokes = [];
    state.t = 0;
    derivePalette();
  }

  function start() {
    if (onStart) onStart();
    requestAnimationFrame(frame);
  }

  function exportImage() {
    if (!canvas) return null;
    const link = document.createElement("a");
    link.download = `synesthesia-${Date.now()}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
    return link.href;
  }

  return {
    attach,
    clear,
    setCallbacks,
    setAudioFrame,
    setFeatures,
    reseed,
    start,
    exportImage,
    get palette() { return state.palette; },
    get hueBase() { return state.hueBase; },
    get hueSpread() { return state.hueSpread; },
  };
})();

export default Renderer;
