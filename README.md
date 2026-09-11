# PulseDeck

A local Mac and Windows soundboard, microphone mixer, voice changer, and replay buffer — for Discord, game chat, streaming, and calls. No accounts, no uploads, no telemetry: everything stays on your computer.

![PulseDeck soundboard](docs/soundboard.png)

## What it does

- **Soundboard** — drop in MP3/WAV/OGG/M4A/FLAC/WebM files, drag pads to reorder them, and play them with a click or a global shortcut (`Ctrl+Alt+1…9, 0` follow the first ten pads). Auto-leveling raises quiet clips while respecting their peaks. A lookahead limiter protects the mix when sounds overlap.
- **Playback regions** — choose the part of a sound a pad plays (with optional fades) on a zoomable waveform. The original audio is kept, so you can widen the region again later. Replay captures can become pads that keep the full capture.
- **Sound Studio** — layer and sequence board sounds, replay captures, microphone takes, speech, and audio files on up to 8 tracks. Trim, split, duplicate, fade, pan, mute/solo, undo/redo, and preview in your headphones, then save the result as a new pad or export a WAV. Projects keep their own copy of every sound and have crash recovery.
- **Record a sound** — record your microphone (dry, or with the current voice effect) straight onto the board or into a Studio project. The broadcast does not need to be connected.
- **Text to speech** — type a phrase, preview it privately, speak it through your broadcast, save it as a pad, or insert it into Studio. Uses the voices installed on your computer.
- **Organize and play** — favorites, tags (searchable), collections, per-pad retrigger modes (toggle, restart, overlap), exclusive groups, a playback queue, and optional ducking that lowers sounds while you speak.
- **Export and back up** — export a pad's played region or its original file, and back up or restore your whole library as a portable folder.
- **Voice changer** — 25 presets (pitch shifts, monsters, robots, radios, rooms…) plus an extra-pitch slider and effect-strength blend. Preview yourself in your headphones before going live.
- **Replay buffer** — keeps the last 30 s–3 min of everything you hear (friends on Discord, game chat, the game itself). Press `Ctrl+Alt+R` to save it, trim it on a waveform, and add it to the soundboard.
- **Game overlay** — a small always-on-top deck (`Ctrl+Alt+O`) you can click while playing.
- **Mixer** — separate microphone and soundboard levels, mute, headphone monitoring, and a setup checklist.

On Windows, PulseDeck sends your mixed voice and sounds into a **virtual audio cable** ([VB-CABLE](https://vb-audio.com/Cable/), free), and any app that accepts a Windows microphone — Discord, OBS, Steam, games, Zoom, browsers — picks it up as `CABLE Output`.

## Install on Mac

Requires macOS 14.2 or later. Apple silicon is the primary tested Mac target.

1. Open the Mac `.dmg` and drag PulseDeck into Applications.
2. Install [BlackHole 2ch](https://existential.audio/blackhole/) once. Complete the administrator prompt and restart when instructed.
3. Open PulseDeck, click **Scan devices**, and allow microphone access. Choose your physical microphone and **BlackHole 2ch** as the broadcast output. Select physical headphones for monitoring.
4. Click **Connect audio**. In Zoom or another calling app, select **BlackHole 2ch** as its microphone and your headphones as its speaker output.
5. In Zoom, choose **Original sound for musicians** and enable it in the meeting so effects and music are not filtered out.

The replay buffer requests Mac system-audio capture access separately. Allow PulseDeck under **System Settings → Privacy & Security → Screen & System Audio Recording** if prompted. The buffer keeps audio in memory until you save a clip; it does not save screen video. Use the packaged app for capture testing, because running from a terminal can attribute permissions to the terminal instead.

Mac shortcuts use **Command + Option** instead of Control + Alt on Windows. Closing the main window leaves PulseDeck and its audio running; click its Dock icon to reopen, or use **PulseDeck → Quit PulseDeck** to stop it. The overlay is configured to appear across desktops and full-screen spaces.

Local Mac builds use ad-hoc signing and manual updates. Developer ID signed, notarized releases support automatic updates. See [Mac setup and verification](docs/mac-setup.md).

## Install on Windows

Download **PulseDeck-Setup.exe** from the [latest release](../../releases/latest) and run it. Installed copies check for updates automatically and offer a one-click restart when a new version is ready.

Prefer a portable copy? Grab **PulseDeck-Portable.zip**, unzip it anywhere, and run `PulseDeck.exe`. The portable build keeps its data in a `PulseDeck Data` folder next to the exe and does not auto-update.

> Windows SmartScreen may warn about an unsigned app on first launch — click **More info → Run anyway**. See [DISTRIBUTION.md](DISTRIBUTION.md) for code signing.

Then follow the in-app **Setup guide**: install VB-CABLE once, pick your mic and `CABLE Input` in the mixer, click **Connect audio**, and choose `CABLE Output` as the microphone in your other apps.

## Previews, speech, and backups

**Previews stay in your headphones.** The region editor, Sound Studio, recorder, and Text to speech preview only through the headphones chosen in the mixer, never through the broadcast output. If no headphones are chosen, PulseDeck asks you to pick them instead of using your speakers. System-audio capture (such as the replay buffer or another app's recorder) can still hear anything your computer plays through its default output, so keep previews on headphones that are not your default speakers if that matters.

**Text to speech** uses the voices installed on your computer: Windows voices from *Settings → Time & language → Speech*, and Mac voices from *System Settings → Accessibility → Spoken Content*. These are system voices, not cloud voices, and nothing is uploaded. A voice reads text in its own language, so choose a voice that matches the text. *Speak now* only plays while audio is connected; a saved speech pad keeps its audio even if the voice is later removed. Phrases are not saved unless you save them as a sound.

**Backups** are ordinary folders. Click *Back up or restore…* in the sidebar, choose a destination outside the library folder, and PulseDeck creates `PulseDeck Backup <date>` with your sounds, replay captures, collections, tags, playback regions, speech provenance, and saved Studio projects, plus a checksum manifest. Unsaved Studio edits, recovery drafts, and device selections are not included. *Restore from backup…* checks every file first and merges the backup into your current library with new ids; nothing is replaced, conflicting custom shortcuts are cleared and reported, and no devices, broadcast, or capture start. If the merged library would exceed a limit (120 sounds, 40 captures, 100 projects), nothing is restored.

**Limits:** Studio projects have up to 8 tracks, 64 regions, and a 3-minute timeline. Recordings are up to 3 minutes. Pads are up to 30 MB, which is about 2 minutes 43 seconds of stereo audio; for longer Studio renders, set an export range or use *Export WAV*.

## Develop

Requires Node.js 22+; Mac packaging requires a Mac with Xcode command-line tools.

```bash
npm ci          # install dependencies (downloads Electron)
npm start       # run from source
npm test        # library tests + voice DSP checks + desktop integration tests
npm run dist    # build the Windows installer and portable zip into dist/
npm run dist:mac:local # build a personal Apple silicon DMG and ZIP on a Mac
npm run dist:mac       # build Mac distribution packages using configured signing
npm run test:package   # launch and inspect the packaged app
```

The desktop tests drive the real app with Playwright; on Linux run them under `xvfb-run -a`. Audio devices are simulated in tests; the mixing, DSP, capture lifecycle, persistence, overlay, and UI are real. `tests/features.cjs` checks regions, Studio, recording, speech (with a test voice), organization, the queue, ducking, export, and backup by measuring the audio that actually reaches the mix. `npm run test:tts-real` checks this computer's real installed voices.

### Project layout

| File | Purpose |
| --- | --- |
| `main.cjs` | Electron main process: windows, global shortcuts, IPC, overlay, auto-updates |
| `preload.cjs`, `overlay-preload.cjs` | The narrow bridges the renderer windows are allowed to use |
| `library.cjs` | Sound library, captures, collections, groups, queue, and settings persistence (`library.json`, schema v2 with migration) |
| `projects.cjs`, `backup.cjs`, `tts.cjs`, `wav-header.cjs` | Studio project storage, backup/restore, local text to speech, WAV validation (main process) |
| `renderer.js`, `index.html`, `style.css` | The main window |
| `audio.js` | Web Audio engine: region-aware playback instances, mixing, limiter, ducking, private preview bus, shared microphone, replay ring buffer |
| `playback-region.js`, `waveform.js`, `region-editor.js` | Shared region math, waveform view, and the playback-region editor |
| `studio-model.js`, `studio-audio.js`, `studio-ui.js`, `dialogs.js` | Sound Studio data model, preview/render scheduling, and interface |
| `recorder.js`, `recorder-ui.js`, `recorder-worklet.js` | Microphone takes |
| `tts-ui.js`, `queue.js`, `queue-ui.js`, `ducking-worklet.js` | Text to speech panel, playback queue, and microphone-driven ducking |
| `voice-effects.js`, `voice-presets.json` | Voice changer DSP graph and presets |
| `replay-worklet.js`, `wav.js` | Ring-buffer audio worklet and WAV helpers |
| `overlay.html`, `overlay.js`, `overlay.css` | The always-on-top game overlay |
| `tests/` | Automated checks |
| `.github/workflows/` | CI tests and tagged releases |

`tests/feature-races.cjs` adds Electron checks for edits during disk saves, switching projects during audio decoding, and cancellation during preview, recording-monitor, and speech startup. It runs with `npm test` and in the three-platform CI matrix. Persistence tests inject failed library commits to verify that project files, recovery drafts, and microphone takes remain recoverable.

## Releasing

See [DISTRIBUTION.md](DISTRIBUTION.md). In short: bump the version, push a `vX.Y.Z` tag, and GitHub Actions builds the installer, publishes the release, and every installed copy updates itself.

## License

[MIT](LICENSE) © Isaac Hollow Horn Bear
