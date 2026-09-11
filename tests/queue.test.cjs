const { test } = require('node:test');
const assert = require('node:assert/strict');
const queueModule = import('../queue.js');

/**
 * Queue control logic against a minimal engine double with the same instance contract as AudioEngine
 * (handles whose `done` resolves once with a reason). Audio routing itself is verified in tests/features.cjs.
 */
function engineDouble({ decodeMs = 0 } = {}) {
    const engine = { instances: new Map(), next: 1, started: [], clipInstances: () => [] };
    engine.play = async (clip, options) => {
        const inst = { id: engine.next++, clipId: clip.id, owner: options.owner, from: options.from, mode: options.mode };
        inst.done = new Promise(resolve => { inst.resolve = resolve; });
        engine.instances.set(inst.id, inst);
        if (decodeMs) await new Promise(r => setTimeout(r, decodeMs));
        if (!engine.instances.has(inst.id)) return { id: inst.id, clipId: clip.id, done: inst.done };
        engine.started.push({ clipId: clip.id, from: options.from, mode: options.mode, loop: clip.loop });
        return { id: inst.id, clipId: clip.id, done: inst.done };
    };
    engine.stopInstance = (inst, reason) => { if (!engine.instances.delete(inst.id)) return null; inst.resolve({ reason, position: 1.25 }); return 1.25; };
    engine.stopHandle = (handle, reason) => { const inst = engine.instances.get(handle.id); return inst ? engine.stopInstance(inst, reason) : null; };
    engine.finish = (reason = 'ended') => { const inst = [...engine.instances.values()][0]; engine.instances.delete(inst.id); inst.resolve({ reason, position: 0.5 }); };
    return engine;
}
const tick = () => new Promise(r => setTimeout(r, 5));

test('entries play once each, advance on completion, and allow duplicates; the latest clip settings are used', async () => {
    const { PlaybackQueue } = await queueModule;
    const clips = { a: { id: 'a', name: 'A', loop: true, triggerMode: 'toggle' }, b: { id: 'b', name: 'B', triggerMode: 'overlap' } };
    const engine = engineDouble(), saved = [];
    const queue = new PlaybackQueue({ engine, getClip: id => clips[id], save: list => saved.push(list) });
    queue.add('a'); queue.add('b'); queue.add('a');
    await queue.play(); await tick();
    assert.deepEqual(engine.started.at(-1), { clipId: 'a', from: 0, mode: 'restart', loop: true });
    clips.b = { ...clips.b, name: 'B edited' };
    engine.finish(); await tick();
    assert.equal(engine.started.at(-1).clipId, 'b'); assert.equal(engine.started.at(-1).mode, 'overlap');
    engine.finish(); await tick(); engine.finish(); await tick();
    assert.deepEqual(engine.started.map(s => s.clipId), ['a', 'b', 'a']);
    assert.equal(queue.state, 'stopped'); assert.equal(queue.entries.length, 0);
    assert.deepEqual(saved.at(-1), []);
});

test('pause resumes from the region-relative position; next cancels the current entry and dispatches once', async () => {
    const { PlaybackQueue } = await queueModule;
    const clips = { a: { id: 'a', name: 'A' }, b: { id: 'b', name: 'B' } };
    const engine = engineDouble();
    const queue = new PlaybackQueue({ engine, getClip: id => clips[id] });
    queue.add('a'); queue.add('b');
    await queue.play(); await tick();
    queue.pause();
    assert.equal(queue.state, 'paused'); assert.equal(queue.offset, 1.25); assert.equal(engine.instances.size, 0);
    await queue.play(); await tick();
    assert.equal(engine.started.at(-1).from, 1.25, 'resumes where it paused');
    queue.next(); await tick();
    assert.deepEqual(engine.started.map(s => [s.clipId, s.from]), [['a', 0], ['a', 1.25], ['b', 0]]);
    assert.equal(engine.instances.size, 1, 'exactly one instance after Next');
});

test('Next during decode never starts the skipped entry; Stop all keeps pending entries and ignores late callbacks', async () => {
    const { PlaybackQueue } = await queueModule;
    const clips = { a: { id: 'a', name: 'A' }, b: { id: 'b', name: 'B' } };
    const engine = engineDouble({ decodeMs: 30 });
    const queue = new PlaybackQueue({ engine, getClip: id => clips[id] });
    queue.add('a'); queue.add('b'); queue.add('a');
    queue.play(); await tick();
    queue.next();
    await new Promise(r => setTimeout(r, 80));
    assert.deepEqual(engine.started.map(s => s.clipId), ['b'], 'the entry skipped while decoding never started');
    const [inst] = engine.instances.values();
    engine.instances.delete(inst.id); inst.resolve({ reason: 'stopAll', position: 0.2 });
    await tick();
    assert.equal(queue.state, 'stopped'); assert.deepEqual(queue.entries.map(e => e.clipId), ['b', 'a'], 'Stop all keeps pending entries');
    queue.stop();
    assert.equal(engine.instances.size, 0);
});

test('an outside stop pauses with a message; deleted clips report an error and can be skipped; clear removes all', async () => {
    const { PlaybackQueue } = await queueModule;
    const clips = { a: { id: 'a', name: 'A' } };
    const engine = engineDouble();
    const queue = new PlaybackQueue({ engine, getClip: id => clips[id] });
    queue.add('a'); queue.add('gone'); queue.add('a');
    await queue.play(); await tick();
    engine.finish('toggle'); await tick();
    assert.equal(queue.state, 'paused'); assert.match(queue.message, /stopped outside the queue/); assert.equal(queue.offset, 0.5);
    await queue.play(); await tick();
    engine.finish('ended'); await tick();
    assert.equal(queue.state, 'paused'); assert.match(queue.message, /deleted/);
    queue.next(); await tick();
    assert.equal(engine.started.at(-1).clipId, 'a');
    assert.throws(() => { for (let i = 0; i < 101; i++) queue.add('a'); }, /100/);
    queue.clear();
    assert.deepEqual([queue.entries.length, queue.state, engine.instances.size], [0, 'stopped', 0]);
    queue.load([{ id: 'x', clipId: 'a' }]);
    assert.equal(queue.state, 'stopped', 'a restored queue never plays by itself');
});
