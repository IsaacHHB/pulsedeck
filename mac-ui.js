import { isMac } from './platform.js';

export function configureMacUI() {
    if (!isMac) return;
    const $ = id => document.getElementById(id);
    // Preserve the controls and their listeners while changing static key labels.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node; (node = walker.nextNode());) {
        node.textContent = node.textContent.replaceAll('Ctrl', 'Cmd').replaceAll('Alt', 'Option');
        if (node.parentElement.tagName === 'KBD' && node.textContent === 'Alt') node.textContent = 'Option';
    }
    for (const element of document.querySelectorAll('[title], [placeholder]')) {
        for (const attribute of ['title', 'placeholder']) if (element.hasAttribute(attribute)) {
            element.setAttribute(attribute, element.getAttribute(attribute).replaceAll('Ctrl', 'Cmd').replaceAll('Alt', 'Option'));
        }
    }
    $('editHotkeyHelp').textContent = 'Cmd+Option, Cmd+Shift, or Option+Shift with a letter, number, or F-key. Works while another app has focus.';
    $('checkCableText').textContent = 'Install BlackHole 2ch, then select it below';
    $('outputHelp').textContent = 'Choose BlackHole 2ch here and as the microphone in Zoom or your other apps.';
    const flow = $('guideDialog').querySelectorAll('.signal-flow span');
    flow[2].textContent = 'BlackHole 2ch'; flow[3].textContent = 'Your app’s microphone'; flow[4].textContent = 'Your meeting';
    const steps = $('guideDialog').querySelectorAll('.setup-steps li');
    steps[0].querySelector('p').textContent = 'Install BlackHole 2ch from its official download. macOS may ask for your administrator password. Restart if the installer requests it, then reopen your audio apps.';
    $('driverLink').textContent = 'Open the official BlackHole download ↗';
    steps[1].querySelector('p').textContent = 'Click Scan devices and allow microphone access. Choose your real microphone, BlackHole 2ch as the broadcast output, and your headphones for monitoring. Click Connect audio.';
    steps[2].querySelector('strong').textContent = 'Choose BlackHole 2ch as the microphone in Zoom or your other app.';
    steps[2].querySelector('p').textContent = 'Keep the meeting’s speaker output on your headphones. Keep PulseDeck running. Closing its window leaves audio running; use PulseDeck → Quit PulseDeck to stop the app.';
    const rows = $('guideDialog').querySelectorAll('tbody tr');
    rows[2].lastElementChild.textContent = 'Audio or Voice settings → Input device / Microphone. Apps without a picker use the Mac’s default input.';
    rows[4].firstElementChild.textContent = 'Apps using the Mac’s default input';
    rows[4].lastElementChild.textContent = 'System Settings → Sound → Input → BlackHole 2ch. Leave Sound → Output set to your headphones.';
    const notes = $('guideDialog').querySelectorAll('.guide-note');
    notes[0].querySelector('strong').textContent = 'Let sound effects through in Zoom';
    notes[0].querySelectorAll('p')[0].textContent = 'In Zoom’s audio settings, select Original sound for musicians and turn it on during the meeting. Voice-focused noise filtering can remove music and sound effects.';
    notes[0].querySelectorAll('p')[2].textContent = 'Keep Zoom’s speaker output and PulseDeck’s monitoring on physical headphones. Sending the meeting’s speaker output to BlackHole would send other people’s voices back to them.';
    notes[1].querySelector('p').textContent = 'Turn on the replay buffer to keep the last 30 seconds to 3 minutes of your Mac’s audio in memory. Allow macOS audio or screen-recording access when prompted. Press Cmd+Option+R to save, then trim the recording and add it to your board. Capture stays separate from your outgoing microphone mix. Include my microphone adds your processed voice. Only saved clips stay on disk. Let other participants know when recording.';
    notes[2].querySelector('strong').textContent = 'Using the floating overlay';
    notes[2].querySelector('p').textContent = 'Press Cmd+Option+O for the small floating deck. Drag its title bar, resize it, and adjust its opacity. It is configured to follow your Mac desktops and full-screen apps. If another app reserves a shortcut, use the overlay’s buttons.';
    document.querySelector('.replay-note').textContent = 'Captures your Mac’s system audio after you grant access. The buffer stays in memory until you save a clip. Keep meeting playback on your headphones and your broadcast output on BlackHole.';
}
