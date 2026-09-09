import PRESETS from './voice-presets.json' with { type: 'json' };
export { PRESETS };

export const GROUPS = [
    { id: 'pitch', name: 'Pitch', blurb: 'Shift your voice up or down while keeping your speed.' },
    { id: 'character', name: 'Characters', blurb: 'Monsters, machines, and villains.' },
    { id: 'device', name: 'Devices', blurb: 'Sound like you are coming through a speaker or a wire.' },
    { id: 'space', name: 'Space & texture', blurb: 'Echoes, rooms, layers, and movement.' }
];

export const PITCH_RANGE = 12;

/**
 * Builds the voice-processing graph for one preset.
 *
 * source → (custom pitch) → preset chain → wet gain ─┐
 *                        └─────────────── dry gain ──┴→ destination
 *
 * Returns { nodes, setMix } — every node is owned by this build and is
 * released by the audio engine when switching presets or disconnecting.
 * `setMix` blends the processed and untouched voice without rebuilding.
 */
export function buildVoiceEffect(ctx, source, destination, effect, options = {}) {
    const nodes = [];
    const own = node => { nodes.push(node); return node; };
    const gain = value => { const node = own(ctx.createGain()); node.gain.value = value; return node; };
    const filter = (type, hz, q = 0.7, db = 0) => {
        const node = own(ctx.createBiquadFilter());
        node.type = type; node.frequency.value = hz; node.Q.value = q; node.gain.value = db;
        return node;
    };
    const chain = (...parts) => { for (let i = 0; i < parts.length - 1; i++) parts[i].connect(parts[i + 1]); return parts[parts.length - 1]; };
    const shaper = curve => { const node = own(ctx.createWaveShaper()); node.curve = curve; node.oversample = '2x'; return node; };
    const crush = drive => shaper(Float32Array.from({ length: 2048 }, (_, i) => Math.tanh((i / 2047 * 2 - 1) * drive) / Math.tanh(drive)));
    const bitcrush = bits => {
        const levels = 2 ** (bits - 1);
        return shaper(Float32Array.from({ length: 4097 }, (_, i) => Math.round((i / 4096 * 2 - 1) * levels) / levels));
    };
    const lfo = (frequency, depth, target, shape = 'sine') => {
        const oscillator = own(ctx.createOscillator()), amount = gain(depth);
        oscillator.type = shape; oscillator.frequency.value = frequency;
        chain(oscillator, amount, target); oscillator.start();
    };
    const ring = (input, frequency, base, amount) => {
        const mod = gain(base);
        lfo(frequency, amount, mod.gain);
        input.connect(mod);
        return mod;
    };
    const tremolo = (input, rate, depth, shape = 'sine') => {
        const mod = gain(1 - depth / 2);
        lfo(rate, depth / 2, mod.gain, shape);
        input.connect(mod);
        return mod;
    };
    const vibrato = (input, rate, depth) => {
        const delay = own(ctx.createDelay(0.05));
        delay.delayTime.value = 0.012;
        lfo(rate, depth, delay.delayTime);
        input.connect(delay);
        return delay;
    };
    const echo = (input, time, feedbackAmount, tone = 20000) => {
        const delay = own(ctx.createDelay(2)), feedback = gain(feedbackAmount), damp = filter('lowpass', tone);
        delay.delayTime.value = time;
        input.connect(delay);
        chain(delay, damp, feedback, delay);
        return delay;
    };
    const reverb = (input, seconds, decay) => {
        const convolver = own(ctx.createConvolver());
        const length = Math.round(ctx.sampleRate * seconds), impulse = ctx.createBuffer(2, length, ctx.sampleRate);
        let seed = 87321;
        for (let channel = 0; channel < 2; channel++) {
            const data = impulse.getChannelData(channel);
            for (let i = 0; i < length; i++) {
                seed = (1664525 * seed + 1013904223) >>> 0;
                data[i] = (seed / 2147483648 - 1) * Math.exp(-i / ctx.sampleRate * decay);
            }
        }
        convolver.buffer = impulse;
        input.connect(convolver);
        return convolver;
    };
    const pitch = (input, semitones) => {
        if (!semitones) return input;
        const ratio = 2 ** (semitones / 12), windowSeconds = 0.05;
        const count = Math.max(128, Math.round(ctx.sampleRate * windowSeconds / Math.abs(1 - ratio)));
        const output = gain(1);
        // Two moving delay heads run half a cycle apart. Their sin² fades sum to one,
        // hiding the point where each delay ramp resets without changing speech speed.
        for (const offset of [0, 0.5]) {
            const delay = own(ctx.createDelay(0.2)), fade = gain(0);
            delay.delayTime.value = 0.008;
            const rampBuffer = ctx.createBuffer(1, count, ctx.sampleRate), fadeBuffer = ctx.createBuffer(1, count, ctx.sampleRate);
            const ramp = rampBuffer.getChannelData(0), envelope = fadeBuffer.getChannelData(0);
            for (let i = 0; i < count; i++) {
                const phase = (i / count + offset) % 1;
                ramp[i] = windowSeconds * (ratio > 1 ? 1 - phase : phase);
                envelope[i] = Math.sin(Math.PI * phase) ** 2;
            }
            for (const [buffer, parameter] of [[rampBuffer, delay.delayTime], [fadeBuffer, fade.gain]]) {
                const control = own(ctx.createBufferSource());
                control.buffer = buffer; control.loop = true; control.connect(parameter); control.start();
            }
            chain(input, delay, fade, output);
        }
        return output;
    };

    // Each builder wires `input` into `out`.
    const builders = {
        clean: (input, out) => input.connect(out),
        deep: (input, out) => pitch(input, -5).connect(out),
        chipmunk: (input, out) => pitch(input, 7).connect(out),
        helium: (input, out) => chain(pitch(input, 12), filter('highshelf', 3000, 0.7, 2), out),
        giant: (input, out) => {
            const low = chain(pitch(input, -12), filter('lowpass', 3200), gain(1.1));
            low.connect(out);
            chain(reverb(low, 0.9, 5), gain(0.2), out);
        },
        monster: (input, out) => chain(pitch(input, -9), filter('lowpass', 2600), crush(2.5), gain(0.65), out),
        demon: (input, out) => {
            const low = pitch(input, -7);
            const growl = ring(low, 32, 0.55, 0.45);
            chain(growl, filter('lowpass', 2400), crush(3), gain(0.55), out);
            chain(pitch(input, -12), filter('lowpass', 900), gain(0.35), out);
        },
        villain: (input, out) => {
            const voice = chain(pitch(input, -4), filter('lowpass', 3800), filter('peaking', 180, 1, 3), crush(1.4), gain(0.8));
            voice.connect(out);
            chain(reverb(voice, 0.7, 6), gain(0.25), out);
        },
        robot: (input, out) => ring(input, 45, 0.4, 0.6).connect(out),
        alien: (input, out) => ring(input, 135, 0.15, 0.85).connect(out),
        cyborg: (input, out) => {
            const low = pitch(input, -3);
            chain(low, gain(0.55), out);
            chain(ring(low, 90, 0.2, 0.8), crush(1.6), gain(0.5), out);
        },
        ghost: (input, out) => {
            const airy = chain(pitch(input, 3), filter('highpass', 300));
            const shaky = tremolo(airy, 5.5, 0.55);
            chain(shaky, gain(0.5), out);
            chain(reverb(shaky, 2.2, 2.6), gain(0.6), out);
        },
        radio: (input, out) => chain(input, filter('highpass', 450), filter('lowpass', 2700), crush(2), out),
        telephone: (input, out) => chain(input, filter('highpass', 600), filter('lowpass', 2200), filter('peaking', 1400, 1), out),
        megaphone: (input, out) => {
            const shaped = chain(input, filter('highpass', 650), filter('lowpass', 3200), crush(5), gain(0.55));
            shaped.connect(out);
            const slap = own(ctx.createDelay(0.2)); slap.delayTime.value = 0.065;
            chain(shaped, slap, gain(0.22), out);
        },
        eightbit: (input, out) => chain(input, filter('lowpass', 3800, 1.5), gain(1.3), bitcrush(6), gain(0.7), out),
        underwater: (input, out) => chain(vibrato(input, 0.4, 0.005), filter('lowpass', 520, 1.2), gain(1.5), out),
        echo: (input, out) => {
            chain(input, gain(0.8), out);
            chain(echo(input, 0.18, 0.28), gain(0.32), out);
        },
        cathedral: (input, out) => {
            chain(input, gain(0.72), out);
            chain(reverb(input, 2.4, 3.1), gain(0.48), out);
        },
        cave: (input, out) => {
            chain(input, gain(0.7), out);
            const bounce = echo(input, 0.32, 0.42, 1800);
            chain(bounce, gain(0.4), out);
            chain(reverb(bounce, 1.3, 3.5), gain(0.35), out);
        },
        stadium: (input, out) => {
            const bright = chain(input, filter('highpass', 200), filter('peaking', 2500, 1, 3));
            chain(bright, gain(0.75), out);
            chain(echo(bright, 0.27, 0.5, 4000), gain(0.4), out);
            chain(reverb(bright, 2.2, 2.4), gain(0.35), out);
        },
        chorus: (input, out) => {
            chain(input, gain(0.55), out);
            for (const [time, frequency] of [[0.019, 0.8], [0.031, 1.1]]) {
                const delay = own(ctx.createDelay(0.1));
                delay.delayTime.value = time;
                lfo(frequency, 0.004, delay.delayTime);
                chain(input, delay, gain(0.24), out);
            }
        },
        harmony: (input, out) => {
            chain(input, gain(0.6), out);
            chain(pitch(input, 4), gain(0.35), out);
            chain(pitch(input, 7), gain(0.3), out);
        },
        wobble: (input, out) => vibrato(input, 6, 0.0025).connect(out),
        flutter: (input, out) => tremolo(input, 11, 0.85, 'triangle').connect(out)
    };

    const semitones = Math.max(-PITCH_RANGE, Math.min(PITCH_RANGE, Math.round(Number(options.pitch) || 0)));
    const mix = Math.max(0, Math.min(1, options.mix === undefined ? 1 : Number(options.mix)));
    const voice = pitch(source, semitones);
    const wet = gain(mix), dry = gain(1 - mix);
    (builders[effect] || builders.clean)(voice, wet);
    wet.connect(destination);
    voice.connect(dry);
    dry.connect(destination);

    const setMix = value => {
        const amount = Math.max(0, Math.min(1, Number(value)));
        const now = ctx.currentTime;
        wet.gain.setTargetAtTime(amount, now, 0.02);
        dry.gain.setTargetAtTime(1 - amount, now, 0.02);
    };
    return { nodes, setMix };
}
