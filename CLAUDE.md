# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

PulseDeck is an Electron desktop app (Windows and macOS) combining a soundboard, microphone mixer, voice changer, and replay buffer. The mixed output goes to a virtual audio device: VB-CABLE on Windows, BlackHole 2ch on Mac. There is no bundler or framework. Files load directly from the repo root, and there are no runtime dependencies besides `electron-updater`.

## Commands

Requires Node.js 22+.

```bash
npm ci                 # install (downloads Electron)
npm start              # run from source; data goes to ./PulseDeck Data
npm test               # unit tests, then voice DSP checks, then the Playwright desktop integration test
npm run dist           # Windows NSIS installer + portable zip into dist/
npm run dist:mac:local # ad-hoc-signed Apple silicon DMG/ZIP (on a Mac)
npm run test:package   # smoke-test the packaged app in dist/ (build it first; PULSEDECK_EXE overrides the path)
```

Running subsets:

```bash
node --test tests/library.test.cjs                                  # one unit-test file
node --test --test-name-pattern="reorder" tests/library.test.cjs    # one unit test by name
node tests/voice-effects.cjs                                        # voice DSP only (launches Electron)
node tests/integration.cjs                                          # desktop integration only (launches Electron)
```

- `tests/*.test.cjs` use `node:test`. `voice-effects.cjs` and `integration.cjs` are standalone Playwright scripts, so each one runs as a whole.
- On Linux, run the Electron tests under `xvfb-run -a`.
- Tests write temporary libraries, screenshots, and JSON reports to `test-results/`, which is gitignored.
- `tests/mac-*-real.cjs` are opt-in checks against real Mac devices (BlackHole, system-audio permission). They are not part of `npm test`; see `docs/mac-setup.md`.
- CI (`.github/workflows/test.yml`) runs on Ubuntu and macOS. The release workflow also runs `npm test` on Windows.

## Module conventions

- `*.cjs` files run in Node: the main process, the preloads, `library.cjs`, and build scripts. `*.js` files are browser ES modules loaded by the renderer (`<script type="module" src="renderer.js">`) or AudioWorklet scripts. `package.json` has no `"type"` field, so Node cannot `require` the `.js` files. Unit tests load them in one of two ways:
  - `platform.test.cjs` imports `platform.js` through a `data:` URL.
  - The worklet tests run the worklet source in `vm` with stubbed `AudioWorkletProcessor`/`registerProcessor`.
- `node --check file.js` parses a renderer module as a classic script and misses module-only errors (such as a duplicate function declaration). Check ES modules with `node --input-type=module --check < file.js`.
- Both HTML pages set a strict CSP (`script-src 'self'`, `style-src 'self'`, no remote hosts). Inline scripts, inline styles, and CDN assets will not load.
- The packaging `files` globs in `package.json` include only root-level `*.js/*.cjs/*.html/*.css/*.json`. A new file in a subdirectory must be added there explicitly, or it will be missing from builds.
- `icon.png` and `icon.ico` are generated procedurally by `make-icon.cjs`, which every `dist` script runs. Change the generator, not the image files.

## Architecture

### Process and security model

- `main.cjs` creates two windows, both with `contextIsolation`, `sandbox`, and no `nodeIntegration`:
  - the main window (`index.html`, `renderer.js`)
  - the always-on-top overlay (`overlay.html`, `overlay.js`)
- Every IPC endpoint is registered through the `handle(name, fn, { mainOnly })` helper in `main.cjs`. The helper rejects requests from any frame other than the two local file URLs. `mainOnly` restricts an endpoint to the main window.
- To add an IPC call, register it with `handle()` and expose it in `preload.cjs` (`window.deck`) or `overlay-preload.cjs` (`window.overlay`).
- Permission and display-media handlers grant media access only to the main window's URL.

### The main window owns all audio

- `renderer.js` is the UI controller and holds the single `AudioEngine` (`audio.js`).
- The overlay runs no audio. It mirrors state that the renderer pushes through `overlay:state`.
- Commands from the overlay and from global shortcuts are forwarded to the main renderer as `shortcut` events (`{type: 'play'|'stop'|'mute'|'capture'}`), and the renderer acts on them.
- On macOS, closing the main window hides it instead of quitting, so audio keeps running.

### Audio graph (`audio.js`)

```
mic lease → live tap → voice effect → mic gain ──────────────┬──────────────┐
                                                             │ (sidechain)  ├→ mix → peak limiter → broadcast gain → sink (virtual cable)
clips → envelope → clip gain → board gain → ducker (input 0) ┴→ boardOut ───┘                 └→ monitor bus → monitor limiter → <audio> → headphones
previews (region editor, capture editor, Studio, recorder, TTS) → preview bus → preview limiter → second <audio> (setSinkId = monitorId only)
```

- Playback is instance-based (`engine.instances`): `play(clip, { mode, owner, from })` resolves a handle whose `done` promise reports `{ reason }` once. Trigger modes are toggle/restart/overlap; exclusive groups stop other clips in the group; caps are 32 total / 8 per clip. Every trigger path calls `play`, which applies the clip's region (`playback-region.js`). `stopAll()` stops pads, the queue instance, and previews, and emits `stopall`; it never releases the microphone, replay, or a recording.
- The preview bus is never connected to the board, mic, broadcast, or replay. `startAudition(deviceId)` refuses a missing/default device or the broadcast output (`code: 'NO_PREVIEW_DEVICE'`); the renderer's `previewDevice()` also refuses virtual devices.
- Microphone ownership: `acquireMic(deviceId)` returns a per-device lease; the stream stops when the last lease is released. The live chain and the recorder each connect their own tap node, so disconnecting one never cuts the other.
- `ducking-worklet.js` lowers only the board, keyed by the live mic after mute and gain. Attack/release are 95% times.

- The broadcast gain stays at 0 until `connect()` succeeds. The context starts with `sinkId: {type:'none'}`.
- `default` and `communications` are rejected as outputs, so a failure never falls back to the speakers.
- Monitoring must use a different device from the broadcast output.
- `limiter-worklet.js` is a 5 ms lookahead linked-stereo peak limiter. It must not change pitch or duration; `limiter.test.cjs` checks this at several sample rates.
- Clip auto-leveling (`levelGainDb`) is RMS-targeted and capped by the clip's peak.
- The replay buffer is separate from the broadcast mix. System audio enters `replay-worklet.js` (a ring buffer) on input 0, and the processed mic can optionally enter on input 1.
- System-audio capture uses different paths per platform:
  - Windows: legacy `chromeMediaSource: 'desktop'` constraints, with `getDisplayMedia` as the fallback.
  - Mac: `getDisplayMedia`. `main.cjs` supplies the app's own frame as the required video source, so only audio permission is needed.

### Persistence (`library.cjs`)

- `Library` owns `library.json` plus the `clips/` and `captures/` folders under the data root.
- `library.json` has `schemaVersion: 2` (unversioned files are version 1 and are migrated once, keeping `library-pre-migration-v1-*.json`). A newer schema throws `SchemaError` and the app refuses to start without writing.
- Mutations go through `library.mutate(fn)` (serialized with `library.exclusive`); on failure the in-memory state returns to the last valid version and only files the operation created are removed. Clips are rebuilt field by field (`normalizeClip`); never spread renderer data into records.
- Writes go through a promise queue and are atomic (temp file, then rename).
- `projects.cjs` stores Studio projects as `projects/<uuid>/project.json`, `draft.json` (1 s recovery draft), and `assets/<uuid>.wav` (canonical 48 kHz PCM16, validated by `wav-header.cjs`). Projects own copies of their audio. Assets are garbage-collected only on close/startup, when no saved or draft state references them.
- `backup.cjs` writes `PulseDeck Backup <stamp>-<id>/manifest.json` with SHA-256 checksums and restores by merging with new ids after validating paths, sizes, hashes, and limits.
- `tts.cjs`: Windows runs a fixed PowerShell script (`-EncodedCommand`, base64 JSON on stdin); macOS runs `/usr/bin/say` with text on stdin. `PULSEDECK_TEST=1` uses a fake provider unless `PULSEDECK_TTS=system`.
- Every renderer-supplied value is validated or clamped on load and on write, including clip fields, settings, and hotkeys. Keep that pattern when adding fields: add a default to `DEFAULTS` and a clamp in `updateSettings`.
- An unreadable `library.json` is copied to `library-recovery-*.json` rather than overwritten.
- Data root order, from `resolveDataRoot()` in `main.cjs`:
  1. `PULSEDECK_DATA`
  2. `./PulseDeck Data` when unpackaged
  3. a portable `PulseDeck Data` folder next to the exe (Windows)
  4. `appData/PulseDeck/PulseDeck Data`

### Shortcuts

- Hotkeys are stored in a portable Windows form (`Control+Alt+X`). `main.cjs` swaps `Control` for `Command` when registering on Mac. `platform.js#shortcutFromEvent` maps Cmd back to `Control` when recording.
- The first ten pads always own `Control+Alt+1…9,0` in display order (`assignSlots`). Reordering reassigns them.
- `Control+Alt+Space/M/O/R` are reserved.
- `hotkeys()` re-registers everything after each library change and returns the keys that failed to register.

### Platform differences

- Device-name rules live in `platform.js`: cable detection, feedback-route detection, and key labels.
- `index.html` copy is written for Windows. On Mac, `mac-ui.js` rewrites text nodes at runtime. It finds guide elements by position (`steps[0]`, `rows[2]`, `notes[0]`), so restructuring the setup guide in `index.html` requires matching updates in `mac-ui.js`.
- On macOS, the integration test asserts that the guide contains no "Ctrl", "Windows", or "VB-CABLE".

### Voice presets

- A preset needs two parts:
  - an entry in `voice-presets.json` (`id`, `group` matching one of `GROUPS`, `name`, `symbol`, `description`)
  - a matching function in the `builders` map in `voice-effects.js`. Unknown ids fall back to `clean`.
- `library.cjs` accepts `settings.effect` only if the id exists in the JSON.
- `tests/voice-effects.cjs` renders every preset offline and checks output level, finiteness, and pitch accuracy for the pitch presets.

## Testing approach

- Integration tests drive the real app with Playwright's `_electron`, with `PULSEDECK_TEST=1` and a temporary `PULSEDECK_DATA`.
- `PULSEDECK_TEST=1` hides windows, enables Chromium's fake media devices, and skips the Mac microphone prompt. `PULSEDECK_HEADLESS=1` only hides windows.
- Only the hardware boundary is stubbed inside the page: `AudioContext.prototype.setSinkId`, `getUserMedia`/`getDisplayMedia` (an oscillator-backed stream), `enumerateDevices`, and `HTMLMediaElement.setSinkId`/`play`. Mixing, DSP, worklets, persistence, IPC, and the overlay are all real.
- Test devices are named like real ones (`CABLE Input (test)`, `BlackHole 2ch`) so that `platform.js` detection works.
- Native dialogs are replaced from the main process with `app.evaluate(({ dialog }) => …)`.
- With `PULSEDECK_TEST=1` the renderer exposes `window.__test` (engine, studio, recorder, tts, queue, state) and records every toast in `window.__toasts`. `tests/features.cjs` measures real output by tapping `engine.board`, `engine.boardOut`, or `engine.previewBus` with a ScriptProcessor (which delivers audio about two buffers late, so wait before checking silence).
- `tests/tts-real.cjs` (`npm run test:tts-real`) exercises this machine's real voices. The real-voice case in `tts.test.cjs` is skipped when `CI` is set; CI runs `tts-real.cjs` on macOS as a non-blocking step.

## Releasing ("push to prod")

When the user says **"push to prod"**, they are authorizing you to commit, version, tag, and push to `origin/main`. Installed desktop copies then update themselves. Pushing commits alone doesn't update anyone: the app's updater reads GitHub Releases, and a release is created only by pushing a `v*` tag. Steps:

1. **Preflight.**
   - Run `git config core.filemode false`. This clone came from a zip with filemode on, so every tracked file shows a bogus 755→644 mode change. `npm version` refuses to run while tracked files show changes.
   - Run `npm ci` if `node_modules` is missing.
   - Run `npm test`. The release workflow runs it first and publishes nothing if it fails, so catch failures before using up a version tag.
2. **Commit the work.** Review `git status`, then `git add -A && git commit`. If anything unexpected is staged, stop and ask.
3. **Release notes.** Add a `# PulseDeck X.Y.Z` section at the top of `WHATS-NEW.md` for the upcoming version (a patch bump of `package.json`). Summarize user-visible changes since the last tag (`git log $(git describe --tags --abbrev=0)..HEAD --oneline`) in the existing style, then commit.
4. **`npm version patch`.** Use `minor` or `major` only when the user asks. This bumps `package.json` and `package-lock.json`, commits, and creates the `vX.Y.Z` tag. Never tag by hand, because the tag and `package.json` version must match, and the updater only installs a version higher than the running one.
5. **`git push --follow-tags`.** This pushes the commits and the tag, and the tag triggers `.github/workflows/release.yml`.
6. **Watch the release run.** It takes about 5 minutes. `gh` isn't installed, so use the public API:
   ```bash
   curl -s "https://api.github.com/repos/IsaacHHB/pulsedeck/actions/workflows/release.yml/runs?per_page=1" | grep -E '"(head_branch|status|conclusion)"'
   curl -s "https://api.github.com/repos/IsaacHHB/pulsedeck/releases/latest" | grep -E '"(tag_name|draft)"|"name": "(latest.yml|PulseDeck-Setup.exe)"'
   ```
   Success means the new tag's release is published, not a draft, with `latest.yml` and `PulseDeck-Setup.exe`. If the run fails, report the failure, fix it, and release the next patch version. Don't move, delete, or reuse a tag that has been pushed.
7. **Report back.** Give the version and the release URL. Installed copies check 8 seconds after launch and every 4 hours after that. They download in the background, then show **Restart to update**.

How updates reach users:
- Auto-update works for copies installed from `PulseDeck-Setup.exe`. Copies run with `npm start`, or hand-packed with `npm run package` (`build.mjs`, an older @electron/packager build written to `../release`), have no `app-update.yml` and show the manual-update message.
- The release's `PulseDeck-Portable.zip` does contain `resources/app-update.yml`, because it is zipped from the same `win-unpacked` folder as the installer. A zip copy will therefore try to update by running the Setup installer. That most likely installs a separate copy under `%LOCALAPPDATA%\Programs\PulseDeck`, which uses the `%APPDATA%` library instead of the portable `PulseDeck Data` folder (not tested end to end). `README.md` and `DISTRIBUTION.md` still say the zip doesn't auto-update.
- Mac packages publish only when the Developer ID and notarization secrets are set, and they aren't yet. Otherwise CI uploads an ad-hoc build as a workflow artifact, and Mac copies don't auto-update. Unsigned Mac builds show the manual-update message.
- See `DISTRIBUTION.md` for code signing and download links.
