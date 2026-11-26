export type TriageStatus = 'pending' | 'keep' | 'discard';

export type MidiIssueSeverity = 'error' | 'warning';

export interface MidiIssue {
  code:
    | 'invalid_header'
    | 'truncated_chunk'
    | 'missing_eot'
    | 'empty_notes'
    | 'very_short'
    | 'sparse_notes'
    | 'dangling_notes'
    | 'large_gap';
  severity: MidiIssueSeverity;
  label: string;
  detail: string;
}

export interface MidiNote {
  pitch: number; // 0-127
  velocity: number; // 1-127
  channel: number; // 0-15
  trackIndex: number;
  startTick: number;
  durationTick: number;
  startSec: number;
  durationSec: number;
}

export interface MidiTempoEvent {
  tick: number;
  microsecondsPerBeat: number;
  bpm: number;
}

export interface MidiTimeSignature {
  tick: number;
  numerator: number;
  denominator: number;
}

export interface MidiTrackSummary {
  index: number;
  name: string;
  noteCount: number;
  channels: number[];
  hasEndOfTrack: boolean;
  wasTruncated: boolean;
}

export interface DetectedKey {
  tonic: number; // 0..11
  mode: 'major' | 'minor';
  label: string;
  relativeLabel: string;
  confidence: number; // 0..100
  scalePitchClasses: Set<number>;
}

export type MidiMetaEventType =
  | 'copyright'
  | 'text'
  | 'marker'
  | 'cue'
  | 'lyric'
  | 'instrument';

export interface MidiMetaTextItem {
  type: MidiMetaEventType;
  text: string;
  tick: number;
  sec: number;
  trackIndex: number;
}

export interface MidiMetadata {
  copyright: string[];
  sequenceName: string | null;
  instruments: string[];
  textEvents: MidiMetaTextItem[];
  markers: MidiMetaTextItem[];
  cues: MidiMetaTextItem[];
  lyrics: MidiMetaTextItem[];
  embeddedKeySignature: string | null;
  totalCount: number;
}

export interface MidiControlChangeEvent {
  tick: number;
  sec: number;
  channel: number; // 0..15
  trackIndex: number;
  controller: number; // 0..127
  value: number; // 0..127
}

export interface MidiPitchBendEvent {
  tick: number;
  sec: number;
  channel: number; // 0..15
  trackIndex: number;
  rawValue: number; // 0..16383 (8192 = center)
  value: number; // -8192..+8191
}

export interface MidiAftertouchEvent {
  kind: 'channel' | 'poly';
  tick: number;
  sec: number;
  channel: number; // 0..15
  trackIndex: number;
  pitch?: number; // 0..127 for polyphonic key pressure
  pressure: number; // 0..127
}

export interface MidiProgramChangeEvent {
  tick: number;
  sec: number;
  channel: number; // 0..15
  trackIndex: number;
  program: number; // 0..127
}

export interface MidiChannelSummary {
  channel: number; // 0..15 (display 1..16)
  noteCount: number;
  programs: number[];
  ccNumbers: number[];
  ccCount: number;
  pitchBendCount: number;
  aftertouchCount: number;
  isDrum: boolean;
}

export interface MidiPerformanceEvents {
  controlChanges: MidiControlChangeEvent[];
  pitchBends: MidiPitchBendEvent[];
  aftertouch: MidiAftertouchEvent[];
  programChanges: MidiProgramChangeEvent[];
  channels: MidiChannelSummary[];
  totalCount: number;
}

export interface ParsedMidi {
  format: number;
  ppqn: number;
  trackCount: number;
  tracks: MidiTrackSummary[];
  notes: MidiNote[];
  tempos: MidiTempoEvent[];
  timeSignatures: MidiTimeSignature[];
  primaryBpm: number;
  primaryTimeSignature: string;
  totalTicks: number;
  totalDurationSec: number;
  barCount: number;
  firstNoteTick: number;
  firstNoteSec: number;
  lastNoteEndTick: number;
  lastNoteEndSec: number;
  leadingBars: number;
  minPitch: number;
  maxPitch: number;
  danglingNotesCount: number;
  longestGapSec: number;
  detectedKey: DetectedKey | null;
  isPercussionOnly: boolean;
  metadata: MidiMetadata;
  performance: MidiPerformanceEvents;
  issues: MidiIssue[];
  hasErrors: boolean;
  hasWarnings: boolean;
}

export interface MidiFileEntry {
  id: string;
  name: string;
  relativePath: string;
  folderPath: string;
  sizeBytes: number;
  lastModified: number;
  sha256?: string;
  originalSha256?: string;
  file?: File;
  fileHandle?: FileSystemFileHandle;
  parentDirHandle?: FileSystemDirectoryHandle;
  parsed: ParsedMidi | null;
  parseError?: string;
  triage: TriageStatus;
  removedFromDisk?: boolean;
  originalBuffer?: ArrayBuffer;
  trimmedBuffer?: ArrayBuffer;
  isTrimmed?: boolean;
}
