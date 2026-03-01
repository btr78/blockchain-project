/**
 * Music Analyzer — Test Suite
 * Run with:  node --test music-analyzer/test.js
 *
 * Uses Node's built-in test runner (node:test), no extra dependencies.
 * Covers: WAV parser, FFT, audio analysis, mixer engine, audio processor.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import { parseWAV, encodeWAV, deinterleave, stereoToMono } from './wavParser.js';
import {
  fft, hanningWindow, magnitudeSpectrum, averageSpectra, toDBFS, hzToBin, binToHz,
} from './fft.js';
import { analyzeAudio, BANDS } from './audioAnalysis.js';
import { generateRecommendations } from './mixerEngine.js';
import { applyMixerSettings } from './audioProcessor.js';

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Generate a mono sine wave at `freq` Hz, `durationSec` seconds. */
function makeSine(freq, sampleRate, durationSec, amplitude = 0.8) {
  const n = Math.round(sampleRate * durationSec);
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    s[i] = amplitude * Math.sin(2 * Math.PI * freq * i / sampleRate);
  }
  return s;
}

/** Generate silence. */
const makeSilence = (n) => new Float64Array(n);

/** Generate white noise in [-amplitude, +amplitude]. */
function makeNoise(n, amplitude = 0.5) {
  const s = new Float64Array(n);
  let seed = 42;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    s[i] = amplitude * ((seed / 0x100000000) * 2 - 1);
  }
  return s;
}

// ─── WAV Parser ────────────────────────────────────────────────────────────────

describe('WAV Parser', () => {

  it('encodes and decodes a mono 16-bit WAV round-trip', () => {
    const original = makeSine(440, 44100, 0.1);
    const buf = encodeWAV(original, 44100, 1);
    const parsed = parseWAV(buf);

    assert.equal(parsed.sampleRate, 44100);
    assert.equal(parsed.numChannels, 1);
    assert.equal(parsed.samples.length, original.length);

    // 16-bit quantisation → max error ≈ 1/32768 ≈ 0.0000305
    for (let i = 0; i < original.length; i++) {
      assert.ok(
        Math.abs(parsed.samples[i] - original[i]) < 0.0001,
        `Sample ${i} mismatch: got ${parsed.samples[i]}, expected ${original[i]}`,
      );
    }
  });

  it('encodes and decodes stereo 16-bit WAV round-trip', () => {
    const left  = makeSine(440, 44100, 0.05);
    const right = makeSine(880, 44100, 0.05);
    const interleaved = new Float64Array(left.length * 2);
    for (let i = 0; i < left.length; i++) {
      interleaved[i * 2]     = left[i];
      interleaved[i * 2 + 1] = right[i];
    }

    const buf    = encodeWAV(interleaved, 44100, 2);
    const parsed = parseWAV(buf);

    assert.equal(parsed.numChannels, 2);
    assert.equal(parsed.samples.length, interleaved.length);
  });

  it('throws on non-RIFF data', () => {
    assert.throws(
      () => parseWAV(Buffer.from('NOT A WAV FILE at all!!!!!!!!!!!!!!!!!!!!!!!!')),
      /not a riff/i,
    );
  });

  it('throws on RIFF file that is not WAVE', () => {
    const buf = Buffer.alloc(44);
    buf.write('RIFF', 0); buf.writeUInt32LE(36, 4); buf.write('AVI ', 8);
    assert.throws(() => parseWAV(buf), /not a? ?wave/i);
  });

  it('clamps samples exceeding ±1 during encode', () => {
    const hot = new Float64Array([1.5, -1.5, 0.5]);
    const buf = encodeWAV(hot, 44100, 1);
    const parsed = parseWAV(buf);
    assert.ok(parsed.samples[0] <= 1.0);
    assert.ok(parsed.samples[1] >= -1.0);
  });

  it('deinterleave splits stereo into equal-length channels', () => {
    const s = new Float64Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
    const { left, right } = deinterleave(s);
    assert.equal(left.length, 3);
    assert.equal(right.length, 3);
    assert.ok(Math.abs(left[0]  - 0.1) < 1e-9);
    assert.ok(Math.abs(right[0] - 0.2) < 1e-9);
    assert.ok(Math.abs(left[2]  - 0.5) < 1e-9);
    assert.ok(Math.abs(right[2] - 0.6) < 1e-9);
  });

  it('stereoToMono averages left and right channels', () => {
    const s = new Float64Array([0.4, 0.0, 0.4, 0.0]); // L=0.4 R=0.0 → mono 0.2
    const mono = stereoToMono(s);
    assert.equal(mono.length, 2);
    assert.ok(Math.abs(mono[0] - 0.2) < 1e-9);
  });

  it('reports correct duration', () => {
    const samples = makeSine(100, 44100, 2.0);
    const buf = encodeWAV(samples, 44100, 1);
    const parsed = parseWAV(buf);
    const duration = parsed.samples.length / parsed.sampleRate;
    assert.ok(Math.abs(duration - 2.0) < 0.001);
  });
});

// ─── FFT ──────────────────────────────────────────────────────────────────────

describe('FFT', () => {

  it('FFT of all-zeros gives all-zeros', () => {
    const n  = 16;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    fft(re, im);
    for (let i = 0; i < n; i++) {
      assert.ok(Math.abs(re[i]) < 1e-10, `re[${i}] = ${re[i]}`);
      assert.ok(Math.abs(im[i]) < 1e-10, `im[${i}] = ${im[i]}`);
    }
  });

  it('FFT of DC signal has energy only in bin 0', () => {
    const n  = 8;
    const re = new Float64Array(n).fill(1.0);
    const im = new Float64Array(n);
    fft(re, im);
    assert.ok(Math.abs(re[0] - n) < 1e-9, `DC bin should be ${n}, got ${re[0]}`);
    for (let i = 1; i < n; i++) {
      assert.ok(Math.abs(re[i]) < 1e-9, `re[${i}] should be 0`);
    }
  });

  it('FFT of a 1-bin sine has energy at the correct bin', () => {
    // A complex exponential e^(j*2π*k*n/N) produces a spike at bin k
    const N = 64;
    const k = 8; // target bin
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let n = 0; n < N; n++) {
      re[n] = Math.cos(2 * Math.PI * k * n / N);
      im[n] = Math.sin(2 * Math.PI * k * n / N); // complex exponential
    }
    fft(re, im);
    const mag = new Float64Array(N);
    for (let i = 0; i < N; i++) mag[i] = Math.sqrt(re[i]**2 + im[i]**2);

    const peak = mag.indexOf(Math.max(...mag));
    assert.equal(peak, k, `Peak should be at bin ${k}, found at ${peak}`);
    assert.ok(mag[k] > N * 0.99, `Magnitude at bin ${k} should be ~${N}, got ${mag[k]}`);
    // All other bins should be near zero
    for (let i = 0; i < N; i++) {
      if (i !== k) assert.ok(mag[i] < 0.01, `mag[${i}] = ${mag[i]} should be ~0`);
    }
  });

  it('throws on non-power-of-2 size', () => {
    assert.throws(
      () => fft(new Float64Array(7), new Float64Array(7)),
      /power of 2/i,
    );
  });

  it('Hanning window has correct length and endpoint values', () => {
    const w = hanningWindow(1024);
    assert.equal(w.length, 1024);
    assert.ok(Math.abs(w[0]) < 1e-9,     'First sample should be ~0');
    assert.ok(Math.abs(w[1023]) < 0.001, 'Last sample should be ~0');
    assert.ok(w[512] > 0.99,             'Center sample should be ~1');
  });

  it('magnitudeSpectrum returns N/2 bins', () => {
    const N      = 1024;
    const signal = new Float64Array(N).fill(0.5);
    const win    = hanningWindow(N);
    const mag    = magnitudeSpectrum(signal, win);
    assert.equal(mag.length, N / 2);
  });

  it('magnitudeSpectrum of a pure sine has peak at correct frequency', () => {
    const SR   = 44100;
    const N    = 4096;
    const freq = 1000; // 1 kHz
    const win  = hanningWindow(N);
    const s    = new Float64Array(N);
    for (let i = 0; i < N; i++) s[i] = Math.sin(2 * Math.PI * freq * i / SR);
    const mag = magnitudeSpectrum(s, win);

    const expectedBin = Math.round(freq * N / SR);
    const peakBin     = mag.indexOf(Math.max(...mag));
    assert.ok(Math.abs(peakBin - expectedBin) <= 1,
      `Peak at bin ${peakBin}, expected ~${expectedBin}`);
  });

  it('toDBFS of 1.0 returns 0 dBFS', () => {
    assert.ok(Math.abs(toDBFS(1.0)) < 1e-9);
  });

  it('toDBFS of 0.5 returns −6.02 dBFS', () => {
    assert.ok(Math.abs(toDBFS(0.5) - (-6.0206)) < 0.01);
  });

  it('toDBFS of 0 or negative returns -Infinity', () => {
    assert.equal(toDBFS(0), -Infinity);
    assert.equal(toDBFS(-0.5), -Infinity);
  });

  it('hzToBin and binToHz are inverse operations', () => {
    const SR = 44100, N = 4096;
    const freq   = 1000;
    const bin    = hzToBin(freq, N, SR);
    const result = binToHz(bin, N, SR);
    assert.ok(Math.abs(result - freq) < SR / N + 1); // within 1 bin width
  });

  it('averageSpectra averages correctly', () => {
    const a = new Float64Array([1, 2, 3]);
    const b = new Float64Array([3, 4, 5]);
    const avg = averageSpectra([a, b]);
    assert.ok(Math.abs(avg[0] - 2) < 1e-9);
    assert.ok(Math.abs(avg[1] - 3) < 1e-9);
    assert.ok(Math.abs(avg[2] - 4) < 1e-9);
  });
});

// ─── Audio Analysis ────────────────────────────────────────────────────────────

describe('Audio Analysis', () => {
  const SR = 44100;

  it('returns all expected top-level fields', () => {
    const mono     = makeSine(440, SR, 1.0);
    const analysis = analyzeAudio(mono, SR, 1);

    const required = [
      'sampleRate', 'numChannels', 'durationSec',
      'rms', 'rmsDBFS', 'peakDBFS', 'lufs',
      'bands', 'spectralCentroid', 'brightnessLabel',
      'dynamicRange', 'crestFactor', 'isCompressed',
      'bpm', 'bpmConfidence', 'stereo', 'clipping',
    ];
    for (const field of required) {
      assert.ok(field in analysis, `Missing field: ${field}`);
    }
  });

  it('frequency bands object contains all 7 expected keys', () => {
    const analysis = analyzeAudio(makeSine(440, SR, 1.0), SR, 1);
    const expectedBands = Object.keys(BANDS);
    for (const b of expectedBands) {
      assert.ok(b in analysis.bands, `Missing band: ${b}`);
      assert.ok(isFinite(analysis.bands[b]), `Band ${b} is not finite`);
    }
  });

  it('silence has near-zero RMS and very low peak', () => {
    const analysis = analyzeAudio(makeSilence(SR), SR, 1);
    assert.ok(analysis.rms < 0.001, `RMS of silence should be ~0, got ${analysis.rms}`);
    assert.ok(analysis.peakDBFS < -60, `Peak of silence should be < -60 dBFS`);
  });

  it('full-scale sine RMS is close to 1/√2 ≈ 0.707', () => {
    const sine     = makeSine(440, SR, 1.0, 1.0);
    const analysis = analyzeAudio(sine, SR, 1);
    assert.ok(
      Math.abs(analysis.rms - (1 / Math.SQRT2)) < 0.01,
      `Expected RMS ~0.707, got ${analysis.rms}`,
    );
  });

  it('clipping is detected when samples hit ±1', () => {
    const clipped = new Float64Array(SR);
    clipped.fill(1.0);
    const analysis = analyzeAudio(clipped, SR, 1);
    assert.ok(analysis.clipping.hasClipping);
    assert.ok(analysis.clipping.clips > 0);
  });

  it('no clipping on a sine at 0.8 amplitude', () => {
    const analysis = analyzeAudio(makeSine(440, SR, 1.0, 0.8), SR, 1);
    assert.ok(!analysis.clipping.hasClipping);
  });

  it('duration matches sample count / sample rate', () => {
    const n        = SR * 3; // 3 seconds
    const mono     = makeSine(440, SR, 3.0);
    const analysis = analyzeAudio(mono, SR, 1);
    assert.ok(Math.abs(analysis.durationSec - 3.0) < 0.1);
  });

  it('stereo width is 0 for identical left/right channels', () => {
    const left  = makeSine(440, SR, 0.5);
    const interleaved = new Float64Array(left.length * 2);
    for (let i = 0; i < left.length; i++) {
      interleaved[i * 2]     = left[i];
      interleaved[i * 2 + 1] = left[i]; // identical → mono
    }
    const analysis = analyzeAudio(interleaved, SR, 2);
    assert.ok(analysis.stereo.width < 0.05, `Width should be ~0, got ${analysis.stereo.width}`);
  });

  it('crest factor of sine is close to 3 dB', () => {
    // Sine: peak = 1, RMS = 1/√2 → crest = 20*log10(√2) ≈ 3.01 dB
    const analysis = analyzeAudio(makeSine(440, SR, 1.0, 1.0), SR, 1);
    assert.ok(
      Math.abs(analysis.crestFactor - 3.01) < 0.5,
      `Expected crestFactor ~3 dB, got ${analysis.crestFactor}`,
    );
  });

  it('all numeric fields are finite numbers', () => {
    const analysis = analyzeAudio(makeNoise(SR * 2, 0.5), SR, 1);
    const numerics = ['rms','rmsDBFS','peakDBFS','lufs','dynamicRange','crestFactor','spectralCentroid'];
    for (const f of numerics) {
      assert.ok(Number.isFinite(analysis[f]), `${f} = ${analysis[f]} is not finite`);
    }
  });
});

// ─── Mixer Engine ─────────────────────────────────────────────────────────────

describe('Mixer Engine', () => {
  let rec;

  before(() => {
    const analysis = analyzeAudio(makeNoise(44100 * 6, 0.4), 44100, 1);
    rec = generateRecommendations(analysis);
  });

  it('returns all required top-level sections', () => {
    for (const key of ['gain', 'eq', 'compressor', 'limiter', 'reverb', 'stereoEnhancer', 'summary']) {
      assert.ok(key in rec, `Missing section: ${key}`);
    }
  });

  it('gain recommendation is within ±24 dB', () => {
    assert.ok(rec.gain.inputGainDB >= -24 && rec.gain.inputGainDB <= 24,
      `Gain ${rec.gain.inputGainDB} dB is out of ±24 range`);
  });

  it('EQ entries have positive frequencies and gainDB within ±12', () => {
    for (const band of rec.eq) {
      assert.ok(band.frequency > 0, `Frequency must be positive: ${band.frequency}`);
      assert.ok(Math.abs(band.gainDB) <= 12,
        `EQ gainDB out of ±12 range: ${band.gainDB} on ${band.band}`);
    }
  });

  it('compressor ratio is a valid "N:1" string', () => {
    assert.match(rec.compressor.ratio, /^\d+(\.\d+)?:1$/);
  });

  it('compressor attack and release are positive', () => {
    assert.ok(rec.compressor.attackMs  > 0);
    assert.ok(rec.compressor.releaseMs > 0);
  });

  it('limiter ceiling is negative (below 0 dBFS)', () => {
    assert.ok(rec.limiter.ceilingDB < 0,
      `Limiter ceiling should be < 0 dBFS, got ${rec.limiter.ceilingDB}`);
  });

  it('reverb wet/dry is between 0 and 1', () => {
    assert.ok(rec.reverb.wetDry >= 0 && rec.reverb.wetDry <= 1);
  });

  it('reverb room size is between 0 and 1', () => {
    assert.ok(rec.reverb.roomSize >= 0 && rec.reverb.roomSize <= 1);
  });

  it('stereo enhancer width is a positive number', () => {
    assert.ok(rec.stereoEnhancer.width > 0);
  });

  it('summary fields are non-empty strings', () => {
    for (const [k, v] of Object.entries(rec.summary)) {
      assert.ok(typeof v === 'string' && v.length > 0, `summary.${k} is empty`);
    }
  });

  it('target LUFS is -14 (streaming standard)', () => {
    assert.equal(rec.gain.targetLUFS, -14);
  });
});

// ─── Audio Processor ──────────────────────────────────────────────────────────

describe('Audio Processor', () => {
  const SR = 44100;
  const DURATION = 2; // seconds

  it('output has the same sample count as input', () => {
    const samples  = makeNoise(SR * DURATION, 0.4);
    const analysis = analyzeAudio(samples, SR, 1);
    const rec      = generateRecommendations(analysis);
    const out      = applyMixerSettings(samples, 1, SR, rec);
    assert.equal(out.length, samples.length);
  });

  it('does not mutate the input samples', () => {
    const samples  = makeSine(440, SR, 0.5);
    const copy     = new Float64Array(samples);
    const analysis = analyzeAudio(samples, SR, 1);
    const rec      = generateRecommendations(analysis);
    applyMixerSettings(samples, 1, SR, rec);
    // Original should be unchanged
    for (let i = 0; i < samples.length; i++) {
      assert.equal(samples[i], copy[i], `Input mutated at index ${i}`);
    }
  });

  it('limiter keeps output within ±1.0', () => {
    // Hot input that would clip without a limiter
    const hot = new Float64Array(SR);
    hot.fill(0.95);
    const analysis = analyzeAudio(hot, SR, 1);
    const rec      = generateRecommendations(analysis);
    const out      = applyMixerSettings(hot, 1, SR, rec);
    for (let i = 0; i < out.length; i++) {
      assert.ok(Math.abs(out[i]) <= 1.0001,
        `Sample ${i} exceeds ±1.0: ${out[i]}`);
    }
  });

  it('processing silence produces silence', () => {
    const silent   = makeSilence(SR);
    const analysis = analyzeAudio(silent, SR, 1);
    const rec      = generateRecommendations(analysis);
    const out      = applyMixerSettings(silent, 1, SR, rec);
    // All samples should still be 0 (or very close after numeric precision)
    for (let i = 0; i < out.length; i++) {
      assert.ok(Math.abs(out[i]) < 1e-9, `Expected silence, got ${out[i]} at ${i}`);
    }
  });

  it('works on stereo (interleaved) input', () => {
    const left  = makeSine(440, SR, 0.5, 0.4);
    const right = makeSine(880, SR, 0.5, 0.4);
    const interleaved = new Float64Array(left.length * 2);
    for (let i = 0; i < left.length; i++) {
      interleaved[i * 2]     = left[i];
      interleaved[i * 2 + 1] = right[i];
    }
    const analysis = analyzeAudio(interleaved, SR, 2);
    const rec      = generateRecommendations(analysis);
    const out      = applyMixerSettings(interleaved, 2, SR, rec);
    assert.equal(out.length, interleaved.length);
    // Should not clip
    for (let i = 0; i < out.length; i++) {
      assert.ok(Math.abs(out[i]) <= 1.0001, `Stereo sample ${i} clipped: ${out[i]}`);
    }
  });

  it('compressor reduces average level of a consistently loud signal', () => {
    // Loud noise: compressor should reduce its average RMS
    const loud     = makeNoise(SR * 2, 0.95);
    const analysis = analyzeAudio(loud, SR, 1);
    const rec      = generateRecommendations(analysis);

    // Force heavy compression settings for this test
    rec.compressor.threshold  = -6;
    rec.compressor.ratio      = '8:1';
    rec.compressor.attackMs   = 1;
    rec.compressor.releaseMs  = 50;
    rec.compressor.makeupGainDB = 0;
    rec.gain.inputGainDB = 0; // disable gain stage for clean measurement

    const out = applyMixerSettings(loud, 1, SR, rec);

    let rmsIn = 0, rmsOut = 0;
    for (let i = 0; i < loud.length; i++) {
      rmsIn  += loud[i] ** 2;
      rmsOut += out[i]  ** 2;
    }
    rmsIn  = Math.sqrt(rmsIn  / loud.length);
    rmsOut = Math.sqrt(rmsOut / out.length);

    assert.ok(rmsOut < rmsIn, `Compressor should reduce RMS: in=${rmsIn.toFixed(3)} out=${rmsOut.toFixed(3)}`);
  });
});
