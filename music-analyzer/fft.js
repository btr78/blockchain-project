/**
 * Fast Fourier Transform (FFT) - iterative Cooley-Tukey algorithm.
 * Operates in-place on real/imaginary arrays whose length must be a power of 2.
 */

/**
 * In-place FFT.  re and im must have the same length (power of 2).
 * @param {Float64Array} re - Real part (modified in-place)
 * @param {Float64Array} im - Imaginary part (modified in-place, start as zeros)
 */
export function fft(re, im) {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error('FFT size must be a power of 2');

  // Bit-reversal permutation
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  // Cooley-Tukey butterfly passes
  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const angle = -2 * Math.PI / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);

    for (let i = 0; i < n; i += len) {
      let curRe = 1.0;
      let curIm = 0.0;

      for (let k = 0; k < halfLen; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + halfLen] * curRe - im[i + k + halfLen] * curIm;
        const vIm = re[i + k + halfLen] * curIm + im[i + k + halfLen] * curRe;

        re[i + k]          = uRe + vRe;
        im[i + k]          = uIm + vIm;
        re[i + k + halfLen] = uRe - vRe;
        im[i + k + halfLen] = uIm - vIm;

        const newRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = newRe;
      }
    }
  }
}

/**
 * Generate a Hanning window to reduce spectral leakage.
 * @param {number} size
 * @returns {Float64Array}
 */
export function hanningWindow(size) {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  return w;
}

/**
 * Compute the magnitude spectrum (|X[k]|) for a block of samples.
 * Returns only the first N/2 bins (positive frequencies).
 * @param {Float64Array} samples  - Time-domain block, length = FFT_SIZE
 * @param {Float64Array} window   - Hanning window of same length
 * @returns {Float64Array}        - Magnitude spectrum, length = FFT_SIZE / 2
 */
export function magnitudeSpectrum(samples, window) {
  const n = samples.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);

  // Apply window
  for (let i = 0; i < n; i++) {
    re[i] = samples[i] * window[i];
  }

  fft(re, im);

  // Return magnitudes for positive frequencies only
  const half = n >> 1;
  const mag = new Float64Array(half);
  for (let i = 0; i < half; i++) {
    mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]) / n;
  }
  // Scale DC and Nyquist correctly (they appear once, not twice)
  mag[0] /= 2;
  return mag;
}

/**
 * Average multiple magnitude spectra together.
 * @param {Float64Array[]} spectra
 * @returns {Float64Array}
 */
export function averageSpectra(spectra) {
  if (spectra.length === 0) throw new Error('No spectra to average');
  const len = spectra[0].length;
  const avg = new Float64Array(len);
  for (const spectrum of spectra) {
    for (let i = 0; i < len; i++) avg[i] += spectrum[i];
  }
  const n = spectra.length;
  for (let i = 0; i < len; i++) avg[i] /= n;
  return avg;
}

/**
 * Convert a linear magnitude value to dBFS.
 * @param {number} magnitude - Linear (0..1)
 * @returns {number} dBFS
 */
export function toDBFS(magnitude) {
  if (magnitude <= 0) return -Infinity;
  return 20 * Math.log10(magnitude);
}

/**
 * Map a FFT bin index to a frequency in Hz.
 * @param {number} bin
 * @param {number} fftSize
 * @param {number} sampleRate
 * @returns {number}
 */
export function binToHz(bin, fftSize, sampleRate) {
  return (bin * sampleRate) / fftSize;
}

/**
 * Map a frequency in Hz to the nearest FFT bin index.
 * @param {number} hz
 * @param {number} fftSize
 * @param {number} sampleRate
 * @returns {number}
 */
export function hzToBin(hz, fftSize, sampleRate) {
  return Math.round((hz * fftSize) / sampleRate);
}
