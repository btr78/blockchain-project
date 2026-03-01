#!/usr/bin/env node
/**
 * Music Audio Analyzer & Mixer Settings Generator
 * ================================================
 * Usage:
 *   node music-analyzer/index.js <audio.wav>        — Analyze a WAV file
 *   node music-analyzer/index.js --demo             — Generate & analyze a demo track
 *   node music-analyzer/index.js <audio.wav> --json — Output raw JSON
 *
 * Supported input: 16-bit or 24-bit PCM WAV (mono or stereo)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseFile as parseMetadata } from 'music-metadata';

import { parseWAV } from './wavParser.js';
import { analyzeAudio, BANDS } from './audioAnalysis.js';
import { generateRecommendations } from './mixerEngine.js';
import { generateDemoWAV } from './demo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── ANSI helpers (colours in terminal) ───────────────────────────────────────
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
  white:  '\x1b[37m',
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
  const normalized = Math.max(0, Math.min(1, (dbfs + 60) / 60)); // -60..0 → 0..1
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

// ─── Gain dB arrow ─────────────────────────────────────────────────────────────
function gainLabel(db) {
  if (db > 0.5)  return green(`+${db.toFixed(1)} dB ↑`);
  if (db < -0.5) return yellow(`${db.toFixed(1)} dB ↓`);
  return dim('0.0 dB  (no change)');
}

// ─── Main report printer ───────────────────────────────────────────────────────
function printReport(filePath, metadata, analysis, rec) {
  const hr  = dim('─'.repeat(66));
  const hr2 = dim('═'.repeat(66));
  const nl  = '';

  console.log(nl);
  console.log(hr2);
  console.log(bold(cyan('  🎵  MUSIC AUDIO ANALYZER & MIXER SETTINGS')));
  console.log(hr2);

  // File info
  console.log(bold('\n  FILE INFO'));
  console.log(hr);
  console.log(`  File     : ${cyan(path.basename(filePath))}`);
  if (metadata?.common?.title)  console.log(`  Title    : ${metadata.common.title}`);
  if (metadata?.common?.artist) console.log(`  Artist   : ${metadata.common.artist}`);
  if (metadata?.common?.album)  console.log(`  Album    : ${metadata.common.album}`);
  console.log(`  Duration : ${analysis.durationSec}s`);
  console.log(`  Channels : ${analysis.numChannels === 2 ? 'Stereo' : 'Mono'}`);
  console.log(`  Sample Rate: ${analysis.sampleRate.toLocaleString()} Hz  |  Channels: ${analysis.numChannels}`);

  // Overview
  console.log(bold('\n  OVERVIEW'));
  console.log(hr);
  const loud = rec.summary.loudness;
  const loudColor = loud === 'Very Hot' ? red : loud === 'Good' ? green : yellow;
  console.log(`  Loudness : ${loudColor(loud)} (${analysis.lufs} LUFS)`);
  console.log(`  Dynamics : ${analysis.isCompressed ? yellow(rec.summary.dynamics) : green(rec.summary.dynamics)} (DR ${analysis.dynamicRange} dB)`);
  console.log(`  Brightness: ${analysis.brightnessLabel}`);
  console.log(`  BPM      : ${rec.summary.bpm}${analysis.bpmConfidence !== 'low' ? dim(` [${analysis.bpmConfidence} confidence]`) : dim(' [low confidence]')}`);
  console.log(`  Stereo   : ${analysis.stereo.widthLabel} (width = ${analysis.stereo.width})`);
  if (analysis.clipping.hasClipping) {
    console.log(`  Clipping : ${red('⚠  ' + analysis.clipping.clips + ' clipped samples detected!')}`);
  } else {
    console.log(`  Clipping : ${green('None detected')}`);
  }

  // Frequency analysis
  console.log(bold('\n  FREQUENCY CONTENT'));
  console.log(hr);
  for (const [name, band] of Object.entries(BANDS)) {
    console.log(eqRow(band.label, analysis.bands[name]));
  }
  console.log(`\n  Spectral Centroid: ${analysis.spectralCentroid.toLocaleString()} Hz (${analysis.brightnessLabel})`);

  // ── MIXER SETTINGS ──
  console.log(nl);
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

  // 6. Stereo enhancer
  console.log(bold('\n  6. STEREO ENHANCEMENT'));
  console.log(hr);
  const se = rec.stereoEnhancer;
  console.log(`  Width      : ${se.width === 1.0 ? dim('No change (1.0×)') : (se.width > 1 ? green : yellow)(`${se.width}×`)}`);
  if (se.haasDelayMs > 0) {
    console.log(`  Haas Delay : ${se.haasDelayMs} ms`);
  }
  console.log(`  ${dim('→ ' + se.note)}`);

  // Footer
  console.log(nl);
  console.log(hr2);
  console.log(bold(cyan('  ✅  Analysis complete')));
  console.log(dim(`  Tip: Feed these settings into your DAW (Ableton, FL Studio, Logic, Reaper, etc.)`));
  console.log(hr2);
  console.log(nl);
}

// ─── Run ───────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const demoMode = args.includes('--demo');

  let filePath;

  if (demoMode) {
    filePath = path.join(__dirname, '_demo_track.wav');
    console.log(yellow('\nGenerating demo audio track...'));
    generateDemoWAV(filePath);
  } else {
    filePath = args.find(a => !a.startsWith('--'));
    if (!filePath) {
      console.error(red('Usage: node music-analyzer/index.js <file.wav> [--json]'));
      console.error(red('       node music-analyzer/index.js --demo'));
      process.exit(1);
    }
    if (!fs.existsSync(filePath)) {
      console.error(red(`File not found: ${filePath}`));
      process.exit(1);
    }
  }

  // Parse WAV
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.wav') {
    console.error(red(`Only WAV files are supported for full analysis (got ${ext})`));
    console.error(dim('Convert your file to WAV first: ffmpeg -i input.mp3 output.wav'));
    process.exit(1);
  }

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

  // Try to read ID3/metadata (best-effort)
  let metadata = null;
  try {
    metadata = await parseMetadata(filePath);
  } catch (_) { /* ignore */ }

  process.stdout.write(yellow('Analysing audio (FFT + BPM + dynamics)...'));
  const analysis = analyzeAudio(wavData.samples, wavData.sampleRate, wavData.numChannels);
  process.stdout.write(green(' done\n'));

  process.stdout.write(yellow('Generating mixer recommendations...'));
  const recommendations = generateRecommendations(analysis);
  process.stdout.write(green(' done\n'));

  if (jsonMode) {
    console.log(JSON.stringify({ analysis, recommendations }, null, 2));
    return;
  }

  printReport(filePath, metadata, analysis, recommendations);

  // Clean up demo WAV
  if (demoMode && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

main().catch(err => {
  console.error(red(`Unexpected error: ${err.message}`));
  process.exit(1);
});
