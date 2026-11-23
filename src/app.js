/**
 * Synesthesia — app shell.
 *
 * Wires together:
 *  - File drop / file input (single track or multiple = album)
 *  - Spotify search + playback (requires Spotify Premium + Developer app client ID)
 *  - AudioPipeline for playback + feature extraction
 *  - Renderer for the generative canvas
 *  - Gallery for per-track album artwork
 *
 * The artwork is generated live while the track plays. For an album, each
 * track gets its own canvas render which can be captured as a PNG and added
 * to the album gallery.
 */

import AudioPipeline from "./audio.js";
import Renderer from "./renderer.js";
import Gallery from "./gallery.js";
import Spotify from "./spotify.js";

// ---- DOM refs ----

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const stageSection = document.getElementById("stageSection");
const trackName = document.getElementById("trackName");
const trackSub = document.getElementById("trackSub");
const trackStatus = document.getElementById("trackStatus");
const playBtn = document.getElementById("playBtn");
const seekBar = document.getElementById("seekBar");
const timeDisplay = document.getElementById("timeDisplay");
const exportBtn = document.getElementById("exportBtn");
const clearBtn = document.getElementById("clearBtn");
const canvas = document.getElementById("canvas");
const canvasOverlay = document.getElementById("canvasOverlay");
const overlayTitle = document.getElementById("overlayTitle");
const overlaySub = document.getElementById("overlaySub");
const paletteSwatches = document.getElementById("paletteSwatches");
const statBpm = document.getElementById("statBpm");
const statEnergy = document.getElementById("statEnergy");
const statBrightness = document.getElementById("statBrightness");
const statWarmth = document.getElementById("statWarmth");
const gallerySection = document.getElementById("gallerySection");
const galleryEl = document.getElementById("gallery");
const layerChips = document.querySelectorAll(".layer-chip[data-layer]");
const imageInput = document.getElementById("imageInput");

// ---- Spotify UI refs ----

const spotifyBtn = document.getElementById("spotifyBtn");
const spotifySource = document.getElementById("spotifySource");
const spotifyStatus = document.getElementById("spotifyStatus");
const spotifyQuery = document.getElementById("spotifyQuery");
const spotifySearchBtn = document.getElementById("spotifySearchBtn");
const spotifyResults = document.getElementById("spotifyResults");
const sourceChips = document.querySelectorAll(".source-chip");

// ---- State ----

let loadedFiles = [];
let currentIndex = -1;
let spotifySourceActive = false;
let spotifySearchRunning = false;

// ---- Init core modules ----

Renderer.attach(canvas);
Gallery.setRoot(galleryEl);

AudioPipeline.setCallbacks({
  onPlaybackStateChange: (playing) => {
    playBtn.innerHTML = playing
      ? '<span class="icon icon-pause" aria-hidden="true"></span>'
      : '<span class="icon icon-play" aria-hidden="true"></span>';
    playBtn.setAttribute("aria-label", playing ? "Pause" : "Play / pause");
  },
  onFrame: (frame, features) => {
    Renderer.setAudioFrame(frame);
  },
  onTimeUpdate: (time, duration) => {
    const t = Math.max(0, time);
    const d = Math.max(0, duration);
    seekBar.value = d > 0 ? (t / d) * 100 : 0;
    timeDisplay.textContent = fmt(t) + " / " + fmt(d);
  },
});

Gallery.setCallbacks({
  onReady: (title, sub) => {
    selectTrackByTitle(title);
  },
});

// ---- Spotify wiring ----

Spotify.setClientConfig({
  clientId: window.SPOTIFY_CLIENT_ID || "",
  redirectUri: window.SPOTIFY_REDIRECT_URI || "http://localhost:3000/spotify-callback",
});

Spotify.setListeners({
  onStateChange: (s) => {
    updateSpotifyStatus(s);
    if (s.signedIn) {
      spotifyBtn.textContent = "Signed in · Spotify";
      spotifyBtn.classList.add("btn-primary");
      spotifyBtn.classList.remove("btn-ghost");
    } else {
      spotifyBtn.innerHTML = '<span class="icon icon-spotify" aria-hidden="true"></span> Spotify';
      spotifyBtn.classList.remove("btn-primary");
      spotifyBtn.classList.add("btn-ghost");
    }
  },
  onAnalysisPossible: (possible, reason) => {
    if (!possible) {
      setSpotifyStatus(reason, "error");
    }
  },
});

function updateSpotifyStatus(s) {
  if (!spotifySourceActive) return;
  if (!s.signedIn) {
    setSpotifyStatus("Sign in with Spotify to search and play.", "");
    return;
  }
  if (!s.deviceId) {
    setSpotifyStatus("Connecting to Spotify player…", "");
    return;
  }
  if (s.playing && s.track) {
    setSpotifyStatus("Playing · " + (s.track.name || "") + " — " + (s.track.artists && s.track.artists[0] || ""), "ok");
    return;
  }
  if (s.playing) {
    setSpotifyStatus("Playing…", "ok");
    return;
  }
  if (s.track) {
    setSpotifyStatus("Paused · " + (s.track.name || "") + " — " + (s.track.artists && s.track.artists[0] || ""), "");
    return;
  }
  setSpotifyStatus("Signed in to Spotify. Search above, then pick a track.", "");
}

function setSpotifyStatus(msg, kind) {
  spotifyStatus.textContent = msg || "";
  spotifyStatus.className = "spotify-status" + (kind ? " " + kind : "");
}

function handleSpotifyAuthClick() {
  if (!window.SPOTIFY_CLIENT_ID) {
    setSpotifyStatus("Spotify not configured yet. Set window.SPOTIFY_CLIENT_ID in index.html (see the <script> at the bottom).", "error");
    return;
  }
  if (!Spotify.hasValidToken()) {
    const url = Spotify.startAuth();
    if (!url) {
      setSpotifyStatus("Spotify auth URL missing. Check your redirect URI in index.html.", "error");
      return;
    }
    window.location.href = url;
    return;
  }
  Spotify.signOut();
  spotifySourceActive = false;
  spotifySource.hidden = true;
  spotifyResults.innerHTML = "";
  setSpotifyStatus("", "");
  updateSpotifyStatus(Spotify.state);
}

spotifyBtn.addEventListener("click", handleSpotifyAuthClick);

spotifySearchBtn.addEventListener("click", () => {
  doSpotifySearch(spotifyQuery.value.trim());
});

spotifyQuery.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    spotifySearchBtn.click();
  }
});

async function doSpotifySearch(query) {
  if (!query || query.length < 1) return;
  if (!Spotify.hasValidToken()) {
    setSpotifyStatus("Please sign in to Spotify first.", "error");
    return;
  }
  if (spotifySearchRunning) return;
  spotifySearchRunning = true;
  spotifySearchBtn.disabled = true;
  spotifyQuery.disabled = true;
  spotifyResults.innerHTML = '<div class="spotify-empty"><span class="spotify-spinner"></span> Searching…</div>';
  try {
    const result = await Spotify.search(query);
    renderSpotifyResults(result.tracks, result.albums);
  } catch (err) {
    setSpotifyStatus(String(err), "error");
    spotifyResults.innerHTML = '<div class="spotify-empty">Search failed: ' + escapeHtml(String(err)) + '</div>';
  } finally {
    spotifySearchRunning = false;
    spotifySearchBtn.disabled = false;
    spotifyQuery.disabled = false;
  }
}

function renderSpotifyResults(tracks, albums) {
  const items = [];
  for (const t of tracks) {
    items.push(Object.assign({}, t, { _kind: "track" }));
  }
  for (const a of albums) {
    items.push(Object.assign({}, a, { _kind: "album" }));
  }
  if (!items.length) {
    spotifyResults.innerHTML = '<div class="spotify-empty">No results found.</div>';
    return;
  }
  spotifyResults.innerHTML = "";
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "spotify-result";

    const img = document.createElement("img");
    img.src = item.cover || "";
    img.alt = item.name || "";
    img.loading = "lazy";
    if (!item.cover) img.style.display = "none";

    const info = document.createElement("div");
    info.className = "spotify-result-info";

    const name = document.createElement("div");
    name.className = "spotify-result-name";
    name.textContent = item.name || "";

    const artist = document.createElement("div");
    artist.className = "spotify-result-artist";
    artist.textContent = item.artist || (item.artists && item.artists[0]) || "";

    const type = document.createElement("div");
    type.className = "spotify-result-type";
    if (item._kind === "album") {
      type.textContent = "Album · " + item.trackCount + " tracks";
    } else {
      type.textContent = "Track · " + fmtMs(item.duration);
    }

    info.appendChild(name);
    info.appendChild(artist);
    info.appendChild(type);

    const play = document.createElement("button");
    play.className = "spotify-result-play";
    play.type = "button";
    play.title = item._kind === "track" ? "Play this track via Spotify" : "Play this album via Spotify";
    play.setAttribute("aria-label", item._kind === "track" ? "Play " + (item.name || "") + " via Spotify" : "Play album " + (item.name || "") + " via Spotify");
    play.innerHTML = '<span class="icon icon-play" aria-hidden="true"></span>';
    play.addEventListener("click", (e) => {
      e.stopPropagation();
      playSpotifyItem(item);
    });

    const useAudio = document.createElement("button");
    useAudio.className = "spotify-result-use";
    useAudio.type = "button";
    useAudio.title = "Choose the audio file for this song so it can generate artwork";
    useAudio.setAttribute("aria-label", "Choose audio file for " + (item.name || ""));
    useAudio.textContent = "Use file";
    useAudio.addEventListener("click", (e) => {
      e.stopPropagation();
      promptSpotifyAudioFile(item);
    });

    row.appendChild(img);
    row.appendChild(info);
    row.appendChild(play);
    row.appendChild(useAudio);
    row.addEventListener("click", () => playSpotifyItem(item));
    spotifyResults.appendChild(row);
  }
}

async function playSpotifyItem(item) {
  if (!Spotify.hasValidToken()) {
    setSpotifyStatus("Please sign in to Spotify first.", "error");
    return;
  }
  if (!Spotify.state.deviceId) {
    setSpotifyStatus("Spotify player isn't ready yet. Trying to connect…", "");
    try {
      await Spotify.ensureSdk();
      await Spotify.startPlayer();
    } catch (err) {
      setSpotifyStatus("Spotify player error: " + escapeHtml(String(err)), "error");
      return;
    }
    await new Promise((r) => setTimeout(r, 800));
    if (!Spotify.state.deviceId) {
      setSpotifyStatus("Spotify player didn't become ready. Make sure you have Spotify Premium and an active Spotify app nearby.", "error");
      return;
    }
  }
  try {
    await Spotify.playTrack(item.uri);
    setSpotifyStatus("Playing · " + (item.name || ""), "ok");
    if (!Spotify.state.analysisPossible) {
      setSpotifyStatus("Playing · " + (item.name || "") + " — artwork uses a Spotify-synced placeholder (live stream analysis isn't available)", "");
    }
  } catch (err) {
    setSpotifyStatus("Playback error: " + escapeHtml(String(err)), "error");
  }
}

// ---- Source switching ----

sourceChips.forEach((chip) => {
  chip.addEventListener("click", () => {
    const src = chip.getAttribute("data-source");
    sourceChips.forEach((c) => c.classList.remove("source-chip-active"));
    chip.classList.add("source-chip-active");
    if (src === "spotify") {
      spotifySourceActive = true;
      spotifySource.hidden = false;
      updateSpotifyStatus(Spotify.state);
    } else {
      spotifySourceActive = false;
      spotifySource.hidden = true;
    }
  });
});

// ---- Spotify "use this audio" file bridge ----

/**
 * When a user picks a Spotify item, they still need to supply the actual
 * audio file for the artwork (Spotify doesn't give us audio files).
 * We show a small "Choose the audio file for this song" button on the
 * row, which opens a file picker scoped to a single file. Once picked, we
 * load it through the normal local pipeline and use the Spotify item's
 * metadata (name/artist/album/cover) as the display identity.
 */
let pendingSpotifyItem = null;

function promptSpotifyAudioFile(item) {
  pendingSpotifyItem = item;
  // Create a one-shot hidden file input for a single audio file.
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "audio/*";
  input.multiple = false;
  input.style.display = "none";
  input.addEventListener("change", async () => {
    const files = input.files;
    document.body.removeChild(input);
    pendingSpotifyItem = null;
    if (!files || !files.length) {
      setSpotifyStatus("No file chosen.", "error");
      return;
    }
    const file = files[0];
    setSpotifyStatus("Decoding audio file for: " + (item.name || "") + "…", "");
    try {
      await useLocalAudioForSpotifyItem(file, item);
    } catch (err) {
      setSpotifyStatus("Couldn't decode audio file: " + escapeHtml(String(err)), "error");
    }
  });
  document.body.appendChild(input);
  input.click();
}

async function useLocalAudioForSpotifyItem(file, item) {
  // Decode the file ourselves (same path as local file drop) so we keep
  // the Spotify metadata for display.
  const c = Spotify.context || null;
  const arrayBuffer = await file.arrayBuffer();
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await audioCtx.decodeAudioData(arrayBuffer);

  // Build a synthetic entry that matches what handleFiles produces, but with
  // the Spotify metadata overlaid for display.
  const rawFeatures = deriveFeaturesFromBuffer(decoded);
  const entry = {
    file: file,
    ok: true,
    buffer: decoded,
    features: Object.assign({}, rawFeatures, {
      // Keep the Spotify identity for the UI.
      _spotifyName: item.name,
      _spotifyArtist: item.artist,
      _spotifyAlbum: item.album,
      _spotifyCover: item.cover,
      _spotifyHref: item.href,
    }),
  };

  loadedFiles = [entry];
  currentIndex = 0;
  await openTrack(0);

  // Override the displayed name/sub with Spotify identity.
  trackName.textContent = item.name || stripExtension(file.name);
  const artist = item.artist || (item.artists && item.artists[0]) || "";
  const album = item.album || "";
  const dur = fmt(item.duration ? item.duration / 1000 : entry.features.duration);
  const subParts = [];
  if (artist) subParts.push(artist);
  if (album) subParts.push(album);
  subParts.push(dur);
  trackSub.textContent = subParts.join(" · ");

  // If there's a cover, optionally show it in the palette area as a hint.
  if (item.cover) {
    paletteSwatches.insertAdjacentHTML(
      "beforebegin",
      '<div class="spotify-cover-hint"><img src="' + item.cover + '" alt="" /></div>'
    );
  }

  stageSection.hidden = false;
  exportBtn.disabled = false;
  clearBtn.disabled = false;
}

function deriveFeaturesFromBuffer(buf) {
  // Lightweight feature derivation mirroring AudioPipeline.featuresFromBuffer,
  // so we don't depend on the private module internals here.
  const channel = buf.getChannelData(0);
  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < channel.length; i++) {
    const s = channel[i];
    sumSq += s * s;
    if (Math.abs(s) > peak) peak = Math.abs(s);
  }
  const rms = Math.sqrt(sumSq / channel.length);
  return {
    duration: buf.duration,
    sampleRate: buf.sampleRate,
    channels: buf.numberOfChannels,
    peak: peak,
    rms: rms,
    bpm: estimateBpmFromChannel(channel, buf.sampleRate),
    brightness: 0.5,
    warmth: 0.5,
    spectralCentroid: 0.5,
    energy: Math.max(0, Math.min(1, rms * 2.2)),
  };
}

function estimateBpmFromChannel(channel, sr) {
  const hop = 512;
  const frames = [];
  for (let i = 0; i < channel.length - hop; i += hop) {
    let s = 0;
    for (let j = 0; j < hop; j++) s += channel[i + j] * channel[i + j];
    frames.push(Math.sqrt(s / hop));
  }
  const n = frames.length;
  if (n < 40) return 0;
  const minLag = Math.floor(sr / hop / 180 * 0.5);
  const maxLag = Math.ceil(sr / hop / 60 * 0.5);
  let bestLag = 0;
  let bestVal = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    let count = 0;
    for (let i = 0; i < n - lag; i++) {
      corr += frames[i] * frames[i + lag];
      count++;
    }
    corr = count ? corr / count : 0;
    if (corr > bestVal) {
      bestVal = corr;
      bestLag = lag;
    }
  }
  if (bestLag < 1) return 0;
  const bpm = 60 / ((bestLag * hop) / sr);
  if (bpm < 40 || bpm > 200) return 0;
  return Math.round(bpm);
}

// ---- Build UI from loaded files ----

async function handleFiles(files) {
  Gallery.clear();
  gallerySection.hidden = true;

  trackName.textContent = files.length === 1 ? stripExtension(files[0].name) : files.length + " files";
  trackSub.textContent = "Decoding audio…";
  stageSection.hidden = false;
  exportBtn.disabled = true;
  clearBtn.disabled = true;

  const results = await AudioPipeline.loadFiles(files);
  const ok = [];
  const failed = [];
  for (const r of results) {
    if (r.ok) ok.push(r);
    else failed.push(r);
  }

  if (!ok.length) {
    trackName.textContent = files.length === 1 ? stripExtension(files[0].name) : "No audio decoded";
    const msg = failed.length === 1
      ? "Couldn't decode: " + failed[0].file.name + "\n\nTry another file (MP3, WAV, FLAC, OGG, M4A)."
      : failed.length + " files couldn't be decoded. Try different audio files.";
    trackSub.textContent = msg;
    return;
  }

  loadedFiles = ok;
  currentIndex = 0;

  if (ok.length === 1) {
    await openTrack(0);
    gallerySection.hidden = true;
    stageSection.hidden = false;
  } else {
    await openTrack(0);
    stageSection.hidden = false;
    gallerySection.hidden = false;
    gallerySection.querySelector(".gallery-title").textContent = "Album art — " + ok.length + " tracks";
  }
}

function selectTrackByTitle(title) {
  const idx = loadedFiles.findIndex((f) => f.file.name === title);
  if (idx >= 0) openTrack(idx);
}

async function openTrack(index) {
  if (index < 0 || index >= loadedFiles.length) return;
  currentIndex = index;

  const entry = loadedFiles[index];
  const name = entry.file.name;
  const features = entry.features;

  trackName.textContent = stripExtension(name);
  trackSub.textContent = describeTrack(entry);
  trackStatus.textContent = "";
  trackStatus.classList.remove("warn", "ok");

  const seed = hashString(name + "|" + entry.file.lastModified);
  Renderer.reseed(seed);
  Renderer.setFeatures(features);
  Renderer.setText(stripExtension(name));
  Renderer.clear();

  AudioPipeline.prepareBuffer(entry.buffer);

  stageSection.hidden = false;
  exportBtn.disabled = false;
  clearBtn.disabled = false;
  trackStatus.textContent = "Loaded";
  trackStatus.classList.add("ok");
  playBtn.innerHTML = '<span class="icon icon-play" aria-hidden="true"></span>';
  seekBar.value = 0;
  timeDisplay.textContent = "0:00 / " + fmt(features.duration);

  await onceFirstFrame();
  Renderer.start();

  if (loadedFiles.length > 1) {
    scheduleGalleryCapture(entry);
  }
}

function onceFirstFrame() {
  return new Promise((resolve) => {
    if (!Renderer.palette.length) {
      const check = () => {
        if (Renderer.palette.length) resolve();
        else requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    } else {
      resolve();
    }
  });
}

function scheduleGalleryCapture(entry) {
  setTimeout(() => {
    if (!AudioPipeline.hasBuffer) return;
    const dataUrl = Renderer.exportImage();
    Gallery.add(dataUrl, {
      title: stripExtension(entry.file.name),
      sub: describeTrack(entry),
      file: entry.file,
    });
  }, 1200);
}

// ---- Playback controls ----

playBtn.addEventListener("click", () => {
  AudioPipeline.togglePlay();
  if (AudioPipeline.isPlaying) {
    trackStatus.textContent = "Playing";
    trackStatus.classList.add("ok");
  } else {
    trackStatus.textContent = AudioPipeline.hasBuffer ? "Paused" : "";
    trackStatus.classList.remove("ok");
  }
});

seekBar.addEventListener("input", (e) => {
  AudioPipeline.seek(parseFloat(e.target.value) / 100);
});

// ---- Visual layers ----

layerChips.forEach((chip) => {
  chip.addEventListener("click", () => {
    const key = chip.getAttribute("data-layer");
    const on = !chip.classList.contains("is-on");

    // Asking for the image layer without a photo is a prompt, not a toggle.
    if (key === "image" && on && !Renderer.hasImage()) {
      imageInput.click();
      return;
    }

    chip.classList.toggle("is-on", on);
    Renderer.setLayers({ [key]: on });
  });
});

imageInput.addEventListener("change", () => {
  const file = imageInput.files && imageInput.files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    Renderer.setImage(img);
    Renderer.reseed(hashString(file.name + "|" + file.lastModified));
    Renderer.setLayers({ image: true });
    const chip = document.querySelector('.layer-chip[data-layer="image"]');
    if (chip) {
      chip.classList.add("is-on");
      chip.textContent = "Distorted image";
    }
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    trackStatus.textContent = "Couldn't read that image";
    trackStatus.classList.add("warn");
  };
  img.src = url;
});

// ---- Export ----

exportBtn.addEventListener("click", () => {
  Renderer.exportImage();
});

// ---- Clear ----

clearBtn.addEventListener("click", () => {
  AudioPipeline.pause();
  AudioPipeline.teardownGraph();
  loadedFiles = [];
  currentIndex = -1;
  stageSection.hidden = true;
  gallerySection.hidden = true;
  dropzone.hidden = false;
  Renderer.clear();
  Gallery.clear();
  exportBtn.disabled = true;
  clearBtn.disabled = true;
  trackName.textContent = "";
  trackSub.textContent = "";
  trackStatus.textContent = "";
  trackStatus.classList.remove("ok");
  timeDisplay.textContent = "0:00 / 0:00";
  seekBar.value = 0;
  paletteSwatches.innerHTML = "";
  statBpm.textContent = "—";
  statEnergy.textContent = "—";
  statBrightness.textContent = "—";
  statWarmth.textContent = "—";
  fileInput.value = "";
  fileInput.disabled = false;
});

// ---- Drop zone ----

dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("drag-over");
});

dropzone.addEventListener("dragleave", () => {
  dropzone.classList.remove("drag-over");
});

dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("drag-over");
  if (e.dataTransfer.files.length) {
    fileInput.files = e.dataTransfer.files;
    handleFiles(e.dataTransfer.files);
  }
});

fileInput.addEventListener("change", async () => {
  if (!fileInput.files.length) return;
  fileInput.disabled = true;
  try {
    await handleFiles(fileInput.files);
  } finally {
    // Keep the file selection visible so the user can clearly see what was loaded.
  }
});

// ---- Keyboard ----

document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  if (e.code === "Space") {
    e.preventDefault();
    if (!stageSection.hidden) playBtn.click();
  }
});

// ---- Render loop ticker ----

function tick() {
  if (AudioPipeline.hasBuffer) {
    AudioPipeline.sampleFrame();
  } else {
    Renderer.setAudioFrame({
      energy: 0.05,
      bass: 0.05,
      mid: 0.05,
      treble: 0.08,
      onsets: 0,
      brightness: 0.3,
      warmth: 0.5,
      loudness: -40,
    });
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---- Helpers ----

function describeTrack(entry) {
  const f = entry.features;
  const parts = [];
  if (f.bpm) parts.push("~" + f.bpm + " bpm");
  if (f.energy) parts.push("energy " + Math.round(f.energy * 100));
  if (f.warmth !== undefined) parts.push("warmth " + Math.round(f.warmth * 100));
  const dur = fmt(f.duration);
  const joined = parts.join(" · ");
  return (dur + " · " + joined).trim() || dur;
}

function stripExtension(name) {
  return name.replace(/\.[^.]+$/, "");
}

function fmt(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m + ":" + String(s).padStart(2, "0");
}

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0) || 1;
}

function escapeHtml(s) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  return String(s).replace(/[&<>"]/g, (c) => (map[c] || c));
}

function fmtMs(ms) {
  if (ms == null || ms === 0) return "—";
  return fmt(ms / 1000);
}

// ---- Spotify callback handling ----

function handleSpotifyCallbackFromUrl() {
  const hash = window.location.hash.slice(1);
  if (!hash) return;
  const params = new URLSearchParams(hash);
  if (params.has("access_token")) {
    const ok = Spotify.handleAuthCallback(hash);
    if (ok) {
      try { window.history.replaceState(null, "", window.location.pathname); } catch (_) {}
      spotifySourceActive = true;
      spotifySource.hidden = false;
      updateSpotifyStatus(Spotify.state);
      if (!Spotify.state.deviceId) {
        ensureSpotifyPlayer().catch((e) => setSpotifyStatus("Player: " + escapeHtml(String(e)), "error"));
      }
    }
  }
}

async function ensureSpotifyPlayer() {
  await Spotify.ensureSdk();
  await Spotify.startPlayer();
}

if (window.location.hash.indexOf("access_token") !== -1 || window.location.pathname.endsWith("/spotify-callback")) {
  handleSpotifyCallbackFromUrl();
}

// ---- Boot ----

dropzone.hidden = false;
stageSection.hidden = true;
gallerySection.hidden = true;

Renderer.reseed(987654321);
Renderer.setFeatures({ energy: 0.15, brightness: 0.3, warmth: 0.5, spectralCentroid: 0.5, bpm: 0, duration: 0 });
Renderer.start();

window.__synesthesia = { AudioPipeline, Renderer, Gallery, Spotify, openTrack, handleFiles };
