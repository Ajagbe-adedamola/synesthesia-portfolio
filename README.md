# Synesthesia — Music to Art

Upload a song or album and hear it become visual art. Each track generates a unique generative artwork driven by the audio's frequency spectrum, energy, beats, and dynamics.

Built with the Web Audio API and HTML Canvas — runs entirely in the browser, no server needed.

## Quick start

```bash
bun install
bun run dev
```

Then open the preview and drop in an audio file (MP3, WAV, FLAC, OGG). The canvas will paint a living artwork that responds to the music.

## How it works

1. The audio file is decoded with `AudioContext.decodeAudioData`.
2. An `AnalyserNode` feeds frequency and time-domain data into a generative renderer.
3. The renderer maps spectral energy, beat transients, bass warmth, and brightness onto color, shape, motion, and texture.
4. Each piece is seeded so the same track produces a consistent visual identity, while still evolving over time.
5. The artwork can be exported as PNG.

## Architecture

- `index.html` — app shell, upload drop zone, controls, gallery, export.
- `styles.css` — visual design and responsive layout.
- `src/audio.js` — audio graph setup: file loading, decoding, analyser, beat detection.
- `src/renderer.js` — generative canvas renderer; maps audio features to visual elements.
- `src/gallery.js` — per-track gallery so an album becomes a sequence of related artworks.
- `src/app.js` — wire-up, state, export.

## Project goals

- Drop in a single track or an album and get back a set of artworks.
- Each artwork should feel like it "listens" to the music, not just react to volume.
- Same track produces a recognizable visual signature; different tracks look different.
- Exportable, shareable results.
