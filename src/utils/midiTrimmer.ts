import type { ParsedMidi } from '../types/midi';

interface RawTrackEvent {
  tick: number;
  status: number;
  metaType?: number;
  data: Uint8Array;
}

function readVLQ(bytes: Uint8Array, posRef: { pos: number }): number {
  let val = 0;
  let count = 0;
  while (posRef.pos < bytes.length && count < 4) {
    const b = bytes[posRef.pos++];
    val = (val << 7) | (b & 0x7f);
    count++;
    if ((b & 0x80) === 0) break;
  }
  return val;
}

function writeVLQ(value: number): number[] {
  const out: number[] = [];
  let v = Math.max(0, Math.floor(value));
  out.unshift(v & 0x7f);
  v >>= 7;
  while (v > 0) {
    out.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return out;
}

function readUint16(bytes: Uint8Array, pos: number): number {
  return ((bytes[pos] ?? 0) << 8) | (bytes[pos + 1] ?? 0);
}

function readUint32(bytes: Uint8Array, pos: number): number {
  return (
    (((bytes[pos] ?? 0) << 24) |
      ((bytes[pos + 1] ?? 0) << 16) |
      ((bytes[pos + 2] ?? 0) << 8) |
      (bytes[pos + 3] ?? 0)) >>>
    0
  );
}

function encodeTrack(events: RawTrackEvent[], endTick: number): Uint8Array {
  // Stable sort by tick; at tick 0 put metadata/setup before notes
  const priority = (ev: RawTrackEvent): number => {
    if (ev.status === 0xff) {
      if (ev.metaType === 0x03 || ev.metaType === 0x04) return 0;
      if (ev.metaType === 0x58 || ev.metaType === 0x59 || ev.metaType === 0x51) return 1;
      return 2;
    }
    const type = ev.status & 0xf0;
    if (type === 0xb0 || type === 0xc0 || type === 0xd0 || type === 0xe0) return 3;
    if (type === 0x80 || (type === 0x90 && ev.data[1] === 0)) return 4;
    return 5;
  };

  const sorted = [...events].sort(
    (a, b) => a.tick - b.tick || priority(a) - priority(b)
  );

  const body: number[] = [];
  let lastTick = 0;

  for (const ev of sorted) {
    const tick = Math.max(0, Math.round(ev.tick));
    const delta = Math.max(0, tick - lastTick);
    lastTick = tick;
    body.push(...writeVLQ(delta));

    if (ev.status === 0xff) {
      body.push(0xff, ev.metaType ?? 0x01, ...writeVLQ(ev.data.length), ...ev.data);
    } else if (ev.status === 0xf0 || ev.status === 0xf7) {
      body.push(ev.status, ...writeVLQ(ev.data.length), ...ev.data);
    } else {
      body.push(ev.status, ...ev.data);
    }
  }

  const finalDelta = Math.max(0, Math.round(endTick) - lastTick);
  body.push(...writeVLQ(finalDelta), 0xff, 0x2f, 0x00);

  const out = new Uint8Array(8 + body.length);
  out.set([0x4d, 0x54, 0x72, 0x6b], 0); // MTrk
  out[4] = (body.length >>> 24) & 0xff;
  out[5] = (body.length >>> 16) & 0xff;
  out[6] = (body.length >>> 8) & 0xff;
  out[7] = body.length & 0xff;
  out.set(body, 8);
  return out;
}

export interface TrimMidiOptions {
  trimStartTick: number;
  trimEndTick?: number | null;
}

export function trimMidiBuffer(buffer: ArrayBuffer, options: TrimMidiOptions): ArrayBuffer {
  const bytes = new Uint8Array(buffer);
  const trimStart = Math.max(0, Math.round(options.trimStartTick));
  const trimEnd =
    options.trimEndTick !== undefined && options.trimEndTick !== null
      ? Math.max(trimStart + 1, Math.round(options.trimEndTick))
      : null;

  let offset = 0;
  // Locate MThd if wrapped in RIFF/RMID
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    for (let i = 0; i < Math.min(bytes.length - 4, 256); i++) {
      if (bytes[i] === 0x4d && bytes[i + 1] === 0x54 && bytes[i + 2] === 0x68 && bytes[i + 3] === 0x64) {
        offset = i;
        break;
      }
    }
  }

  if (
    offset + 14 > bytes.length ||
    bytes[offset] !== 0x4d ||
    bytes[offset + 1] !== 0x54 ||
    bytes[offset + 2] !== 0x68 ||
    bytes[offset + 3] !== 0x64
  ) {
    throw new Error('Ungültiger MIDI-Header.');
  }

  const headerLen = readUint32(bytes, offset + 4);
  const format = readUint16(bytes, offset + 8);
  const division = readUint16(bytes, offset + 12);
  offset += 8 + headerLen;

  const encodedTracks: Uint8Array[] = [];

  while (offset + 8 <= bytes.length) {
    const tag = String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3]
    );
    const chunkLen = readUint32(bytes, offset + 4);
    offset += 8;

    const chunkEnd = Math.min(bytes.length, offset + chunkLen);
    if (tag !== 'MTrk') {
      offset = chunkEnd;
      continue;
    }

    const posRef = { pos: offset };
    let tick = 0;
    let runningStatus = 0;

    // Preserved state up to trimStart
    const trackNames: RawTrackEvent[] = [];
    let latestTempo: RawTrackEvent | null = null;
    let latestTimeSig: RawTrackEvent | null = null;
    let latestKeySig: RawTrackEvent | null = null;
    const latestPrograms = new Map<number, RawTrackEvent>();
    const latestCCs = new Map<string, RawTrackEvent>();
    const latestPitchBends = new Map<number, RawTrackEvent>();
    const latestAftertouch = new Map<number, RawTrackEvent>();

    // Track notes that started before trimStart and may still be sounding at trimStart
    const preStartOpenNotes = new Map<number, { status: number; pitch: number; velocity: number }>();
    // Track notes currently active inside the kept window
    const keptOpenNotes = new Set<number>();

    const keptEvents: RawTrackEvent[] = [];
    let trackMaxTick = 0;

    while (posRef.pos < chunkEnd) {
      const delta = readVLQ(bytes, posRef);
      tick += delta;
      if (posRef.pos >= chunkEnd) break;

      let status = bytes[posRef.pos];
      if (status >= 0x80) {
        posRef.pos++;
        if (status < 0xf0) runningStatus = status;
        else if (status === 0xf0 || status === 0xf7) runningStatus = 0;
      } else {
        if (runningStatus === 0) {
          posRef.pos++;
          continue;
        }
        status = runningStatus;
      }

      if (status === 0xff) {
        if (posRef.pos >= chunkEnd) break;
        const metaType = bytes[posRef.pos++];
        const len = readVLQ(bytes, posRef);
        const safeLen = Math.min(len, Math.max(0, chunkEnd - posRef.pos));
        const data = bytes.slice(posRef.pos, posRef.pos + safeLen);
        posRef.pos += safeLen;

        if (metaType === 0x2f) {
          trackMaxTick = Math.max(trackMaxTick, tick);
          break;
        }

        const ev: RawTrackEvent = { tick, status: 0xff, metaType, data };
        if (tick <= trimStart) {
          if (
            metaType === 0x03 ||
            metaType === 0x04 ||
            metaType === 0x02 ||
            (tick === 0 && metaType === 0x01)
          ) {
            trackNames.push({ ...ev, tick: 0 });
          } else if (metaType === 0x51) {
            latestTempo = { ...ev, tick: 0 };
          } else if (metaType === 0x58) {
            latestTimeSig = { ...ev, tick: 0 };
          } else if (metaType === 0x59) {
            latestKeySig = { ...ev, tick: 0 };
          }
        } else if (trimEnd === null || tick <= trimEnd) {
          const shiftedTick = tick - trimStart;
          keptEvents.push({ ...ev, tick: shiftedTick });
          trackMaxTick = Math.max(trackMaxTick, shiftedTick);
        }
      } else if (status === 0xf0 || status === 0xf7) {
        const len = readVLQ(bytes, posRef);
        const safeLen = Math.min(len, Math.max(0, chunkEnd - posRef.pos));
        const data = bytes.slice(posRef.pos, posRef.pos + safeLen);
        posRef.pos += safeLen;
        if (tick >= trimStart && (trimEnd === null || tick <= trimEnd)) {
          const shiftedTick = tick - trimStart;
          keptEvents.push({ tick: shiftedTick, status, data });
          trackMaxTick = Math.max(trackMaxTick, shiftedTick);
        }
      } else {
        const type = status & 0xf0;
        const ch = status & 0x0f;
        const isOneByte = type === 0xc0 || type === 0xd0;
        const byteCount = isOneByte ? 1 : 2;
        if (posRef.pos + byteCount > chunkEnd) break;
        const data = bytes.slice(posRef.pos, posRef.pos + byteCount);
        posRef.pos += byteCount;

        const isNoteOn = type === 0x90 && data[1] > 0;
        const isNoteOff = type === 0x80 || (type === 0x90 && data[1] === 0);

        if (tick < trimStart) {
          if (isNoteOn) {
            const key = ch * 128 + (data[0] & 0x7f);
            preStartOpenNotes.set(key, { status, pitch: data[0] & 0x7f, velocity: data[1] });
          } else if (isNoteOff) {
            const key = ch * 128 + (data[0] & 0x7f);
            preStartOpenNotes.delete(key);
          } else if (type === 0xc0) {
            latestPrograms.set(ch, { tick: 0, status, data });
          } else if (type === 0xb0) {
            const ccNum = data[0];
            // Preserve non-panic CCs (Bank, Volume, Pan, Modulation, Expression, Sustain)
            if (ccNum < 120) {
              latestCCs.set(`${ch}:${ccNum}`, { tick: 0, status, data });
            }
          } else if (type === 0xe0) {
            latestPitchBends.set(ch, { tick: 0, status, data });
          } else if (type === 0xd0) {
            latestAftertouch.set(ch, { tick: 0, status, data });
          }
        } else if (trimEnd === null || tick <= trimEnd) {
          const shiftedTick = tick - trimStart;
          if (isNoteOn) {
            const key = ch * 128 + (data[0] & 0x7f);
            keptOpenNotes.add(key);
            keptEvents.push({ tick: shiftedTick, status, data });
            trackMaxTick = Math.max(trackMaxTick, shiftedTick);
          } else if (isNoteOff) {
            const key = ch * 128 + (data[0] & 0x7f);
            // If this Note-Off closes a note that began before trimStart, or is currently open, keep it
            if (preStartOpenNotes.has(key) || keptOpenNotes.has(key)) {
              keptOpenNotes.delete(key);
              keptEvents.push({ tick: shiftedTick, status, data });
              trackMaxTick = Math.max(trackMaxTick, shiftedTick);
            }
          } else {
            keptEvents.push({ tick: shiftedTick, status, data });
            trackMaxTick = Math.max(trackMaxTick, shiftedTick);
          }
        }
      }
    }

    // Build final event list for this track
    const finalEvents: RawTrackEvent[] = [
      ...trackNames,
      ...(latestTempo ? [latestTempo] : []),
      ...(latestTimeSig ? [latestTimeSig] : []),
      ...(latestKeySig ? [latestKeySig] : []),
      ...latestPrograms.values(),
      ...latestCCs.values(),
      ...latestPitchBends.values(),
      ...latestAftertouch.values(),
    ];

    // Notes that started before trimStart and were still sounding at trimStart -> start cleanly at tick 0
    for (const [key, note] of preStartOpenNotes.entries()) {
      keptOpenNotes.add(key);
      finalEvents.push({
        tick: 0,
        status: note.status,
        data: new Uint8Array([note.pitch, note.velocity]),
      });
    }

    finalEvents.push(...keptEvents);

    // Close any notes still active if trimmed at trimEnd
    const shiftedEnd = trimEnd !== null ? Math.max(trackMaxTick, trimEnd - trimStart) : trackMaxTick;
    if (trimEnd !== null && keptOpenNotes.size > 0) {
      for (const key of keptOpenNotes) {
        const ch = Math.floor(key / 128);
        const pitch = key % 128;
        finalEvents.push({
          tick: shiftedEnd,
          status: 0x80 | ch,
          data: new Uint8Array([pitch, 0]),
        });
      }
    }

    encodedTracks.push(encodeTrack(finalEvents, shiftedEnd));
    offset = chunkEnd;
  }

  // Write MThd + tracks
  const header = new Uint8Array(14);
  header.set([0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06], 0);
  header[8] = (format >>> 8) & 0xff;
  header[9] = format & 0xff;
  header[10] = (encodedTracks.length >>> 8) & 0xff;
  header[11] = encodedTracks.length & 0xff;
  header[12] = (division >>> 8) & 0xff;
  header[13] = division & 0xff;

  const totalBytes = header.length + encodedTracks.reduce((acc, t) => acc + t.length, 0);
  const result = new Uint8Array(totalBytes);
  result.set(header, 0);
  let writePos = header.length;
  for (const t of encodedTracks) {
    result.set(t, writePos);
    writePos += t.length;
  }
  return result.buffer;
}

export function computeBarStartTick(parsed: ParsedMidi, tick: number): number {
  const ts = parsed.timeSignatures[0] || { numerator: 4, denominator: 4 };
  const ticksPerBar = parsed.ppqn * ts.numerator * (4 / ts.denominator);
  if (ticksPerBar <= 0) return 0;
  return Math.floor(Math.max(0, tick) / ticksPerBar) * ticksPerBar;
}

export function computeBarEndTick(parsed: ParsedMidi, tick: number): number {
  const ts = parsed.timeSignatures[0] || { numerator: 4, denominator: 4 };
  const ticksPerBar = parsed.ppqn * ts.numerator * (4 / ts.denominator);
  if (ticksPerBar <= 0) return tick;
  return Math.ceil(Math.max(1, tick) / ticksPerBar) * ticksPerBar;
}

export interface SmartTrimSuggestion {
  trimStartTick: number;
  trimEndTick: number | null;
  hasLeadingSilence: boolean;
  hasTrailingSilence: boolean;
  hasSilenceToTrim: boolean;
  removedLeadingSec: number;
  removedLeadingBars: number;
  removedTrailingSec: number;
  summary: string;
}

/**
 * Scans the raw MIDI binary buffer across all tracks to locate leading silence
 * (and optional trailing empty bars) and computes a musically aligned trim point.
 */
export function analyzeSilenceTrimSuggestion(
  buffer: ArrayBuffer,
  parsed: ParsedMidi
): SmartTrimSuggestion {
  const bytes = new Uint8Array(buffer);
  const ts = parsed.timeSignatures[0] || { numerator: 4, denominator: 4 };
  const ticksPerBar = Math.max(1, parsed.ppqn * ts.numerator * (4 / ts.denominator));

  // Scan raw binary MTrk chunks directly for Note-On (velocity > 0) events
  const noteOnHits: Array<{ tick: number; velocity: number }> = [];
  let maxNoteEndFromScan = 0;

  let offset = 0;
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46
  ) {
    for (let i = 0; i < Math.min(bytes.length - 4, 256); i++) {
      if (
        bytes[i] === 0x4d &&
        bytes[i + 1] === 0x54 &&
        bytes[i + 2] === 0x68 &&
        bytes[i + 3] === 0x64
      ) {
        offset = i;
        break;
      }
    }
  }

  if (
    offset + 14 <= bytes.length &&
    bytes[offset] === 0x4d &&
    bytes[offset + 1] === 0x54 &&
    bytes[offset + 2] === 0x68 &&
    bytes[offset + 3] === 0x64
  ) {
    const headerLen = readUint32(bytes, offset + 4);
    offset += 8 + headerLen;

    while (offset + 8 <= bytes.length) {
      const tag = String.fromCharCode(
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3]
      );
      const chunkLen = readUint32(bytes, offset + 4);
      offset += 8;
      const chunkEnd = Math.min(bytes.length, offset + chunkLen);

      if (tag !== 'MTrk') {
        offset = chunkEnd;
        continue;
      }

      const posRef = { pos: offset };
      let tick = 0;
      let runningStatus = 0;

      while (posRef.pos < chunkEnd) {
        tick += readVLQ(bytes, posRef);
        if (posRef.pos >= chunkEnd) break;

        let status = bytes[posRef.pos];
        if (status >= 0x80) {
          posRef.pos++;
          if (status < 0xf0) runningStatus = status;
          else if (status === 0xf0 || status === 0xf7) runningStatus = 0;
        } else {
          if (runningStatus === 0) {
            posRef.pos++;
            continue;
          }
          status = runningStatus;
        }

        if (status === 0xff) {
          if (posRef.pos >= chunkEnd) break;
          const metaType = bytes[posRef.pos++];
          const len = readVLQ(bytes, posRef);
          posRef.pos = Math.min(chunkEnd, posRef.pos + len);
          if (metaType === 0x2f) break;
        } else if (status === 0xf0 || status === 0xf7) {
          const len = readVLQ(bytes, posRef);
          posRef.pos = Math.min(chunkEnd, posRef.pos + len);
        } else {
          const type = status & 0xf0;
          const byteCount = type === 0xc0 || type === 0xd0 ? 1 : 2;
          if (posRef.pos + byteCount > chunkEnd) break;
          const d2 = byteCount === 2 ? bytes[posRef.pos + 1] : 0;
          posRef.pos += byteCount;

          if (type === 0x90 && d2 > 0) {
            noteOnHits.push({ tick, velocity: d2 });
            if (tick > maxNoteEndFromScan) maxNoteEndFromScan = tick;
          } else if (type === 0x80 || (type === 0x90 && d2 === 0)) {
            if (tick > maxNoteEndFromScan) maxNoteEndFromScan = tick;
          }
        }
      }
      offset = chunkEnd;
    }
  }

  if (noteOnHits.length === 0 && parsed.notes.length === 0) {
    return {
      trimStartTick: 0,
      trimEndTick: null,
      hasLeadingSilence: false,
      hasTrailingSilence: false,
      hasSilenceToTrim: false,
      removedLeadingSec: 0,
      removedLeadingBars: 0,
      removedTrailingSec: 0,
      summary: 'Keine Noten in der MIDI-Datei vorhanden.',
    };
  }

  noteOnHits.sort((a, b) => a.tick - b.tick);
  const firstHit = noteOnHits[0] ?? { tick: parsed.firstNoteTick, velocity: 96 };
  let onsetTick = firstHit.tick;
  let skippedGhostNote = false;

  // Check if the very first note is a quiet stray trigger (vel <= 15) followed by >= 2 empty bars
  if (noteOnHits.length >= 3 && firstHit.velocity <= 15) {
    const secondHit = noteOnHits[1];
    if (secondHit.tick - firstHit.tick >= ticksPerBar * 2) {
      onsetTick = secondHit.tick;
      skippedGhostNote = true;
    }
  }

  // Smart bar-grid alignment near bar boundaries (preserves humanization/downbeat)
  let suggestedStartTick = onsetTick;
  let alignedToBar = false;
  if (onsetTick > 0) {
    const offsetInBar = onsetTick % ticksPerBar;
    const barStart = Math.floor(onsetTick / ticksPerBar) * ticksPerBar;
    const earlyLeadInTolerance = Math.round(parsed.ppqn / 8); // 32nd-note early pickup
    const lateHitTolerance = Math.round(parsed.ppqn / 4); // 16th-note late onset

    if (offsetInBar === 0) {
      alignedToBar = true;
      suggestedStartTick = onsetTick;
    } else if (offsetInBar <= lateHitTolerance && barStart > 0) {
      suggestedStartTick = barStart;
      alignedToBar = true;
    } else if (ticksPerBar - offsetInBar <= earlyLeadInTolerance && barStart > 0) {
      suggestedStartTick = barStart;
      alignedToBar = true;
    }
  }

  // Check for empty trailing bars at the end
  const lastEndTick = Math.max(parsed.lastNoteEndTick, maxNoteEndFromScan);
  const trailingTicks = Math.max(0, parsed.totalTicks - lastEndTick);
  const hasTrailingSilence = trailingTicks >= ticksPerBar;
  const suggestedEndTick = hasTrailingSilence
    ? Math.min(parsed.totalTicks, Math.max(suggestedStartTick + parsed.ppqn, computeBarEndTick(parsed, lastEndTick)))
    : null;

  const secPerTick =
    parsed.totalTicks > 0 ? parsed.totalDurationSec / parsed.totalTicks : 0;
  const removedLeadingSec = Math.max(0, suggestedStartTick * secPerTick);
  const removedLeadingBars = Math.round((suggestedStartTick / ticksPerBar) * 10) / 10;
  const removedTrailingSec =
    suggestedEndTick !== null ? Math.max(0, (parsed.totalTicks - suggestedEndTick) * secPerTick) : 0;

  const hasLeadingSilence = suggestedStartTick > 0;
  const hasSilenceToTrim =
    hasLeadingSilence || (suggestedEndTick !== null && suggestedEndTick < parsed.totalTicks);

  let summary = '';
  if (!hasSilenceToTrim) {
    summary = 'Kein relevanter Leerlauf erkannt — die 1. Note beginnt bereits direkt am Anfang.';
  } else {
    const parts: string[] = [];
    if (hasLeadingSilence) {
      const barInfo =
        removedLeadingBars >= 1 ? `${removedLeadingBars} Takte (${removedLeadingSec.toFixed(1)} s)` : `${removedLeadingSec.toFixed(1)} s`;
      parts.push(`Vorlauf ${barInfo} erkannt`);
    }
    if (skippedGhostNote) {
      parts.push('stille Störnote am Anfang übersprungen');
    }
    if (alignedToBar && hasLeadingSilence) {
      parts.push('auf Taktanfang eingerastet');
    }
    if (hasTrailingSilence && suggestedEndTick !== null) {
      parts.push(`leeres Ende (−${removedTrailingSec.toFixed(1)} s) gekürzt`);
    }
    summary = `Vorschlag: ${parts.join(' · ')}.`;
  }

  return {
    trimStartTick: suggestedStartTick,
    trimEndTick: suggestedEndTick,
    hasLeadingSilence,
    hasTrailingSilence,
    hasSilenceToTrim,
    removedLeadingSec,
    removedLeadingBars,
    removedTrailingSec,
    summary,
  };
}

