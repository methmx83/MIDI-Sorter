import type { MidiNote, ParsedMidi } from '../types/midi';

export interface MidiPlaybackState {
  isPlaying: boolean;
  currentSec: number;
  totalSec: number;
  activePitches: Set<number>;
}

type StateListener = (state: MidiPlaybackState) => void;

function midiToFrequency(pitch: number): number {
  return 440 * Math.pow(2, (pitch - 69) / 12);
}

export class WebMidiPlayer {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private midi: ParsedMidi | null = null;
  private isPlaying = false;
  private startContextTime = 0;
  private offsetSec = 0;
  private nextNoteIdx = 0;
  private schedulerTimer: number | null = null;
  private rafId: number | null = null;
  private volume = 0.7;
  private activeNodes: Set<AudioNode> = new Set();
  private listeners: Set<StateListener> = new Set();

  private ensureAudioContext(): AudioContext {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.volume * 0.45;
      this.masterGain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const state = this.getState();
    for (const l of this.listeners) {
      l(state);
    }
  }

  getState(): MidiPlaybackState {
    const totalSec = this.midi?.totalDurationSec ?? 0;
    const currentSec = this.getCurrentSec();
    const activePitches = new Set<number>();

    if (this.isPlaying && this.midi) {
      for (const n of this.midi.notes) {
        if (n.startSec <= currentSec && n.startSec + n.durationSec >= currentSec) {
          activePitches.add(n.pitch);
        } else if (n.startSec > currentSec) {
          break;
        }
      }
    }

    return {
      isPlaying: this.isPlaying,
      currentSec,
      totalSec,
      activePitches,
    };
  }

  private getCurrentSec(): number {
    if (!this.midi) return 0;
    if (!this.isPlaying || !this.ctx) {
      return Math.min(this.offsetSec, this.midi.totalDurationSec);
    }
    const elapsed = this.ctx.currentTime - this.startContextTime;
    return Math.min(this.offsetSec + Math.max(0, elapsed), this.midi.totalDurationSec);
  }

  setVolume(val: number): void {
    this.volume = Math.max(0, Math.min(1, val));
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(this.volume * 0.45, this.ctx.currentTime, 0.02);
    }
  }

  load(midi: ParsedMidi | null, autoPlay = false): void {
    this.stop();
    this.midi = midi;
    this.offsetSec = 0;
    this.nextNoteIdx = 0;
    this.emit();
    if (autoPlay && midi && midi.notes.length > 0) {
      this.play(0);
    }
  }

  play(fromSec?: number): void {
    if (!this.midi || this.midi.notes.length === 0) return;

    const ctx = this.ensureAudioContext();
    this.stopScheduledNodes();

    if (typeof fromSec === 'number') {
      this.offsetSec = Math.max(0, Math.min(fromSec, this.midi.totalDurationSec));
    } else if (this.offsetSec >= this.midi.totalDurationSec - 0.05) {
      this.offsetSec = 0;
    }

    this.nextNoteIdx = this.midi.notes.findIndex((n) => n.startSec >= this.offsetSec - 0.01);
    if (this.nextNoteIdx === -1) {
      this.nextNoteIdx = this.midi.notes.length;
    }

    this.isPlaying = true;
    this.startContextTime = ctx.currentTime;

    if (this.schedulerTimer !== null) window.clearInterval(this.schedulerTimer);
    this.schedulerTimer = window.setInterval(() => this.scheduleLookahead(), 35);
    this.scheduleLookahead();

    const tickLoop = () => {
      if (!this.isPlaying) return;
      const cur = this.getCurrentSec();
      if (this.midi && cur >= this.midi.totalDurationSec) {
        this.pause();
        this.offsetSec = 0;
        this.emit();
        return;
      }
      this.emit();
      this.rafId = window.requestAnimationFrame(tickLoop);
    };
    if (this.rafId !== null) window.cancelAnimationFrame(this.rafId);
    this.rafId = window.requestAnimationFrame(tickLoop);
    this.emit();
  }

  pause(): void {
    if (!this.isPlaying) return;
    this.offsetSec = this.getCurrentSec();
    this.isPlaying = false;
    this.clearTimers();
    this.stopScheduledNodes();
    this.emit();
  }

  stop(): void {
    this.isPlaying = false;
    this.offsetSec = 0;
    this.nextNoteIdx = 0;
    this.clearTimers();
    this.stopScheduledNodes();
    this.emit();
  }

  seek(sec: number): void {
    if (!this.midi) return;
    const clamped = Math.max(0, Math.min(sec, this.midi.totalDurationSec));
    if (this.isPlaying) {
      this.play(clamped);
    } else {
      this.offsetSec = clamped;
      this.emit();
    }
  }

  toggle(): void {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  private clearTimers(): void {
    if (this.schedulerTimer !== null) {
      window.clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private stopScheduledNodes(): void {
    for (const node of this.activeNodes) {
      try {
        if ('stop' in node && typeof (node as OscillatorNode).stop === 'function') {
          (node as OscillatorNode).stop();
        }
        node.disconnect();
      } catch {
        // already stopped
      }
    }
    this.activeNodes.clear();
  }

  private scheduleLookahead(): void {
    if (!this.isPlaying || !this.midi || !this.ctx || !this.masterGain) return;

    const lookaheadSec = 0.22;
    const currentSongSec = this.getCurrentSec();
    const horizonSec = currentSongSec + lookaheadSec;

    while (this.nextNoteIdx < this.midi.notes.length) {
      const note = this.midi.notes[this.nextNoteIdx];
      if (note.startSec > horizonSec) break;
      this.nextNoteIdx++;

      const deltaFromNow = note.startSec - currentSongSec;
      if (deltaFromNow < -0.05) continue;

      const scheduleAt = this.ctx.currentTime + Math.max(0, deltaFromNow);
      this.triggerNote(note, scheduleAt);
    }
  }

  private triggerNote(note: MidiNote, when: number): void {
    if (!this.ctx || !this.masterGain) return;
    const velGain = Math.max(0.08, (note.velocity / 127) * 0.28);

    // Channel 9 (MIDI Ch 10) percussion synthesis
    if (note.channel === 9) {
      this.triggerDrum(note.pitch, when, velGain);
      return;
    }

    const osc = this.ctx.createOscillator();
    const subOsc = this.ctx.createOscillator();
    const filter = this.ctx.createBiquadFilter();
    const env = this.ctx.createGain();

    const freq = midiToFrequency(note.pitch);
    osc.type = note.pitch < 48 ? 'sawtooth' : 'triangle';
    osc.frequency.setValueAtTime(freq, when);

    subOsc.type = 'sine';
    subOsc.frequency.setValueAtTime(freq, when);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(Math.min(5500, freq * 5.5), when);

    const dur = Math.min(6.0, Math.max(0.06, note.durationSec));
    const attack = 0.008;
    const release = Math.min(0.18, dur * 0.35 + 0.04);

    env.gain.setValueAtTime(0.0001, when);
    env.gain.linearRampToValueAtTime(velGain, when + attack);
    env.gain.setValueAtTime(velGain * 0.85, when + Math.max(attack, dur - 0.01));
    env.gain.exponentialRampToValueAtTime(0.0001, when + dur + release);

    osc.connect(filter);
    subOsc.connect(filter);
    filter.connect(env);
    env.connect(this.masterGain);

    osc.start(when);
    subOsc.start(when);
    osc.stop(when + dur + release + 0.02);
    subOsc.stop(when + dur + release + 0.02);

    this.activeNodes.add(osc);
    this.activeNodes.add(subOsc);
    osc.onended = () => {
      this.activeNodes.delete(osc);
      this.activeNodes.delete(subOsc);
      try {
        filter.disconnect();
        env.disconnect();
      } catch {
        // ignore
      }
    };
  }

  private triggerDrum(pitch: number, when: number, velGain: number): void {
    if (!this.ctx || !this.masterGain) return;
    if (pitch === 35 || pitch === 36) {
      // Kick
      const osc = this.ctx.createOscillator();
      const env = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(135, when);
      osc.frequency.exponentialRampToValueAtTime(42, when + 0.12);
      env.gain.setValueAtTime(velGain * 1.4, when);
      env.gain.exponentialRampToValueAtTime(0.0001, when + 0.16);
      osc.connect(env);
      env.connect(this.masterGain);
      osc.start(when);
      osc.stop(when + 0.18);
      this.activeNodes.add(osc);
      osc.onended = () => this.activeNodes.delete(osc);
    } else {
      // Short filtered noise burst for snare/hat
      const bufferSize = Math.floor(this.ctx.sampleRate * 0.09);
      const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      const noise = this.ctx.createBufferSource();
      noise.buffer = buffer;

      const filter = this.ctx.createBiquadFilter();
      filter.type = pitch === 38 || pitch === 40 ? 'bandpass' : 'highpass';
      filter.frequency.setValueAtTime(pitch === 38 || pitch === 40 ? 1800 : 6500, when);

      const env = this.ctx.createGain();
      const decay = pitch === 38 || pitch === 40 ? 0.09 : 0.045;
      env.gain.setValueAtTime(velGain * 0.75, when);
      env.gain.exponentialRampToValueAtTime(0.0001, when + decay);

      noise.connect(filter);
      filter.connect(env);
      env.connect(this.masterGain);
      noise.start(when);
      noise.stop(when + decay + 0.01);
      this.activeNodes.add(noise);
      noise.onended = () => this.activeNodes.delete(noise);
    }
  }
}
