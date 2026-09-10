// Shared device rules. Both device lists and connection checks use these names.
export const isMac = globalThis.window?.deck?.platform === 'darwin';
export const cableOutputName = isMac ? 'BlackHole 2ch' : 'CABLE Input';
export const cableInputName = isMac ? 'BlackHole 2ch' : 'CABLE Output';
export const driverName = isMac ? 'BlackHole 2ch' : 'VB-CABLE';
export const microphoneHelp = isMac
    ? 'Allow PulseDeck in System Settings → Privacy & Security → Microphone, then scan devices again.'
    : 'Check Windows Settings → Privacy → Microphone allows desktop apps, then try again.';
export const isCable = label => /cable input|\bblackhole\b/i.test(label || '');
export const isVirtual = label => /cable|voicemeeter|virtual|blackhole|soundflower|loopback|parrot/i.test(label || '');
export const cableReturn = label => /blackhole/i.test(label || '') ? label : 'CABLE Output';
export const isFeedbackRoute = (mic, output) => isCable(output) && (
    /cable output/i.test(mic) && /cable input/i.test(output) ||
    /blackhole/i.test(mic) && /blackhole/i.test(output)
);
export function prettyKey(key, mac = isMac) {
    return key.replaceAll('Control', mac ? 'Cmd' : 'Ctrl').replaceAll('Alt', mac ? 'Option' : 'Alt').replaceAll('+', ' + ');
}

// Option changes event.key on macOS. Physical letter/digit codes stay stable.
export function shortcutFromEvent(event, mac = isMac) {
    if (mac ? event.ctrlKey : event.metaKey) return '';
    // Keep Control as the portable storage key; the Mac main process registers Command.
    const mods = [(mac ? event.metaKey : event.ctrlKey) ? 'Control' : '', event.altKey ? 'Alt' : '', event.shiftKey ? 'Shift' : ''].filter(Boolean);
    const key = /^(Key[A-Z]|Digit[0-9])$/.test(event.code) ? event.code.replace(/^(Key|Digit)/, '') : event.key.toUpperCase();
    return mods.length === 2 && /^([A-Z0-9]|F([1-9]|1[0-9]|2[0-4]))$/.test(key) ? [...mods, key].join('+') : '';
}
