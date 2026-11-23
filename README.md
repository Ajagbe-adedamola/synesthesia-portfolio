# Synesthesia — Sound into Image

**Category: Music + Creative coding**

Upload a track and watch it become a picture. The system listens to what is playing — rhythm, frequency, intensity — and turns those measurements into typography, geometry and texture that move with the music.

Put on an Afrobeats record and the low end pushes the composition around, the hi-hats break it into detail, and the beat hits land as flashes of light and movement.

Everything runs in the browser. There is no server, no upload, and no pre-rendered video — the artwork is generated frame by frame from the live audio signal.

![category](https://img.shields.io/badge/category-music%20%2B%20creative%20coding-ff4d8d)

## What it generates

| Behaviour | What it looks like | Driven by |
| --- | --- | --- |
| **Moving typography** | The track title, set large, with every letter riding its own wave — swelling on the drop, scattering on hi-hats, echoing in a mis-registered ghost print | bass, onsets, treble |
| **Abstract shapes** | Glowing color fields, drifting particles, fine line work, ripples on the beat | bass, energy, onsets |
| **Distorted images** | Your own photo, torn into horizontal slices that bend, shear and punch on the beat | bass, energy, onsets |
| **Animated patterns** | Concentric rings and a dot lattice that breathe outward, tilt and zoom with the track | treble, energy, bass |
| **Dynamic composition** | The whole field drifts, rotates and re-scales, so no two frames sit still | energy, onsets |

## Try it

```bash
bun install
bun run dev
```

Then open the app and drop in an audio file (MP3, WAV, FLAC, OGG, M4A). One file makes one piece; several files make an album, with each track producing its own artwork in a sequence.

Use the **Layers** row under the canvas to compose a piece: turn typography, shapes or patterns on and off, and add a photo for the distortion layer.

## How sound becomes an image

An `AnalyserNode` reports the spectrum every frame. Those numbers are reduced to a small set of features, and each feature is assigned a job:

- **Bass** → weight and scale. It swells the typography, thickens ring strokes, and is what literally bends the distorted image.
- **Mid** → body. Density of the shapes, how much the composition holds together.
- **Treble** → detail and agitation. It multiplies pattern rings, adds jitter to letterforms, and spawns spark-shaped particles.
- **Energy** → speed and travel. Higher energy runs the artwork faster and pushes the camera further.
- **Onsets (beats)** → punctuation. Every strong onset is a flare, a size jump, a new particle burst.
- **Brightness** → palette lift. Brighter tracks get a wider, lighter hue spread.
- **Warmth** → hue direction. Warm material leans orange and red, cool material leans blue and violet.

A per-track seed (hash of filename + modified time) makes each piece reproducible: the same song always grows into the same visual identity, while still evolving differently on every play.

## Architecture

```
analyser → features ─┐
                     ├─→ renderer.frame()   → canvas → PNG export
palette ← warmth ────┘    ├── typography layer
                          ├── pattern layer
                          ├── shape layer
                          └── image layer
```

- `index.html` — shell, drop zone, layer controls, player, gallery.
- `styles.css` — layout and visual design.
- `src/audio.js` — audio graph, decoding, analyser, beat detection, feature extraction.
- `src/renderer.js` — the generative engine: palette derivation, the four layers, composition, export.
- `src/gallery.js` — per-track gallery so an album becomes a sequence of pieces.
- `src/spotify.js` — optional Spotify search and playback.
- `src/app.js` — wiring, state, playback UI, export.

## Technology

**Used now:** Web Audio API (`AnalyserNode` for spectrum and time-domain data), Canvas 2D for all drawing, ES modules with no build step, and a seeded PRNG (mulberry32) for reproducible pieces.

**Planned:** the layer boundaries were drawn so individual layers can be replaced by shader-based renderers — p5.js for generative fields, Three.js plus custom GLSL for the distorted-image and pattern layers. The intent is a WebGL path that keeps the same audio-feature contract, so a track sounds the same but renders with far more depth.

## Notes and limits

- Spotify playback can't hand over an audio stream, so the artwork needs a local file. The Spotify panels let you attach the file for a track you found there, keeping its title and cover.
- Beat detection is a lightweight autocorrelation over an energy envelope, not a full tempo tracker; it reports a pulse, not a metronomic BPM.
- Live microphones and system audio are not wired up — files only.
- Built and tested in Chromium. Export gives you a PNG at canvas resolution.
