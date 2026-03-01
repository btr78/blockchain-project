/**
 * Mixer Recommendation Engine.
 * Converts audio analysis results into concrete mixer settings:
 * gain staging, EQ, compression, limiting, reverb/space, and stereo enhancement.
 */

// ─── Target loudness reference ──────────────────────────────────────────────────
const TARGET_LUFS_STREAMING = -14; // Spotify / Apple Music / YouTube
const TARGET_LUFS_MASTER    = -9;  // Loud mastering target

// ─── Reference frequency balance (well-mixed track, dBFS relative) ─────────────
// These ratios describe how each band should sit relative to the "mid" band.
// A negative value means that band should be quieter than the mid by that many dB.
const IDEAL_BALANCE = {
  subBass:  -8,   // sub-bass sits 8 dB below mids
  bass:     -3,   // bass slightly below mids
  lowMid:   -5,   // low-mid pulled back to avoid mud
  mid:       0,   // reference (0 = same as mids)
  highMid:  -3,   // slight presence dip
  presence: -6,   // presence pulled back
  air:     -10,   // air region naturally rolls off
};

// ─── Gain staging ──────────────────────────────────────────────────────────────

function recommendGain(lufs) {
  const gainForStreaming = TARGET_LUFS_STREAMING - lufs;
  const gainForMaster    = TARGET_LUFS_MASTER    - lufs;
  const clampedStreaming = Math.max(-24, Math.min(24, gainForStreaming));

  return {
    inputGainDB: Math.round(clampedStreaming * 10) / 10,
    targetLUFS: TARGET_LUFS_STREAMING,
    gainForMasteringDB: Math.round(gainForMaster * 10) / 10,
    note: gainForStreaming > 0
      ? `Track is ${Math.abs(gainForStreaming).toFixed(1)} dB too quiet for streaming — increase gain`
      : `Track is ${Math.abs(gainForStreaming).toFixed(1)} dB too hot for streaming — reduce gain`,
  };
}

// ─── EQ recommendations ────────────────────────────────────────────────────────

/**
 * Compare each band to the ideal balance and suggest cuts/boosts.
 * @param {Object} bands - dBFS energy per band
 * @returns {EQSetting[]}
 */
function recommendEQ(bands) {
  const midLevel = bands.mid; // Reference: actual mid level
  const eqSettings = [];

  const bandDetails = {
    subBass:  { freq: 40,    q: 0.7, label: 'Sub-bass' },
    bass:     { freq: 100,   q: 1.0, label: 'Bass' },
    lowMid:   { freq: 320,   q: 1.2, label: 'Low-mid (mud)' },
    mid:      { freq: 1000,  q: 0.8, label: 'Mid' },
    highMid:  { freq: 3200,  q: 1.0, label: 'High-mid (presence)' },
    presence: { freq: 6000,  q: 0.9, label: 'Presence / Air' },
    air:      { freq: 12000, q: 0.7, label: 'Air / Brilliance' },
  };

  for (const [band, detail] of Object.entries(bandDetails)) {
    const actual  = bands[band];
    const target  = midLevel + IDEAL_BALANCE[band];
    const diff    = actual - target; // positive = too loud, needs cut

    // Skip if values are non-finite (e.g. silence or inaudible band)
    if (!Number.isFinite(diff) || Math.abs(diff) < 1.5) continue;

    const gainDB   = Math.max(-12, Math.min(12, -Math.round(diff * 10) / 10));
    const action   = gainDB > 0 ? 'Boost' : 'Cut';
    let   reason;

    if (band === 'subBass' && diff > 0)   reason = 'Excessive sub-bass causes boom / muddiness';
    else if (band === 'subBass')          reason = 'Sub-bass is thin; track may lack body on large speakers';
    else if (band === 'bass' && diff > 0) reason = 'Too much bass — mix sounds bassy/muddy';
    else if (band === 'bass')             reason = 'Bass is light — may sound thin';
    else if (band === 'lowMid' && diff > 0) reason = 'Low-mid buildup (classic mud) — cut to clean up';
    else if (band === 'lowMid')           reason = 'Low-mids are scooped — can sound hollow';
    else if (band === 'mid' && diff > 0)  reason = 'Mids are prominent — may sound nasal/boxy';
    else if (band === 'mid')              reason = 'Mids are recessed — mix may sound scooped';
    else if (band === 'highMid' && diff > 0) reason = 'Upper-mid harshness — can be fatiguing';
    else if (band === 'highMid')          reason = 'Upper-mids are dull — mix lacks definition';
    else if (band === 'presence' && diff > 0) reason = 'Too much presence — can sound harsh/sibilant';
    else if (band === 'presence')         reason = 'Presence region is low — mix sounds dull';
    else if (band === 'air' && diff > 0)  reason = 'Excessive high-end — may sound harsh/digital';
    else                                  reason = 'High-end rolloff — mix sounds dull / lacks air';

    eqSettings.push({
      band,
      frequency: detail.freq,
      gainDB,
      q: detail.q,
      type: Math.abs(gainDB) > 6 ? 'peaking' : 'peaking',
      action,
      reason,
    });
  }

  // Sort by frequency
  eqSettings.sort((a, b) => a.frequency - b.frequency);
  return eqSettings;
}

// ─── Compression ───────────────────────────────────────────────────────────────

function recommendCompression(analysis) {
  const { dynamicRange, crestFactor, isCompressed, bpm } = analysis;

  // If already heavily compressed, don't add more
  if (dynamicRange < 4) {
    return {
      threshold: -6,
      ratio: '1.2:1',
      attackMs: 10,
      releaseMs: 100,
      makeupGainDB: 0,
      kneeDB: 3,
      note: 'Track is already heavily limited — avoid additional compression',
    };
  }

  // Determine ratio from dynamic range
  let ratio, thresholdDB, makeupGain;
  if (dynamicRange > 20) {
    ratio = '6:1';
    thresholdDB = -24;
    makeupGain  = 6;
  } else if (dynamicRange > 14) {
    ratio = '4:1';
    thresholdDB = -20;
    makeupGain  = 4;
  } else if (dynamicRange > 8) {
    ratio = '2:1';
    thresholdDB = -18;
    makeupGain  = 2;
  } else {
    ratio = '1.5:1';
    thresholdDB = -16;
    makeupGain  = 1;
  }

  // Attack/release based on transient content (crest factor)
  // High crest factor = percussive → fast attack
  let attackMs, releaseMs;
  if (crestFactor > 15) {
    attackMs  = 2;
    releaseMs = 60;
  } else if (crestFactor > 10) {
    attackMs  = 8;
    releaseMs = 120;
  } else {
    attackMs  = 20;
    releaseMs = 250;
  }

  // Release modulation hint from BPM
  let bpmNote = '';
  if (bpm > 0) {
    const beatDurationMs = Math.round((60 / bpm) * 1000);
    const suggestedRelease = Math.round(beatDurationMs * 0.5);
    bpmNote = ` At ${bpm} BPM, try release ≈ ${suggestedRelease} ms (½ beat).`;
  }

  return {
    threshold: thresholdDB,
    ratio,
    attackMs,
    releaseMs,
    makeupGainDB: makeupGain,
    kneeDB: 4,
    note: `Dynamic range is ${dynamicRange} dB.${bpmNote}`,
  };
}

// ─── Limiter ───────────────────────────────────────────────────────────────────

function recommendLimiter(peakDBFS, clipping) {
  const ceilingDB = -0.3;
  const gainReduction = Math.max(0, peakDBFS - ceilingDB);

  return {
    ceilingDB,
    gainReductionDB: Math.round(gainReduction * 10) / 10,
    truePeak: true,
    note: clipping.hasClipping
      ? `⚠️  ${clipping.clips} clipped samples detected — reduce input gain before limiting`
      : 'No clipping detected — limiter is a safety net only',
  };
}

// ─── Reverb / Space ────────────────────────────────────────────────────────────

function recommendReverb(analysis) {
  const { stereo, bpm, spectralCentroid } = analysis;
  const width = stereo ? stereo.width : 0;

  // Narrow stereo → more reverb to open up the space
  let preDelayMs, roomSize, wetDry, decayMs;

  if (width < 0.2) {
    preDelayMs = 15;
    roomSize   = 0.6;
    wetDry     = 0.25;
    decayMs    = 1800;
  } else if (width < 0.5) {
    preDelayMs = 10;
    roomSize   = 0.45;
    wetDry     = 0.15;
    decayMs    = 1200;
  } else {
    // Already wide — minimal reverb
    preDelayMs = 8;
    roomSize   = 0.3;
    wetDry     = 0.08;
    decayMs    = 800;
  }

  // BPM-sync hint
  let delaySync = '';
  if (bpm > 0) {
    const eighthNote = Math.round((60 / bpm / 2) * 1000);
    const quarterNote = Math.round((60 / bpm) * 1000);
    delaySync = `Sync delay to BPM: 1/8 = ${eighthNote} ms, 1/4 = ${quarterNote} ms`;
  }

  // High spectral centroid → shorter reverb to avoid harshness
  if (spectralCentroid > 2000) {
    decayMs = Math.round(decayMs * 0.7);
    wetDry  = Math.round(wetDry * 0.8 * 100) / 100;
  }

  return {
    preDelayMs,
    roomSize,
    wetDry: Math.round(wetDry * 100) / 100,
    decayMs,
    highFreqDamping: spectralCentroid > 1800 ? 0.7 : 0.4,
    delaySync: delaySync || 'No BPM detected — set reverb tail to taste',
  };
}

// ─── Stereo enhancement ────────────────────────────────────────────────────────

function recommendStereoEnhancement(stereo) {
  if (!stereo || stereo.widthLabel === 'Mono') {
    return {
      width: 1.3,
      haasDelayMs: 15,
      note: 'Mono source — apply Haas effect (15–20 ms delay on one side) or Mid/Side processing to widen',
    };
  }

  let targetWidth, note;
  if (stereo.width < 0.3) {
    targetWidth = 1.4;
    note = 'Narrow mix — increase stereo width; check if mono compatibility is maintained';
  } else if (stereo.width > 0.9) {
    targetWidth = 0.85;
    note = 'Very wide — slight narrowing improves mono compatibility and center focus';
  } else {
    targetWidth = 1.0;
    note = 'Stereo width is good — no adjustment needed';
  }

  return {
    width: targetWidth,
    haasDelayMs: 0,
    note,
  };
}

// ─── Main export ───────────────────────────────────────────────────────────────

/**
 * Generate complete mixer recommendations from audio analysis.
 * @param {object} analysis - Result of analyzeAudio()
 * @returns {MixerSettings}
 */
export function generateRecommendations(analysis) {
  const {
    lufs, peakDBFS, bands, clipping,
    dynamicRange, crestFactor, isCompressed,
    bpm, stereo, spectralCentroid, brightnessLabel,
  } = analysis;

  return {
    gain:            recommendGain(lufs),
    eq:              recommendEQ(bands),
    compressor:      recommendCompression(analysis),
    limiter:         recommendLimiter(peakDBFS, clipping),
    reverb:          recommendReverb(analysis),
    stereoEnhancer:  recommendStereoEnhancement(stereo),

    // Summary labels for the report
    summary: {
      loudness: lufs > -10 ? 'Very Hot' : lufs > -16 ? 'Good' : lufs > -23 ? 'Quiet' : 'Very Quiet',
      dynamics: isCompressed ? 'Heavily Compressed' : dynamicRange > 14 ? 'Dynamic' : 'Moderate',
      brightness: brightnessLabel,
      bpm: bpm > 0 ? `${bpm} BPM` : 'Unknown',
    },
  };
}
