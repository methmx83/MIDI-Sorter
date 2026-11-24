import type {
  MidiIssue,
  MidiMetadata,
  MidiMetaEventType,
  MidiMetaTextItem,
  MidiNote,
  MidiTempoEvent,
  MidiTimeSignature,
  MidiTrackSummary,
  ParsedMidi,
} from '../types/midi';
import { detectKeyFromNotes } from './musicTheory';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function midiPitchToName(pitch: number): string {
  const clamped = Math.max(0, Math.min(127, Math.round(pitch)));
  const octave = Math.floor(clamped / 12) - 1;
  return `${NOTE_NAMES[clamped % 12]}${octave}`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const totalSec = Math.round(seconds);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

class ByteReader {
  private pos = 0;
  private view: DataView;

  constructor(private bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get offset(): number {
    return this.pos;
  }

  set offset(val: number) {
    this.pos = Math.max(0, Math.min(this.bytes.length, val));
  }

  get remaining(): number {
    return this.bytes.length - this.pos;
  }

  readAscii(length: number): string {
    const end = Math.min(this.bytes.length, this.pos + length);
    let out = '';
    for (let i = this.pos; i < end; i++) {
      out += String.fromCharCode(this.bytes[i]);
    }
    this.pos = end;
    return out;
  }

  readUint8(): number {
    if (this.pos >= this.bytes.length) return 0;
    return this.bytes[this.pos++];
  }

  peekUint8(): number {
    if (this.pos >= this.bytes.length) return 0;
    return this.bytes[this.pos];
  }

  readUint16(): number {
    if (this.pos + 2 > this.bytes.length) {
      this.pos = this.bytes.length;
      return 0;
    }
    const val = this.view.getUint16(this.pos, false);
    this.pos += 2;
    return val;
  }

  readUint32(): number {
    if (this.pos + 4 > this.bytes.length) {
      this.pos = this.bytes.length;
      return 0;
    }
    const val = this.view.getUint32(this.pos, false);
    this.pos += 4;
    return val;
  }

  readVLQ(): { value: number; truncated: boolean } {
    let value = 0;
    let count = 0;
    while (this.pos < this.bytes.length && count < 4) {
      const byte = this.bytes[this.pos++];
      value = (value << 7) | (byte & 0x7f);
      count++;
      if ((byte & 0x80) === 0) {
        return { value, truncated: false };
      }
    }
    return { value, truncated: this.pos >= this.bytes.length };
  }

  readBytes(length: number): Uint8Array {
    const end = Math.min(this.bytes.length, this.pos + length);
    const slice = this.bytes.subarray(this.pos, end);
    this.pos = end;
    return slice;
  }

  skip(length: number): void {
    this.pos = Math.min(this.bytes.length, this.pos + Math.max(0, length));
  }
}

interface RawNoteOn {
  tick: number;
  velocity: number;
  trackIndex: number;
}

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true })
      .decode(bytes)
      .replace(/\0/g, '')
      .trim();
  } catch {
    try {
      return new TextDecoder('windows-1252', { fatal: false })
        .decode(bytes)
        .replace(/\0/g, '')
        .trim();
    } catch {
      return '';
    }
  }
}

const KEY_SIG_MAJOR = [
  'Cb-Dur',
  'Gb-Dur',
  'Db-Dur',
  'Ab-Dur',
  'Eb-Dur',
  'Bb-Dur',
  'F-Dur',
  'C-Dur',
  'G-Dur',
  'D-Dur',
  'A-Dur',
  'E-Dur',
  'H-Dur',
  'F#-Dur',
  'C#-Dur',
];

const KEY_SIG_MINOR = [
  'ab-Moll',
  'eb-Moll',
  'b-Moll',
  'f-Moll',
  'c-Moll',
  'g-Moll',
  'd-Moll',
  'a-Moll',
  'e-Moll',
  'h-Moll',
  'f#-Moll',
  'c#-Moll',
  'g#-Moll',
  'd#-Moll',
  'a#-Moll',
];

function decodeKeySignatureMeta(sfByte: number, miByte: number): string | null {
  const sf = sfByte > 127 ? sfByte - 256 : sfByte;
  if (sf < -7 || sf > 7) return null;
  const idx = sf + 7;
  return miByte === 1 ? KEY_SIG_MINOR[idx] : KEY_SIG_MAJOR[idx];
}

function createEmptyMetadata(): MidiMetadata {
  return {
    copyright: [],
    sequenceName: null,
    instruments: [],
    textEvents: [],
    markers: [],
    cues: [],
    lyrics: [],
    embeddedKeySignature: null,
    totalCount: 0,
  };
}

export function parseMidiBuffer(buffer: ArrayBuffer): ParsedMidi {
  const bytes = new Uint8Array(buffer);
  const reader = new ByteReader(bytes);
  const issues: MidiIssue[] = [];

  // Allow optional RIFF/RMID wrapper if encountered
  if (bytes.length >= 12 && reader.readAscii(4) === 'RIFF') {
    reader.offset = 0;
    let foundMThd = -1;
    for (let i = 0; i < Math.min(bytes.length - 4, 256); i++) {
      if (
        bytes[i] === 0x4d &&
        bytes[i + 1] === 0x54 &&
        bytes[i + 2] === 0x68 &&
        bytes[i + 3] === 0x64
      ) {
        foundMThd = i;
        break;
      }
    }
    if (foundMThd >= 0) {
      reader.offset = foundMThd;
    }
  } else {
    reader.offset = 0;
  }

  if (reader.remaining < 14) {
    return buildInvalidMidi('Datei zu klein für einen gültigen MIDI-Header (< 14 Bytes).');
  }

  const headerTag = reader.readAscii(4);
  if (headerTag !== 'MThd') {
    return buildInvalidMidi(`Ungültiger MIDI-Header („${headerTag || 'leer'}“ statt „MThd“).`);
  }

  const headerLength = reader.readUint32();
  const format = reader.readUint16();
  const declaredTracks = reader.readUint16();
  const divisionRaw = reader.readUint16();

  if (headerLength > 6) {
    reader.skip(headerLength - 6);
  }

  let ppqn = 480;
  let smpteTicksPerSecond = 0;
  if ((divisionRaw & 0x8000) === 0) {
    ppqn = divisionRaw > 0 ? divisionRaw : 480;
  } else {
    const fpsRaw = (divisionRaw >> 8) & 0x7f;
    const fps = fpsRaw === 29 ? 29.97 : 256 - ((divisionRaw >> 8) & 0xff) || 24;
    const subFrames = divisionRaw & 0xff || 40;
    smpteTicksPerSecond = fps * subFrames;
    ppqn = 480;
  }

  const rawNotes: Array<{
    pitch: number;
    velocity: number;
    channel: number;
    trackIndex: number;
    startTick: number;
    durationTick: number;
  }> = [];

  const tempos: MidiTempoEvent[] = [];
  const timeSignatures: MidiTimeSignature[] = [];
  const tracks: MidiTrackSummary[] = [];
  const rawMetaTexts: Array<{
    type: MidiMetaEventType;
    text: string;
    tick: number;
    trackIndex: number;
  }> = [];
  let sequenceName: string | null = null;
  let embeddedKeySignature: string | null = null;

  let maxTick = 0;
  let danglingNotesCount = 0;
  let truncatedTracksCount = 0;
  let missingEotCount = 0;

  let trackIndex = 0;
  while (reader.remaining >= 4 && trackIndex < Math.max(declaredTracks, 1) + 64) {
    const chunkTag = reader.readAscii(4);
    if (chunkTag !== 'MTrk') {
      if (reader.remaining < 4) break;
      const skipLen = reader.readUint32();
      reader.skip(skipLen);
      continue;
    }

    if (reader.remaining < 4) {
      truncatedTracksCount++;
      break;
    }

    const trackLength = reader.readUint32();
    const trackStart = reader.offset;
    const expectedEnd = trackStart + trackLength;
    const wasLengthTruncated = expectedEnd > bytes.length;
    const safeEnd = Math.min(bytes.length, expectedEnd);

    let tick = 0;
    let runningStatus = 0;
    let trackName = '';
    let trackNoteCount = 0;
    let hasEndOfTrack = false;
    let trackTruncated = wasLengthTruncated;
    const trackChannels = new Set<number>();

    // Active notes per (channel * 128 + pitch)
    const activeNotes = new Map<number, RawNoteOn[]>();

    while (reader.offset < safeEnd) {
      const vlq = reader.readVLQ();
      tick += vlq.value;
      if (vlq.truncated || reader.offset >= safeEnd) {
        trackTruncated = true;
        break;
      }

      let status = reader.peekUint8();
      if (status >= 0x80) {
        reader.readUint8();
        if (status < 0xf0) {
          runningStatus = status;
        } else if (status === 0xf0 || status === 0xf7) {
          runningStatus = 0;
        }
      } else {
        if (runningStatus === 0) {
          // Malformed byte without running status — advance cautiously
          reader.readUint8();
          continue;
        }
        status = runningStatus;
      }

      if (status === 0xff) {
        // Meta event
        if (reader.offset >= safeEnd) {
          trackTruncated = true;
          break;
        }
        const metaType = reader.readUint8();
        const lenRes = reader.readVLQ();
        const metaLen = lenRes.value;
        if (reader.offset + metaLen > safeEnd) {
          trackTruncated = true;
        }
        const metaData = reader.readBytes(Math.min(metaLen, Math.max(0, safeEnd - reader.offset)));

        if (metaType === 0x2f) {
          hasEndOfTrack = true;
          if (tick > maxTick) maxTick = tick;
          break;
        } else if (metaType === 0x01) {
          const text = decodeText(metaData);
          if (text) rawMetaTexts.push({ type: 'text', text, tick, trackIndex });
        } else if (metaType === 0x02) {
          const text = decodeText(metaData);
          if (text) rawMetaTexts.push({ type: 'copyright', text, tick, trackIndex });
        } else if (metaType === 0x03) {
          const text = decodeText(metaData);
          if (text) {
            if (!trackName) trackName = text;
            if (trackIndex === 0 && !sequenceName) sequenceName = text;
          }
        } else if (metaType === 0x04) {
          const text = decodeText(metaData);
          if (text) rawMetaTexts.push({ type: 'instrument', text, tick, trackIndex });
        } else if (metaType === 0x05) {
          const text = decodeText(metaData);
          if (text) rawMetaTexts.push({ type: 'lyric', text, tick, trackIndex });
        } else if (metaType === 0x06) {
          const text = decodeText(metaData);
          if (text) rawMetaTexts.push({ type: 'marker', text, tick, trackIndex });
        } else if (metaType === 0x07) {
          const text = decodeText(metaData);
          if (text) rawMetaTexts.push({ type: 'cue', text, tick, trackIndex });
        } else if (metaType === 0x51 && metaData.length >= 3) {
          const usPerBeat = (metaData[0] << 16) | (metaData[1] << 8) | metaData[2];
          if (usPerBeat > 0) {
            tempos.push({
              tick,
              microsecondsPerBeat: usPerBeat,
              bpm: Math.round((60_000_000 / usPerBeat) * 10) / 10,
            });
          }
        } else if (metaType === 0x58 && metaData.length >= 2) {
          const numerator = metaData[0] || 4;
          const denominator = Math.pow(2, metaData[1] || 2);
          timeSignatures.push({ tick, numerator, denominator });
        } else if (metaType === 0x59 && metaData.length >= 2 && !embeddedKeySignature) {
          embeddedKeySignature = decodeKeySignatureMeta(metaData[0], metaData[1]);
        }
      } else if (status === 0xf0 || status === 0xf7) {
        const lenRes = reader.readVLQ();
        reader.skip(Math.min(lenRes.value, Math.max(0, safeEnd - reader.offset)));
      } else {
        const type = status & 0xf0;
        const channel = status & 0x0f;

        if (type === 0xc0 || type === 0xd0) {
          // 1 data byte
          if (reader.offset >= safeEnd) {
            trackTruncated = true;
            break;
          }
          reader.readUint8();
        } else if (
          type === 0x80 ||
          type === 0x90 ||
          type === 0xa0 ||
          type === 0xb0 ||
          type === 0xe0
        ) {
          if (reader.offset + 2 > safeEnd) {
            trackTruncated = true;
            break;
          }
          const d1 = reader.readUint8();
          const d2 = reader.readUint8();

          if (type === 0x90 && d2 > 0) {
            trackChannels.add(channel);
            const key = channel * 128 + (d1 & 0x7f);
            const list = activeNotes.get(key) || [];
            list.push({ tick, velocity: d2 & 0x7f, trackIndex });
            activeNotes.set(key, list);
            trackNoteCount++;
          } else if (type === 0x80 || (type === 0x90 && d2 === 0)) {
            const pitch = d1 & 0x7f;
            const key = channel * 128 + pitch;
            const list = activeNotes.get(key);
            if (list && list.length > 0) {
              const start = list.shift()!;
              const durationTick = Math.max(1, tick - start.tick);
              rawNotes.push({
                pitch,
                velocity: start.velocity,
                channel,
                trackIndex: start.trackIndex,
                startTick: start.tick,
                durationTick,
              });
            }
          }
        }
      }

      if (tick > maxTick) maxTick = tick;
    }

    // Close any dangling notes that never received Note-Off
    for (const [key, list] of activeNotes.entries()) {
      const channel = Math.floor(key / 128);
      const pitch = key % 128;
      for (const start of list) {
        danglingNotesCount++;
        const fallbackEnd = Math.max(maxTick, start.tick + Math.round(ppqn / 2));
        rawNotes.push({
          pitch,
          velocity: start.velocity,
          channel,
          trackIndex: start.trackIndex,
          startTick: start.tick,
          durationTick: Math.max(1, fallbackEnd - start.tick),
        });
      }
    }

    if (trackTruncated) truncatedTracksCount++;
    if (!hasEndOfTrack && (trackNoteCount > 0 || trackLength > 0)) {
      missingEotCount++;
    }

    tracks.push({
      index: trackIndex,
      name: trackName || `Spur ${trackIndex + 1}`,
      noteCount: trackNoteCount,
      channels: Array.from(trackChannels).sort((a, b) => a - b),
      hasEndOfTrack,
      wasTruncated: trackTruncated,
    });

    reader.offset = safeEnd;
    trackIndex++;
  }

  if (tracks.length < declaredTracks) {
    truncatedTracksCount++;
  }

  // Sort tempos & time signatures
  tempos.sort((a, b) => a.tick - b.tick);
  if (tempos.length === 0 || tempos[0].tick > 0) {
    tempos.unshift({ tick: 0, microsecondsPerBeat: 500_000, bpm: 120 });
  }

  timeSignatures.sort((a, b) => a.tick - b.tick);
  if (timeSignatures.length === 0) {
    timeSignatures.push({ tick: 0, numerator: 4, denominator: 4 });
  }

  // Build tempo segment table for accurate tick -> seconds conversion
  const tempoSegments: Array<{ tick: number; sec: number; usPerBeat: number }> = [];
  if (smpteTicksPerSecond > 0) {
    tempoSegments.push({ tick: 0, sec: 0, usPerBeat: 500_000 });
  } else {
    let accSec = 0;
    let prevTick = 0;
    let prevUs = tempos[0].microsecondsPerBeat;
    tempoSegments.push({ tick: 0, sec: 0, usPerBeat: prevUs });

    for (let i = 1; i < tempos.length; i++) {
      const t = tempos[i];
      if (t.tick > prevTick) {
        accSec += ((t.tick - prevTick) / ppqn) * (prevUs / 1_000_000);
        prevTick = t.tick;
      }
      prevUs = t.microsecondsPerBeat;
      tempoSegments.push({ tick: t.tick, sec: accSec, usPerBeat: prevUs });
    }
  }

  const tickToSeconds = (targetTick: number): number => {
    if (smpteTicksPerSecond > 0) {
      return targetTick / smpteTicksPerSecond;
    }
    let seg = tempoSegments[0];
    for (let i = 1; i < tempoSegments.length; i++) {
      if (tempoSegments[i].tick <= targetTick) {
        seg = tempoSegments[i];
      } else {
        break;
      }
    }
    return seg.sec + ((targetTick - seg.tick) / ppqn) * (seg.usPerBeat / 1_000_000);
  };

  const notes: MidiNote[] = rawNotes
    .map((n) => {
      const startSec = tickToSeconds(n.startTick);
      const endSec = tickToSeconds(n.startTick + n.durationTick);
      return {
        ...n,
        startSec,
        durationSec: Math.max(0.02, endSec - startSec),
      };
    })
    .sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);

  let minPitch = 127;
  let maxPitch = 0;
  let maxNoteEndTick = 0;
  for (const n of notes) {
    if (n.pitch < minPitch) minPitch = n.pitch;
    if (n.pitch > maxPitch) maxPitch = n.pitch;
    const endTick = n.startTick + n.durationTick;
    if (endTick > maxNoteEndTick) maxNoteEndTick = endTick;
  }
  if (notes.length === 0) {
    minPitch = 48;
    maxPitch = 72;
  }

  const effectiveTotalTicks = Math.max(maxTick, maxNoteEndTick, ppqn * 4);
  const totalDurationSec = tickToSeconds(effectiveTotalTicks);

  const primaryTs = timeSignatures[0];
  const ticksPerBar = ppqn * primaryTs.numerator * (4 / primaryTs.denominator);
  const barCount = Math.max(1, Math.ceil(effectiveTotalTicks / Math.max(1, ticksPerBar)));

  const firstNoteTick = notes.length > 0 ? notes[0].startTick : 0;
  const firstNoteSec = notes.length > 0 ? notes[0].startSec : 0;
  const lastNoteEndTick = notes.length > 0 ? maxNoteEndTick : 0;
  const lastNoteEndSec = notes.length > 0 ? tickToSeconds(maxNoteEndTick) : 0;
  const leadingBars = Math.floor(firstNoteTick / Math.max(1, ticksPerBar));

  // Longest silent gap analysis (between active notes)
  let longestGapSec = 0;
  if (notes.length > 1) {
    let activeEndSec = notes[0].startSec + notes[0].durationSec;
    for (let i = 1; i < notes.length; i++) {
      const n = notes[i];
      if (n.startSec > activeEndSec) {
        const gap = n.startSec - activeEndSec;
        if (gap > longestGapSec) longestGapSec = gap;
      }
      const endSec = n.startSec + n.durationSec;
      if (endSec > activeEndSec) activeEndSec = endSec;
    }
  }

  // Diagnostic checks for completeness
  if (truncatedTracksCount > 0) {
    issues.push({
      code: 'truncated_chunk',
      severity: 'error',
      label: 'Datei abgeschnitten',
      detail: `${truncatedTracksCount} Spur(en) enden vorzeitig vor der erwarteten Byte-Länge.`,
    });
  }
  if (missingEotCount > 0) {
    issues.push({
      code: 'missing_eot',
      severity: 'error',
      label: 'Kein End-of-Track',
      detail: `${missingEotCount} Spur(en) besitzen keinen sauberen MIDI-Endmarker.`,
    });
  }
  if (notes.length === 0) {
    issues.push({
      code: 'empty_notes',
      severity: 'error',
      label: 'Keine Noten',
      detail: 'Die MIDI-Datei enthält keine Note-On-Ereignisse.',
    });
  } else {
    if (danglingNotesCount > 0) {
      issues.push({
        code: 'dangling_notes',
        severity: 'warning',
        label: `${danglingNotesCount} offene Note(n)`,
        detail: 'Noten ohne Note-Off gefunden (häufig bei abgebrochener Aufnahme).',
      });
    }
    if (notes.length < 8) {
      issues.push({
        code: 'sparse_notes',
        severity: 'warning',
        label: 'Sehr wenig Inhalt',
        detail: `Nur ${notes.length} Note(n) in der gesamten Datei.`,
      });
    } else if (totalDurationSec < 2.0) {
      issues.push({
        code: 'very_short',
        severity: 'warning',
        label: 'Extrem kurz',
        detail: `Gesamtdauer liegt unter 2 Sekunden (${totalDurationSec.toFixed(1)} s).`,
      });
    }
    if (longestGapSec > 8.0 && totalDurationSec > 12.0) {
      issues.push({
        code: 'large_gap',
        severity: 'warning',
        label: `${longestGapSec.toFixed(0)}s Lücke`,
        detail: `Lange Pause ohne Noten (${longestGapSec.toFixed(1)} s) innerhalb der Sequenz.`,
      });
    }
  }

  const keyAnalysis = detectKeyFromNotes(notes);

  const copyrightSet = new Set<string>();
  const instrumentSet = new Set<string>();
  const textEvents: MidiMetaTextItem[] = [];
  const markers: MidiMetaTextItem[] = [];
  const cues: MidiMetaTextItem[] = [];
  const lyrics: MidiMetaTextItem[] = [];

  const sortedMetaTexts = [...rawMetaTexts].sort((a, b) => a.tick - b.tick);
  for (const ev of sortedMetaTexts) {
    const item: MidiMetaTextItem = {
      type: ev.type,
      text: ev.text,
      tick: ev.tick,
      sec: tickToSeconds(ev.tick),
      trackIndex: ev.trackIndex,
    };
    if (ev.type === 'copyright') {
      copyrightSet.add(ev.text);
    } else if (ev.type === 'instrument') {
      instrumentSet.add(ev.text);
    } else if (ev.type === 'marker') {
      markers.push(item);
    } else if (ev.type === 'cue') {
      cues.push(item);
    } else if (ev.type === 'lyric') {
      lyrics.push(item);
    } else {
      textEvents.push(item);
    }
  }

  const copyright = Array.from(copyrightSet);
  const instruments = Array.from(instrumentSet);
  const totalMetaCount =
    copyright.length +
    instruments.length +
    textEvents.length +
    markers.length +
    cues.length +
    lyrics.length +
    (embeddedKeySignature ? 1 : 0);

  const metadata: MidiMetadata = {
    copyright,
    sequenceName,
    instruments,
    textEvents,
    markers,
    cues,
    lyrics,
    embeddedKeySignature,
    totalCount: totalMetaCount,
  };

  return {
    format,
    ppqn,
    trackCount: tracks.length,
    tracks,
    notes,
    tempos,
    timeSignatures,
    primaryBpm: tempos[0].bpm,
    primaryTimeSignature: `${primaryTs.numerator}/${primaryTs.denominator}`,
    totalTicks: effectiveTotalTicks,
    totalDurationSec,
    barCount,
    firstNoteTick,
    firstNoteSec,
    lastNoteEndTick,
    lastNoteEndSec,
    leadingBars,
    minPitch,
    maxPitch,
    danglingNotesCount,
    longestGapSec,
    detectedKey: keyAnalysis.primary,
    isPercussionOnly: keyAnalysis.isPercussionOnly,
    metadata,
    issues,
    hasErrors: issues.some((i) => i.severity === 'error'),
    hasWarnings: issues.some((i) => i.severity === 'warning'),
  };
}

function buildInvalidMidi(detail: string): ParsedMidi {
  return {
    format: 0,
    ppqn: 480,
    trackCount: 0,
    tracks: [],
    notes: [],
    tempos: [{ tick: 0, microsecondsPerBeat: 500_000, bpm: 120 }],
    timeSignatures: [{ tick: 0, numerator: 4, denominator: 4 }],
    primaryBpm: 120,
    primaryTimeSignature: '4/4',
    totalTicks: 1920,
    totalDurationSec: 2,
    barCount: 1,
    firstNoteTick: 0,
    firstNoteSec: 0,
    lastNoteEndTick: 0,
    lastNoteEndSec: 0,
    leadingBars: 0,
    minPitch: 48,
    maxPitch: 72,
    danglingNotesCount: 0,
    longestGapSec: 0,
    detectedKey: null,
    isPercussionOnly: false,
    metadata: createEmptyMetadata(),
    issues: [
      {
        code: 'invalid_header',
        severity: 'error',
        label: 'Ungültige Datei',
        detail,
      },
    ],
    hasErrors: true,
    hasWarnings: false,
  };
}

// ---------- Demo MIDI Binary Encoder (real SMF binary files for optional testing) ----------

function writeVLQ(value: number): number[] {
  const bytes: number[] = [];
  let v = Math.max(0, Math.floor(value));
  bytes.unshift(v & 0x7f);
  v >>= 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return bytes;
}

interface RawEventSpec {
  tick: number;
  bytes: number[];
}

function encodeSmfTrack(
  events: RawEventSpec[],
  options?: { omitEndOfTrack?: boolean; truncateBytes?: number }
): Uint8Array {
  const sorted = [...events].sort((a, b) => a.tick - b.tick);
  const body: number[] = [];
  let lastTick = 0;

  for (const ev of sorted) {
    const delta = Math.max(0, ev.tick - lastTick);
    lastTick = ev.tick;
    body.push(...writeVLQ(delta), ...ev.bytes);
  }

  if (!options?.omitEndOfTrack) {
    body.push(...writeVLQ(0), 0xff, 0x2f, 0x00);
  }

  const declaredLen = body.length;
  const actualBody =
    options?.truncateBytes && options.truncateBytes < body.length
      ? body.slice(0, options.truncateBytes)
      : body;

  const out = new Uint8Array(8 + actualBody.length);
  out.set([0x4d, 0x54, 0x72, 0x6b], 0); // MTrk
  out[4] = (declaredLen >>> 24) & 0xff;
  out[5] = (declaredLen >>> 16) & 0xff;
  out[6] = (declaredLen >>> 8) & 0xff;
  out[7] = declaredLen & 0xff;
  out.set(actualBody, 8);
  return out;
}

function encodeSmfFile(ppqn: number, tracks: Uint8Array[]): Uint8Array {
  const header = new Uint8Array(14);
  header.set([0x4d, 0x54, 0x68, 0x64], 0); // MThd
  header.set([0x00, 0x00, 0x00, 0x06], 4); // length = 6
  header[8] = 0x00;
  header[9] = tracks.length > 1 ? 0x01 : 0x00;
  header[10] = (tracks.length >>> 8) & 0xff;
  header[11] = tracks.length & 0xff;
  header[12] = (ppqn >>> 8) & 0xff;
  header[13] = ppqn & 0xff;

  const totalSize = header.length + tracks.reduce((acc, t) => acc + t.length, 0);
  const result = new Uint8Array(totalSize);
  result.set(header, 0);
  let pos = header.length;
  for (const t of tracks) {
    result.set(t, pos);
    pos += t.length;
  }
  return result;
}

function noteEvents(
  pitch: number,
  startTick: number,
  durTick: number,
  vel = 96,
  ch = 0,
  skipOff = false
): RawEventSpec[] {
  const evs: RawEventSpec[] = [{ tick: startTick, bytes: [0x90 | ch, pitch & 0x7f, vel & 0x7f] }];
  if (!skipOff) {
    evs.push({ tick: startTick + durTick, bytes: [0x80 | ch, pitch & 0x7f, 0] });
  }
  return evs;
}

export function createDemoMidiFiles(): File[] {
  const ppqn = 480;
  const beat = ppqn;
  const bar = beat * 4;

  const makeFile = (name: string, data: Uint8Array): File => {
    const ab = new ArrayBuffer(data.byteLength);
    new Uint8Array(ab).set(data);
    return new File([ab], name, { type: 'audio/midi', lastModified: Date.now() });
  };

  const metaEvent = (tick: number, metaType: number, text: string): RawEventSpec => {
    const encoded = Array.from(new TextEncoder().encode(text));
    return { tick, bytes: [0xff, metaType, ...writeVLQ(encoded.length), ...encoded] };
  };

  // 1. ARK-Hi_Spic_Uni.mid (complete 16-bar rhythmic spiccato pattern)
  const spicEvents: RawEventSpec[] = [
    { tick: 0, bytes: [0xff, 0x51, 0x03, 0x07, 0xa1, 0x20] }, // 120 BPM
    { tick: 0, bytes: [0xff, 0x59, 0x02, 0xfd, 0x01] }, // c-Moll key signature
    metaEvent(0, 0x02, '© 2026 Studio Demo Archive'),
    metaEvent(0, 0x04, 'Strings Spiccato Ensemble'),
    metaEvent(0, 0x01, '16-Takt Streicher-Ostinato, quantisiert auf 1/16'),
    metaEvent(0, 0x06, 'Intro'),
    metaEvent(bar * 8, 0x06, 'Oktav-Steigerung'),
  ];
  const scale = [60, 62, 63, 67, 68, 72, 74, 75];
  for (let b = 0; b < 16; b++) {
    if (b === 7 || b === 15) continue; // brief phrase breath
    for (let s = 0; s < 16; s++) {
      if (s % 2 === 0 || (b % 4 === 3 && s > 10)) {
        const pitch = scale[(b * 3 + s) % scale.length] + (b >= 8 ? 12 : 0);
        spicEvents.push(...noteEvents(pitch, b * bar + s * (beat / 4), beat / 5, 92 + (s % 4) * 6));
      }
    }
    // low pedal octave
    spicEvents.push(...noteEvents(36 + (b % 4 === 2 ? 5 : 0), b * bar, beat * 3.5, 85));
  }

  // 2. Ascend_Piano.mid (complete lyrical piano arpeggio + melody)
  const pianoEvents: RawEventSpec[] = [
    { tick: 0, bytes: [0xff, 0x51, 0x03, 0x09, 0x27, 0xc0] }, // 100 BPM
    { tick: 0, bytes: [0xff, 0x59, 0x02, 0x00, 0x00] }, // C-Dur key signature
    metaEvent(0, 0x02, '© SoundLab Piano Sketches'),
    metaEvent(0, 0x04, 'Concert Grand Piano'),
    metaEvent(0, 0x06, 'Thema A'),
    metaEvent(bar * 4, 0x06, 'Variation'),
    metaEvent(bar * 8, 0x06, 'Finale'),
  ];
  const chords = [
    [48, 55, 60, 64, 67],
    [45, 52, 57, 60, 64],
    [41, 48, 53, 57, 60],
    [43, 50, 55, 59, 62],
  ];
  for (let b = 0; b < 12; b++) {
    const ch = chords[b % chords.length];
    for (let i = 0; i < 8; i++) {
      const note = ch[i % ch.length] + (i >= 5 ? 12 : 0);
      pianoEvents.push(...noteEvents(note, b * bar + i * (beat / 2), beat * 0.45, 78 + (i % 3) * 8));
    }
    pianoEvents.push(...noteEvents(ch[0] - 12, b * bar, bar - 40, 84));
  }

  // 3. basic_pitch_transcription_abgebrochen.mid (incomplete — cuts off after bar 2 + dangling notes + truncated chunk)
  const brokenEvents: RawEventSpec[] = [{ tick: 0, bytes: [0xff, 0x51, 0x03, 0x07, 0xa1, 0x20] }];
  for (let i = 0; i < 6; i++) {
    brokenEvents.push(...noteEvents(55 + (i % 4) * 3, i * (beat / 2), beat / 3, 88, 0, i === 5));
  }

  // 4. Bass_Buzz_nur_fragment.mid (only 3 stray notes at the beginning, 12 bars empty afterwards)
  const fragmentEvents: RawEventSpec[] = [
    { tick: 0, bytes: [0xff, 0x51, 0x03, 0x06, 0x8f, 0xb0] },
    ...noteEvents(36, 0, beat, 100),
    ...noteEvents(38, beat, beat / 2, 90),
    ...noteEvents(36, beat * 2, beat / 2, 80),
    { tick: bar * 10, bytes: [0xb0, 0x40, 0x00] },
  ];

  // 5. BL_Horn_Sus_leer.mid (completely empty MIDI export, 0 notes!)
  const emptyEvents: RawEventSpec[] = [
    { tick: 0, bytes: [0xff, 0x51, 0x03, 0x08, 0x58, 0x3b] },
    { tick: bar * 4, bytes: [0xb0, 0x07, 0x64] },
  ];

  // 6. Battery_Groove_Complete.mid (multi-track drums + bass)
  const bassTrack: RawEventSpec[] = [
    { tick: 0, bytes: [0xff, 0x51, 0x03, 0x07, 0x0a, 0x2c] },
    metaEvent(0, 0x03, 'Sub Bass'),
    metaEvent(0, 0x04, 'Analog Mono Bass'),
  ];
  const drumTrack: RawEventSpec[] = [
    metaEvent(0, 0x03, 'Drum Kit'),
    metaEvent(0, 0x01, 'Tight 8-Bar Groove'),
  ];
  for (let b = 0; b < 8; b++) {
    for (let s = 0; s < 8; s++) {
      const t = b * bar + s * (beat / 2);
      if (s % 2 === 0) drumTrack.push(...noteEvents(36, t, beat / 4, 110, 9)); // Kick
      if (s === 2 || s === 6) drumTrack.push(...noteEvents(38, t, beat / 4, 104, 9)); // Snare
      drumTrack.push(...noteEvents(42, t, beat / 6, 75, 9)); // Hat
      if (s % 2 === 0) bassTrack.push(...noteEvents(33 + ((b % 2) * 5) + (s === 6 ? 2 : 0), t, beat * 0.42, 95, 0));
    }
  }

  // 7. arp_mit_luecke.mid (huge silent gap in the middle)
  const gapEvents: RawEventSpec[] = [{ tick: 0, bytes: [0xff, 0x51, 0x03, 0x07, 0xa1, 0x20] }];
  for (let b = 0; b < 3; b++) {
    for (let s = 0; s < 8; s++) {
      gapEvents.push(...noteEvents(60 + ((s * 3) % 12), b * bar + s * (beat / 2), beat / 3, 86));
    }
  }
  for (let b = 9; b < 11; b++) {
    for (let s = 0; s < 8; s++) {
      gapEvents.push(...noteEvents(64 + ((s * 4) % 12), b * bar + s * (beat / 2), beat / 3, 86));
    }
  }

  // 8. Melodie_mit_Vorlauf.mid (melody starts halfway through at bar 9 — ideal to test trimming!)
  const lateEvents: RawEventSpec[] = [
    { tick: 0, bytes: [0xff, 0x51, 0x03, 0x07, 0xa1, 0x20] },
    metaEvent(0, 0x01, 'Enthält 8 Takte Vorlauf vor Einsatz der Melodie'),
    metaEvent(bar * 8, 0x06, 'Melodie-Einsatz'),
  ];
  const melodyNotes = [64, 67, 69, 71, 72, 71, 69, 67];
  for (let b = 8; b < 14; b++) {
    for (let s = 0; s < 8; s++) {
      const pitch = melodyNotes[(b + s) % melodyNotes.length];
      lateEvents.push(...noteEvents(pitch, b * bar + s * (beat / 2), beat * 0.4, 94));
    }
    lateEvents.push(...noteEvents(48 + ((b % 2) * 5), b * bar, bar - 40, 82));
  }

  return [
    makeFile('ARK-Hi_Spic_Uni.mid', encodeSmfFile(ppqn, [encodeSmfTrack(spicEvents)])),
    makeFile('Ascend_Piano.mid', encodeSmfFile(ppqn, [encodeSmfTrack(pianoEvents)])),
    makeFile(
      'basic_pitch_transcription2_abgebrochen.mid',
      encodeSmfFile(ppqn, [encodeSmfTrack(brokenEvents, { omitEndOfTrack: true, truncateBytes: 34 })])
    ),
    makeFile('Bass_Buzz_fragment.mid', encodeSmfFile(ppqn, [encodeSmfTrack(fragmentEvents)])),
    makeFile('BL_Horn_Sus_leer.mid', encodeSmfFile(ppqn, [encodeSmfTrack(emptyEvents)])),
    makeFile(
      'Battery_Groove_Complete.mid',
      encodeSmfFile(ppqn, [encodeSmfTrack(bassTrack), encodeSmfTrack(drumTrack)])
    ),
    makeFile('arp_mit_luecke.mid', encodeSmfFile(ppqn, [encodeSmfTrack(gapEvents)])),
    makeFile('Melodie_mit_Vorlauf.mid', encodeSmfFile(ppqn, [encodeSmfTrack(lateEvents)])),
  ];
}
