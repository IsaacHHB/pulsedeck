# PulseDeck

A local Windows soundboard, microphone mixer, voice changer, and replay buffer — for Discord, game chat, streaming, and calls. No accounts, no uploads, no telemetry: everything stays on your PC.

![PulseDeck soundboard](docs/soundboard.png)

## What it does

- **Soundboard** — drop in MP3/WAV/OGG/M4A/FLAC/WebM files, drag pads to reorder them, and play them with a click or a global shortcut (`Ctrl+Alt+1…9, 0` follow the first ten pads). Auto-leveling evens out quiet and loud clips so they all come through in voice chat.
- **Voice changer** — 25 presets (pitch shifts, monsters, robots, radios, rooms…) plus an extra-pitch slider and effect-strength blend. Preview yourself in your headphones before going live.
- **Replay buffer** — keeps the last 30 s–3 min of everything you hear (friends on Discord, game chat, the game itself). Press `Ctrl+Alt+R` to save it, trim it on a waveform, and add it to the soundboard.
- **Game overlay** — a small always-on-top deck (`Ctrl+Alt+O`) you can click while playing.
- **Mixer** — separate microphone and soundboard levels, mute, headphone monitoring, and a setup checklist.

PulseDeck sends your mixed voice and sounds into a **virtual audio cable** ([VB-CABLE](https://vb-audio.com/Cable/), free), and any app that accepts a Windows microphone — Discord, OBS, Steam, games, Zoom, browsers — picks it up as `CABLE Output`.

## Install

Download **PulseDeck-Setup.exe** from the [latest release](../../releases/latest) and run it. Installed copies check for updates automatically and offer a one-click restart when a new version is ready.

Prefer a portable copy? Grab **PulseDeck-Portable.zip**, unzip it anywhere, and run `PulseDeck.exe`. The portable build keeps its data in a `PulseDeck Data` folder next to the exe and does not auto-update.

> Windows SmartScreen may warn about an unsigned app on first launch — click **More info → Run anyway**. See [DISTRIBUTION.md](DISTRIBUTION.md) for code signing.

Then follow the in-app **Setup guide**: install VB-CABLE once, pick your mic and `CABLE Input` in the mixer, click **Connect audio**, and choose `CABLE Output` as the microphone in your other apps.

## Develop

Requires Node.js 22+.

```bash
npm ci          # install dependencies (downloads Electron)
npm start       # run from source
npm test        # library tests + voice DSP checks + desktop integration tests
npm run dist    # build the Windows installer and portable zip into dist/
```

The desktop tests drive the real app with Playwright; on Linux run them under `xvfb-run -a`. Audio devices are simulated in tests; the mixing, DSP, capture lifecycle, persistence, overlay, and UI are real.

### Project layout

| File | Purpose |
| --- | --- |
| `main.cjs` | Electron main process: windows, global shortcuts, IPC, overlay, auto-updates |
| `preload.cjs`, `overlay-preload.cjs` | The narrow bridges the renderer windows are allowed to use |
| `library.cjs` | Sound library, captures, and settings persistence (`library.json`) |
| `renderer.js`, `index.html`, `style.css` | The main window |
| `audio.js` | Web Audio engine: mixing, limiter, monitoring, replay ring buffer |
| `voice-effects.js`, `voice-presets.json` | Voice changer DSP graph and presets |
| `replay-worklet.js`, `wav.js` | Ring-buffer audio worklet and WAV helpers |
| `overlay.html`, `overlay.js`, `overlay.css` | The always-on-top game overlay |
| `tests/` | Automated checks |
| `.github/workflows/` | CI tests and tagged releases |

## Releasing

See [DISTRIBUTION.md](DISTRIBUTION.md). In short: bump the version, push a `vX.Y.Z` tag, and GitHub Actions builds the installer, publishes the release, and every installed copy updates itself.

## License

[MIT](LICENSE) © Isaac Hollow Horn Bear
