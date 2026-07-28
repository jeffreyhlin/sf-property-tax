# The audio guide

The story has an optional voice-over, toggled from the Audio button in the dock.
It reads each beat as you scroll, and reads a parcel's numbers aloud when you
open one.

Those two halves work differently, and the difference is forced by the
architecture rather than chosen.

| | Story beats | Parcel readouts |
|---|---|---|
| Text | 8 fixed lines | generated per parcel |
| Voice | recorded MP3 (ElevenLabs) | browser speech synthesis |
| Cost | one-time, ~1,200 characters | free |

The public site is static, so there is no server that could hold an API key and
no way to synthesize on demand. Anything the browser can reach is public. So
scripted narration is rendered ahead of time on your machine and shipped as
plain static files, and the 207,000 parcel readouts — which cannot be
pre-recorded — fall back to the browser's own voice.

**If you never run the generator, the guide still works.** Every beat falls back
to speech synthesis. Recorded audio is an upgrade, not a dependency.

## Generating the voice-over

The script lives in `web/src/narration.json`. That file is the single source of
truth: the app reads it to know what to say, and the generator reads it to know
what to record. Edit the text there, not in `App.tsx`.

```bash
cd worker
node gen-voice.mjs --dry-run          # character count, spends nothing
```

Then get a key from <https://elevenlabs.io> (Profile → API Keys) and put it
somewhere the script can find it. `worker/.env` is gitignored:

```bash
echo "ELEVENLABS_API_KEY=sk_..." > worker/.env
```

Pick a voice and render:

```bash
cd worker
node gen-voice.mjs --list-voices
node gen-voice.mjs --voice <voice_id>
```

That writes `web/public/audio/<beat-id>.mp3` plus a `manifest.json`. The
manifest is what the app checks to decide whether a recorded take exists, so it
has to ship alongside the MP3s.

Re-runs hash each line and skip anything unchanged, so fixing one sentence costs
one sentence rather than the whole script. `--force` regenerates everything, and
changing the voice or model does that automatically.

### Then deploy as usual

```bash
cd web && npm run build
netlify deploy --prod --dir web/dist
```

## Cost

The whole script is about 1,200 characters. ElevenLabs' free tier is 10,000
characters a month, so a full render costs nothing and you can afford to redo it
several times while picking a voice. This only becomes a real line item if the
story grows by an order of magnitude.

## Choosing a voice

`--list-voices` prints every voice on the account with its labels. Worth
listening to a few on their site first: this is a civic-data piece, so a plain
news read carries it better than a dramatic one. The generator's settings
(`VOICE_SETTINGS` in `gen-voice.mjs`) already lean that way — stability up, style
at zero, speed just under 1 so the dollar figures land.

## Options

| Flag / variable | Default | What it does |
|---|---|---|
| `--voice <id>` | — | which voice to use, required |
| `--list-voices` | — | print the account's voices and exit |
| `--dry-run` | — | character count only, no key needed |
| `--force` | — | regenerate every beat |
| `ELEVENLABS_API_KEY` | — | key; `worker/.env` also works |
| `ELEVENLABS_VOICE_ID` | — | alternative to `--voice` |
| `ELEVENLABS_MODEL_ID` | `eleven_multilingual_v2` | quality tier; the flash models trade fidelity for latency we do not need |
| `ELEVENLABS_FORMAT` | `mp3_44100_128` | output format |
| `VOICE_DELAY_MS` | 700 | gap between calls |

## Known gaps

- **Parcel readouts stay robotic.** Fixing that needs runtime synthesis, which
  needs a server and a key, which is the thing this design deliberately avoids.
  A middle option would be recording the fixed sentence frames and speaking only
  the numbers, but stitched audio tends to sound worse than an honest fallback.
- **No captions.** The narration text is in `narration.json` and could be shown
  as a transcript for anyone who cannot use audio. Not built.
- **The Audio button does not indicate which mode you are getting.** Recorded
  and synthesized narration look identical in the UI.
