import type { MidiNote, ParsedMidi } from '../types/midi';
import { getBpmAtSec, getTimeSigAtTick, secondsToTick } from './midiTimeline';

export interface WebMidiOutputDevice {
  id: string;
  name: string;
  manufacturer: string;
  state: string;
}

export type MidiChannelRouting = 'ch1' | 'original';

export type WebMidiStatus = 'uninitialized' | 'ready' | 'unsupported' | 'denied';

export interface MidiPlaybackState {
  isPlaying: boolean;
  currentSec: number;
  totalSec: number;
  activePitches: Set<number>;
  baseBpm: number;
  currentBpm: number;
  playbackBpm: number;
  tempoRate: number;
  isTempoOverridden: boolean;
  hasExplicitTempo: boolean;
  hasTempoChanges: boolean;
  currentTimeSignature: string;
  hasTimeSignatureChanges: boolean;
  midiStatus: WebMidiStatus;
  midiError: string | null;
  midiOutputs: WebMidiOutputDevice[];
  selectedMidiOutputId: string | null;
  midiChannelRouting: MidiChannelRouting;
}

type StateListener = (state: MidiPlaybackState) => void;

interface PendingMidiNoteOff {
  offMidiSec: number;
  channel: number;
  pitch: number;
}

const LS_MIDI_OUTPUT_NAME_KEY = 'midi_sorter_midi_output_name_v1';
const LS_MIDI_CHANNEL_ROUTING_KEY = 'midi_sorter_midi_channel_v1';

function loadSavedOutputName(): string | null {
  try {
    return window.localStorage.getItem(LS_MIDI_OUTPUT_NAME_KEY);
  } catch {
    return null;
  }
}

function saveOutputName(name: string | null): void {
  try {
    if (name) window.localStorage.setItem(LS_MIDI_OUTPUT_NAME_KEY, name);
    else window.localStorage.removeItem(LS_MIDI_OUTPUT_NAME_KEY);
  } catch {
    // ignore storage errors
  }
}

function loadSavedChannelRouting(): MidiChannelRouting {
  try {
    const val = window.localStorage.getItem(LS_MIDI_CHANNEL_ROUTING_KEY);
    return val === 'original' ? 'original' : 'ch1';
  } catch {
    return 'ch1';
  }
}

function saveChannelRouting(routing: MidiChannelRouting): void {
  try {
    window.localStorage.setItem(LS_MIDI_CHANNEL_ROUTING_KEY, routing);
  } catch {
    // ignore storage errors
  }
}

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
  private overrideBpm: number | null = null;
  private activeNodes: Set<AudioNode> = new Set();
  private listeners: Set<StateListener> = new Set();

  // Web MIDI Output state
  private midiAccess: MIDIAccess | null = null;
  private midiStatus: WebMidiStatus = 'uninitialized';
  private midiError: string | null = null;
  private midiOutputs: WebMidiOutputDevice[] = [];
  private selectedMidiOutputId: string | null = null;
  private preferredMidiOutputName: string | null = loadSavedOutputName();
  private midiChannelRouting: MidiChannelRouting = loadSavedChannelRouting();
  private pendingMidiNoteOffs: PendingMidiNoteOff[] = [];
  private soundingMidiNotes: Map<string, { channel: number; pitch: number }> = new Map();
  private perfEvents: Array<{ sec: number; tick: number; channel: number; bytes: [number, number] | [number, number, number] }> = [];
  private nextPerfIdx = 0;

  private ensureAudioContext(): AudioContext {
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
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

  async initWebMidi(): Promise<void> {
    if (typeof navigator === 'undefined' || typeof navigator.requestMIDIAccess !== 'function') {
      this.midiStatus = 'unsupported';
      this.midiError =
        'Web MIDI wird von diesem Browser nicht unterstützt (bitte Chrome oder Edge nutzen).';
      this.emit();
      return;
    }

    try {
      const access = await navigator.requestMIDIAccess({ sysex: false });
      this.midiAccess = access;
      this.midiStatus = 'ready';
      this.midiError = null;
      access.onstatechange = () => {
        this.refreshMidiOutputs();
      };
      this.refreshMidiOutputs();
    } catch (err) {
      this.midiStatus = 'denied';
      if (err instanceof DOMException && err.name === 'SecurityError') {
        this.midiError =
          'Web MIDI wurde hier blockiert (z. B. im Vorschau-Frame). Öffne die App direkt in Chrome/Edge auf localhost:3000.';
      } else {
        this.midiError =
          err instanceof Error ? err.message : 'Zugriff auf MIDI-Geräte fehlgeschlagen.';
      }
      this.emit();
    }
  }

  refreshMidiOutputs(): void {
    if (!this.midiAccess) {
      void this.initWebMidi();
      return;
    }

    const outputs: WebMidiOutputDevice[] = [];
    for (const out of this.midiAccess.outputs.values()) {
      outputs.push({
        id: out.id,
        name: out.name || `MIDI-Ausgang (${out.id})`,
        manufacturer: out.manufacturer || '',
        state: out.state,
      });
    }
    outputs.sort((a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }));
    this.midiOutputs = outputs;

    if (this.selectedMidiOutputId && outputs.some((o) => o.id === this.selectedMidiOutputId)) {
      // Keep active port
    } else if (this.preferredMidiOutputName) {
      const matched = outputs.find((o) => o.name === this.preferredMidiOutputName);
      this.selectedMidiOutputId = matched ? matched.id : null;
    } else {
      this.selectedMidiOutputId = null;
    }

    this.emit();
  }

  setMidiOutput(outputId: string | null): void {
    this.sendAllNotesOff();
    const nextId = outputId && outputId.trim() ? outputId : null;
    this.selectedMidiOutputId = nextId;

    if (nextId) {
      const found = this.midiOutputs.find((o) => o.id === nextId);
      this.preferredMidiOutputName = found ? found.name : null;
      saveOutputName(this.preferredMidiOutputName);
    } else {
      this.preferredMidiOutputName = null;
      saveOutputName(null);
    }

    this.emit();
  }

  setMidiChannelRouting(routing: MidiChannelRouting): void {
    if (this.midiChannelRouting === routing) return;
    this.sendAllNotesOff();
    this.midiChannelRouting = routing;
    saveChannelRouting(routing);
    this.emit();
  }

  panicMidi(): void {
    this.sendAllNotesOff();
    this.emit();
  }

  private getActiveMidiOutput(): MIDIOutput | null {
    if (!this.midiAccess || !this.selectedMidiOutputId) return null;
    return this.midiAccess.outputs.get(this.selectedMidiOutputId) ?? null;
  }

  private sendAllNotesOff(): void {
    const out = this.getActiveMidiOutput();
    if (out) {
      try {
        for (const item of this.soundingMidiNotes.values()) {
          out.send([0x80 | (item.channel & 0x0f), item.pitch & 0x7f, 0]);
        }
        for (let ch = 0; ch < 16; ch++) {
          out.send([0xb0 | ch, 64, 0]); // Sustain pedal off
          out.send([0xb0 | ch, 123, 0]); // All Notes Off
          out.send([0xb0 | ch, 120, 0]); // All Sound Off
          out.send([0xe0 | ch, 0x00, 0x40]); // Reset Pitch Bend to center
        }
      } catch {
        // Output may have been disconnected
      }
    }
    this.pendingMidiNoteOffs = [];
    this.soundingMidiNotes.clear();
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

  private getBaseBpm(): number {
    const bpm = this.midi?.primaryBpm;
    return bpm && Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
  }

  private getTempoRate(): number {
    if (this.overrideBpm === null) return 1;
    const base = this.getBaseBpm();
    return Math.max(0.15, Math.min(4, this.overrideBpm / base));
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

    const baseBpm = this.getBaseBpm();
    const currentBpm = this.midi ? getBpmAtSec(this.midi, currentSec) : baseBpm;
    const tempoRate = this.getTempoRate();
    const playbackBpm =
      this.overrideBpm !== null
        ? Math.round(currentBpm * tempoRate * 10) / 10
        : currentBpm;
    const currentTick = this.midi ? secondsToTick(this.midi, currentSec) : 0;
    const activeTs = this.midi
      ? getTimeSigAtTick(this.midi.timeSignatures, currentTick)
      : { numerator: 4, denominator: 4 };

    return {
      isPlaying: this.isPlaying,
      currentSec,
      totalSec,
      activePitches,
      baseBpm,
      currentBpm,
      playbackBpm,
      tempoRate,
      isTempoOverridden: this.overrideBpm !== null,
      hasExplicitTempo: this.midi?.hasExplicitTempo ?? false,
      hasTempoChanges: this.midi?.hasTempoChanges ?? false,
      currentTimeSignature: `${activeTs.numerator}/${activeTs.denominator}`,
      hasTimeSignatureChanges: this.midi?.hasTimeSignatureChanges ?? false,
      midiStatus: this.midiStatus,
      midiError: this.midiError,
      midiOutputs: this.midiOutputs,
      selectedMidiOutputId: this.selectedMidiOutputId,
      midiChannelRouting: this.midiChannelRouting,
    };
  }

  private getCurrentSec(): number {
    if (!this.midi) return 0;
    if (!this.isPlaying || !this.ctx) {
      return Math.min(this.offsetSec, this.midi.totalDurationSec);
    }
    const elapsedReal = Math.max(0, this.ctx.currentTime - this.startContextTime);
    const elapsedMidi = elapsedReal * this.getTempoRate();
    return Math.min(this.offsetSec + elapsedMidi, this.midi.totalDurationSec);
  }

  setVolume(val: number): void {
    this.volume = Math.max(0, Math.min(1, val));
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(this.volume * 0.45, this.ctx.currentTime, 0.02);
    }
  }

  setPlaybackBpm(bpm: number | null): void {
    const currentPos = this.getCurrentSec();
    const base = this.getBaseBpm();

    if (bpm === null || !Number.isFinite(bpm)) {
      this.overrideBpm = null;
    } else {
      const clamped = Math.max(20, Math.min(300, Math.round(bpm * 10) / 10));
      this.overrideBpm = Math.abs(clamped - base) < 0.05 ? null : clamped;
    }

    if (this.isPlaying && this.midi && this.ctx) {
      this.offsetSec = currentPos;
      this.startContextTime = this.ctx.currentTime;
      this.stopScheduledNodes();
      this.nextNoteIdx = this.midi.notes.findIndex((n) => n.startSec >= currentPos - 0.01);
      if (this.nextNoteIdx === -1) {
        this.nextNoteIdx = this.midi.notes.length;
      }
      this.nextPerfIdx = this.perfEvents.findIndex((ev) => ev.sec >= currentPos - 0.01);
      if (this.nextPerfIdx === -1) {
        this.nextPerfIdx = this.perfEvents.length;
      }
      this.scheduleLookahead();
    }

    this.emit();
  }

  load(midi: ParsedMidi | null, autoPlay = false): void {
    this.stop();
    this.midi = midi;
    this.overrideBpm = null;
    this.offsetSec = 0;
    this.nextNoteIdx = 0;
    this.nextPerfIdx = 0;
    this.perfEvents = [];

    if (midi?.performance) {
      const combined: Array<{
        sec: number;
        tick: number;
        channel: number;
        bytes: [number, number] | [number, number, number];
      }> = [];

      for (const pc of midi.performance.programChanges) {
        combined.push({
          sec: pc.sec,
          tick: pc.tick,
          channel: pc.channel & 0x0f,
          bytes: [0xc0, pc.program & 0x7f],
        });
      }
      for (const cc of midi.performance.controlChanges) {
        if (cc.controller >= 120) continue; // skip channel mode panic CCs during playback
        combined.push({
          sec: cc.sec,
          tick: cc.tick,
          channel: cc.channel & 0x0f,
          bytes: [0xb0, cc.controller & 0x7f, cc.value & 0x7f],
        });
      }
      for (const pb of midi.performance.pitchBends) {
        const lsb = pb.rawValue & 0x7f;
        const msb = (pb.rawValue >> 7) & 0x7f;
        combined.push({
          sec: pb.sec,
          tick: pb.tick,
          channel: pb.channel & 0x0f,
          bytes: [0xe0, lsb, msb],
        });
      }
      for (const at of midi.performance.aftertouch) {
        if (at.kind === 'channel') {
          combined.push({
            sec: at.sec,
            tick: at.tick,
            channel: at.channel & 0x0f,
            bytes: [0xd0, at.pressure & 0x7f],
          });
        } else {
          combined.push({
            sec: at.sec,
            tick: at.tick,
            channel: at.channel & 0x0f,
            bytes: [0xa0, (at.pitch ?? 60) & 0x7f, at.pressure & 0x7f],
          });
        }
      }
      combined.sort((a, b) => a.sec - b.sec || a.tick - b.tick);
      this.perfEvents = combined;
    }

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
    this.nextPerfIdx = this.perfEvents.findIndex((ev) => ev.sec >= this.offsetSec - 0.01);
    if (this.nextPerfIdx === -1) {
      this.nextPerfIdx = this.perfEvents.length;
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
    this.nextPerfIdx = 0;
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
    this.sendAllNotesOff();
  }

  private scheduleLookahead(): void {
    if (!this.isPlaying || !this.midi || !this.ctx || !this.masterGain) return;

    const rate = this.getTempoRate();
    const lookaheadMidiSec = 0.24 * rate;
    const currentSongSec = this.getCurrentSec();
    const horizonSec = currentSongSec + lookaheadMidiSec;

    const midiOut = this.getActiveMidiOutput();
    const nowCtx = this.ctx.currentTime;
    const nowPerf = performance.now();

    // 1. Schedule pending external MIDI Note-Offs inside lookahead horizon
    if (midiOut && this.pendingMidiNoteOffs.length > 0) {
      const remaining: PendingMidiNoteOff[] = [];
      for (const item of this.pendingMidiNoteOffs) {
        if (item.offMidiSec <= horizonSec) {
          const deltaReal = Math.max(0, (item.offMidiSec - currentSongSec) / rate);
          const offAt = nowPerf + deltaReal * 1000;
          try {
            midiOut.send([0x80 | item.channel, item.pitch, 0], offAt);
          } catch {
            // ignore disconnected output
          }
          this.soundingMidiNotes.delete(`${item.channel}:${item.pitch}`);
        } else {
          remaining.push(item);
        }
      }
      this.pendingMidiNoteOffs = remaining;
    }

    // 1b. Schedule CC / Pitch Bend / Aftertouch / Program Change for external Web MIDI output
    if (midiOut) {
      while (this.nextPerfIdx < this.perfEvents.length) {
        const pev = this.perfEvents[this.nextPerfIdx];
        if (pev.sec > horizonSec) break;
        this.nextPerfIdx++;

        const deltaMidi = pev.sec - currentSongSec;
        if (deltaMidi < -0.05 * rate) continue;

        const deltaReal = Math.max(0, deltaMidi / rate);
        const scheduleAt = nowPerf + deltaReal * 1000;
        const ch = this.midiChannelRouting === 'ch1' ? 0 : pev.channel;
        const msg =
          pev.bytes.length === 2
            ? [pev.bytes[0] | ch, pev.bytes[1]]
            : [pev.bytes[0] | ch, pev.bytes[1], pev.bytes[2]];
        try {
          midiOut.send(msg, scheduleAt);
        } catch {
          // ignore disconnected output
        }
      }
    }

    // 2. Schedule upcoming Note-Ons
    while (this.nextNoteIdx < this.midi.notes.length) {
      const note = this.midi.notes[this.nextNoteIdx];
      if (note.startSec > horizonSec) break;
      this.nextNoteIdx++;

      const deltaMidi = note.startSec - currentSongSec;
      if (deltaMidi < -0.05 * rate) continue;

      const deltaReal = Math.max(0, deltaMidi / rate);

      if (midiOut) {
        const ch = this.midiChannelRouting === 'ch1' ? 0 : note.channel & 0x0f;
        const pitch = Math.max(0, Math.min(127, note.pitch));
        const vel = Math.max(1, Math.min(127, note.velocity));
        const scheduleMidiAt = nowPerf + deltaReal * 1000;
        try {
          midiOut.send([0x90 | ch, pitch, vel], scheduleMidiAt);
        } catch {
          // ignore disconnected output
        }
        const offMidiSec = note.startSec + Math.max(0.03, note.durationSec);
        this.soundingMidiNotes.set(`${ch}:${pitch}`, { channel: ch, pitch });
        this.pendingMidiNoteOffs.push({ offMidiSec, channel: ch, pitch });
      } else {
        const scheduleAt = nowCtx + deltaReal;
        this.triggerNote(note, scheduleAt, rate);
      }
    }
  }

  private triggerNote(note: MidiNote, when: number, rate: number): void {
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

    const dur = Math.min(6.0, Math.max(0.05, note.durationSec / rate));
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
