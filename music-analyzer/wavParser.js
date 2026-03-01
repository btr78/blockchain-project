/**
 * WAV file parser - reads PCM audio data from WAV files.
 * Supports 16-bit and 24-bit PCM, mono and stereo.
 */

/**
 * Parse a WAV file buffer into audio samples.
 * @param {Buffer} buffer - Raw file buffer
 * @returns {{ sampleRate: number, numChannels: number, bitsPerSample: number,
 *             samples: Float64Array, duration: number }}
 */
export function parseWAV(buffer) {
  if (buffer.length < 44) throw new Error('File too small to be a WAV file');

  const riff = buffer.toString('ascii', 0, 4);
  if (riff !== 'RIFF') throw new Error('Not a RIFF file (not a WAV)');

  const wave = buffer.toString('ascii', 8, 12);
  if (wave !== 'WAVE') throw new Error('RIFF file is not WAVE format');

  let offset = 12;
  let sampleRate, numChannels, bitsPerSample, audioFormat;
  let dataBuffer = null;

  // Walk through all chunks
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    offset += 8;

    if (chunkId === 'fmt ') {
      audioFormat  = buffer.readUInt16LE(offset);
      numChannels  = buffer.readUInt16LE(offset + 2);
      sampleRate   = buffer.readUInt32LE(offset + 4);
      bitsPerSample = buffer.readUInt16LE(offset + 14);
    } else if (chunkId === 'data') {
      dataBuffer = buffer.slice(offset, offset + chunkSize);
    }

    // Advance; chunks are word-aligned (round up to even)
    offset += chunkSize + (chunkSize % 2);
  }

  if (!dataBuffer) throw new Error('No data chunk found in WAV file');
  if (audioFormat !== 1) throw new Error(`Only PCM WAV (format 1) is supported, got format ${audioFormat}`);

  const bytesPerSample = bitsPerSample / 8;
  const numSamples = Math.floor(dataBuffer.length / bytesPerSample);
  const samples = new Float64Array(numSamples);

  if (bitsPerSample === 16) {
    for (let i = 0; i < numSamples; i++) {
      samples[i] = dataBuffer.readInt16LE(i * 2) / 32768.0;
    }
  } else if (bitsPerSample === 24) {
    for (let i = 0; i < numSamples; i++) {
      const b0 = dataBuffer[i * 3];
      const b1 = dataBuffer[i * 3 + 1];
      const b2 = dataBuffer[i * 3 + 2];
      let val = (b2 << 16) | (b1 << 8) | b0;
      if (val >= 0x800000) val -= 0x1000000;
      samples[i] = val / 8388608.0;
    }
  } else if (bitsPerSample === 32) {
    for (let i = 0; i < numSamples; i++) {
      samples[i] = dataBuffer.readInt32LE(i * 4) / 2147483648.0;
    }
  } else {
    throw new Error(`Unsupported bit depth: ${bitsPerSample}`);
  }

  const duration = numSamples / numChannels / sampleRate;
  return { sampleRate, numChannels, bitsPerSample, samples, duration };
}

/**
 * Separate interleaved stereo samples into left/right channels.
 * @param {Float64Array} samples - Interleaved samples
 * @returns {{ left: Float64Array, right: Float64Array }}
 */
export function deinterleave(samples) {
  const n = Math.floor(samples.length / 2);
  const left  = new Float64Array(n);
  const right = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    left[i]  = samples[i * 2];
    right[i] = samples[i * 2 + 1];
  }
  return { left, right };
}

/**
 * Mix stereo samples down to mono.
 * @param {Float64Array} samples - Interleaved stereo
 * @returns {Float64Array} Mono
 */
export function stereoToMono(samples) {
  const n = Math.floor(samples.length / 2);
  const mono = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    mono[i] = (samples[i * 2] + samples[i * 2 + 1]) * 0.5;
  }
  return mono;
}

/**
 * Write a minimal valid WAV file buffer (16-bit PCM).
 * Used by the demo generator.
 * @param {Float64Array} samples - Mono or interleaved samples
 * @param {number} sampleRate
 * @param {number} numChannels
 * @returns {Buffer}
 */
export function encodeWAV(samples, sampleRate, numChannels) {
  const dataLength = samples.length * 2; // 16-bit
  const buf = Buffer.alloc(44 + dataLength);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataLength, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);          // chunk size
  buf.writeUInt16LE(1, 20);           // PCM
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * numChannels * 2, 28); // byte rate
  buf.writeUInt16LE(numChannels * 2, 32);              // block align
  buf.writeUInt16LE(16, 34);          // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataLength, 40);

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return buf;
}
