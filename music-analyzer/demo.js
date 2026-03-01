/**
 * Demo audio generator.
 * Creates a synthetic WAV file that simulates a music track
 * so the analyzer can be tested without a real audio file.
 *
 * The demo track contains:
 *   - Kick-like sub-bass pulse  at 60 BPM
 *   - Bass line with harmonics
 *   - Mid-range pad / chord tones
 *   - High-frequency hi-hat clicks
 *   - Slight stereo spread
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { encodeWAV } from './wavParser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SAMPLE_RATE = 44100;
const DURATION    = 10; // seconds
const NUM_CHANNELS = 2;

/** Simple ADSR envelope */
function adsr(t, attack, decay, sustain, release, duration) {
  if (t < attack)                    return t / attack;
  if (t < attack + decay)            return 1 - (1 - sustain) * ((t - attack) / decay);
  if (t < duration - release)        return sustain;
  return sustain * Math.max(0, (duration - t) / release);
}

/** Sine wave at a given frequency */
const sine = (t, freq) => Math.sin(2 * Math.PI * freq * t);

export function generateDemoWAV(outputPath) {
  const totalSamples = SAMPLE_RATE * DURATION;
  const left  = new Float64Array(totalSamples);
  const right = new Float64Array(totalSamples);

  const bpm = 120;
  const beatDur = 60 / bpm;

  for (let i = 0; i < totalSamples; i++) {
    const t = i / SAMPLE_RATE;
    const beatPhase = (t % beatDur) / beatDur; // 0..1 within each beat

    // — Kick drum (sub-bass thump on every beat) —
    const kickEnv = beatPhase < 0.15 ? Math.exp(-beatPhase * 40) : 0;
    const kickFreq = 60 * Math.exp(-beatPhase * 25);
    const kick = sine(t, kickFreq) * kickEnv * 0.7;

    // — Bass line (quarter-note pulse, two alternating notes) —
    const bar  = Math.floor(t / (beatDur * 4));
    const beat = Math.floor(t / beatDur) % 4;
    const bassNote = [55, 55, 65, 50][beat];  // E2, E2, C3, D2 (Hz approx)
    const bassEnv  = Math.exp(-(beatPhase * 12));
    const bass = (
      sine(t, bassNote) * 0.5 +
      sine(t, bassNote * 2) * 0.2 +
      sine(t, bassNote * 3) * 0.1
    ) * bassEnv * 0.5;

    // — Pad / chords (every 4 beats) —
    const padFreqs = [261, 329, 392]; // C4, E4, G4 major chord
    let pad = 0;
    for (const f of padFreqs) {
      pad += sine(t, f) * 0.1 + sine(t, f * 2) * 0.03;
    }
    pad *= 0.3;

    // — Hi-hat (every 8th note, louder on off-beats) —
    const eighthPhase = (t % (beatDur / 2)) / (beatDur / 2);
    const isOffBeat   = Math.floor(t / (beatDur / 2)) % 2 === 1;
    const hhEnv = eighthPhase < 0.05 ? Math.exp(-eighthPhase * 80) : 0;
    // White noise approximation (pseudo-random)
    const noise = Math.sin(t * 17389) * Math.sin(t * 23441) * Math.sin(t * 31337);
    const hihat = noise * hhEnv * (isOffBeat ? 0.15 : 0.08);

    // — Mix —
    const mono = kick + bass + pad + hihat;

    // Stereo: slight L/R variation on pad & hihat
    left[i]  = mono + pad * 0.15 + hihat * 0.12;
    right[i] = mono - pad * 0.15 - hihat * 0.12;
  }

  // Normalise to prevent clipping
  let maxAmp = 0;
  for (let i = 0; i < totalSamples; i++) {
    maxAmp = Math.max(maxAmp, Math.abs(left[i]), Math.abs(right[i]));
  }
  if (maxAmp > 0.95) {
    const scale = 0.92 / maxAmp;
    for (let i = 0; i < totalSamples; i++) {
      left[i]  *= scale;
      right[i] *= scale;
    }
  }

  // Interleave L/R
  const interleaved = new Float64Array(totalSamples * 2);
  for (let i = 0; i < totalSamples; i++) {
    interleaved[i * 2]     = left[i];
    interleaved[i * 2 + 1] = right[i];
  }

  const wavBuffer = encodeWAV(interleaved, SAMPLE_RATE, NUM_CHANNELS);
  fs.writeFileSync(outputPath, wavBuffer);
  console.log(`Demo WAV written → ${outputPath}`);
  return outputPath;
}

// Run directly: node demo.js [output-path]
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outPath = process.argv[2] || path.join(__dirname, 'demo.wav');
  generateDemoWAV(outPath);
}
