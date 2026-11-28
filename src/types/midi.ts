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
  sec: number;
  microsecondsPerBeat: number;
  bpm: number;
}

export interface MidiTimeSignature {
  tick: number;
  sec: number;
  bar: number;
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

export type KeyStatus = 'detected' | 'unknown' | 'percussion' | 'empty';

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
  smpteTicksPerSecond: number;
  trackCount: number;
  tracks: MidiTrackSummary[];
  notes: MidiNote[];
  tempos: MidiTempoEvent[];
  timeSignatures: MidiTimeSignature[];
  hasExplicitTempo: boolean;
  hasExplicitTimeSignature: boolean;
  hasTempoChanges: boolean;
  hasTimeSignatureChanges: boolean;
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
  keyStatus: KeyStatus;
  keyUnknownReason?: string;
  isPercussionOnly: boolean;
  isCompleteComposition: boolean;
  completeCompositionReason?: string;
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
  sidecarFile?: File;
  sidecarHandle?: FileSystemFileHandle;
  sidecarRelativePath?: string;
  parsed: ParsedMidi | null;
  parseError?: string;
  triage: TriageStatus;
  removedFromDisk?: boolean;
  originalBuffer?: ArrayBuffer;
  trimmedBuffer?: ArrayBuffer;
  isTrimmed?: boolean;
  datasetMeta?: MidiDatasetMetadata;
}

export type MidiOrigin = 'eigenkomposition' | 'library' | 'unbekannt';

export type MidiFileType =
  | 'full_track'
  | 'pattern'
  | 'phrase'
  | 'loop'
  | 'einzelspur'
  | 'unbekannt';

export type BuiltinInstrumentFamily =
  | 'strings'
  | 'brass'
  | 'woodwinds'
  | 'keys'
  | 'synth'
  | 'guitar_plucked'
  | 'bass'
  | 'drums_percussion'
  | 'choir_vocal'
  | 'orchestra_ensemble'
  | 'fx_other'
  | 'unbekannt';

export type InstrumentFamily = BuiltinInstrumentFamily | (string & {});

export type BuiltinMusicalRole =
  | 'melodie'
  | 'gegenmelodie'
  | 'harmonie'
  | 'bass'
  | 'percussion'
  | 'ostinato_arp'
  | 'arrangement'
  | 'fx'
  | 'unbekannt';

export type MusicalRole = BuiltinMusicalRole | (string & {});

export type MetadataReviewStatus = 'offen' | 'in_arbeit' | 'geprueft';

export type FieldProvenance = 'auto' | 'manual';

export type TrackableMetaField =
  | 'origin'
  | 'fileType'
  | 'genre'
  | 'subgenres'
  | 'instrument'
  | 'instrumentFamily'
  | 'articulation'
  | 'musicalRole'
  | 'rating'
  | 'triage'
  | 'workStatus'
  | 'moods';

export interface MidiSourceLink {
  midiFile: string;
  metadataFile: string;
  sha256: string | null;
  originalFile?: string | null;
  originalSha256?: string | null;
  parentCompositionId?: string | null;
  sourceTrackIndex?: number | null;
  sourceTrackName?: string | null;
  startTickOffset?: number | null;
  segmentBars?: { fromBar: number; toBar: number } | null;
}

export interface MidiDatasetSection {
  name: string;
  vonTakt: number;
  bisTakt: number;
}

export interface TrackMetadataEntry {
  trackIndex: number;
  trackName: string;
  noteCount: number;
  instrument: string;
  instrumentFamily: InstrumentFamily;
  articulation: string;
  musicalRole: MusicalRole;
  confirmed: boolean;
}

export interface MidiDatasetMetadata {
  compositionId: string;
  title: string;
  origin: MidiOrigin;
  fileType: MidiFileType;
  isMultiTrackMeta?: boolean;
  workStatus: string;
  reviewStatus: MetadataReviewStatus;
  genre: string;
  subgenres: string[];
  instrument: string;
  instrumentFamily: InstrumentFamily;
  articulation: string;
  musicalRole: MusicalRole;
  trackMetadata?: TrackMetadataEntry[];
  rating: number | null; // 1..10 or null
  moods: string[];
  whyILike: string[];
  specialFeatures: string[];
  importantTracks: {
    hauptmelodie: string[];
    gegenmelodie: string[];
    harmonie: string[];
    bass: string[];
    rhythmischesFundament: string[];
  };
  sections: MidiDatasetSection[];
  libraryAbbreviations: Array<{ key: string; meaning: string }>;
  keyOverride?: {
    grundton: string;
    modus: string;
    sicherheit: string;
  } | null;
  fieldProvenance: Record<TrackableMetaField, FieldProvenance>;
  sourceLink: MidiSourceLink;
  sidecarLoaded: boolean;
  sidecarDirty: boolean;
  lastSavedAt?: string;
}
