/**
 * Audio pipeline for the synesthesia artwork generator.
 *
 * Responsibilities:
 *  - Accept audio files (single or multiple).
 *  - Decode the audio with AudioContext.decodeAudioData.
 *  - Build an audio graph: source -> analyser (-> optional gain for volume shaping).
 *  - Provide playback control (play/pause/seek) and time updates.
 *  - Extract frame-by-frame audio features used by the renderer:
 *      * Frequency spectrum (bass / mid / treble bands)
 *      - Short-time energy / RMS
 *      - Beat / transient detection (onset energy)
 *      - Overall brightness and warmth derived from the spectrum
 */

function makeAudioPipeline() {
  var ctx = null;
  var buffer = null;
  var source = null;
  var analyser = null;
  var gain = null;
  var position = 0;
  var paused = true;
  var pauseStart = 0;
  var startOffset = 0;
  var resumeAt = 0;

  var features = {
    duration: 0,
    sampleRate: 0,
    channels: 0,
    bpm: 0,
    energy: 0,
    brightness: 0,
    warmth: 0,
    spectralCentroid: 0,
  };

  var frame = {
    energy: 0,
    bass: 0,
    mid: 0,
    treble: 0,
    onsets: 0,
    brightness: 0,
    warmth: 0,
    loudness: 0,
  };

  var onPlaybackStateChange = null;
  var onFrame = null;
  var onTimeUpdate = null;

  function ensureContext() {
    if (!ctx || ctx.state === "closed") {
      ctx = new AudioContext({ latencyHint: "interactive" });
    }
    if (ctx.state === "suspended") {
      ctx.resume().catch(function () {});
    }
    return ctx;
  }

  function ensureGraph() {
    if (!buffer) return null;
    var c = ensureContext();
    if (!analyser) {
      source = c.createBufferSource();
      source.buffer = buffer;

      analyser = c.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.8;

      gain = c.createGain();
      gain.gain.value = 1;

      source.connect(gain);
      gain.connect(analyser);

      source.onended = function () {
        paused = true;
        if (onPlaybackStateChange) onPlaybackStateChange(false);
      };
    }
    return analyser;
  }

  function setCallbacks(opts) {
    opts = opts || {};
    if (opts.onPlaybackStateChange) onPlaybackStateChange = opts.onPlaybackStateChange;
    if (opts.onFrame) onFrame = opts.onFrame;
    if (opts.onTimeUpdate) onTimeUpdate = opts.onTimeUpdate;
  }

  function loadFiles(files) {
    var c = ensureContext();
    var results = [];
    return new Promise(function (resolve) {
      var index = 0;
      function next() {
        if (index >= files.length) {
          resolve(results);
          return;
        }
        var file = files[index++];
        file.arrayBuffer().then(function (arrayBuffer) {
          var decoded = null;
          try {
            decoded = c.decodeAudioData(arrayBuffer, function () {
              throw new Error("Could not decode audio file: " + file.name);
            });
          } catch (err) {
            console.warn("Skipping file that could not be decoded:", file.name, err);
            results.push({ file: file, ok: false, error: String(err) });
            next();
            return;
          }
          var f = deriveFeatures(decoded);
          results.push({ file: file, ok: true, buffer: decoded, features: f });
          next();
        }).catch(function (err) {
          console.warn("Skipping file that failed to read:", file.name, err);
          results.push({ file: file, ok: false, error: String(err) });
          next();
        });
      }
      next();
    });
  }

  function prepareBuffer(buf) {
    buffer = buf;
    position = 0;
    startOffset = 0;
    paused = true;
    pauseStart = 0;
    features.duration = buf.duration;
    features.sampleRate = buf.sampleRate;
    features.channels = buf.numberOfChannels;
    recomputeGlobalFeatures(buf);
    teardownGraph();
    ensureGraph();
    if (onFrame) onFrame(frame, features);
    if (onTimeUpdate) onTimeUpdate(0, features.duration);
  }

  function teardownGraph() {
    if (source) {
      try { source.stop(); } catch (e) {}
      source.disconnect();
      source = null;
    }
    if (analyser) {
      analyser.disconnect();
      analyser = null;
    }
    if (gain) {
      gain.disconnect();
      gain = null;
    }
  }

  function play() {
    if (!buffer || !analyser) return;
    var c = ensureContext();
    if (source) {
      try { source.stop(); } catch (e) {}
      source.disconnect();
      source = null;
    }
    source = c.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    gain.connect(c.destination);
    var offset = currentPosition();
    source.start(0, offset);
    paused = false;
    pauseStart = 0;
    startOffset = offset;
    source.onended = function () {
      paused = true;
      if (onPlaybackStateChange) onPlaybackStateChange(false);
    };
    if (onPlaybackStateChange) onPlaybackStateChange(true);
  }

  function pause() {
    if (!ctx || !source) return;
    if (paused) return;
    position = currentPosition();
    paused = true;
    try { source.stop(); } catch (e) {}
    source.disconnect();
    source = null;
    if (onPlaybackStateChange) onPlaybackStateChange(false);
  }

  function togglePlay() {
    if (!buffer) return;
    if (paused) {
      if (currentPosition() >= features.duration - 0.05) {
        position = 0;
        startOffset = 0;
      }
      play();
    } else {
      pause();
    }
  }

  function seek(norm) {
    if (!buffer) return;
    var t = Math.max(0, Math.min(1, norm)) * features.duration;
    var wasPlaying = !paused;
    if (wasPlaying) pause();
    position = t;
    startOffset = t;
    if (wasPlaying) play();
    if (onTimeUpdate) onTimeUpdate(t, features.duration);
  }

  function currentPosition() {
    if (!ctx) return position;
    if (paused) return position;
    var elapsed = ctx.currentTime - (resumeAt || ctx.currentTime);
    return Math.min(features.duration, Math.max(0, startOffset + elapsed));
  }

  function sampleFrame() {
    if (!analyser || !buffer) {
      if (onFrame) onFrame(frame, features);
      return;
    }
    var freq = new Uint8Array(analyser.frequencyBinCount);
    var time = new Uint8Array(analyser.fftSize);
    analyser.getByteFrequencyData(freq);
    analyser.getByteTimeDomainData(time);
    var nyquist = features.sampleRate / 2;
    var binWidth = nyquist / analyser.frequencyBinCount;

    var sumSq = 0;
    for (var i = 0; i < time.length; i++) {
      var v = (time[i] - 128) / 128;
      sumSq += v * v;
    }
    var rms = Math.sqrt(sumSq / time.length);
    var loudness = 20 * Math.log10(Math.max(rms, 1e-6));
    frame.loudness = Math.max(-60, Math.min(0, loudness));
    frame.energy = clamp01((rms * 2.2));

    var bass = bandEnergy(freq, 20, 250, nyquist, binWidth);
    var mid = bandEnergy(freq, 250, 2000, nyquist, binWidth);
    var treble = bandEnergy(freq, 2000, 16000, nyquist, binWidth);
    frame.bass = clamp01(bass);
    frame.mid = clamp01(mid);
    frame.treble = clamp01(treble);

    frame.onsets = computeOnsetActivity(freq);
    frame.brightness = clamp01(computeBrightness(freq, nyquist, binWidth));
    frame.warmth = clamp01(computeWarmth(freq, nyquist, binWidth));

    features.energy = clamp01(features.energy * 0.92 + frame.energy * 0.08);
    features.brightness = clamp01(features.brightness * 0.92 + frame.brightness * 0.08);
    features.warmth = clamp01(features.warmth * 0.92 + frame.warmth * 0.08);

    if (onFrame) onFrame(frame, features);
    if (onTimeUpdate) onTimeUpdate(currentPosition(), features.duration);
  }

  function bandEnergy(freq, lo, hi, nyquist, binWidth) {
    var sum = 0;
    var count = 0;
    for (var i = 0; i < freq.length; i++) {
      var f = i * binWidth;
      if (f >= lo && f < hi) {
        sum += freq[i];
        count++;
      }
    }
    if (count === 0) return 0;
    return (sum / count) / 255;
  }

  function computeOnsetActivity(freq) {
    if (!computeOnsetActivity._prev) {
      computeOnsetActivity._prev = new Float32Array(freq.length);
    }
    var prev = computeOnsetActivity._prev;
    var acc = 0;
    for (var i = 0; i < freq.length; i++) {
      var cur = freq[i] / 255;
      var d = cur - prev[i];
      if (d > 0) acc += d;
      prev[i] = prev[i] * 0.6 + cur * 0.4;
    }
    return clamp01(acc / freq.length * 6);
  }

  function computeBrightness(freq, nyquist, binWidth) {
    var weighted = 0;
    var total = 0;
    for (var i = 0; i < freq.length; i++) {
      var f = i * binWidth;
      var v = freq[i] / 255;
      weighted += f * v;
      total += v;
    }
    if (total === 0) return 0;
    var centroid = weighted / total;
    return centroid / nyquist;
  }

  function computeWarmth(freq, nyquist, binWidth) {
    var low = bandEnergy(freq, 30, 400, nyquist, binWidth);
    var high = bandEnergy(freq, 2000, 16000, nyquist, binWidth);
    if (low + high === 0) return 0.5;
    return clamp01(low / (low + high));
  }

  function deriveFeatures(buf) {
    var channel = buf.getChannelData(0);
    var peak = 0;
    var sumSq = 0;
    for (var i = 0; i < channel.length; i++) {
      var s = channel[i];
      sumSq += s * s;
      if (Math.abs(s) > peak) peak = Math.abs(s);
    }
    var rms = Math.sqrt(sumSq / channel.length);
    var bpm = estimateBpm(channel, buf.sampleRate);

    var tmpCtx = new AudioContext({ latencyHint: "interactive" });
    var centroid = 0;
    var brightness = 0;
    var warmth = 0;
    try {
      var src = tmpCtx.createBufferSource();
      src.buffer = buf;
      var ana = tmpCtx.createAnalyser();
      ana.fftSize = 2048;
      src.connect(ana);
      src.start(0);
      sleep(30).then(function () {
        var freq = new Uint8Array(ana.frequencyBinCount);
        ana.getByteFrequencyData(freq);
        var nyquist = buf.sampleRate / 2;
        var binWidth = nyquist / ana.frequencyBinCount;
        centroid = computeBrightness(freq, nyquist, binWidth);
        warmth = computeWarmth(freq, nyquist, binWidth);
        brightness = centroid;
        try { src.stop(); } catch (e) {}
      });
    } catch (e) {}
    try { tmpCtx.close(); } catch (e) {}

    var result = {
      duration: buf.duration,
      sampleRate: buf.sampleRate,
      channels: buf.numberOfChannels,
      peak: peak,
      rms: rms,
      bpm: bpm,
      brightness: clamp01(brightness),
      warmth: clamp01(warmth),
      spectralCentroid: clamp01(centroid),
      energy: clamp01(rms * 2.2),
    };
    return result;
  }

  function recomputeGlobalFeatures(buf) {
    var f = featuresFromBuffer(buf);
    features.bpm = f.bpm;
    features.energy = f.energy;
    features.brightness = f.brightness;
    features.warmth = f.warmth;
    features.spectralCentroid = f.spectralCentroid;
  }

  function featuresFromBuffer(buf) {
    var channel = buf.getChannelData(0);
    var peak = 0;
    var sumSq = 0;
    for (var i = 0; i < channel.length; i++) {
      var s = channel[i];
      sumSq += s * s;
      if (Math.abs(s) > peak) peak = Math.abs(s);
    }
    var rms = Math.sqrt(sumSq / channel.length);
    return {
      duration: buf.duration,
      sampleRate: buf.sampleRate,
      channels: buf.numberOfChannels,
      peak: peak,
      rms: rms,
      bpm: estimateBpm(channel, buf.sampleRate),
      brightness: 0.5,
      warmth: 0.5,
      spectralCentroid: 0.5,
      energy: clamp01(rms * 2.2),
    };
  }

  function estimateBpm(channel, sr) {
    var hop = 512;
    var frames = [];
    for (var i = 0; i < channel.length - hop; i += hop) {
      var s = 0;
      for (var j = 0; j < hop; j++) s += channel[i + j] * channel[i + j];
      frames.push(Math.sqrt(s / hop));
    }
    var n = frames.length;
    if (n < 40) return 0;
    var minLag = Math.floor(sr / hop / 180 * 0.5);
    var maxLag = Math.ceil(sr / hop / 60 * 0.5);
    var bestLag = 0;
    var bestVal = -1;
    for (var lag = minLag; lag <= maxLag; lag++) {
      var corr = 0;
      var count = 0;
      for (var i = 0; i < n - lag; i++) {
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
    var bpm = 60 / ((bestLag * hop) / sr);
    if (bpm < 40 || bpm > 200) return 0;
    return Math.round(bpm);
  }

  function clamp01(v) {
    return Math.max(0, Math.min(1, v));
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  return {
    loadFiles: loadFiles,
    prepareBuffer: prepareBuffer,
    play: play,
    pause: pause,
    togglePlay: togglePlay,
    seek: seek,
    currentPosition: currentPosition,
    sampleFrame: sampleFrame,
    setCallbacks: setCallbacks,
    teardownGraph: teardownGraph,
    get features() { return features; },
    get frame() { return frame; },
    get hasBuffer() { return !!buffer; },
    get isPlaying() { return !paused && !!ctx; },
    get context() { return ctx; },
  };
}

var AudioPipeline = makeAudioPipeline();

export default AudioPipeline;
