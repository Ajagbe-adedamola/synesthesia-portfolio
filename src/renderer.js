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

  /** Cached noise plate for the film-grain pass. */
  let grainTile = null;

  /**
   * Visual layers. The brief asks for typography, abstract shapes, distorted
   * images, animated patterns and dynamic composition; each behaviour lives in
   * its own layer so a piece can be composed from any combination of them.
   */
  const layers = { type: true, shapes: true, patterns: true, image: false };

  /** Word the typography layer animates (usually the track title). */
  let artworkText = "SYNESTHESIA";

  /** Optional source image for the distortion layer. */
  let sourceImage = null;

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
    // Layer 1: distorted source image (when one has been added).
    if (layers.image) paintImageLayer(ctx, w, h);

    // Layer 2: animated geometric patterns.
    if (layers.patterns) paintPatterns(ctx, w, h);

    // Layer 3: abstract shapes — pulse, particles, blooms, strokes, washes.
    if (layers.shapes) {
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
    }

    // Layer 4: moving typography.
    if (layers.type) paintTypography(ctx, w, h);

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

  /**
   * Build the grain plate once. Drawing ~30k individual 1px rects per frame was
   * the single most expensive thing in the loop; one cached plate that is
   * re-positioned each frame gives the same flickering film texture for a
   * fraction of the cost.
   */
  function makeGrainTile(size = 180) {
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const g = c.getContext("2d");
    const img = g.createImageData(size, size);
    const d = img.data;
    for (let i = 0; i < size * size; i++) {
      const p = i * 4;
      d[p] = 255;
      d[p + 1] = 255;
      d[p + 2] = 255;
      d[p + 3] = Math.random() > 0.7 ? 12 + ((Math.random() * 26) | 0) : 0;
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  function paintGrain(ctx, w, h, brightness) {
    if (!grainTile) grainTile = makeGrainTile();
    const pattern = ctx.createPattern(grainTile, "repeat");
    if (!pattern) return;

    ctx.save();
    // Subtle film grain; more visible on bright pieces.
    ctx.globalCompositeOperation = "overlay";
    ctx.globalAlpha = 0.05 + brightness * 0.1;

    // Jump the plate each frame so the grain crawls like film.
    ctx.translate(
      -Math.floor(Math.random() * grainTile.width),
      -Math.floor(Math.random() * grainTile.height)
    );
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, w + grainTile.width, h + grainTile.height);
    ctx.restore();
  }

  // ---- Layer: animated patterns ----

  /**
   * Concentric rings and a dot lattice. Ring count follows treble, ring weight
   * and the slow camera zoom follow bass and onsets, so the pattern breathes
   * with the beat instead of looping on its own clock.
   */
  function paintPatterns(ctx, w, h) {
    const bass = clamp01(audio.bass || 0);
    const treble = clamp01(audio.treble || 0);
    const energy = clamp01(audio.energy || features.energy);
    const onset = clamp01(audio.onsets || 0);

    ctx.save();
    // Dynamic composition: the whole field drifts and tilts with energy.
    ctx.translate(w / 2, h / 2);
    ctx.rotate(Math.sin(state.t * 0.13) * 0.06 * (0.3 + energy));
    const zoom = 1 + bass * 0.06 + onset * 0.05;
    ctx.scale(zoom, zoom);
    ctx.translate(-w / 2, -h / 2);
    ctx.globalCompositeOperation = "screen";

    const rings = 10 + Math.floor(treble * 26);
    const gap = (Math.hypot(w, h) * 0.6) / rings;
    for (let i = 0; i < rings; i++) {
      const [hue, sat, lig] = paletteSample(i);
      const wob = Math.sin(state.t * 1.2 + i * 0.4) * gap * 0.35;
      const r = (i + 0.5) * gap + wob + bass * gap * 0.6;
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, Math.max(1, r), 0, Math.PI * 2);
      ctx.lineWidth = 0.5 + bass * 2.5 + onset * 2;
      ctx.strokeStyle = `hsla(${hue},${sat}%,${lig}%,${0.06 + onset * 0.18 + energy * 0.05})`;
      ctx.stroke();
    }

    // A sparse dot lattice keeps the pattern from reading as pure decoration.
    const step = 46 - treble * 18;
    ctx.fillStyle = `hsla(${state.hueBase},60%,72%,${0.05 + onset * 0.1})`;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const d = Math.hypot(x - w / 2, y - h / 2);
        const r = 1.2 + Math.sin(d * 0.02 - state.t * 2) * 1.4 + bass * 2;
        if (r <= 0.2) continue;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();
  }

  // ---- Layer: moving typography ----

  /**
   * The track title, set large and set free: each glyph rises on its own phase
   * (treble widens the wobble), the whole word swells with bass and jumps on
   * onsets, and a ghost line prints behind it for a mis-registered feel.
   */
  function paintTypography(ctx, w, h) {
    const text = String(artworkText || "").toUpperCase().slice(0, 28).trim();
    if (!text) return;

    const bass = clamp01(audio.bass || 0);
    const treble = clamp01(audio.treble || 0);
    const energy = clamp01(audio.energy || features.energy);
    const bright = clamp01(audio.brightness || features.brightness);

    let size = Math.min((w * 1.55) / Math.max(5, text.length), h * 0.19);
    size *= 0.92 + bass * 0.32 + state.pulse * 0.22;

    ctx.save();
    ctx.font = `900 ${Math.max(10, size)}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.globalCompositeOperation = "screen";

    const chars = Array.from(text);
    const widths = chars.map((c) => ctx.measureText(c).width);
    const total = widths.reduce((a, b) => a + b, 0);
    const startX = w / 2 - total / 2;
    const baseY = h * (0.5 + Math.sin(state.t * 0.35) * 0.035);

    let x = startX;
    for (let i = 0; i < chars.length; i++) {
      const cw = widths[i];
      const rise = Math.sin(state.t * 1.4 + i * 0.45) * size * (0.06 + treble * 0.22);
      const fall = Math.cos(state.t * 0.9 + i * 0.3) * size * 0.05;
      const [hue, sat, lig] = paletteSample(i);
      ctx.fillStyle = `hsla(${hue},${sat}%,${Math.min(92, lig + 18)}%,${0.6 + bright * 0.3})`;
      ctx.fillText(chars[i], x + cw / 2, baseY + rise - fall);
      x += cw;
    }

    // Ghost pass, offset and out of phase — the print-registration echo.
    if (energy > 0.22) {
      ctx.globalAlpha = 0.16 + state.pulse * 0.24;
      ctx.fillStyle = `hsla(${(state.hueBase + 180) % 360},70%,72%,0.5)`;
      let gx = startX + Math.sin(state.t * 0.8) * 10;
      for (let i = 0; i < chars.length; i++) {
        ctx.fillText(
          chars[i],
          gx + widths[i] / 2,
          baseY + Math.sin(state.t * 1.1 + i * 0.5) * size * 0.5
        );
        gx += widths[i];
      }
    }

    ctx.restore();
  }

  // ---- Layer: distorted image ----

  /**
   * The loaded photo, torn into horizontal slices whose offset is driven by
   * bass and energy, with a slow zoom pulse on onsets. Low-frequency content
   * literally bends the picture.
   */
  function paintImageLayer(ctx, w, h) {
    if (!sourceImage) return;

    const bass = clamp01(audio.bass || 0);
    const energy = clamp01(audio.energy || features.energy);
    const bright = clamp01(audio.brightness || features.brightness);

    const fit = Math.max(w / sourceImage.width, h / sourceImage.height);
    const zoom = fit * (1 + bass * 0.08 + state.pulse * 0.05);
    const dw = sourceImage.width * zoom;
    const dh = sourceImage.height * zoom;
    const dx = (w - dw) / 2;
    const dy = (h - dh) / 2;

    const slices = 54;
    const sh = sourceImage.height / slices;
    const amp = (2 + bass * 30) * (0.4 + energy);

    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 0.55 + bright * 0.35;
    for (let i = 0; i < slices; i++) {
      const off =
        Math.sin(state.t * 2 + i * 0.32) * amp +
        Math.sin(state.t * 0.6 + i * 0.9) * amp * 0.45;
      ctx.drawImage(
        sourceImage,
        0, i * sh, sourceImage.width, sh,
        dx + off, dy + (dh / slices) * i, dw, dh / slices + 1
      );
    }
    ctx.restore();
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

  function setLayers(next) {
    if (!next) return;
    for (const key of Object.keys(layers)) {
      if (typeof next[key] === "boolean") layers[key] = next[key];
    }
  }

  function setText(text) {
    const t = String(text || "").trim();
    artworkText = t || "SYNESTHESIA";
  }

  /** Accepts an <img> or a canvas; stored at a sane size for slicing. */
  function setImage(imgOrCanvas) {
    if (!imgOrCanvas) {
      sourceImage = null;
      return;
    }
    const iw = imgOrCanvas.naturalWidth || imgOrCanvas.width;
    const ih = imgOrCanvas.naturalHeight || imgOrCanvas.height;
    if (!iw || !ih) {
      sourceImage = null;
      return;
    }
    const scale = Math.min(1, 1600 / iw);
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(iw * scale));
    c.height = Math.max(1, Math.round(ih * scale));
    const g = c.getContext("2d");
    g.imageSmoothingQuality = "high";
    g.drawImage(imgOrCanvas, 0, 0, c.width, c.height);
    sourceImage = c;
  }

  function hasImage() {
    return !!sourceImage;
  }

  function getLayers() {
    return Object.assign({}, layers);
  }

  return {
    attach,
    clear,
    setCallbacks,
    setAudioFrame,
    setFeatures,
    setLayers,
    getLayers,
    setText,
    setImage,
    hasImage,
    reseed,
    start,
    exportImage,
    get palette() { return state.palette; },
    get hueBase() { return state.hueBase; },
    get hueSpread() { return state.hueSpread; },
  };
})();

export default Renderer;
