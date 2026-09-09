const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
async function until(page, fn, timeout = 12000) {
  const started = Date.now();
  while (true) {
    if (await page.evaluate(fn)) return;
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for: ' + fn.toString().slice(0, 120));
    await page.waitForTimeout(100);
  }
}
async function main() {
  const root = path.resolve(__dirname, '..'), results = path.join(root, 'test-results');
  const data = await fs.mkdtemp(path.join(results, 'voice-'));
  const env = { ...process.env, PULSEDECK_TEST: '1', PULSEDECK_DATA: data }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['--no-sandbox', root], env });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(count => document.querySelectorAll('[data-effect]').length === count, require('../voice-presets.json').length);
    await page.click('#voiceNav');
    const report = await page.evaluate(async () => {
      const { buildVoiceEffect, PRESETS } = await import('./voice-effects.js');
      async function render(id, silent = false) {
        const ctx = new OfflineAudioContext(1, 48000, 48000), buffer = ctx.createBuffer(1, 48000, 48000), samples = buffer.getChannelData(0);
        if (!silent) for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(2 * Math.PI * 440 * i / 48000) * 0.15;
        const source = ctx.createBufferSource(); source.buffer = buffer; buildVoiceEffect(ctx, source, ctx.destination, id); source.start();
        return (await ctx.startRendering()).getChannelData(0);
      }
      function rms(samples) { return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length); }
      function peakHz(samples, low, high) {
        let best = { hz:0, power:0 }; const start=12000, count=24000;
        for (let hz=low; hz<=high; hz++) {
          const coefficient=2*Math.cos(2*Math.PI*hz/48000); let s1=0,s2=0;
          for(let i=start;i<start+count;i++){const s0=samples[i]+coefficient*s1-s2;s2=s1;s1=s0;}
          const power=s1*s1+s2*s2-coefficient*s1*s2;if(power>best.power)best={hz,power};
        } return best.hz;
      }
      const checks=[]; let clean;
      for(const preset of PRESETS){
        const samples=await render(preset.id), silent=await render(preset.id,true);
        if(preset.id==='clean')clean=samples;
        const difference=rms(samples.map((n,i)=>n-clean[i]));
        checks.push({id:preset.id,rms:rms(samples),peak:Math.max(...samples.map(Math.abs)),finite:samples.every(Number.isFinite),silentRms:rms(silent),difference});
      }
      const pitch=[];
      for(const [id,semitones] of [['deep',-5],['chipmunk',7],['monster',-9],['helium',12],['giant',-12],['villain',-4]]){
        const expected=440*2**(semitones/12), samples=await render(id);pitch.push({id,expected,measured:peakHz(samples,Math.floor(expected-45),Math.ceil(expected+45))});
      }
      async function renderCustom(id, options, silent = false) {
        const ctx = new OfflineAudioContext(1, 48000, 48000), buffer = ctx.createBuffer(1, 48000, 48000), samples = buffer.getChannelData(0);
        if (!silent) for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(2 * Math.PI * 440 * i / 48000) * 0.15;
        const source = ctx.createBufferSource(); source.buffer = buffer; buildVoiceEffect(ctx, source, ctx.destination, id, options); source.start();
        return (await ctx.startRendering()).getChannelData(0);
      }
      const custom = await renderCustom('clean', { pitch: 3 });
      pitch.push({ id: 'clean+3', expected: 440 * 2 ** (3 / 12), measured: peakHz(custom, Math.floor(440 * 2 ** (3 / 12) - 45), Math.ceil(440 * 2 ** (3 / 12) + 45)) });
      const dry = await renderCustom('radio', { mix: 0 }), half = await renderCustom('radio', { mix: 0.5 });
      const mixCheck = { dryDifference: rms(dry.map((n, i) => n - clean[i])), halfDifference: rms(half.map((n, i) => n - clean[i])), fullDifference: checks.find(c => c.id === 'radio').difference };
      return {checks,pitch,mixCheck};
    });
    for(const check of report.checks){assert.ok(check.finite && check.peak<2 && check.rms>0.001, JSON.stringify(check));assert.ok(check.silentRms<1e-8,`Noise from ${check.id}`);if(check.id!=='clean')assert.ok(check.difference>0.003,`No audible processing: ${check.id}`);}
    for(const pitch of report.pitch)assert.ok(Math.abs(pitch.expected-pitch.measured)<12,JSON.stringify(pitch));
    assert.ok(report.mixCheck.dryDifference < 0.002 && report.mixCheck.halfDifference > 0.003 && report.mixCheck.halfDifference < report.mixCheck.fullDifference, JSON.stringify(report.mixCheck));
    await page.click('[data-effect=chipmunk]');
    await until(page, async () => (await window.deck.getLibrary()).settings.effect === 'chipmunk'); await page.reload();
    await page.waitForFunction(() => document.querySelector('[data-effect=chipmunk]')?.classList.contains('active'));
    await page.click('#voiceNav');
    const card=page.locator('#effects'); await card.scrollIntoViewIfNeeded(); await page.screenshot({path:path.join(results,'voice-presets.png')});
    report.persistence='Chipmunk selection survives reload';
    await fs.writeFile(path.join(results,'voice-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  }finally{await app.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
