# PulseDeck 0.6.1

- Mac shortcuts now use Command + Option, including the soundboard, mute, stop, save replay, and overlay. Existing library shortcuts keep their portable storage format.
- Replay continues advancing through silent or missing input frames, so old sounds age out of the last 60 seconds.
- Replay capture now keeps the app awake even when the microphone mixer is disconnected.

# PulseDeck 0.6.0

- Mac support with BlackHole audio routing, Mac setup instructions, microphone permissions, and native system-audio capture for replay.
- Command + Option shortcut labels and physical-key handling for Option-modified characters.
- Floating overlay across Mac desktops and full-screen spaces. Closing the main window keeps audio running; the Dock reopens it.
- Mac DMG/ZIP packaging, personal builds, and a signed/notarized release path for automatic updates.
- Feedback checks recognize BlackHole and keep it out of headphone monitoring.
- Replay's global shortcut is reserved so a custom sound cannot take it over.

# PulseDeck v0.5 — what's new

## Replay buffer: grab what anyone said

Open the new **Replay buffer** tab and flip it on. PulseDeck then listens to everything that plays through your headphones — your friends on Discord, game chat, the game itself — and keeps the most recent stretch (30 seconds to 3 minutes, your choice) in memory.

When something happens that you want, press **Ctrl+Alt+R** from anywhere (mid-game included), click **Save the last 60 s**, or hit the **● Clip** button on the game overlay. That stretch is saved as a capture. Pick it from the list, trim it on the waveform (drag the Start/End sliders or click the waveform; **Snap to sound** trims silence automatically), hit **Play selection** to check it, give it a name, and **Add to soundboard** — it becomes a pad with its own shortcut, auto-leveled like everything else.

Options: **Include my microphone** mixes your own voice into the capture (so back-and-forth exchanges have both sides), and **Start when PulseDeck opens** keeps the buffer always running.

Two things to know: it hears your default Windows playback device, so keep Discord and the game playing through your headphones (not the cable). And it does record other people — a heads-up to your friends is the right move.

Captures live in `PulseDeck Data\captures` (the newest 40 are kept). Nothing is written to disk until you save one.

---

# Earlier: v0.4

Your sounds, order, and settings are kept. If PulseDeck was open during the update, close it and reopen it once.

## Why some sounds weren't coming through (and the fix)

Your clips were decoded fine — the problem was loudness. Measured levels ranged from −3 dB (rip-my-granny) down to −23 dB (hub-intro, wow, gunshot, Charlie, HAHA, the saxophones). The quiet ones were roughly a tenth as loud as the loud ones, so a game's voice-activation gate simply dropped them, and everything felt quiet overall.

- **Auto-level sounds** (on by default, in the Mixer) measures every clip the first time it plays and brings it to a consistent, speech-like loudness — up to +20 dB for very quiet clips. Open a sound's settings to see its measured level and how much was added.
- The **Soundboard** slider now goes to **200% (Boost)**.
- The output limiter now runs just under full scale instead of squashing everything above −6 dB, so the mix is noticeably hotter without clipping the cable.

Also check the game/Discord side — voice chat is designed to pass speech and reject everything else. In the receiving app, turn **noise suppression** off, set **voice activity / input sensitivity** to manual and low (or use push-to-talk and hold it while a clip plays), and turn off **automatic gain control**. The Setup guide in the app now covers this. And note the naming: the microphone you pick in a game or Discord is **CABLE Output** — CABLE Input is the playback side that PulseDeck sends to.

## Game overlay

Press **Ctrl+Alt+O** (or click **Overlay** in the top bar) for a small always-on-top deck you can click while playing. Drag it by its title bar, resize it from any edge, set its transparency at the bottom, and it remembers where you left it. It has Stop and Mic-mute buttons and mirrors what's playing. It stays above windowed and borderless-windowed games; exclusive-fullscreen games cover every overlay, so set the game's display mode to Borderless if you don't see it.

## Drag to reorder — shortcuts follow position

Drag pads to rearrange them. The first ten pads always own **Ctrl+Alt+1 … 9, 0** in display order, so moving a sound into slot 3 makes it Ctrl+Alt+3. Pads past the tenth can have a custom Ctrl+Shift / Alt+Shift shortcut.

## Compact UI

Pads are now dense single-row tiles (color stripe, name, length, shortcut, progress bar while playing), all 25 voice presets fit on one screen, and the whole layout is tighter.
