/**
 * The audio guide.
 *
 * Two kinds of narration, and they cannot work the same way:
 *
 *   Story beats are fixed text, so they are recorded ahead of time by
 *   worker/gen-voice.mjs and served as static MP3s. Real voice.
 *
 *   Parcel readouts are generated from whichever of 207,000 parcels you just
 *   opened. There is nothing to pre-record and no server to synthesize
 *   against, so they fall back to the browser's own speech synthesis.
 *
 * If the MP3s have not been generated, everything falls back to speech
 * synthesis and the guide still works, just robotically.
 */

import script from './narration.json';

export const NARRATION: Record<string, string> = Object.fromEntries(
  script.beats.map((b) => [b.id, b.text]),
);

type Manifest = { voiceId: string; beats: Record<string, { hash: string }> };

// undefined = not looked for yet, null = looked and there is none
let manifest: Manifest | null | undefined;
let manifestPromise: Promise<Manifest | null> | null = null;
let current: HTMLAudioElement | null = null;
// Bumped by every narrate()/stop, so a call that resumes after an await can
// tell it has been superseded. Without it, scrolling quickly through beats
// starts one audio element per beat and they all play over each other — the
// manifest fetch on the first call makes that window wide.
let generation = 0;

const AUDIO_BASE = import.meta.env.VITE_AUDIO_BASE ?? '/audio';

function loadManifest(): Promise<Manifest | null> {
  if (manifest !== undefined) return Promise.resolve(manifest);
  if (manifestPromise) return manifestPromise;
  manifestPromise = fetch(`${AUDIO_BASE}/manifest.json`)
    .then((r) => {
      // A missing file can come back as the SPA shell with a 200, so trust the
      // content type rather than the status. Parsing index.html would throw and
      // land in the catch anyway; this just makes the miss deliberate.
      if (!r.ok) return null;
      if (!(r.headers.get('content-type') || '').includes('json')) return null;
      return r.json();
    })
    .catch(() => null)
    .then((m: Manifest | null) => {
      manifest = m;
      return m;
    });
  return manifestPromise;
}

/** Warm the manifest so the first beat does not wait on a round trip. */
export function primeNarration(): void {
  void loadManifest();
}

export function stopNarration(): void {
  generation++;
  if (current) {
    current.pause();
    current = null;
  }
  if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
}

function speechFallback(text: string): void {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 0.97;
  window.speechSynthesis.speak(u);
}

/**
 * Speak a scripted beat. Prefers the recorded take, falls back to synthesis.
 * Playback can be refused by autoplay policy if we somehow got here without a
 * user gesture, so a rejected play() also falls back rather than going silent.
 */
export async function narrate(id: string): Promise<void> {
  const text = NARRATION[id];
  if (!text) return;
  stopNarration();
  const mine = generation;

  const m = await loadManifest();
  if (mine !== generation) return; // a later beat took over while we waited
  if (!m?.beats?.[id]) {
    speechFallback(text);
    return;
  }

  const el = new Audio(`${AUDIO_BASE}/${id}.mp3`);
  current = el;
  try {
    await el.play();
    // play() resolves once playback has actually begun, by which point a newer
    // beat may have started and cleared `current`. Stop this one if so.
    if (mine !== generation) {
      el.pause();
      if (current === el) current = null;
    }
  } catch {
    // Autoplay blocked, or the file is missing despite the manifest.
    if (current === el) current = null;
    if (mine === generation) speechFallback(text);
  }
}

/** Speak generated text. Always synthesis: there is no recording to have. */
export function narrateText(text: string): void {
  stopNarration();
  speechFallback(text);
}
