import type {
  MidiIssue,
  MidiTempoEvent,
  MidiTimeSignature,
  ParsedMidi,
} from '../types/midi';

export interface TempoSegment {
  tick: number;
  sec: number;
  usPerBeat: number;
  bpm: number;
}

export interface MidiBarInfo {
  barNumber: number; // 1-indexed
  startTick: number;
  endTick: number;
  numerator: number;
  denominator: number;
  ticksPerBeat: number;
  isTimeSigChange: boolean;
}

/**
 * Builds cumulative seconds lookup segments from sorted tempo events (accounting for tempo changes).
 */
export function buildTempoSegments(
  ppqn: number,
  tempos: Array<{ tick: number; microsecondsPerBeat: number; bpm: number }>,
  smpteTicksPerSecond = 0
): TempoSegment[] {
  if (smpteTicksPerSecond > 0) {
    return [{ tick: 0, sec: 0, usPerBeat: 500_000, bpm: 120 }];
  }

  // Collapse duplicate events at identical ticks (keep latest)
  const dedupedMap = new Map<number, { tick: number; microsecondsPerBeat: number; bpm: number }>();
  for (const t of tempos) {
    dedupedMap.set(Math.max(0, Math.round(t.tick)), {
      tick: Math.max(0, Math.round(t.tick)),
      microsecondsPerBeat: t.microsecondsPerBeat,
      bpm: t.bpm,
    });
  }
  const sorted = Array.from(dedupedMap.values()).sort((a, b) => a.tick - b.tick);
  if (sorted.length === 0 || sorted[0].tick > 0) {
    sorted.unshift({ tick: 0, microsecondsPerBeat: 500_000, bpm: 120 });
  }

  const segments: TempoSegment[] = [];
  let accSec = 0;
  let prevTick = 0;
  let prevUs = sorted[0].microsecondsPerBeat;
  segments.push({ tick: 0, sec: 0, usPerBeat: prevUs, bpm: sorted[0].bpm });

  for (let i = 1; i < sorted.length; i++) {
    const t = sorted[i];
    if (t.tick > prevTick) {
      accSec += ((t.tick - prevTick) / Math.max(1, ppqn)) * (prevUs / 1_000_000);
      prevTick = t.tick;
    }
    prevUs = t.microsecondsPerBeat;
    segments.push({ tick: t.tick, sec: accSec, usPerBeat: prevUs, bpm: t.bpm });
  }

  return segments;
}

export function tickToSecondsFromSegments(
  segments: TempoSegment[],
  ppqn: number,
  smpteTicksPerSecond: number,
  targetTick: number
): number {
  const safeTick = Math.max(0, targetTick);
  if (smpteTicksPerSecond > 0) {
    return safeTick / smpteTicksPerSecond;
  }
  if (segments.length === 0) {
    return (safeTick / Math.max(1, ppqn)) * 0.5;
  }
  let lo = 0;
  let hi = segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segments[mid].tick <= safeTick) lo = mid;
    else hi = mid - 1;
  }
  const seg = segments[lo];
  return seg.sec + ((safeTick - seg.tick) / Math.max(1, ppqn)) * (seg.usPerBeat / 1_000_000);
}

export function secondsToTickFromSegments(
  segments: TempoSegment[],
  ppqn: number,
  smpteTicksPerSecond: number,
  targetSec: number
): number {
  const safeSec = Math.max(0, targetSec);
  if (smpteTicksPerSecond > 0) {
    return safeSec * smpteTicksPerSecond;
  }
  if (segments.length === 0) {
    return (safeSec / 0.5) * Math.max(1, ppqn);
  }
  let lo = 0;
  let hi = segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segments[mid].sec <= safeSec) lo = mid;
    else hi = mid - 1;
  }
  const seg = segments[lo];
  return seg.tick + ((safeSec - seg.sec) / (seg.usPerBeat / 1_000_000)) * Math.max(1, ppqn);
}

export function tickToSeconds(
  parsed: Pick<ParsedMidi, 'ppqn' | 'tempos' | 'smpteTicksPerSecond'>,
  tick: number
): number {
  const segs = buildTempoSegments(parsed.ppqn, parsed.tempos, parsed.smpteTicksPerSecond);
  return tickToSecondsFromSegments(segs, parsed.ppqn, parsed.smpteTicksPerSecond, tick);
}

export function secondsToTick(
  parsed: Pick<ParsedMidi, 'ppqn' | 'tempos' | 'smpteTicksPerSecond'>,
  sec: number
): number {
  const segs = buildTempoSegments(parsed.ppqn, parsed.tempos, parsed.smpteTicksPerSecond);
  return secondsToTickFromSegments(segs, parsed.ppqn, parsed.smpteTicksPerSecond, sec);
}

export function getBpmAtSec(
  parsed: Pick<ParsedMidi, 'ppqn' | 'tempos' | 'smpteTicksPerSecond' | 'primaryBpm'>,
  sec: number
): number {
  if (parsed.smpteTicksPerSecond > 0 || parsed.tempos.length <= 1) {
    return parsed.primaryBpm;
  }
  const segs = buildTempoSegments(parsed.ppqn, parsed.tempos, parsed.smpteTicksPerSecond);
  const safeSec = Math.max(0, sec);
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid].sec <= safeSec) lo = mid;
    else hi = mid - 1;
  }
  return segs[lo]?.bpm ?? parsed.primaryBpm;
}

/**
 * Builds an exact bar map from tick 0 to totalTicks, supporting arbitrary time signature changes.
 */
export function buildBarGrid(
  ppqn: number,
  timeSignatures: Array<Pick<MidiTimeSignature, 'tick' | 'numerator' | 'denominator'>>,
  totalTicks: number
): MidiBarInfo[] {
  const safePpqn = Math.max(1, ppqn);
  const effectiveEnd = Math.max(safePpqn, totalTicks);

  // Deduplicate time signatures at identical ticks (keep latest)
  const deduped = new Map<number, { tick: number; numerator: number; denominator: number }>();
  for (const ts of timeSignatures) {
    const t = Math.max(0, Math.round(ts.tick));
    deduped.set(t, {
      tick: t,
      numerator: Math.max(1, ts.numerator || 4),
      denominator: Math.max(1, ts.denominator || 4),
    });
  }

  const normalized = Array.from(deduped.values()).sort((a, b) => a.tick - b.tick);
  if (normalized.length === 0 || normalized[0].tick > 0) {
    normalized.unshift({ tick: 0, numerator: 4, denominator: 4 });
  }

  const bars: MidiBarInfo[] = [];
  let curTick = 0;
  let tsIdx = 0;
  let barNumber = 1;
  let lastSigKey = '';

  while (curTick < effectiveEnd && bars.length < 50_000) {
    while (tsIdx + 1 < normalized.length && normalized[tsIdx + 1].tick <= curTick) {
      tsIdx++;
    }
    const activeTs = normalized[tsIdx];
    const sigKey = `${activeTs.numerator}/${activeTs.denominator}`;
    const isTimeSigChange = bars.length > 0 && sigKey !== lastSigKey;
    lastSigKey = sigKey;

    const ticksPerBeat = Math.max(1, safePpqn * (4 / activeTs.denominator));
    const ticksPerBar = Math.max(1, ticksPerBeat * activeTs.numerator);
    const nextTsTick =
      tsIdx + 1 < normalized.length ? normalized[tsIdx + 1].tick : Infinity;

    let barEnd = curTick + ticksPerBar;
    if (nextTsTick > curTick && nextTsTick < barEnd) {
      barEnd = nextTsTick;
    }

    bars.push({
      barNumber,
      startTick: curTick,
      endTick: barEnd,
      numerator: activeTs.numerator,
      denominator: activeTs.denominator,
      ticksPerBeat,
      isTimeSigChange,
    });

    curTick = barEnd;
    barNumber++;
  }

  if (bars.length === 0) {
    bars.push({
      barNumber: 1,
      startTick: 0,
      endTick: safePpqn * 4,
      numerator: 4,
      denominator: 4,
      ticksPerBeat: safePpqn,
      isTimeSigChange: false,
    });
  }

  return bars;
}

export function getBarGrid(
  parsed: Pick<ParsedMidi, 'ppqn' | 'timeSignatures' | 'totalTicks'>
): MidiBarInfo[] {
  return buildBarGrid(parsed.ppqn, parsed.timeSignatures, parsed.totalTicks);
}

export function findBarAtTick(bars: MidiBarInfo[], tick: number): MidiBarInfo {
  if (bars.length === 0) {
    return {
      barNumber: 1,
      startTick: 0,
      endTick: 1920,
      numerator: 4,
      denominator: 4,
      ticksPerBeat: 480,
      isTimeSigChange: false,
    };
  }
  const safeTick = Math.max(0, tick);
  let lo = 0;
  let hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bars[mid].startTick <= safeTick) lo = mid;
    else hi = mid - 1;
  }
  return bars[lo];
}

export function tickToBarNumber(bars: MidiBarInfo[], tick: number): number {
  return findBarAtTick(bars, tick).barNumber;
}

export function tickToBarFraction(bars: MidiBarInfo[], tick: number): number {
  const bar = findBarAtTick(bars, tick);
  const len = Math.max(1, bar.endTick - bar.startTick);
  const frac = Math.max(0, Math.min(1, (tick - bar.startTick) / len));
  return bar.barNumber + frac;
}

export function barStartTickAt(parsed: ParsedMidi, tick: number): number {
  const bars = getBarGrid(parsed);
  return findBarAtTick(bars, tick).startTick;
}

export function barEndTickAt(parsed: ParsedMidi, tick: number): number {
  const bars = getBarGrid(parsed);
  return findBarAtTick(bars, Math.max(0, tick - 1)).endTick;
}

export function nearestBarSnapTick(parsed: ParsedMidi, tick: number): number {
  const bars = getBarGrid(parsed);
  const bar = findBarAtTick(bars, tick);
  const distStart = Math.abs(tick - bar.startTick);
  const distEnd = Math.abs(bar.endTick - tick);
  const candidate = distStart <= distEnd ? bar.startTick : bar.endTick;
  return Math.max(0, Math.min(parsed.totalTicks, candidate));
}

export function getTimeSigAtTick(
  timeSignatures: MidiTimeSignature[],
  tick: number
): MidiTimeSignature {
  let active = timeSignatures[0] || {
    tick: 0,
    sec: 0,
    bar: 1,
    numerator: 4,
    denominator: 4,
  };
  for (let i = 1; i < timeSignatures.length; i++) {
    if (timeSignatures[i].tick <= tick) active = timeSignatures[i];
    else break;
  }
  return active;
}

export function getTempoAtTick(
  tempos: MidiTempoEvent[],
  tick: number
): MidiTempoEvent {
  let active = tempos[0] || {
    tick: 0,
    sec: 0,
    microsecondsPerBeat: 500_000,
    bpm: 120,
  };
  for (let i = 1; i < tempos.length; i++) {
    if (tempos[i].tick <= tick) active = tempos[i];
    else break;
  }
  return active;
}

/**
 * Determines whether a MIDI file represents a complete composition (rather than a fragment,
 * aborted transcription, or clip with excessive leading/trailing dead air).
 * Smart Trimming is disabled by default for complete compositions to preserve intentional intros,
 * phrasing, reverb/sustain tails, and structural bar alignment.
 */
export function evaluateCompleteComposition(params: {
  noteCount: number;
  barCount: number;
  totalTicks: number;
  totalDurationSec: number;
  firstNoteTick: number;
  firstNoteSec: number;
  lastNoteEndTick: number;
  leadingBars: number;
  trailingEmptyBars: number;
  issues: MidiIssue[];
}): { isComplete: boolean; reason?: string } {
  const hasErrors = params.issues.some((i) => i.severity === 'error');
  const hasLargeGap = params.issues.some((i) => i.code === 'large_gap');

  if (hasErrors || params.noteCount < 16) {
    return { isComplete: false };
  }
  if (params.barCount < 8 && params.totalDurationSec < 15) {
    return { isComplete: false };
  }
  if (params.leadingBars >= 2 || params.firstNoteSec >= 4.0) {
    return { isComplete: false };
  }
  if (hasLargeGap) {
    return { isComplete: false };
  }

  const activeSpanRatio =
    params.totalTicks > 0
      ? (params.lastNoteEndTick - params.firstNoteTick) / params.totalTicks
      : 0;
  if (params.trailingEmptyBars >= 4 || activeSpanRatio < 0.55) {
    return { isComplete: false };
  }

  return {
    isComplete: true,
    reason: `${params.barCount} Takte, ${params.noteCount} Noten ohne Vorlauf-/Lückenproblem`,
  };
}
