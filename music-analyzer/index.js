#!/usr/bin/env node
/**
 * Music Audio Analyzer & Mixer Settings Generator
 * ================================================
 * Usage:
 *   node music-analyzer/index.js <audio.wav>           — Analyze a WAV file
 *   node music-analyzer/index.js --demo                — Generate & analyze a demo track
 *   node music-analyzer/index.js <audio.wav> --enhance — Analyze + apply settings → saves <file>_enhanced.wav
 *   node music-analyzer/index.js <audio.wav> --play    — Analyze + play audio through speakers
 *   node music-analyzer/index.js <audio.wav> --json    — Output raw JSON
 *
 * Supported input: 16-bit, 24-bit, or 32-bit PCM WAV (mono or stereo)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';
import { parseFile as parseMetadata } from 'music-metadata';

import { parseWAV, encodeWAV } from './wavParser.js';
import { analyzeAudio, BANDS } from './audioAnalysis.js';
import { generateRecommendations } from './mixerEngine.js';
import { applyMixerSettings } from './audioProcessor.js';
import { generateDemoWAV } from './demo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── ANSI helpers ──────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  magenta:'\x1b[35m',
  blue:   '\x1b[34m',
};
const bold   = s => `${C.bold}${s}${C.reset}`;
const dim    = s => `${C.dim}${s}${C.reset}`;
const cyan   = s => `${C.cyan}${s}${C.reset}`;
const green  = s => `${C.green}${s}${C.reset}`;
const yellow = s => `${C.yellow}${s}${C.reset}`;
const red    = s => `${C.red}${s}${C.reset}`;
const blue   = s => `${C.blue}${s}${C.reset}`;
const mag    = s => `${C.magenta}${s}${C.reset}`;

// ─── Bar graph ─────────────────────────────────────────────────────────────────
function levelBar(dbfs, width = 24) {
  const normalized = Math.max(0, Math.min(1, (dbfs + 60) / 60));
  const filled = Math.round(normalized * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  const colorFn = dbfs > -6 ? red : dbfs > -18 ? green : yellow;
  return `${colorFn(bar)} ${dim(dbfs.toFixed(1) + ' dBFS')}`;
}

// ─── EQ band row ───────────────────────────────────────────────────────────────
function eqRow(label, dbfs, width = 20) {
  const normalized = Math.max(0, Math.min(1, (dbfs + 60) / 60));
  const filled = Math.round(normalized * width);
  const bar = '▓'.repeat(filled) + '·'.repeat(width - filled);
  const colorFn = dbfs > -10 ? red : dbfs > -25 ? green : blue;
  return `  ${bold(label.padEnd(14))} ${colorFn(bar)} ${dim(dbfs.toFixed(1) + ' dBFS')}`;
}

// ─── Gain label ────────────────────────────────────────────────────────────────
function gainLabel(db) {
  if (db > 0.5)  return green(`+${db.toFixed(1)} dB ↑`);
  if (db < -0.5) return yellow(`${db.toFixed(1)} dB ↓`);
  return dim('0.0 dB  (no change)');
}

// ─── Playback ──────────────────────────────────────────────────────────────────

/**
 * Detect which audio playback tool is available on this system.
 * Returns { tool, args } or null if none found.
 */
function detectPlaybackTool(wavPath) {
  const candidates = [
    { bin: 'aplay',  args: [wavPath] },
    { bin: 'play',   args: [wavPath] },           // sox
    { bin: 'ffplay', args: ['-nodisp', '-autoexit', wavPath] },
    { bin: 'paplay', args: [wavPath] },            // PulseAudio
    { bin: 'pw-play',args: [wavPath] },            // PipeWire
    { bin: 'mpg123', args: ['--wav', '-', wavPath] },
  ];

  for (const { bin, args } of candidates) {
    try {
      execSync(`which ${bin}`, { stdio: 'ignore' });
      return { bin, args };
    } catch (_) { /* not found */ }
  }
  return null;
}

/**
 * Attempt to play a WAV file, printing a progress ticker.
 * Falls back gracefully if no audio device/tool is available.
 * @param {string} wavPath
 * @param {number} durationSec
 */
async function playAudio(wavPath, durationSec) {
  const tool = detectPlaybackTool(wavPath);

  if (!tool) {
    console.log(yellow('\n  ⚠  No audio playback tool found on this system.'));
    console.log(dim('     Install one of: aplay (alsa-utils), play (sox), ffplay (ffmpeg)'));
    console.log(dim(`     Then run:  aplay "${wavPath}"`));
    return false;
  }

  return new Promise((resolve) => {
    console.log(cyan(`\n  ▶  Playing via ${tool.bin}  (${durationSec}s) — press Ctrl+C to stop\n`));

    const proc = spawn(tool.bin, tool.args, { stdio: ['ignore', 'ignore', 'pipe'] });

    // Progress bar ticker
    const startTime = Date.now();
    const totalMs   = durationSec * 1000;
    const barWidth  = 40;

    const ticker = setInterval(() => {
      const elapsed  = Date.now() - startTime;
      const progress = Math.min(1, elapsed / totalMs);
      const filled   = Math.round(progress * barWidth);
      const bar      = green('█'.repeat(filled)) + dim('░'.repeat(barWidth - filled));
      const elapsedS = (elapsed / 1000).toFixed(1);
      const totalS   = durationSec.toFixed(1);
      process.stdout.write(`\r  ${bar} ${cyan(elapsedS + 's')} / ${dim(totalS + 's')}  `);
    }, 100);

    proc.on('close', (code) => {
      clearInterval(ticker);
      process.stdout.write('\n');
      if (code !== 0 && code !== null) {
        console.log(yellow(`  ⚠  Playback exited with code ${code} — no audio device may be available.`));
        console.log(dim(`     You can manually play the file: ${tool.bin} "${wavPath}"`));
        resolve(false);
      } else {
        console.log(green('  ✓  Playback complete'));
        resolve(true);
      }
    });

    proc.stderr.on('data', () => { /* suppress stderr noise from alsa/pulse */ });

    proc.on('error', (err) => {
      clearInterval(ticker);
      process.stdout.write('\n');
      console.log(yellow(`  ⚠  Could not launch ${tool.bin}: ${err.message}`));
      resolve(false);
    });
  });
}

// ─── Enhance: apply settings + save ───────────────────────────────────────────

/**
 * Apply mixer settings to the audio and write an enhanced WAV file.
 * @param {string}       inputPath   - Original file path (used to derive output name)
 * @param {Float64Array} samples
 * @param {number}       numChannels
 * @param {number}       sampleRate
 * @param {object}       rec          - Mixer recommendations
 * @param {string}       [outputPath] - Override output path
 * @returns {string}     outputPath
 */
function enhanceAndSave(inputPath, samples, numChannels, sampleRate, rec, outputPath) {
  process.stdout.write(yellow('Applying mixer settings (EQ + compression + limiting)...'));
  const processed = applyMixerSettings(samples, numChannels, sampleRate, rec);
  process.stdout.write(green(' done\n'));

  if (!outputPath) {
    const ext  = path.extname(inputPath);
    const base = inputPath.slice(0, -ext.length);
    outputPath = `${base}_enhanced.wav`;
  }

  process.stdout.write(yellow(`Saving enhanced WAV → ${path.basename(outputPath)}...`));
  const outBuf = encodeWAV(processed, sampleRate, numChannels);
  fs.writeFileSync(outputPath, outBuf);
  process.stdout.write(green(' done\n'));

  return outputPath;
}

// ─── Report ────────────────────────────────────────────────────────────────────
function printReport(filePath, metadata, analysis, rec, enhancedPath) {
  const hr  = dim('─'.repeat(66));
  const hr2 = dim('═'.repeat(66));

  console.log('');
  console.log(hr2);
  console.log(bold(cyan('  🎵  MUSIC AUDIO ANALYZER & MIXER SETTINGS')));
  console.log(hr2);

  // File info
  console.log(bold('\n  FILE INFO'));
  console.log(hr);
  console.log(`  File       : ${cyan(path.basename(filePath))}`);
  if (metadata?.common?.title)  console.log(`  Title      : ${metadata.common.title}`);
  if (metadata?.common?.artist) console.log(`  Artist     : ${metadata.common.artist}`);
  if (metadata?.common?.album)  console.log(`  Album      : ${metadata.common.album}`);
  console.log(`  Duration   : ${analysis.durationSec}s`);
  console.log(`  Channels   : ${analysis.numChannels === 2 ? 'Stereo' : 'Mono'}`);
  console.log(`  Sample Rate: ${analysis.sampleRate.toLocaleString()} Hz`);
  if (enhancedPath) {
    console.log(`  Enhanced   : ${green(path.basename(enhancedPath))}`);
  }

  // Overview
  console.log(bold('\n  OVERVIEW'));
  console.log(hr);
  const loud = rec.summary.loudness;
  const loudColor = loud === 'Very Hot' ? red : loud === 'Good' ? green : yellow;
  console.log(`  Loudness  : ${loudColor(loud)} (${analysis.lufs} LUFS)`);
  console.log(`  Dynamics  : ${analysis.isCompressed ? yellow(rec.summary.dynamics) : green(rec.summary.dynamics)} (DR ${analysis.dynamicRange} dB)`);
  console.log(`  Brightness: ${analysis.brightnessLabel}`);
  console.log(`  BPM       : ${rec.summary.bpm}${analysis.bpmConfidence !== 'low' ? dim(` [${analysis.bpmConfidence} confidence]`) : dim(' [low confidence]')}`);
  console.log(`  Stereo    : ${analysis.stereo.widthLabel} (width = ${analysis.stereo.width})`);
  if (analysis.clipping.hasClipping) {
    console.log(`  Clipping  : ${red('⚠  ' + analysis.clipping.clips + ' clipped samples detected!')}`);
  } else {
    console.log(`  Clipping  : ${green('None detected')}`);
  }

  // Frequency
  console.log(bold('\n  FREQUENCY CONTENT'));
  console.log(hr);
  for (const [name, band] of Object.entries(BANDS)) {
    console.log(eqRow(band.label, analysis.bands[name]));
  }
  console.log(`\n  Spectral Centroid: ${analysis.spectralCentroid.toLocaleString()} Hz (${analysis.brightnessLabel})`);

  // Mixer settings
  console.log('');
  console.log(hr2);
  console.log(bold(mag('  🎚️   MIXER SETTINGS & RECOMMENDATIONS')));
  console.log(hr2);

  // 1. Gain
  console.log(bold('\n  1. GAIN STAGING'));
  console.log(hr);
  const g = rec.gain;
  console.log(`  Input Gain  : ${gainLabel(g.inputGainDB)}`);
  console.log(`  Target      : ${g.targetLUFS} LUFS  (Spotify / Apple Music / YouTube)`);
  console.log(`  For mastering: ${gainLabel(g.gainForMasteringDB)} toward ${dim('-9 LUFS')}`);
  console.log(`  ${dim('→ ' + g.note)}`);

  // 2. EQ
  console.log(bold('\n  2. EQUALIZER  (parametric EQ settings)'));
  console.log(hr);
  if (rec.eq.length === 0) {
    console.log(green('  ✓ Frequency balance is good — no EQ corrections needed'));
  } else {
    console.log(`  ${'Band'.padEnd(14)} ${'Freq'.padEnd(8)} ${'Gain'.padEnd(10)} ${'Q'.padEnd(5)} Reason`);
    console.log(dim(`  ${'-'.repeat(63)}`));
    for (const eq of rec.eq) {
      const freqStr = `${eq.frequency} Hz`.padEnd(8);
      const gainStr = (eq.gainDB > 0 ? green(`+${eq.gainDB} dB`) : yellow(`${eq.gainDB} dB`)).padEnd(18);
      const qStr    = eq.q.toFixed(1).padEnd(5);
      console.log(`  ${eq.band.padEnd(14)} ${freqStr} ${gainStr} ${qStr} ${dim(eq.reason)}`);
    }
  }

  // 3. Compressor
  console.log(bold('\n  3. COMPRESSOR'));
  console.log(hr);
  const cmp = rec.compressor;
  console.log(`  Threshold  : ${cmp.threshold} dBFS`);
  console.log(`  Ratio      : ${bold(cmp.ratio)}`);
  console.log(`  Attack     : ${cmp.attackMs} ms`);
  console.log(`  Release    : ${cmp.releaseMs} ms`);
  console.log(`  Knee       : ${cmp.kneeDB} dB  (soft knee)`);
  console.log(`  Makeup Gain: ${gainLabel(cmp.makeupGainDB)}`);
  console.log(`  ${dim('→ ' + cmp.note)}`);

  // 4. Limiter
  console.log(bold('\n  4. LIMITER  (output stage)'));
  console.log(hr);
  const lim = rec.limiter;
  console.log(`  Ceiling    : ${lim.ceilingDB} dBFS  (true peak)`);
  console.log(`  Gain Reduction needed: ${lim.gainReductionDB > 0 ? red(lim.gainReductionDB + ' dB') : green('0 dB  (no reduction needed)')}`);
  console.log(`  ${dim('→ ' + lim.note)}`);

  // 5. Reverb
  console.log(bold('\n  5. REVERB / SPACE'));
  console.log(hr);
  const rev = rec.reverb;
  console.log(`  Pre-delay  : ${rev.preDelayMs} ms`);
  console.log(`  Room Size  : ${(rev.roomSize * 100).toFixed(0)}%`);
  console.log(`  Wet/Dry    : ${(rev.wetDry * 100).toFixed(0)}% wet`);
  console.log(`  Decay      : ${rev.decayMs} ms`);
  console.log(`  HF Damping : ${(rev.highFreqDamping * 100).toFixed(0)}%`);
  console.log(`  ${dim('→ ' + rev.delaySync)}`);

  // 6. Stereo
  console.log(bold('\n  6. STEREO ENHANCEMENT'));
  console.log(hr);
  const se = rec.stereoEnhancer;
  console.log(`  Width      : ${se.width === 1.0 ? dim('No change (1.0×)') : (se.width > 1 ? green : yellow)(`${se.width}×`)}`);
  if (se.haasDelayMs > 0) console.log(`  Haas Delay : ${se.haasDelayMs} ms`);
  console.log(`  ${dim('→ ' + se.note)}`);

  // Footer
  console.log('');
  console.log(hr2);
  console.log(bold(cyan('  ✅  Analysis complete')));
  if (enhancedPath) {
    console.log(green(`  🎧  Enhanced audio saved → ${path.basename(enhancedPath)}`));
    console.log(dim('     Open it in any audio player or DAW to hear the improvements.'));
  } else {
    console.log(dim('  Tip: Use --enhance to apply these settings and save a processed WAV.'));
    console.log(dim('  Tip: Use --play to listen to the audio during analysis.'));
  }
  console.log(hr2);
  console.log('');
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args        = process.argv.slice(2);
  const jsonMode    = args.includes('--json');
  const demoMode    = args.includes('--demo');
  const enhanceMode = args.includes('--enhance');
  const playMode    = args.includes('--play');

  let filePath;

  if (demoMode) {
    filePath = path.join(__dirname, '_demo_track.wav');
    console.log(yellow('\nGenerating demo audio track...'));
    generateDemoWAV(filePath);
  } else {
    filePath = args.find(a => !a.startsWith('--'));
    if (!filePath) {
      console.error(red('Usage: node music-analyzer/index.js <file.wav> [--enhance] [--play] [--json]'));
      console.error(red('       node music-analyzer/index.js --demo [--enhance] [--play]'));
      process.exit(1);
    }
    if (!fs.existsSync(filePath)) {
      console.error(red(`File not found: ${filePath}`));
      process.exit(1);
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.wav') {
    console.error(red(`Only WAV files are supported (got ${ext})`));
    console.error(dim('Convert first:  ffmpeg -i input.mp3 output.wav'));
    process.exit(1);
  }

  // ── Play original before analysis ──────────────────────────────────────────
  if (playMode) {
    console.log(bold(cyan('\n  ▶  PLAYBACK — Original')));
    // We need duration; do a quick WAV header peek
    const headerBuf = fs.readFileSync(filePath);
    let origDuration = 0;
    try {
      const { sampleRate, numChannels, samples } = parseWAV(headerBuf);
      origDuration = samples.length / numChannels / sampleRate;
    } catch (_) {}
    await playAudio(filePath, origDuration);
  }

  // ── Load & parse ───────────────────────────────────────────────────────────
  process.stdout.write(yellow('Reading file...'));
  const buffer = fs.readFileSync(filePath);
  process.stdout.write(green(' done\n'));

  process.stdout.write(yellow('Parsing WAV...'));
  let wavData;
  try {
    wavData = parseWAV(buffer);
  } catch (err) {
    console.error(red(`\nFailed to parse WAV: ${err.message}`));
    process.exit(1);
  }
  process.stdout.write(green(' done\n'));

  // Best-effort metadata
  let metadata = null;
  try { metadata = await parseMetadata(filePath); } catch (_) {}

  // ── Analyse ────────────────────────────────────────────────────────────────
  process.stdout.write(yellow('Analysing audio (FFT + BPM + dynamics)...'));
  const analysis = analyzeAudio(wavData.samples, wavData.sampleRate, wavData.numChannels);
  process.stdout.write(green(' done\n'));

  process.stdout.write(yellow('Generating mixer recommendations...'));
  const recommendations = generateRecommendations(analysis);
  process.stdout.write(green(' done\n'));

  if (jsonMode) {
    console.log(JSON.stringify({ analysis, recommendations }, null, 2));
    if (demoMode) fs.existsSync(filePath) && fs.unlinkSync(filePath);
    return;
  }

  // ── Enhance ────────────────────────────────────────────────────────────────
  let enhancedPath = null;
  if (enhanceMode) {
    const outPath = demoMode
      ? path.join(__dirname, 'demo_enhanced.wav')
      : undefined; // auto-derived from filePath
    enhancedPath = enhanceAndSave(
      filePath,
      wavData.samples,
      wavData.numChannels,
      wavData.sampleRate,
      recommendations,
      outPath,
    );
  }

  // ── Print report ───────────────────────────────────────────────────────────
  printReport(filePath, metadata, analysis, recommendations, enhancedPath);

  // ── Play enhanced result ───────────────────────────────────────────────────
  if (playMode && enhancedPath) {
    console.log(bold(cyan('  ▶  PLAYBACK — Enhanced (mixer settings applied)')));
    await playAudio(enhancedPath, analysis.durationSec);
  }

  // Clean up demo temp WAV (the raw unprocessed one)
  if (demoMode && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

main().catch(err => {
  console.error(red(`Unexpected error: ${err.message}`));
  process.exit(1);
});
