# PulseDeck on Mac

## First use

Install PulseDeck in Applications and install [BlackHole 2ch](https://existential.audio/blackhole/). The BlackHole installer requires your Mac administrator password and may require a restart. Keep your meeting's speaker output on headphones.

| Setting | Select |
| --- | --- |
| PulseDeck microphone | Your real microphone |
| PulseDeck broadcast output | BlackHole 2ch |
| PulseDeck monitoring output | Your headphones |
| Zoom microphone | BlackHole 2ch |
| Zoom speaker | Your headphones |

Click Scan devices, allow microphone access, then Connect audio. In Zoom, select Original sound for musicians and enable it during the meeting. If an app has no input picker, set the Mac's default sound input to BlackHole 2ch. Keep the Mac's output on headphones.

The first ten sound pads use Command + Option + 1 through 9, then 0. Command + Option + Space stops sounds, M mutes the microphone, R saves replay audio, and O toggles the floating deck. Custom shortcuts retain the same underlying keys as Windows libraries. If another app reserves a shortcut, the on-screen controls still work.

Closing the main window keeps audio running. Click the Dock icon to reopen. Quit PulseDeck from its app menu to stop it completely.

## Replay

Enable the replay buffer and allow system-audio capture when macOS asks. If access was denied, allow PulseDeck under System Audio Recording in System Settings → Privacy & Security → Screen & System Audio Recording, then quit and reopen PulseDeck. Version 0.6.4 needs audio access only; full screen-recording access is unnecessary. Use the packaged PulseDeck app, because development launches may use their parent terminal's permission identity.

Play some audio on the Mac. The replay meter should show Sound. Save a clip, trim it, preview through headphones, and add it to the board. Include my microphone adds the processed mic while the microphone is connected or being previewed. Keep the meeting's output off BlackHole to avoid feeding participants' voices back to them.

## Verification with real devices

The automated tests simulate device endpoints. Before relying on PulseDeck in a meeting, finish these checks:

1. Verify BlackHole 2ch appears in PulseDeck and Zoom after installation.
2. In Zoom's microphone test, record a spoken phrase and a soundboard clip. Confirm both play back. Repeat with a voice preset.
3. Confirm mute silences your voice while soundboard clips still play, and Stop all stops clips.
4. Confirm a saved system-audio replay contains the audio you heard. Test including the microphone separately.
5. Confirm the floating deck is reachable in the desktops and full-screen apps you use.
6. Disconnect your headset and reconnect it. Confirm PulseDeck stops the affected route and allows you to select the device again.

## Updates

Personal builds use manual updates. A public Mac release requires Developer ID signing and Apple notarization before automatic updates can be verified. This does not prevent local soundboard, voice, mixer, or replay use.

## Sources

- [BlackHole](https://existential.audio/blackhole/)
- [Electron system-audio capture](https://www.electronjs.org/docs/latest/api/desktop-capturer)
- [Zoom professional audio settings](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0059985)

For a real 60-second replay check, run `node tests/mac-replay-real.cjs` on a quiet Mac. This opt-in test plays two quiet tones separated by silence, saves a full minute, verifies that older audio was discarded, trims to a five-second soundboard clip, and checks saving from the main button, shortcut action, and overlay. It uses a separate test library.

To verify PulseDeck's own macOS permissions, quit PulseDeck and run `node tests/mac-audio-permission-real.cjs`. This launches the installed app through macOS Launch Services instead of inheriting the terminal's recording permissions. It uses a separate library, checks a full minute and an audible five-second trim, and closes the test app afterward. Set `PULSEDECK_EXPECT_SCREEN_DENIED=1` to require that the check succeeds without full screen-recording permission.


## Distorted or unusually deep sound

Version 0.6.2 fixes a confirmed overload problem in automatic leveling. The previous compressor could let peaks above full scale through at the standard 100% board level. Peak-aware leveling and a lookahead limiter now protect the outgoing mix. The limiter introduces a fixed 5 ms delay; it does not change playback rate or pitch.

For Zoom, keep Original sound for musicians enabled during the meeting. Voice isolation and noise suppression can still alter soundboard audio after it leaves PulseDeck. In games, disable voice noise suppression and automatic gain control when those options are available. PulseDeck cannot change another app's audio filters.

For a real outgoing-audio test, run `node tests/mac-broadcast-real.cjs` with BlackHole installed. It uses a separate test library, plays generated 44.1 and 48 kHz MP3s into BlackHole, and measures the received pitch, duration, and peak level. Run it when no meeting is listening to BlackHole.
