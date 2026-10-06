// Synthesised thermal-printer sound (no audio files): head buzz + stepper whine while paper feeds,
// a short snap on each cut. Off until the user enables it (browsers require a gesture anyway).

let ctx: AudioContext | null = null;
let gain: GainNode | null = null;
const feeding = new Set<string>();

function noise(context: AudioContext, seconds: number): AudioBuffer {
  const buffer = context.createBuffer(1, context.sampleRate * seconds, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function start(): void {
  ctx = new AudioContext();
  gain = ctx.createGain();
  gain.gain.value = 0;
  // thermal head: band-passed noise chopped at the dot-line rate
  const buzz = ctx.createBufferSource();
  buzz.buffer = noise(ctx, 2);
  buzz.loop = true;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 3200;
  band.Q.value = 0.8;
  const chop = ctx.createGain();
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 95;
  lfo.connect(chop.gain);
  // stepper motor
  const motor = ctx.createOscillator();
  motor.type = 'sawtooth';
  motor.frequency.value = 520;
  const motorLevel = ctx.createGain();
  motorLevel.gain.value = 0.05;
  const low = ctx.createBiquadFilter();
  low.type = 'lowpass';
  low.frequency.value = 1400;
  buzz.connect(band).connect(chop).connect(gain);
  motor.connect(motorLevel).connect(low).connect(gain);
  gain.connect(ctx.destination);
  buzz.start();
  lfo.start();
  motor.start();
}

export const printingSound = {
  enabled: false,
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on && !ctx) start();
    if (ctx) void (on ? ctx.resume() : ctx.suspend());
  },
  feeding(device: string, on: boolean): void {
    if (on === feeding.has(device)) return;
    if (on) feeding.add(device);
    else feeding.delete(device);
    if (ctx && gain) gain.gain.setTargetAtTime(this.enabled && feeding.size ? 0.12 : 0, ctx.currentTime, 0.03);
  },
  cut(): void {
    if (!ctx || !this.enabled) return;
    const snap = ctx.createBufferSource();
    snap.buffer = noise(ctx, 0.08);
    const high = ctx.createBiquadFilter();
    high.type = 'highpass';
    high.frequency.value = 2500;
    const level = ctx.createGain();
    level.gain.setValueAtTime(0.35, ctx.currentTime);
    level.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
    snap.connect(high).connect(level).connect(ctx.destination);
    snap.start();
  },
};

/** Filtered noise burst `at` seconds from now: the building block of the drawer's mechanical sounds. */
function burst(at: number, seconds: number, type: BiquadFilterType, frequency: number, level: number): void {
  if (!ctx) return;
  const t = ctx.currentTime + at;
  const source = ctx.createBufferSource();
  source.buffer = noise(ctx, seconds);
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = frequency;
  const envelope = ctx.createGain();
  envelope.gain.setValueAtTime(level, t);
  envelope.gain.exponentialRampToValueAtTime(0.001, t + seconds);
  source.connect(filter).connect(envelope).connect(ctx.destination);
  source.start(t);
}

/** A coin touching another: a short, high, slightly detuned ring. */
function clink(at: number, frequency: number, level: number): void {
  if (!ctx) return;
  const t = ctx.currentTime + at;
  const envelope = ctx.createGain();
  envelope.gain.setValueAtTime(level, t);
  envelope.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
  envelope.connect(ctx.destination);
  for (const ratio of [1, 2.76]) {
    const tone = ctx.createOscillator();
    tone.frequency.value = frequency * ratio;
    tone.connect(envelope);
    tone.start(t);
    tone.stop(t + 0.13);
  }
}

export const drawerSound = {
  /** Solenoid clack, the tray rolling out on its bearings, the end stop and the coins shaking. `stop` = seconds until the end stop. */
  open(stop: number): void {
    if (!ctx || !printingSound.enabled) return;
    burst(0, 0.035, 'lowpass', 900, 0.5);
    burst(0.01, 0.02, 'highpass', 3000, 0.25);
    burst(0.02, stop, 'bandpass', 700, 0.08);
    burst(stop, 0.07, 'lowpass', 300, 0.6);
    for (let i = 0; i < 6; i++) clink(stop + 0.01 + Math.random() * 0.12, 3200 + Math.random() * 2600, 0.04);
  },
  /** The tray pushed back in and the latch catching. */
  close(latch: number): void {
    if (!ctx || !printingSound.enabled) return;
    burst(0, latch, 'bandpass', 600, 0.06);
    burst(latch, 0.05, 'lowpass', 400, 0.55);
    burst(latch + 0.005, 0.025, 'highpass', 2500, 0.3);
    for (let i = 0; i < 3; i++) clink(latch + Math.random() * 0.08, 3500 + Math.random() * 2000, 0.025);
  },
};

/** A square-ish piezo tone, like a payment terminal's buzzer. */
function tone(at: number, frequency: number, seconds: number, level = 0.08): void {
  if (!ctx) return;
  const t = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  osc.type = 'square';
  osc.frequency.value = frequency;
  const low = ctx.createBiquadFilter();
  low.type = 'lowpass';
  low.frequency.value = 3500;
  const envelope = ctx.createGain();
  envelope.gain.setValueAtTime(0, t);
  envelope.gain.linearRampToValueAtTime(level, t + 0.005);
  envelope.gain.setValueAtTime(level, t + seconds - 0.01);
  envelope.gain.linearRampToValueAtTime(0, t + seconds);
  osc.connect(low).connect(envelope).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + seconds + 0.02);
}

export const terminalSound = {
  /** Card read (the contactless "beep"). */
  read(): void {
    if (printingSound.enabled) tone(0, 2400, 0.16);
  },
  key(): void {
    if (printingSound.enabled) tone(0, 2900, 0.03, 0.04);
  },
  approved(): void {
    if (!printingSound.enabled) return;
    tone(0, 2400, 0.09);
    tone(0.14, 2400, 0.09);
  },
  declined(): void {
    if (printingSound.enabled) tone(0, 900, 0.45, 0.07);
  },
};

export const scannerSound = {
  /** The classic "good read" beep of a handheld imager. */
  goodRead(): void {
    if (printingSound.enabled) tone(0, 2700, 0.07, 0.07);
  },
};
