import type { MidiNote, ParsedMidi } from '../types/midi';
import { getBpmAtSec, getTimeSigAtTick, secondsToTick } from './midiTimeline';
import {
  inferGmProgramFromTrackName,
  Sf2WebAudioSynth,
  type Sf2PresetInfo,
} from './sf2Engine';
import {
  clearActiveSoundFontFromDb,
  loadActiveSoundFontFromDb,
  saveActiveSoundFontToDb,
} from './sf2Storage';

export interface WebMidiOutputDevice {
  id: string;
  name: string;
  manufacturer: string;
  state: string;
}

export type MidiChannelRouting = 'ch1' | 'original';

export type WebMidiStatus = 'uninitialized' | 'ready' | 'unsupported' | 'denied';

export interface BundledSoundFontItem {
  id: string; // "library:<filename>"
  name: string;
  label: string;
  url: string;
  sizeBytes: number;
}

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
  // SoundFont (.sf2) & audio polish state
  sf2Loaded: boolean;
  sf2Loading: boolean;
  sf2BankName: string | null;
  sf2FileName: string | null;
  sf2Presets: Sf2PresetInfo[];
  sf2SelectedPresetId: string | null; // null = Auto (GM / Spur)
  sf2Error: string | null;
  sf2Library: BundledSoundFontItem[];
  sf2SelectedSourceId: string; // '' = Browser-Synth, 'library:<file>', 'custom'
  sf2CustomName: string | null;
  reverbEnabled: boolean;
  mutedTracks: Set<number>;
  soloTracks: Set<number>;
}

type StateListener = (state: MidiPlaybackState) => void;

interface PendingMidiNoteOff {
  offMidiSec: number;
  channel: number;
  pitch: number;
}

const LS_MIDI_OUTPUT_NAME_KEY = 'midi_sorter_midi_output_name_v1';
const LS_MIDI_CHANNEL_ROUTING_KEY = 'midi_sorter_midi_channel_v1';
const LS_REVERB_ENABLED_KEY = 'midi_sorter_reverb_enabled_v1';
const LS_SF2_SOURCE_KEY = 'midi_sorter_sf2_source_v1';

function loadSavedSf2Source(): string | null {
  try {
    return window.localStorage.getItem(LS_SF2_SOURCE_KEY);
  } catch {
    return null;
  }
}

function saveSf2Source(sourceId: string): void {
  try {
    window.localStorage.setItem(LS_SF2_SOURCE_KEY, sourceId);
  } catch {
    // ignore
  }
}

function loadSavedReverbPref(): boolean {
  try {
    return window.localStorage.getItem(LS_REVERB_ENABLED_KEY) !== 'false';
  } catch {
    return true;
  }
}

function saveReverbPref(val: boolean): void {
  try {
    window.localStorage.setItem(LS_REVERB_ENABLED_KEY, String(val));
  } catch {
    // ignore
  }
}

function createHallImpulseResponse(ctx: AudioContext, durationSec = 1.45, decay = 2.6): AudioBuffer {
  const sr = ctx.sampleRate;
  const length = Math.floor(sr * durationSec);
  const impulse = ctx.createBuffer(2, length, sr);
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < length; i++) {
      const env = Math.pow(1 - i / length, decay);
      // Gentle pre-delay + smooth damped stereo noise
      const preDelay = i < sr * 0.012 ? i / (sr * 0.012) : 1;
      const white = Math.random() * 2 - 1;
      lp = lp * 0.62 + white * 0.38;
      data[i] = lp * env * preDelay * 0.55;
    }
  }
  return impulse;
}

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
  private synthBus: GainNode | null = null;
  private reverbWetGain: GainNode | null = null;
  private midi: ParsedMidi | null = null;
  private isPlaying = false;
  private startContextTime = 0;
  private offsetSec = 0;
  private nextNoteIdx = 0;
  private schedulerTimer: number | null = null;
  private rafId: number | null = null;
  private volume = 0.75;
  private overrideBpm: number | null = null;
  private activeNodes: Set<AudioNode> = new Set();
  private listeners: Set<StateListener> = new Set();

  // SoundFont (.sf2) engine state
  private sf2 = new Sf2WebAudioSynth();
  private sf2Loading = false;
  private sf2BankName: string | null = null;
  private sf2FileName: string | null = null;
  private sf2Presets: Sf2PresetInfo[] = [];
  private sf2SelectedPresetId: string | null = null;
  private sf2Error: string | null = null;
  private sf2Library: BundledSoundFontItem[] = [];
  private sf2SelectedSourceId: string = '';
  private sf2CustomName: string | null = null;
  private sf2UrlBufferCache: Map<string, ArrayBuffer> = new Map();
  private reverbEnabled: boolean = loadSavedReverbPref();
  private trackProgramMap: Map<number, { program: number; isDrum: boolean }> = new Map();
  private channelProgramMap: Map<number, number> = new Map();
  private mutedTracks: Set<number> = new Set();
  private soloTracks: Set<number> = new Set();

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

      // Master chain: synthBus -> (dry + hall reverb) -> soft limiter -> masterGain -> destination
      this.synthBus = this.ctx.createGain();
      this.synthBus.gain.value = 1.0;

      const compressor = this.ctx.createDynamicsCompressor();
      compressor.threshold.value = -8;
      compressor.knee.value = 18;
      compressor.ratio.value = 6;
      compressor.attack.value = 0.004;
      compressor.release.value = 0.16;

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.volume * 0.72;

      const dryGain = this.ctx.createGain();
      dryGain.gain.value = 0.95;

      const convolver = this.ctx.createConvolver();
      convolver.buffer = createHallImpulseResponse(this.ctx);

      this.reverbWetGain = this.ctx.createGain();
      this.reverbWetGain.gain.value = this.reverbEnabled ? 0.24 : 0.0;

      this.synthBus.connect(dryGain);
      dryGain.connect(compressor);

      this.synthBus.connect(convolver);
      convolver.connect(this.reverbWetGain);
      this.reverbWetGain.connect(compressor);

      compressor.connect(this.masterGain);
      this.masterGain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  async refreshSoundFontLibrary(): Promise<BundledSoundFontItem[]> {
    try {
      let res = await fetch('/api/soundfonts', { cache: 'no-store' });
      if (!res.ok) {
        res = await fetch('/soundfonts/manifest.json', { cache: 'no-store' });
      }
      if (res.ok) {
        const data = (await res.json()) as { files?: BundledSoundFontItem[] };
        if (Array.isArray(data.files)) {
          this.sf2Library = data.files;
          this.emit();
          return this.sf2Library;
        }
      }
    } catch {
      // Ignore if offline or endpoint unavailable
    }
    return this.sf2Library;
  }

  private async loadBundledSoundFont(item: BundledSoundFontItem): Promise<void> {
    this.sf2Loading = true;
    this.sf2Error = null;
    this.emit();
    try {
      let buffer = this.sf2UrlBufferCache.get(item.url);
      if (!buffer) {
        const res = await fetch(item.url);
        if (!res.ok) {
          throw new Error(`SoundFont „${item.name}“ konnte nicht geladen werden (${res.status}).`);
        }
        buffer = await res.arrayBuffer();
        this.sf2UrlBufferCache.set(item.url, buffer);
      }
      const info = this.sf2.loadBuffer(buffer, item.name);
      this.sf2BankName = info.bankName;
      this.sf2FileName = info.fileName;
      this.sf2Presets = info.presets;
      this.sf2SelectedPresetId = info.presets.length === 1 ? info.presets[0].id : null;
      this.sf2SelectedSourceId = item.id;
      this.sf2Error = null;
      saveSf2Source(item.id);
    } catch (err) {
      this.sf2Error =
        err instanceof Error ? err.message : 'SoundFont (.sf2) konnte nicht geladen werden.';
    } finally {
      this.sf2Loading = false;
      this.emit();
    }
  }

  async initSavedSoundFont(): Promise<void> {
    this.sf2Loading = true;
    this.emit();
    try {
      const [library, storedCustom] = await Promise.all([
        this.refreshSoundFontLibrary(),
        loadActiveSoundFontFromDb(),
      ]);
      this.sf2CustomName = storedCustom?.name ?? null;

      const savedSource = loadSavedSf2Source();

      // 1. Respect explicit "Browser-Synth" selection
      if (savedSource === 'none') {
        this.sf2SelectedSourceId = '';
        return;
      }

      // 2. Restore previously chosen SoundFont from public/soundfonts/
      if (savedSource && savedSource.startsWith('library:')) {
        const match = library.find((f) => f.id === savedSource);
        if (match) {
          await this.loadBundledSoundFont(match);
          return;
        }
      }

      // 3. Restore previously uploaded custom SoundFont from IndexedDB
      if (savedSource === 'custom' && storedCustom) {
        const info = this.sf2.loadBuffer(storedCustom.buffer, storedCustom.name);
        this.sf2BankName = info.bankName;
        this.sf2FileName = info.fileName;
        this.sf2Presets = info.presets;
        this.sf2SelectedPresetId = info.presets.length === 1 ? info.presets[0].id : null;
        this.sf2SelectedSourceId = 'custom';
        this.sf2Error = null;
        return;
      }

      // 4. Default on first visit: auto-load first SoundFont from public/soundfonts/ if present, else custom DB
      if (library.length > 0) {
        await this.loadBundledSoundFont(library[0]);
      } else if (storedCustom) {
        const info = this.sf2.loadBuffer(storedCustom.buffer, storedCustom.name);
        this.sf2BankName = info.bankName;
        this.sf2FileName = info.fileName;
        this.sf2Presets = info.presets;
        this.sf2SelectedPresetId = info.presets.length === 1 ? info.presets[0].id : null;
        this.sf2SelectedSourceId = 'custom';
        this.sf2Error = null;
      }
    } catch (err) {
      this.sf2Error =
        err instanceof Error ? err.message : 'Gespeichertes SoundFont konnte nicht geladen werden.';
    } finally {
      this.sf2Loading = false;
      this.emit();
    }
  }

  async selectSoundFontSource(sourceId: string): Promise<void> {
    if (!sourceId) {
      this.sf2.unload();
      this.sf2BankName = null;
      this.sf2FileName = null;
      this.sf2Presets = [];
      this.sf2SelectedPresetId = null;
      this.sf2SelectedSourceId = '';
      this.sf2Error = null;
      saveSf2Source('none');
      this.emit();
      return;
    }

    if (sourceId.startsWith('library:')) {
      const item = this.sf2Library.find((f) => f.id === sourceId);
      if (item) {
        await this.loadBundledSoundFont(item);
      }
      return;
    }

    if (sourceId === 'custom') {
      this.sf2Loading = true;
      this.sf2Error = null;
      this.emit();
      try {
        const stored = await loadActiveSoundFontFromDb();
        if (stored) {
          const info = this.sf2.loadBuffer(stored.buffer, stored.name);
          this.sf2BankName = info.bankName;
          this.sf2FileName = info.fileName;
          this.sf2Presets = info.presets;
          this.sf2SelectedPresetId = info.presets.length === 1 ? info.presets[0].id : null;
          this.sf2SelectedSourceId = 'custom';
          this.sf2CustomName = stored.name;
          saveSf2Source('custom');
        }
      } catch (err) {
        this.sf2Error =
          err instanceof Error ? err.message : 'SoundFont konnte nicht geladen werden.';
      } finally {
        this.sf2Loading = false;
        this.emit();
      }
    }
  }

  async loadSoundFontFile(file: File): Promise<void> {
    this.sf2Loading = true;
    this.sf2Error = null;
    this.emit();
    try {
      const buffer = await file.arrayBuffer();
      const info = this.sf2.loadBuffer(buffer, file.name);
      this.sf2BankName = info.bankName;
      this.sf2FileName = info.fileName;
      this.sf2Presets = info.presets;
      this.sf2SelectedPresetId = info.presets.length === 1 ? info.presets[0].id : null;
      this.sf2SelectedSourceId = 'custom';
      this.sf2CustomName = file.name;
      this.sf2Error = null;
      saveSf2Source('custom');
      void saveActiveSoundFontToDb(file.name, buffer);
    } catch (err) {
      this.sf2Error =
        err instanceof Error ? err.message : 'SoundFont (.sf2) konnte nicht geladen werden.';
    } finally {
      this.sf2Loading = false;
      this.emit();
    }
  }

  unloadSoundFont(): void {
    this.sf2.unload();
    this.sf2BankName = null;
    this.sf2FileName = null;
    this.sf2Presets = [];
    this.sf2SelectedPresetId = null;
    this.sf2SelectedSourceId = '';
    this.sf2CustomName = null;
    this.sf2Error = null;
    saveSf2Source('none');
    void clearActiveSoundFontFromDb();
    this.emit();
  }

  setSf2Preset(presetId: string | null): void {
    this.sf2SelectedPresetId = presetId && presetId.trim() ? presetId : null;
    this.emit();
  }

  setReverbEnabled(enabled: boolean): void {
    this.reverbEnabled = enabled;
    saveReverbPref(enabled);
    if (this.reverbWetGain && this.ctx) {
      this.reverbWetGain.gain.setTargetAtTime(enabled ? 0.24 : 0.0, this.ctx.currentTime, 0.03);
    }
    this.emit();
  }

  toggleTrackMute(trackIndex: number): void {
    const next = new Set(this.mutedTracks);
    if (next.has(trackIndex)) next.delete(trackIndex);
    else next.add(trackIndex);
    this.mutedTracks = next;
    this.emit();
  }

  toggleTrackSolo(trackIndex: number): void {
    const next = new Set(this.soloTracks);
    if (next.has(trackIndex)) next.delete(trackIndex);
    else next.add(trackIndex);
    this.soloTracks = next;
    this.emit();
  }

  clearTrackMuteSolo(): void {
    if (this.mutedTracks.size === 0 && this.soloTracks.size === 0) return;
    this.mutedTracks = new Set();
    this.soloTracks = new Set();
    this.emit();
  }

  private isTrackAudible(trackIndex: number): boolean {
    if (this.soloTracks.size > 0) {
      return this.soloTracks.has(trackIndex);
    }
    return !this.mutedTracks.has(trackIndex);
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
      sf2Loaded: this.sf2.isLoaded(),
      sf2Loading: this.sf2Loading,
      sf2BankName: this.sf2BankName,
      sf2FileName: this.sf2FileName,
      sf2Presets: this.sf2Presets,
      sf2SelectedPresetId: this.sf2SelectedPresetId,
      sf2Error: this.sf2Error,
      sf2Library: this.sf2Library,
      sf2SelectedSourceId: this.sf2SelectedSourceId,
      sf2CustomName: this.sf2CustomName,
      reverbEnabled: this.reverbEnabled,
      mutedTracks: new Set(this.mutedTracks),
      soloTracks: new Set(this.soloTracks),
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
      this.masterGain.gain.setTargetAtTime(this.volume * 0.72, this.ctx.currentTime, 0.02);
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
    this.mutedTracks = new Set();
    this.soloTracks = new Set();
    this.trackProgramMap.clear();
    this.channelProgramMap.clear();

    if (midi) {
      for (const pc of midi.performance.programChanges) {
        if (!this.channelProgramMap.has(pc.channel)) {
          this.channelProgramMap.set(pc.channel, pc.program);
        }
        if (!this.trackProgramMap.has(pc.trackIndex)) {
          this.trackProgramMap.set(pc.trackIndex, {
            program: pc.program,
            isDrum: pc.channel === 9,
          });
        }
      }
      for (const tr of midi.tracks) {
        if (!this.trackProgramMap.has(tr.index)) {
          const isDrumCh = tr.channels.length > 0 && tr.channels.every((c) => c === 9);
          const inferred = inferGmProgramFromTrackName(tr.name);
          this.trackProgramMap.set(tr.index, {
            program: inferred.program,
            isDrum: isDrumCh || inferred.isDrum,
          });
        }
      }
    }

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
    this.sf2.stopAll();
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

      if (!this.isTrackAudible(note.trackIndex)) continue;

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
    const dest = this.synthBus || this.masterGain;
    if (!this.ctx || !dest) return;

    // Use loaded SoundFont (.sf2) when available!
    if (this.sf2.isLoaded()) {
      const dur = Math.min(10.0, Math.max(0.05, note.durationSec / rate));
      const trackProg = this.trackProgramMap.get(note.trackIndex);
      const isDrum = note.channel === 9 || Boolean(trackProg?.isDrum);
      const program =
        trackProg?.program ?? this.channelProgramMap.get(note.channel) ?? 0;

      this.sf2.triggerNote(
        this.ctx,
        dest,
        note.pitch,
        note.velocity,
        when,
        dur,
        note.channel,
        program,
        isDrum,
        this.sf2SelectedPresetId
      );
      return;
    }

    const velGain = Math.max(0.08, (note.velocity / 127) * 0.24);

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
    env.connect(dest);

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
    const dest = this.synthBus || this.masterGain;
    if (!this.ctx || !dest) return;
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
      env.connect(dest);
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
      env.connect(dest);
      noise.start(when);
      noise.stop(when + decay + 0.01);
      this.activeNodes.add(noise);
      noise.onended = () => this.activeNodes.delete(noise);
    }
  }
}
