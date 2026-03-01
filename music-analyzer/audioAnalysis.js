/**
 * Audio analysis engine.
 * Extracts loudness, frequency content, dynamics, BPM, and stereo width
 * from raw PCM samples.
 */

import { magnitudeSpectrum, averageSpectra, hanningWindow, toDBFS, hzToBin } from './fft.js';
import { deinterleave, stereoToMono } from './wavParser.js';

const FFT_SIZE = 4096;
const WINDOW = hanningWindow(FFT_SIZE);

/** Frequency band definitions */
export const BANDS = {
  subBass:  { min: 20,   max: 60,    label: 'Sub-bass',  center: 40   },
  bass:     { min: 60,   max: 250,   label: 'Bass',      center: 120  },
  lowMid:   { min: 250,  max: 500,   label: 'Low-mid',   center: 350  },
  mid:      { min: 500,  max: 2000,  label: 'Mid',       center: 1000 },
  highMid:  { min: 2000, max: 4000,  label: 'High-mid',  center: 3000 },
  presence: { min: 4000, max: 8000,  label: 'Presence',  center: 6000 },
  air:      { min: 8000, max: 20000, label: 'Air',       center: 12000 },
};

// ─── Loudness ──────────────────────────────────────────────────────────────────

/**
 * Compute RMS level of a sample array.
 * @param {Float64Array} samples
 * @returns {number} RMS (0..1)
 */
function computeRMS(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/**
 * Compute peak level (absolute maximum).
 * @param {Float64Array} samples
 * @returns {number}
 */
function computePeak(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i]);
    if (abs > peak) peak = abs;
  }
  return peak;
}

/**
 * Compute short-term RMS energy over a sliding window.
 * Used for dynamic range and BPM analysis.
 * @param {Float64Array} samples
 * @param {number} windowSize - samples per window
 * @returns {Float64Array} RMS per window
 */
function shortTermEnergy(samples, windowSize) {
  const numWindows = Math.floor(samples.length / windowSize);
  const energy = new Float64Array(numWindows);
  for (let w = 0; w < numWindows; w++) {
    let sum = 0;
    const start = w * windowSize;
    for (let i = 0; i < windowSize; i++) sum += samples[start + i] ** 2;
    energy[w] = Math.sqrt(sum / windowSize);
  }
  return energy;
}

/**
 * Approximate LUFS from RMS (K-weighted approximation).
 * Accurate LUFS requires ITU-R BS.1770 filtering; this is a close estimate.
 */
function rmsToLUFS(rms) {
  if (rms <= 0) return -Infinity;
  return 20 * Math.log10(rms) - 0.691; // BS.1770 offset approx
}

// ─── Frequency analysis ────────────────────────────────────────────────────────

/**
 * Compute average magnitude spectrum across many overlapping windows.
 * @param {Float64Array} mono - Mono samples
 * @param {number} sampleRate
 * @returns {Float64Array} Averaged magnitude spectrum
 */
function computeAverageSpectrum(mono, sampleRate) {
  const hop = FFT_SIZE >> 1; // 50% overlap
  const spectra = [];
  const maxWindows = 200; // cap to keep analysis fast
  const step = Math.max(1, Math.floor((mono.length - FFT_SIZE) / (hop * maxWindows)));

  for (let start = 0; start + FFT_SIZE <= mono.length; start += hop * step) {
    const block = mono.slice(start, start + FFT_SIZE);
    spectra.push(magnitudeSpectrum(block, WINDOW));
    if (spectra.length >= maxWindows) break;
  }

  return averageSpectra(spectra);
}

/**
 * Compute dBFS energy for each frequency band.
 * @param {Float64Array} spectrum - Averaged magnitude spectrum
 * @param {number} sampleRate
 * @returns {Object} { subBass, bass, lowMid, mid, highMid, presence, air } in dBFS
 */
function computeBandEnergies(spectrum, sampleRate) {
  const result = {};
  for (const [name, band] of Object.entries(BANDS)) {
    const binLow  = Math.max(0, hzToBin(band.min, FFT_SIZE, sampleRate));
    const binHigh = Math.min(spectrum.length - 1, hzToBin(band.max, FFT_SIZE, sampleRate));

    if (binHigh <= binLow) {
      result[name] = -80;
      continue;
    }

    // RMS of magnitudes in band
    let sumSq = 0;
    let count = 0;
    for (let b = binLow; b <= binHigh; b++) {
      sumSq += spectrum[b] ** 2;
      count++;
    }
    const rms = Math.sqrt(sumSq / count);
    result[name] = toDBFS(rms * 10); // *10 to bring into reasonable dBFS range
  }
  return result;
}

/**
 * Compute spectral centroid (perceived brightness).
 * @param {Float64Array} spectrum
 * @param {number} sampleRate
 * @returns {number} Hz
 */
function spectralCentroid(spectrum, sampleRate) {
  let weightedSum = 0;
  let totalMag = 0;
  for (let i = 0; i < spectrum.length; i++) {
    const hz = (i * sampleRate) / (FFT_SIZE);
    weightedSum += hz * spectrum[i];
    totalMag += spectrum[i];
  }
  return totalMag > 0 ? weightedSum / totalMag : 0;
}

// ─── BPM detection ─────────────────────────────────────────────────────────────

/**
 * Detect BPM using energy-onset method.
 * @param {Float64Array} mono - Mono samples
 * @param {number} sampleRate
 * @returns {{ bpm: number, confidence: string }}
 */
function detectBPM(mono, sampleRate) {
  const WINDOW_SIZE = 512;
  const energy = shortTermEnergy(mono, WINDOW_SIZE);
  const windowDurationSec = WINDOW_SIZE / sampleRate;

  // Compute local average energy over 1-second history (~43 windows at 44100)
  const historyLen = Math.ceil(1.0 / windowDurationSec);
  const onsets = [];

  for (let i = historyLen; i < energy.length; i++) {
    const localMean = energy.slice(i - historyLen, i).reduce((a, b) => a + b, 0) / historyLen;
    if (energy[i] > 1.4 * localMean && energy[i] > 0.01) {
      onsets.push(i);
    }
  }

  if (onsets.length < 4) {
    return { bpm: 0, confidence: 'low' };
  }

  // Collect inter-onset intervals
  const intervals = [];
  for (let i = 1; i < onsets.length; i++) {
    const gapWindows = onsets[i] - onsets[i - 1];
    const gapSec = gapWindows * windowDurationSec;
    // Only accept intervals in the 60–200 BPM range
    if (gapSec >= 0.3 && gapSec <= 1.0) {
      intervals.push(gapSec);
    }
  }

  if (intervals.length < 2) {
    return { bpm: 0, confidence: 'low' };
  }

  // Median interval → BPM
  intervals.sort((a, b) => a - b);
  const medianInterval = intervals[Math.floor(intervals.length / 2)];
  const rawBPM = 60 / medianInterval;

  // Snap to nearest whole BPM and fold into 60-180 range
  let bpm = Math.round(rawBPM);
  while (bpm > 180) bpm = Math.round(bpm / 2);
  while (bpm < 60) bpm = Math.round(bpm * 2);

  const confidence = intervals.length > 10 ? 'high' : intervals.length > 4 ? 'medium' : 'low';
  return { bpm, confidence };
}

// ─── Dynamic range ─────────────────────────────────────────────────────────────

/**
 * Compute dynamic range using the DR metric approach:
 * DR = peak level - average of the loudest 20% of short-term RMS values.
 * @param {Float64Array} mono
 * @returns {{ dynamicRange: number, crestFactor: number, isCompressed: boolean }}
 */
function analyzeDynamics(mono) {
  const rmsValues = Array.from(shortTermEnergy(mono, 2048));
  rmsValues.sort((a, b) => b - a); // descending

  const top20 = rmsValues.slice(0, Math.max(1, Math.floor(rmsValues.length * 0.2)));
  const avgLoud = top20.reduce((a, b) => a + b, 0) / top20.length;

  const peak = computePeak(mono);
  const overallRMS = computeRMS(mono);

  const dynamicRange = peak > 0 && avgLoud > 0
    ? 20 * Math.log10(peak) - 20 * Math.log10(avgLoud)
    : 0;

  const crestFactor = overallRMS > 0
    ? 20 * Math.log10(peak / overallRMS)
    : 0;

  return {
    dynamicRange: Math.round(dynamicRange * 10) / 10,
    crestFactor: Math.round(crestFactor * 10) / 10,
    isCompressed: dynamicRange < 8,
  };
}

// ─── Stereo width ──────────────────────────────────────────────────────────────

/**
 * Analyse the stereo field width (Mid/Side).
 * @param {Float64Array} left
 * @param {Float64Array} right
 * @returns {{ width: number, widthLabel: string, midLevel: number, sideLevel: number }}
 */
function analyzeStereoWidth(left, right) {
  const n = Math.min(left.length, right.length);
  let midPower = 0;
  let sidePower = 0;

  for (let i = 0; i < n; i++) {
    const mid  = (left[i] + right[i]) * 0.5;
    const side = (left[i] - right[i]) * 0.5;
    midPower  += mid  * mid;
    sidePower += side * side;
  }

  midPower  = Math.sqrt(midPower  / n);
  sidePower = Math.sqrt(sidePower / n);

  const width = midPower > 0 ? sidePower / midPower : 0; // 0 = mono, 1 = very wide

  let widthLabel;
  if (width < 0.1)      widthLabel = 'Mono / Very Narrow';
  else if (width < 0.3) widthLabel = 'Narrow';
  else if (width < 0.6) widthLabel = 'Moderate';
  else if (width < 0.9) widthLabel = 'Wide';
  else                  widthLabel = 'Very Wide';

  return {
    width: Math.round(width * 100) / 100,
    widthLabel,
    midLevel: toDBFS(midPower),
    sideLevel: toDBFS(sidePower),
  };
}

// ─── Clipping detection ────────────────────────────────────────────────────────

function detectClipping(samples, threshold = 0.9999) {
  let clips = 0;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) >= threshold) clips++;
  }
  return { clips, hasClipping: clips > 0 };
}

// ─── Main analysis entry point ─────────────────────────────────────────────────

/**
 * Perform full audio analysis.
 * @param {Float64Array} samples   - Interleaved or mono PCM samples (normalised -1..1)
 * @param {number}       sampleRate
 * @param {number}       numChannels
 * @returns {AnalysisResult}
 */
export function analyzeAudio(samples, sampleRate, numChannels) {
  // Prepare mono + channel arrays
  let mono, left, right;
  if (numChannels === 2) {
    ({ left, right } = deinterleave(samples));
    mono = stereoToMono(samples);
  } else {
    mono = samples;
    left = samples;
    right = samples;
  }

  // Loudness
  const rms      = computeRMS(mono);
  const peak     = computePeak(mono);
  const peakDBFS = toDBFS(peak);
  const rmsDBFS  = toDBFS(rms);
  const lufs     = rmsToLUFS(rms);

  // Frequency analysis
  const spectrum  = computeAverageSpectrum(mono, sampleRate);
  const bands     = computeBandEnergies(spectrum, sampleRate);
  const centroid  = spectralCentroid(spectrum, sampleRate);

  // Brightness label
  let brightnessLabel;
  if (centroid < 800)       brightnessLabel = 'Dark / Warm';
  else if (centroid < 1500) brightnessLabel = 'Balanced';
  else if (centroid < 2500) brightnessLabel = 'Bright';
  else                      brightnessLabel = 'Very Bright / Harsh';

  // Dynamics
  const dynamics = analyzeDynamics(mono);

  // BPM (only attempt if track > 5 seconds)
  const durationSec = mono.length / sampleRate;
  const bpmResult = durationSec > 5 ? detectBPM(mono, sampleRate) : { bpm: 0, confidence: 'low' };

  // Stereo width (meaningful only for stereo files)
  const stereo = numChannels === 2
    ? analyzeStereoWidth(left, right)
    : { width: 0, widthLabel: 'Mono', midLevel: rmsDBFS, sideLevel: -Infinity };

  // Clipping
  const clipping = detectClipping(samples);

  return {
    // File properties
    sampleRate,
    numChannels,
    durationSec: Math.round(durationSec * 10) / 10,

    // Loudness
    rms,
    rmsDBFS: Math.round(rmsDBFS * 10) / 10,
    peakDBFS: Math.round(peakDBFS * 10) / 10,
    lufs: Math.round(lufs * 10) / 10,

    // Frequency content
    bands,
    spectralCentroid: Math.round(centroid),
    brightnessLabel,

    // Dynamics
    ...dynamics,

    // Rhythm
    bpm: bpmResult.bpm,
    bpmConfidence: bpmResult.confidence,

    // Stereo
    stereo,

    // Clipping
    clipping,
  };
}
