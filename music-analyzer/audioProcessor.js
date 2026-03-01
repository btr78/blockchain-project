/**
 * Audio Processor — applies mixer settings to raw PCM samples.
 *
 * Signal chain (in order):
 *   Input gain → Parametric EQ (biquad filters) → Compressor → Output Limiter
 *
 * All processing is done in 64-bit floating-point on the interleaved sample
 * array returned by the WAV parser, so stereo is handled naturally.
 */

// ─── Biquad filter (RBJ Audio EQ Cookbook) ────────────────────────────────────

/**
 * Compute biquad coefficients for a peaking EQ band.
 * @param {number} freq       - Center frequency (Hz)
 * @param {number} gainDB     - Gain in dB (positive = boost, negative = cut)
 * @param {number} q          - Quality factor (bandwidth)
 * @param {number} sampleRate
 * @returns {{ b0,b1,b2,a0,a1,a2 }}
 */
function peakingEQCoeffs(freq, gainDB, q, sampleRate) {
  const A  = Math.pow(10, gainDB / 40);   // sqrt of linear gain
  const w0 = 2 * Math.PI * freq / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = sinW0 / (2 * q);

  const b0 =  1 + alpha * A;
  const b1 = -2 * cosW0;
  const b2 =  1 - alpha * A;
  const a0 =  1 + alpha / A;
  const a1 = -2 * cosW0;
  const a2 =  1 - alpha / A;

  return { b0, b1, b2, a0, a1, a2 };
}

/**
 * Compute biquad coefficients for a high-shelf filter.
 * @param {number} freq       - Shelf frequency (Hz)
 * @param {number} gainDB     - Gain in dB
 * @param {number} sampleRate
 * @returns {{ b0,b1,b2,a0,a1,a2 }}
 */
function highShelfCoeffs(freq, gainDB, sampleRate) {
  const A  = Math.pow(10, gainDB / 40);
  const w0 = 2 * Math.PI * freq / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const s  = 1.0; // shelf slope
  const alpha = sinW0 / 2 * Math.sqrt((A + 1/A) * (1/s - 1) + 2);

  const sqA = Math.sqrt(A);
  const b0 =       A * ((A+1) + (A-1)*cosW0 + 2*sqA*alpha);
  const b1 = -2 * A * ((A-1) + (A+1)*cosW0                );
  const b2 =       A * ((A+1) + (A-1)*cosW0 - 2*sqA*alpha);
  const a0 =           ((A+1) - (A-1)*cosW0 + 2*sqA*alpha);
  const a1 =     2 *   ((A-1) - (A+1)*cosW0               );
  const a2 =           ((A+1) - (A-1)*cosW0 - 2*sqA*alpha);

  return { b0, b1, b2, a0, a1, a2 };
}

/**
 * Compute biquad coefficients for a low-shelf filter.
 */
function lowShelfCoeffs(freq, gainDB, sampleRate) {
  const A  = Math.pow(10, gainDB / 40);
  const w0 = 2 * Math.PI * freq / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const s  = 1.0;
  const alpha = sinW0 / 2 * Math.sqrt((A + 1/A) * (1/s - 1) + 2);

  const sqA = Math.sqrt(A);
  const b0 =       A * ((A+1) - (A-1)*cosW0 + 2*sqA*alpha);
  const b1 = 2 * A   * ((A-1) - (A+1)*cosW0               );
  const b2 =       A * ((A+1) - (A-1)*cosW0 - 2*sqA*alpha);
  const a0 =           ((A+1) + (A-1)*cosW0 + 2*sqA*alpha);
  const a1 =    -2 *   ((A-1) + (A+1)*cosW0               );
  const a2 =           ((A+1) + (A-1)*cosW0 - 2*sqA*alpha);

  return { b0, b1, b2, a0, a1, a2 };
}

/**
 * Apply a biquad filter in-place to a mono sample array using Direct Form II.
 * @param {Float64Array} samples - Modified in-place
 * @param {{ b0,b1,b2,a0,a1,a2 }} coeffs
 */
function applyBiquad(samples, coeffs) {
  const { b0, b1, b2, a0, a1, a2 } = coeffs;
  const nb0 = b0 / a0, nb1 = b1 / a0, nb2 = b2 / a0;
  const na1 = a1 / a0, na2 = a2 / a0;

  let w1 = 0, w2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const w0 = x - na1 * w1 - na2 * w2;
    samples[i] = nb0 * w0 + nb1 * w1 + nb2 * w2;
    w2 = w1;
    w1 = w0;
  }
}

/**
 * Apply biquad filter independently to each channel of an interleaved buffer.
 * @param {Float64Array} interleaved - Modified in-place
 * @param {number}       numChannels
 * @param {object}       coeffs
 */
function applyBiquadInterleaved(interleaved, numChannels, coeffs) {
  for (let ch = 0; ch < numChannels; ch++) {
    const { b0, b1, b2, a0, a1, a2 } = coeffs;
    const nb0 = b0/a0, nb1 = b1/a0, nb2 = b2/a0;
    const na1 = a1/a0, na2 = a2/a0;

    let w1 = 0, w2 = 0;
    for (let i = ch; i < interleaved.length; i += numChannels) {
      const x  = interleaved[i];
      const w0 = x - na1 * w1 - na2 * w2;
      interleaved[i] = nb0 * w0 + nb1 * w1 + nb2 * w2;
      w2 = w1;
      w1 = w0;
    }
  }
}

// ─── Gain ──────────────────────────────────────────────────────────────────────

function applyGain(samples, gainDB) {
  const linear = Math.pow(10, gainDB / 20);
  for (let i = 0; i < samples.length; i++) samples[i] *= linear;
}

// ─── Compressor ────────────────────────────────────────────────────────────────

/**
 * Simple feed-forward compressor with soft-knee and ballistics.
 * @param {Float64Array} samples    - Modified in-place (mono or interleaved)
 * @param {number} numChannels
 * @param {object} settings         - { threshold, ratio, attackMs, releaseMs, makeupGainDB, kneeDB }
 * @param {number} sampleRate
 */
function applyCompressor(samples, numChannels, settings, sampleRate) {
  const { threshold, ratio, attackMs, releaseMs, makeupGainDB, kneeDB = 4 } = settings;

  const attackCoeff  = Math.exp(-1 / (sampleRate * attackMs  / 1000));
  const releaseCoeff = Math.exp(-1 / (sampleRate * releaseMs / 1000));
  const halfKnee     = kneeDB / 2;
  const makeupLinear = Math.pow(10, makeupGainDB / 20);

  let env = 0; // envelope follower (dB)

  const numFrames = samples.length / numChannels;

  for (let frame = 0; frame < numFrames; frame++) {
    // Peak level across channels (in dB)
    let peakLin = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      peakLin = Math.max(peakLin, Math.abs(samples[frame * numChannels + ch]));
    }
    const inputDB = peakLin > 1e-10 ? 20 * Math.log10(peakLin) : -200;

    // Gain computer with soft knee
    let gainReductionDB;
    const over = inputDB - threshold;
    if (over <= -halfKnee) {
      gainReductionDB = 0;
    } else if (over <= halfKnee) {
      // Soft knee
      const t = (over + halfKnee) / kneeDB;
      gainReductionDB = (1/ratio - 1) * (over + halfKnee) * t / 2;
    } else {
      gainReductionDB = over * (1/ratio - 1);
    }

    // Envelope follower on the gain reduction (ballistics)
    const targetEnv = gainReductionDB;
    if (targetEnv < env) {
      env = attackCoeff  * env + (1 - attackCoeff)  * targetEnv; // attack (gain going down)
    } else {
      env = releaseCoeff * env + (1 - releaseCoeff) * targetEnv; // release (gain recovering)
    }

    const gainLinear = Math.pow(10, env / 20) * makeupLinear;
    for (let ch = 0; ch < numChannels; ch++) {
      samples[frame * numChannels + ch] *= gainLinear;
    }
  }
}

// ─── Limiter (hard + look-ahead via peak detection) ───────────────────────────

/**
 * True-peak brickwall limiter.
 * @param {Float64Array} samples   - Modified in-place
 * @param {number} ceilingDB       - e.g. -0.3
 */
function applyLimiter(samples, ceilingDB) {
  const ceiling = Math.pow(10, ceilingDB / 20);
  const attackCoeff  = Math.exp(-1 / 32);  // ~32 samples attack
  const releaseCoeff = Math.exp(-1 / 4410); // ~100ms release at 44100

  let env = 1.0;

  for (let i = 0; i < samples.length; i++) {
    const abs   = Math.abs(samples[i]);
    const target = abs > ceiling ? ceiling / abs : 1.0;

    if (target < env) {
      env = attackCoeff  * env + (1 - attackCoeff)  * target;
    } else {
      env = releaseCoeff * env + (1 - releaseCoeff) * target;
    }

    samples[i] *= env;
  }
}

// ─── Main processing entry point ──────────────────────────────────────────────

/**
 * Apply all mixer recommendations to a copy of the samples.
 * @param {Float64Array} samples      - Original interleaved samples (not mutated)
 * @param {number}       numChannels
 * @param {number}       sampleRate
 * @param {object}       rec          - Output of generateRecommendations()
 * @returns {Float64Array}            - Processed interleaved samples
 */
export function applyMixerSettings(samples, numChannels, sampleRate, rec) {
  // Work on a copy so we don't mutate the original
  const out = new Float64Array(samples);

  // 1. Input gain
  const gainDB = rec.gain.inputGainDB;
  if (Math.abs(gainDB) > 0.1) {
    applyGain(out, gainDB);
  }

  // 2. Parametric EQ (apply each band as a biquad filter)
  for (const band of rec.eq) {
    let coeffs;

    if (band.band === 'subBass' || band.band === 'bass') {
      // Low-shelf for bottom end
      coeffs = lowShelfCoeffs(band.frequency, band.gainDB, sampleRate);
    } else if (band.band === 'air') {
      // High-shelf for top end
      coeffs = highShelfCoeffs(band.frequency, band.gainDB, sampleRate);
    } else {
      // Peaking EQ for mids
      coeffs = peakingEQCoeffs(band.frequency, band.gainDB, band.q, sampleRate);
    }

    applyBiquadInterleaved(out, numChannels, coeffs);
  }

  // 3. Compressor
  const cmp = rec.compressor;
  applyCompressor(out, numChannels, {
    threshold:    cmp.threshold,
    ratio:        parseFloat(cmp.ratio),  // e.g. "4:1" → 4.0
    attackMs:     cmp.attackMs,
    releaseMs:    cmp.releaseMs,
    makeupGainDB: cmp.makeupGainDB,
    kneeDB:       cmp.kneeDB,
  }, sampleRate);

  // 4. Output limiter
  applyLimiter(out, rec.limiter.ceilingDB);

  return out;
}
