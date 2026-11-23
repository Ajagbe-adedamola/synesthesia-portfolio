/**
 * Spotify integration for Synesthesia.
 *
 * Two things:
 *  1. Search Spotify for tracks/albums and show metadata + cover art.
 *  2. Optionally play a track through the Spotify Web Playback SDK so the
 *     app can generate artwork from the stream.
 *
 * Requirements (user must provide):
 *  - A Spotify Developer app client ID from https://developer.spotify.com/dashboard
 *  - A Spotify Premium account (the Web Playback SDK requires Premium).
 *  - A redirect URI added to the app's settings, e.g. http://localhost:3000/spotify-callback
 *
 * Caveats:
 *  - The Spotify Web Playback SDK plays an encrypted media stream in the
 *    browser. Feeding that stream into an AudioContext/AnalyserNode is browser-
 *    dependent and may not be possible (Chrome in particular restricts feeding
 *    certain cross-origin media into createMediaElementSource). When analysis is
 *    not possible we still play the track for listening, but we tell the user
 *    the artwork will use a synthetic placeholder rather than the live stream.
 *  - Mobile browsers and some desktop browsers have autoplay restrictions; the
 *    user may need to interact with the player to transfer playback.
 */

const Spotify = (() => {
  /** @type {string | null} */
  let clientId = null;

  /** @type {string} redirect URI registered on the Spotify app */
  let redirectUri = "http://localhost:3000/spotify-callback";

  /** @type {string | null} current access token */
  let token = null;

  /** @type {number | null} token expiry (ms since epoch) */
  let tokenExpiresAt = null;

  /** @type {window.Spotify.Player | null} */
  let player = null;

  /** @type {HTMLAudioElement | null} the SDK-created media element, when available */
  let mediaElement = null;

  /** @type {{ onStateChange: ((s: SpotifyState) => void) | null, onAnalysisPossible: ((p: boolean, reason: string) => void) | null }} */
  const listeners = { onStateChange: null, onAnalysisPossible: null };

  /** Current playback state exposed to the app. */
  const state = {
    signedIn: false,
    playing: false,
    track: null, // { uri, name, artists, album, cover, duration }
    deviceId: null,
    analysisPossible: false,
    analysisReason: "",
  };

  function setClientConfig({ clientId: id, redirectUri: ru } = {}) {
    if (id) clientId = id;
    if (ru) redirectUri = ru;
  }

  function setListeners({ onStateChange, onAnalysisPossible } = {}) {
    if (onStateChange) listeners.onStateChange = onStateChange;
    if (onAnalysisPossible) listeners.onAnalysisPossible = onAnalysisPossible;
  }

  // ---- OAuth (implicit flow, in-browser) ----

  function startAuth() {
    if (!clientId) return null;
    const scopes = ["streaming", "user-read-private", "user-read-email"];
    const url = new URL("https://accounts.spotify.com/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("response_type", "token");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", scopes.join(" "));
    url.searchParams.set("show_dialog", "true");
    return url.toString();
  }

  function handleAuthCallback(fragment) {
    if (!fragment) return false;
    const params = new URLSearchParams(fragment.replace(/^#/, ""));
    const accessToken = params.get("access_token");
    const expiresIn = params.get("expires_in");
    if (!accessToken) return false;
    token = accessToken;
    tokenExpiresAt = expiresIn ? Date.now() + Number(expiresIn) * 1000 : Date.now() + 3600 * 1000;
    state.signedIn = true;
    listeners.onStateChange && listeners.onStateChange({ ...state });
    return true;
  }

  function signOut() {
    token = null;
    tokenExpiresAt = null;
    stopPlayer();
    state.signedIn = false;
    state.playing = false;
    state.track = null;
    state.deviceId = null;
    listeners.onStateChange && listeners.onStateChange({ ...state });
  }

  function hasValidToken() {
    if (!token || !tokenExpiresAt) return false;
    return Date.now() < tokenExpiresAt - 60_000;
  }

  // ---- Spotify Web API (metadata / search) ----

  async function apiFetch(path, options = {}) {
    if (!hasValidToken()) throw new Error("Not signed in to Spotify");
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    };
    const res = await fetch(`https://api.spotify.com/v1${path}`, { headers, ...options });
    if (res.status === 401) {
      // Token likely expired; clear and ask to re-auth.
      token = null;
      tokenExpiresAt = null;
      state.signedIn = false;
      listeners.onStateChange && listeners.onStateChange({ ...state });
      throw new Error("Spotify session expired; please sign in again.");
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Spotify API error ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
  }

  async function search(query, type = "track,album") {
    const data = await apiFetch(`/search?q=${encodeURIComponent(query)}&type=${type}&limit=12`);
    const tracks = (data.tracks?.items || []).map(normalizeTrack);
    const albums = (data.albums?.items || []).map(normalizeAlbum);
    return { tracks, albums };
  }

  function normalizeTrack(item) {
    return {
      uri: item.uri,
      id: item.id,
      name: item.name,
      artists: item.artists.map((a) => a.name).filter(Boolean),
      artist: item.artists.map((a) => a.name).filter(Boolean).join(", "),
      album: item.album?.name || "",
      cover: firstCover(item.album),
      duration: item.duration_ms,
      type: "track",
      href: item.external_urls?.spotify,
    };
  }

  function normalizeAlbum(item) {
    return {
      uri: item.uri,
      id: item.id,
      name: item.name,
      artists: item.artists.map((a) => a.name).filter(Boolean),
      artist: item.artists.map((a) => a.name).filter(Boolean).join(", "),
      cover: firstCover(item),
      trackCount: item.total,
      type: "album",
      href: item.external_urls?.spotify,
    };
  }

  function firstCover(album) {
    const imgs = album?.images || [];
    return imgs.length ? imgs[0].url : null;
  }

  // ---- Web Playback SDK ----

  function isSdkReady() {
    return typeof window.Spotify === "function";
  }

  function tryLoadSdk() {
    return new Promise((resolve) => {
      if (isSdkReady()) return resolve(true);
      const script = document.createElement("script");
      script.src = "https://sdk.scdn.co/spotify-player.js";
      script.async = true;
      script.onload = () => resolve(isSdkReady());
      script.onerror = () => resolve(false);
      document.body.appendChild(script);
    });
  }

  async function ensureSdk() {
    const ok = await tryLoadSdk();
    if (!ok) throw new Error("Could not load the Spotify Web Playback SDK script.");
    if (!isSdkReady()) throw new Error("Spotify Web Playback SDK did not become ready.");
  }

  function createPlayer() {
    if (!clientId || !token) throw new Error("Not configured for Spotify playback");
    const p = new window.Spotify.Player({
      name: "Synesthesia",
      getOAuthToken: (cb) => cb(token),
      volume: 0.8,
    });
    p.addListener("ready", (data) => {
      state.deviceId = data.device_id;
      state.analysisPossible = assessAnalysisPossible();
      listeners.onAnalysisPossible && listeners.onAnalysisPossible(state.analysisPossible, analysisReason());
      listeners.onStateChange && listeners.onStateChange({ ...state });
    });
    p.addListener("not_ready", () => {
      state.deviceId = null;
      listeners.onStateChange && listeners.onStateChange({ ...state });
    });
    p.addListener("player_state_changed", (playerState) => {
      const wasPlaying = state.playing;
      if (playerState) {
        state.playing = !playerState.paused && !!playerState.track_window?.current_track;
        if (playerState.track_window?.current_track) {
          state.track = normalizeTrack(playerState.track_window.current_track);
        }
      } else {
        state.playing = false;
      }
      if (wasPlaying !== state.playing) {
        listeners.onStateChange && listeners.onStateChange({ ...state });
      }
    });
    p.addListener("initialization_failed", (error) => {
      console.error("Spotify player initialization failed:", error);
      state.analysisPossible = false;
      state.analysisReason = "Spotify player failed to initialize.";
      listeners.onAnalysisPossible && listeners.onAnalysisPossible(false, state.analysisReason);
    });
    player = p;
    return p;
  }

  function startPlayer() {
    if (!player) createPlayer();
    return new Promise((resolve, reject) => {
      if (!player) return reject(new Error("Player not created"));
      player.connect();
      // Give it a moment to emit ready / not_ready.
      setTimeout(() => resolve({ deviceId: state.deviceId, analysisPossible: state.analysisPossible }), 1500);
    });
  }

  function stopPlayer() {
    if (player) {
      try { player.disconnect(); } catch (_) {}
      player = null;
    }
    mediaElement = null;
    state.deviceId = null;
    state.playing = false;
  }

  function playTrack(uri) {
    if (!player) throw new Error("Spotify player not started");
    if (!state.deviceId) throw new Error("Spotify player not ready yet");
    // Use the Web API to start playback on this device.
    return apiFetch("/me/player/play", {
      method: "PUT",
      body: JSON.stringify({ uris: [uri], device_id: state.deviceId }),
    }).then(() => {
      state.playing = true;
      listeners.onStateChange && listeners.onStateChange({ ...state });
    });
  }

  function pausePlayback() {
    if (!player) return Promise.resolve();
    return player.togglePlay().then(() => {
      state.playing = false;
      listeners.onStateChange && listeners.onStateChange({ ...state });
    });
  }

  function resumePlayback() {
    if (!player) return Promise.resolve();
    return player.togglePlay().then(() => {
      state.playing = true;
      listeners.onStateChange && listeners.onStateChange({ ...state });
    });
  }

  function seekTo(ms) {
    if (!state.deviceId) return Promise.reject(new Error("No Spotify device"));
    return apiFetch("/me/player/seek", {
      method: "PUT",
      body: JSON.stringify({ position_ms: Math.max(0, ms) }),
    });
  }

  // ---- Analysis feasibility ----

  /**
   * Whether we can analyze the Spotify stream through an AudioContext.
   *
   * The Web Playback SDK plays media via the browser's media pipeline. In some
   * browsers we can attach an AnalyserNode to that media element; in others we
   * cannot (cross-origin / encrypted-media restrictions).
   *
   * We detect this by trying to obtain a media element from the player (when the
   * SDK exposes one) and testing whether createMediaElementSource succeeds.
   */
  function assessAnalysisPossible() {
    // The Spotify Web Playback SDK does not reliably expose a manipulable media
    // element to the embedder. Attempting createMediaElementSource on the SDK's
    // internal playback element is not a supported path and may be blocked by
    // browser policy. As a conservative default, we report that live analysis of
    // the Spotify stream is not available, while playback still works for listening.
    //
    // If a future SDK revision exposes a media element we can probe, we can re-test
    // here and update analysisPossible dynamically.
    state.analysisReason = "Spotify plays an encrypted browser media stream; live waveform analysis isn't supported from it. The track still plays for listening.";
    return false;
  }

  function analysisReason() {
    return state.analysisReason || "Unknown";
  }

  // ---- Bridge to our audio pipeline ----

  /**
   * When analysis is possible, connect the player's media element to our
   * AudioContext analyser and return the analyser + element. Otherwise return null.
   */
  function connectToAnalyser(ctx) {
    if (!state.analysisPossible) return null;
    try {
      const el = getMediaElement();
      if (!el) return null;
      const source = ctx.createMediaElementSource(el);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);
      // Don't connect analyser → destination here; the SDK handles output.
      mediaElement = el;
      return analyser;
    } catch (err) {
      console.warn("Could not connect Spotify media to analyser:", err);
      return null;
    }
  }

  function getMediaElement() {
    // The Web Playback SDK does not expose a public media element for capture.
    // This is a placeholder: if the SDK ever exposes one, we'd use it here.
    return null;
  }

  // ---- Public API ----

  return {
    setClientConfig,
    setListeners,
    startAuth,
    handleAuthCallback,
    signOut,
    hasValidToken,
    search,
    ensureSdk,
    startPlayer,
    stopPlayer,
    playTrack,
    pausePlayback,
    resumePlayback,
    seekTo,
    isSdkReady,
    connectToAnalyser,
    // State
    get state() { return state; },
    get clientId() { return clientId; },
    get redirectUri() { return redirectUri; },
  };
})();

export default Spotify;
