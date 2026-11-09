/**
 * Browser pink-noise generator acting as a ProtectionCommandSink.
 *
 * Disabled by default; enable() must be called from a user gesture. The level
 * is a linear gain on the browser's output and is NOT a calibrated sound
 * pressure level: actual loudness depends on the device, volume and headphones.
 */

import type { ProtectionCommand, ProtectionCommandSink } from './protection.ts';

export const MAX_PINK_LEVEL = 0.25;

/** Paul Kellet's economy pink-noise filter over white noise, normalised to ±0.5 peak. */
function pinkBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0;
  let peak = 0;
  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + white * 0.099046;
    b1 = 0.963 * b1 + white * 0.2965164;
    b2 = 0.57 * b2 + white * 1.0526913;
    data[i] = b0 + b1 + b2 + white * 0.1848;
    peak = Math.max(peak, Math.abs(data[i]));
  }
  for (let i = 0; i < length; i++) data[i] = (data[i] / peak) * 0.5;
  return buffer;
}

export class PinkNoiseSink implements ProtectionCommandSink {
  private ctx: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private gain: GainNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private requested = false;
  enabled = false;
  muted = false;
  level = 0.05;

  /** Must run inside a user gesture (browser autoplay policy). */
  async enable() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.buffer = pinkBuffer(this.ctx, 4);
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 0;
      this.gain.connect(this.ctx.destination);
    }
    await this.ctx.resume();
    this.enabled = true;
    if (this.requested) this.start();
  }

  disable() {
    this.enabled = false;
    this.stopSource();
  }

  setLevel(level: number) {
    this.level = Math.max(0, Math.min(MAX_PINK_LEVEL, level));
    this.applyGain();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (this.gain && this.ctx) {
      // Mute is immediate: no ramp.
      this.gain.gain.cancelScheduledValues(this.ctx.currentTime);
      this.gain.gain.setValueAtTime(muted ? 0 : this.source ? this.level : 0, this.ctx.currentTime);
    }
  }

  get playing() {
    return !!this.source && this.enabled && !this.muted;
  }

  send(command: ProtectionCommand) {
    this.requested = command.type === 'PRECONDITION_START';
    if (this.requested) this.start();
    else this.stopSource();
  }

  private applyGain() {
    if (!this.gain || !this.ctx) return;
    const target = this.muted || !this.source ? 0 : this.level;
    this.gain.gain.cancelScheduledValues(this.ctx.currentTime);
    this.gain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.005);
  }

  private start() {
    if (!this.enabled || !this.ctx || !this.buffer || !this.gain || this.source) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.loop = true;
    src.connect(this.gain);
    src.start();
    this.source = src;
    this.applyGain();
  }

  private stopSource() {
    if (!this.source || !this.ctx || !this.gain) return;
    const src = this.source;
    this.source = null;
    this.gain.gain.cancelScheduledValues(this.ctx.currentTime);
    this.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.01);
    src.stop(this.ctx.currentTime + 0.08);
  }

  /** Freeze/unfreeze audio together with the simulation clock. */
  setPaused(paused: boolean) {
    if (!this.ctx || !this.enabled) return;
    void (paused ? this.ctx.suspend() : this.ctx.resume());
  }

  /** Stop any sound immediately and release the audio context. */
  dispose() {
    this.requested = false;
    this.stopSource();
    void this.ctx?.close();
    this.ctx = null;
    this.enabled = false;
  }
}
