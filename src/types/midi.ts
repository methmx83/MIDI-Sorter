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
