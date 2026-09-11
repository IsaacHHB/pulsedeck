/** Slow IO and cancellation regressions. Real Electron UI, IPC, project storage and audio engine. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Library } = require('../library.cjs');
const { ProjectStore } = require('../projects.cjs');
const { launch, toneWav, press, selectSource } = require('./features.cjs');

async function main() {
  const root = await fs.mkdtemp(path.join(__dirname, '..', 'test-results', 'races-'));
  const library = new Library(root); await library.init();
  const store = new ProjectStore(library); await store.init();
  const pad = await library.importBuffer('Slow source', toneWav(440, 0.5));
  const projects = [];
  for (const name of ['First project', 'Second project']) {
    const p = await store.create(name), a = await store.addAsset(p.id, toneWav(440, 0.5));
    projects.push(await store.save(p.id, { ...p, assets: [a], regions: [{ id: randomUUID(), trackId: p.tracks[0].id, assetId: a.id, atSeconds: 0, inSeconds: 0, outSeconds: 0.5, gainDb: 0, pan: 0, fadeInMs: 0, fadeOutMs: 0, label: 'Tone' }] }));
  }
  const { app, page, errors } = await launch(root);
  const passed = [];
  const pass = name => { passed.push(name); console.log('PASS:', name); };
  const wait = fn => page.waitForFunction(fn, undefined, { polling: 25 });
  try {
    await press(page, '#studioNav');
    await page.evaluate(id => window.__test.studio.openProject(id), projects[0].id);
    // Delay the real file replacement while the user makes another edit.
    await app.evaluate(async (_electron, file) => {
      const fs = process.getBuiltinModule('fs/promises');
      const rename = fs.rename;
      let release; const pending = new Promise(resolve => { release = resolve; });
      globalThis.reviewIO = { started: false, release, restore: () => { fs.rename = rename; release(); } };
      fs.rename = async (from, to) => {
        if (to === file && !globalThis.reviewIO.started) { globalThis.reviewIO.started = true; await pending; }
        return rename(from, to);
      };
    }, path.join(root, 'projects', projects[0].id, 'project.json'));
    await page.evaluate(() => { window.reviewSave = window.__test.studio.saveCurrent(); });
    for (let i = 0; !await app.evaluate(() => globalThis.reviewIO.started); i++) {
      if (i > 100) throw new Error('Save never reached file replacement');
      await new Promise(r => setTimeout(r, 25));
    }
    await page.locator('.track-gain').first().fill('-6');
    await page.locator('.track-gain').first().dispatchEvent('change');
    await app.evaluate(() => globalThis.reviewIO.restore());
    await page.evaluate(() => window.reviewSave);
    assert.deepEqual(await page.evaluate(() => [window.__test.studio.current.project.tracks[0].gainDb, window.__test.studio.hasUnsaved]), [-6, true]);
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'projects', projects[0].id, 'project.json'))).tracks[0].gainDb, 0);
    await page.evaluate(() => window.__test.studio.saveCurrent());
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'projects', projects[0].id, 'project.json'))).tracks[0].gainDb, -6);
    pass('Edits made during Save survive; disk contains the submitted revision until the next explicit save');

    // Switching project while a source decodes must not attach it to the new project.
    await selectSource(page, 'Slow source');
    await page.evaluate(() => {
      const engine = window.__test.engine, load = engine.load.bind(engine);
      window.reviewLoadStarted = false;
      engine.load = async clip => {
        window.reviewLoadStarted = true;
        await new Promise(resolve => { window.reviewReleaseLoad = resolve; });
        engine.load = load; return load(clip);
      };
    });
    await press(page, '#srcAppend'); await wait(() => window.reviewLoadStarted);
    await page.evaluate(id => window.__test.studio.openProject(id), projects[1].id);
    await page.evaluate(() => window.reviewReleaseLoad());
    await wait(() => window.__test.engine.buffers.size > 0);
    assert.equal(await page.evaluate(() => window.__test.studio.current.project.regions.length), 1);
    pass('A source that finishes decoding after a project switch is not inserted into the new project');

    // A preview awaiting decode must stay stopped after Stop all.
    await page.evaluate(() => {
      const engine = window.__test.engine, load = engine.load.bind(engine);
      engine.load = async clip => { await new Promise(resolve => { window.reviewReleaseLoad = resolve; }); engine.load = load; return load(clip); };
      window.reviewReleaseLoad = null;
    });
    await selectSource(page, 'Slow source'); await press(page, '#srcPreview');
    await wait(() => Boolean(window.reviewReleaseLoad));
    await page.evaluate(() => { window.__test.engine.stopAll(); window.reviewReleaseLoad(); });
    await new Promise(r => setTimeout(r, 150));
    assert.equal(await page.evaluate(() => Boolean(window.__test.engine.auditionSession)), false);
    pass('Stop all invalidates Studio previews that are still decoding');

    // Also exercise cancellation while the shared preview engine itself initializes.
    assert.equal(await page.evaluate(async () => {
      const engine = window.__test.engine, init = engine.init.bind(engine);
      let release; engine.init = () => new Promise(resolve => { release = resolve; });
      const pending = engine.startAudition('test-phones').then(() => 'played', e => e.code);
      engine.stopAll(); engine.init = init; release();
      return pending;
    }), 'CANCELLED');
    pass('Stop all cancels preview initialization before any output session is created');

    await page.evaluate(() => {
      const { engine, recorder } = window.__test, start = engine.startAudition.bind(engine);
      engine.startAudition = async device => {
        await new Promise(resolve => { window.reviewReleaseMonitor = resolve; });
        engine.startAudition = start;
        return start(device);
      };
      window.reviewRecording = recorder.start({ deviceId: 'test-mic', monitorDevice: 'test-phones' });
    });
    await wait(() => Boolean(window.reviewReleaseMonitor));
    await page.evaluate(() => { window.__test.recorder.cancel(); window.reviewReleaseMonitor(); });
    await page.evaluate(() => window.reviewRecording);
    assert.deepEqual(await page.evaluate(() => ({ state: window.__test.recorder.state, session: Boolean(window.__test.recorder.session), preview: Boolean(window.__test.engine.auditionSession), liveTracks: window.testTracks.filter(t => t.readyState === 'live').length })), { state: 'idle', session: false, preview: false, liveTracks: 0 });
    pass('Cancelling while recording monitoring opens releases the take, late preview and microphone lease');

    await press(page, '#ttsNav');
    await page.fill('#ttsText', 'Old phrase');
    await page.selectOption('#ttsVoice', 'test-voice-hang');
    await press(page, '#ttsSave');
    await wait(() => window.__test.tts.status === 'generating');
    await page.fill('#ttsText', 'New phrase');
    await wait(() => window.__test.tts.status === 'cancelled');
    assert.equal(await page.evaluate(() => window.__test.tts.result), null);
    assert.equal((await page.evaluate(() => window.deck.getLibrary())).clips.length, 1);
    pass('Editing text cancels an old speech generation without saving or playing the old phrase');

    await press(page, '#studioNav');
    await page.setViewportSize({ width: 1024, height: 740 });
    await page.screenshot({ path: path.join(__dirname, '..', 'test-results', 'review-studio.png') });
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(__dirname, '..', 'test-results', 'feature-races-report.json'), JSON.stringify({ passed: passed.length, checks: passed }, null, 2));
  } finally {
    await app.evaluate(() => globalThis.reviewIO?.restore()).catch(() => {});
    await app.close();
  }
}
main().catch(error => {
  console.error(error);
  // CI logs need a token to read; workflow annotations are public, so surface the failure there too.
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=feature-races.cjs failed::${String(error.stack || error).slice(0, 3500).replace(/%/g, '%25').replace(/\r?\n/g, '%0A')}`);
  process.exitCode = 1;
});
