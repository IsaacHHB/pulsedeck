const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const rules = fs.readFile(path.join(__dirname, '../platform.js'), 'utf8')
    .then(source => import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`));

test('BlackHole and VB-CABLE route detection keeps physical microphones and headphones separate', async () => {
    const { isCable, isVirtual, isFeedbackRoute, cableReturn } = await rules;
    for (const name of ['BlackHole 2ch', 'BlackHole 16ch', 'CABLE Input (VB-Audio)']) {
        assert.ok(isCable(name)); assert.ok(isVirtual(name));
    }
    for (const name of ['MacBook Pro Microphone', 'External Headphones', 'AirPods Pro']) {
        assert.equal(isVirtual(name), false); assert.equal(isCable(name), false);
    }
    assert.ok(isFeedbackRoute('BlackHole 2ch', 'BlackHole 2ch'));
    assert.ok(isFeedbackRoute('CABLE Output', 'CABLE Input'));
    assert.equal(isFeedbackRoute('MacBook Pro Microphone', 'BlackHole 2ch'), false);
    assert.equal(cableReturn('BlackHole 2ch'), 'BlackHole 2ch');
    assert.equal(cableReturn('CABLE Input'), 'CABLE Output');
});

test('Mac Command and Windows Control shortcuts share portable storage and preserve Option-modified keys', async () => {
    const { shortcutFromEvent, prettyKey } = await rules;
    assert.equal(shortcutFromEvent({ ctrlKey: true, altKey: true, code: 'KeyG', key: '©' }), 'Control+Alt+G');
    assert.equal(shortcutFromEvent({ ctrlKey: true, altKey: true, code: 'Digit2', key: '™' }), 'Control+Alt+2');
    assert.equal(shortcutFromEvent({ ctrlKey: true, shiftKey: true, code: 'F12', key: 'F12' }), 'Control+Shift+F12');
    assert.equal(shortcutFromEvent({ ctrlKey: true, altKey: true, metaKey: true, code: 'KeyG', key: 'g' }), '');
    assert.equal(shortcutFromEvent({ altKey: true, code: 'KeyG', key: '©' }), '');
    assert.equal(shortcutFromEvent({ metaKey: true, altKey: true, code: 'KeyR', key: '®' }, true), 'Control+Alt+R');
    assert.equal(shortcutFromEvent({ metaKey: true, shiftKey: true, code: 'KeyG', key: 'G' }, true), 'Control+Shift+G');
    assert.equal(shortcutFromEvent({ ctrlKey: true, altKey: true, code: 'KeyR', key: '®' }, true), '');
    assert.equal(prettyKey('Control+Alt+R', true), 'Cmd + Option + R');
    assert.equal(prettyKey('Control+Alt+R', false), 'Ctrl + Alt + R');
});

test('Mac bundles declare microphone/system capture access and both supported architectures', async () => {
    const config = require('../package.json').build.mac;
    assert.ok(config.extendInfo.NSMicrophoneUsageDescription);
    assert.ok(config.extendInfo.NSAudioCaptureUsageDescription);
    assert.equal(config.minimumSystemVersion, '14.2');
    assert.deepEqual(config.target.find(t => t.target === 'zip').arch, ['arm64', 'x64']);
});
