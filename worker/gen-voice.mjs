#!/usr/bin/env node
/**
 * Generate the audio-guide narration with ElevenLabs.
 *
 * The public site is fully static, so there is no server that could hold an
 * API key. Anything shipped to the browser is public. So narration is rendered
 * to MP3 here, on your machine, and the resulting files are served as plain
 * static assets. The key never leaves this script.
 *
 *   export ELEVENLABS_API_KEY=...          # or put it in worker/.env
 *   node gen-voice.mjs --list-voices       # pick a voice
 *   node gen-voice.mjs --voice <voice_id>  # render every beat
 *
 * Re-runs only regenerate beats whose text changed, so editing one line of
 * narration.json costs one line of credits rather than the whole script.
 *
 * Node 18+. No dependencies.
 */

import { readFile, writeFile, mkdir, readdir, stat, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const NARRATION = join(HERE, '..', 'web', 'src', 'narration.json');
const OUT_DIR = join(HERE, '..', 'web', 'public', 'audio');
const MANIFEST = join(OUT_DIR, 'manifest.json');

const API = 'https://api.elevenlabs.io';
// multilingual_v2 is the quality tier; the flash models trade fidelity for
// latency, which buys us nothing when we render ahead of time.
const MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2';
const OUTPUT_FORMAT = process.env.ELEVENLABS_FORMAT || 'mp3_44100_128';
const DELAY_MS = Number(process.env.VOICE_DELAY_MS || 700);

// Slightly higher stability than the default and no style push: this is a
// news read, not a performance. Speed just under 1 so the numbers land.
const VOICE_SETTINGS = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0,
  speed: 0.96,
  use_speaker_boost: true,
};

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hashOf = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** Key from the environment, falling back to a gitignored worker/.env. */
async function apiKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY.trim();
  try {
    const env = await readFile(join(HERE, '.env'), 'utf8');
    for (const line of env.split('\n')) {
      const m = line.match(/^\s*ELEVENLABS_API_KEY\s*=\s*(.+?)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* no .env, fall through */
  }
  return null;
}

async function listVoices(key) {
  const res = await fetch(`${API}/v2/voices?page_size=100`, {
    headers: { 'xi-api-key': key },
  });
  if (!res.ok) throw new Error(`voices: ${res.status} ${await res.text()}`);
  const { voices = [] } = await res.json();
  return voices;
}

async function synthesize(key, voiceId, text) {
  const url = `${API}/v1/text-to-speech/${voiceId}?output_format=${OUTPUT_FORMAT}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': key,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: MODEL_ID,
      voice_settings: VOICE_SETTINGS,
    }),
  });
  if (!res.ok) {
    // The 401/422 bodies explain themselves well; pass them straight through.
    throw new Error(`tts ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function readManifest() {
  try {
    return JSON.parse(await readFile(MANIFEST, 'utf8'));
  } catch {
    return { beats: {} };
  }
}

async function main() {
  const { beats } = JSON.parse(await readFile(NARRATION, 'utf8'));
  const chars = beats.reduce((n, b) => n + b.text.length, 0);

  if (has('--dry-run')) {
    console.log(`${beats.length} beats, ${chars} characters total\n`);
    for (const b of beats) console.log(`  ${b.id.padEnd(20)} ${b.text.length} chars`);
    console.log('\nNothing was generated and no credits were spent.');
    return;
  }

  const key = await apiKey();
  if (!key) {
    console.error(
      'No API key.\n\n' +
        '  export ELEVENLABS_API_KEY=sk_...\n' +
        '    or\n' +
        '  echo "ELEVENLABS_API_KEY=sk_..." > worker/.env   (gitignored)\n\n' +
        'Then re-run. `--dry-run` works without a key.',
    );
    process.exit(1);
  }

  if (has('--list-voices')) {
    const voices = await listVoices(key);
    console.log(`${voices.length} voices:\n`);
    for (const v of voices) {
      const labels = Object.values(v.labels || {}).join(', ');
      console.log(`  ${v.voice_id}  ${(v.name || '').padEnd(22)} ${labels}`);
    }
    console.log('\nPick one and pass it: node gen-voice.mjs --voice <voice_id>');
    return;
  }

  const voiceId = valueOf('--voice') || process.env.ELEVENLABS_VOICE_ID;
  if (!voiceId) {
    console.error('No voice. Run `node gen-voice.mjs --list-voices` and pass --voice <voice_id>.');
    process.exit(1);
  }

  await mkdir(OUT_DIR, { recursive: true });
  const prev = await readManifest();
  const force = has('--force');
  // Anything that changes how a take sounds invalidates every take, not just
  // the ones whose text changed. Voice settings get hashed because they are a
  // whole object and any field in it (speed, stability) changes the output.
  const settingsHash = hashOf(JSON.stringify(VOICE_SETTINGS));
  const settingsChanged =
    prev.voiceId !== voiceId ||
    prev.modelId !== MODEL_ID ||
    prev.format !== OUTPUT_FORMAT ||
    prev.settingsHash !== settingsHash;

  const next = {
    voiceId,
    modelId: MODEL_ID,
    format: OUTPUT_FORMAT,
    settingsHash,
    generatedAt: new Date().toISOString(),
    beats: {},
  };

  // Written after every beat rather than once at the end. A 429 or a dropped
  // connection halfway through used to leave the manifest untouched, so the
  // beats already paid for looked unrecorded and the next run bought them
  // again — and on a first run the app could not see them at all, since it
  // gates on the manifest rather than on the files.
  const saveManifest = () => writeFile(MANIFEST, JSON.stringify(next, null, 2) + '\n');

  let made = 0, kept = 0, billed = 0;
  for (const beat of beats) {
    const hash = hashOf(beat.text);
    const file = join(OUT_DIR, `${beat.id}.mp3`);
    const old = prev.beats?.[beat.id];
    let exists = false;
    try {
      exists = (await stat(file)).size > 0;
    } catch {
      /* not there yet */
    }

    if (!force && !settingsChanged && exists && old?.hash === hash) {
      next.beats[beat.id] = old;
      kept++;
      console.log(`  = ${beat.id} (unchanged)`);
      continue;
    }

    process.stdout.write(`  → ${beat.id} … `);
    let mp3;
    try {
      mp3 = await synthesize(key, voiceId, beat.text);
    } catch (e) {
      // Bank what has already been paid for before giving up.
      console.log('failed');
      await saveManifest();
      throw new Error(`${e.message}\n\n${made} beat(s) were generated and recorded in the manifest. Re-run to pick up where this stopped.`);
    }
    await writeFile(file, mp3);
    next.beats[beat.id] = { hash, bytes: mp3.length, chars: beat.text.length };
    made++;
    billed += beat.text.length;
    await saveManifest();
    console.log(`${(mp3.length / 1024).toFixed(0)} KB`);
    if (made < beats.length) await sleep(DELAY_MS);
  }

  // Drop MP3s whose beat was renamed or deleted, so the folder stays truthful.
  // This directory is generated output and the manifest is authoritative, so a
  // leftover take is only ever confusing.
  const known = new Set(beats.map((b) => `${b.id}.mp3`));
  for (const f of await readdir(OUT_DIR)) {
    if (f.endsWith('.mp3') && !known.has(f)) {
      await rm(join(OUT_DIR, f));
      console.log(`  ✕ ${f} removed (no such beat any more)`);
    }
  }

  await saveManifest();
  console.log(`\n${made} generated, ${kept} reused, ${billed} characters billed.`);
  console.log(`Manifest: ${MANIFEST}`);
}

main().catch((e) => {
  console.error(`\n${e.message}`);
  process.exit(1);
});
