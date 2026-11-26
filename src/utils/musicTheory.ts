import type {
  DetectedKey,
  KeyStatus,
  MidiNote,
  MidiTimeSignature,
} from '../types/midi';
import { buildBarGrid } from './midiTimeline';
export type { DetectedKey };

const PITCH_CLASSES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

// German key labels
const MAJOR_KEY_NAMES = [
  'C-Dur',
  'Db-Dur',
  'D-Dur',
  'Eb-Dur',
  'E-Dur',
  'F-Dur',
  'F#-Dur',
  'G-Dur',
  'Ab-Dur',
  'A-Dur',
  'Bb-Dur',
  'H-Dur',
];

const MINOR_KEY_NAMES = [
  'c-Moll',
  'c#-Moll',
  'd-Moll',
  'eb-Moll',
  'e-Moll',
  'f-Moll',
  'f#-Moll',
  'g-Moll',
  'g#-Moll',
  'a-Moll',
  'b-Moll',
  'h-Moll',
];

// Krumhansl-Kessler tonal hierarchy profiles
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export interface DetectedChord {
  symbol: string;
  root: number;
  bass: number;
  startTick: number;
  endTick: number;
  startBar: number;
  quality: string;
  score: number;
}

export interface MidiHarmonyAnalysis {
  key: DetectedKey | null;
  keyStatus: KeyStatus;
  keyUnknownReason?: string;
  secondaryKey: string | null;
  chords: DetectedChord[];
  progressionSummary: string[];
  isPercussionOnly: boolean;
}

interface ChordTemplate {
  suffix: string;
  intervals: number[]; // relative to root 0..11
  required?: number[]; // intervals that must be present
  penaltyWeight: number;
}

const CHORD_TEMPLATES: ChordTemplate[] = [
  // Triads (preferred when cleanly present)
  { suffix: '', intervals: [0, 4, 7], required: [0, 4], penaltyWeight: 0.0 },
  { suffix: 'm', intervals: [0, 3, 7], required: [0, 3], penaltyWeight: 0.0 },
  { suffix: 'dim', intervals: [0, 3, 6], required: [0, 3, 6], penaltyWeight: 0.15 },
  { suffix: 'aug', intervals: [0, 4, 8], required: [0, 4, 8], penaltyWeight: 0.2 },
  { suffix: 'sus4', intervals: [0, 5, 7], required: [0, 5, 7], penaltyWeight: 0.15 },
  { suffix: 'sus2', intervals: [0, 2, 7], required: [0, 2, 7], penaltyWeight: 0.18 },
  // Seventh chords
  { suffix: 'maj7', intervals: [0, 4, 7, 11], required: [0, 4, 11], penaltyWeight: 0.08 },
  { suffix: '7', intervals: [0, 4, 7, 10], required: [0, 4, 10], penaltyWeight: 0.08 },
  { suffix: 'm7', intervals: [0, 3, 7, 10], required: [0, 3, 10], penaltyWeight: 0.08 },
  { suffix: 'm7b5', intervals: [0, 3, 6, 10], required: [0, 3, 6, 10], penaltyWeight: 0.16 },
  { suffix: 'dim7', intervals: [0, 3, 6, 9], required: [0, 3, 6, 9], penaltyWeight: 0.2 },
  { suffix: 'm(maj7)', intervals: [0, 3, 7, 11], required: [0, 3, 11], penaltyWeight: 0.22 },
  // Common extensions / sixths
  { suffix: 'add9', intervals: [0, 2, 4, 7], required: [0, 2, 4], penaltyWeight: 0.16 },
  { suffix: 'm(add9)', intervals: [0, 2, 3, 7], required: [0, 2, 3], penaltyWeight: 0.16 },
  { suffix: '6', intervals: [0, 4, 7, 9], required: [0, 4, 9], penaltyWeight: 0.2 },
  { suffix: 'm6', intervals: [0, 3, 7, 9], required: [0, 3, 9], penaltyWeight: 0.2 },
  // Power chord fallback
  { suffix: '5', intervals: [0, 7], required: [0, 7], penaltyWeight: 0.45 },
];

function pearsonCorrelation(a: number[], b: number[]): number {
  const n = a.length;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < n; i++) {
    sumA += a[i];
    sumB += b[i];
  }
  const meanA = sumA / n;
  const meanB = sumB / n;

  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const denom = Math.sqrt(denA * denB);
  return denom > 0 ? num / denom : 0;
}

function buildScaleSet(tonic: number, mode: 'major' | 'minor'): Set<number> {
  const intervals =
    mode === 'major' ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10];
  return new Set(intervals.map((iv) => (tonic + iv) % 12));
}

export function detectKeyFromNotes(notes: MidiNote[]): {
  primary: DetectedKey | null;
  status: KeyStatus;
  unknownReason?: string;
  secondaryLabel: string | null;
  isPercussionOnly: boolean;
} {
  if (notes.length === 0) {
    return {
      primary: null,
      status: 'empty',
      unknownReason: 'Keine Noten vorhanden',
      secondaryLabel: null,
      isPercussionOnly: false,
    };
  }

  const pitchedNotes = notes.filter((n) => n.channel !== 9);
  if (pitchedNotes.length === 0) {
    return {
      primary: null,
      status: 'percussion',
      secondaryLabel: null,
      isPercussionOnly: true,
    };
  }

  const pcWeights = new Array<number>(12).fill(0);
  const bassWeights = new Array<number>(12).fill(0);
  const distinctPcs = new Set<number>();
  let totalWeight = 0;

  for (const n of pitchedNotes) {
    const pc = ((n.pitch % 12) + 12) % 12;
    distinctPcs.add(pc);
    const weight = Math.max(0.05, n.durationSec) * (0.45 + n.velocity / 200);
    pcWeights[pc] += weight;
    totalWeight += weight;
    if (n.pitch < 55) {
      bassWeights[pc] += weight;
    }
  }

  if (pitchedNotes.length < 4 || distinctPcs.size < 2 || totalWeight < 0.35) {
    return {
      primary: null,
      status: 'unknown',
      unknownReason:
        distinctPcs.size < 2
          ? 'Nur ein einzelner Ton / zu wenig Tonvielfalt'
          : 'Zu wenige melodische Noten für eine zuverlässige Tonarterkennung',
      secondaryLabel: null,
      isPercussionOnly: false,
    };
  }

  // Slight bass-note tonic reinforcement (helps distinguish C major vs A minor)
  const combinedWeights = pcWeights.map((w, idx) => w + bassWeights[idx] * 0.35);

  const candidates: Array<{
    tonic: number;
    mode: 'major' | 'minor';
    score: number;
    label: string;
    relativeLabel: string;
  }> = [];

  for (let tonic = 0; tonic < 12; tonic++) {
    const rotatedMajor = new Array<number>(12);
    const rotatedMinor = new Array<number>(12);
    for (let i = 0; i < 12; i++) {
      rotatedMajor[(tonic + i) % 12] = MAJOR_PROFILE[i];
      rotatedMinor[(tonic + i) % 12] = MINOR_PROFILE[i];
    }

    const majCorr = pearsonCorrelation(combinedWeights, rotatedMajor);
    const minCorr = pearsonCorrelation(combinedWeights, rotatedMinor);

    candidates.push({
      tonic,
      mode: 'major',
      score: majCorr,
      label: MAJOR_KEY_NAMES[tonic],
      relativeLabel: MINOR_KEY_NAMES[(tonic + 9) % 12],
    });
    candidates.push({
      tonic,
      mode: 'minor',
      score: minCorr,
      label: MINOR_KEY_NAMES[tonic],
      relativeLabel: MAJOR_KEY_NAMES[(tonic + 3) % 12],
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const second = candidates[1];

  // If best Krumhansl-Kessler correlation is too weak, key is genuinely unknown/atonal
  if (!best || !Number.isFinite(best.score) || best.score < 0.35) {
    return {
      primary: null,
      status: 'unknown',
      unknownReason: 'Tonart nicht eindeutig bestimmbar (atonal oder stark chromatisch)',
      secondaryLabel: null,
      isPercussionOnly: false,
    };
  }

  const confidence = Math.max(25, Math.min(99, Math.round(((best.score + 1) / 2) * 100)));
  const secondaryLabel =
    second && best.score - second.score < 0.08 ? second.label : null;

  return {
    primary: {
      tonic: best.tonic,
      mode: best.mode,
      label: best.label,
      relativeLabel: best.relativeLabel,
      confidence,
      scalePitchClasses: buildScaleSet(best.tonic, best.mode),
    },
    status: 'detected',
    secondaryLabel,
    isPercussionOnly: false,
  };
}

function matchChordWindow(
  pcEnergy: number[],
  lowestPitch: number | null,
  key: DetectedKey | null
): { symbol: string; root: number; bass: number; quality: string; score: number } | null {
  let totalEnergy = 0;
  let activeCount = 0;
  for (let i = 0; i < 12; i++) {
    if (pcEnergy[i] > 0) {
      totalEnergy += pcEnergy[i];
      activeCount++;
    }
  }
  if (totalEnergy <= 0 || activeCount < 2) return null;

  const norm = pcEnergy.map((v) => v / totalEnergy);
  const bassPc = lowestPitch !== null ? ((lowestPitch % 12) + 12) % 12 : -1;

  let bestMatch: {
    symbol: string;
    root: number;
    bass: number;
    quality: string;
    score: number;
  } | null = null;

  for (let root = 0; root < 12; root++) {
    if (norm[root] < 0.08) continue; // Root should meaningfully sound in window

    for (const tpl of CHORD_TEMPLATES) {
      const ivSet = new Set(tpl.intervals.map((iv) => (root + iv) % 12));

      // Check required chord tones
      if (tpl.required) {
        let missingRequired = false;
        for (const req of tpl.required) {
          if (norm[(root + req) % 12] < 0.06) {
            missingRequired = true;
            break;
          }
        }
        if (missingRequired) continue;
      }

      let inChordEnergy = 0;
      let outChordEnergy = 0;
      let matchedCount = 0;

      for (let pc = 0; pc < 12; pc++) {
        if (ivSet.has(pc)) {
          inChordEnergy += norm[pc];
          if (norm[pc] >= 0.06) matchedCount++;
        } else {
          outChordEnergy += norm[pc];
        }
      }

      const coverage = matchedCount / tpl.intervals.length;
      let score = inChordEnergy * 1.35 - outChordEnergy * 1.15 + coverage * 0.45 - tpl.penaltyWeight;

      // Bass root alignment bonus
      if (bassPc === root) {
        score += 0.28;
      } else if (bassPc >= 0 && ivSet.has(bassPc)) {
        score += 0.08;
      }

      // Diatonic bonus relative to detected key
      if (key) {
        if (key.scalePitchClasses.has(root)) score += 0.08;
        let diatonicTones = 0;
        for (const pc of ivSet) {
          if (key.scalePitchClasses.has(pc)) diatonicTones++;
        }
        if (diatonicTones === ivSet.size) score += 0.1;
      }

      if (!bestMatch || score > bestMatch.score) {
        const rootName = PITCH_CLASSES[root];
        const useSlash =
          bassPc >= 0 &&
          bassPc !== root &&
          ivSet.has(bassPc) &&
          lowestPitch !== null &&
          lowestPitch < 57;
        const symbol = useSlash
          ? `${rootName}${tpl.suffix}/${PITCH_CLASSES[bassPc]}`
          : `${rootName}${tpl.suffix}`;

        bestMatch = {
          symbol,
          root,
          bass: bassPc >= 0 ? bassPc : root,
          quality: tpl.suffix || 'maj',
          score,
        };
      }
    }
  }

  if (!bestMatch || bestMatch.score < 0.55) return null;
  return bestMatch;
}

export function analyzeMidiHarmony(
  notes: MidiNote[],
  ppqn: number,
  timeSignatures: MidiTimeSignature[],
  totalTicks: number
): MidiHarmonyAnalysis {
  const {
    primary: key,
    status: keyStatus,
    unknownReason: keyUnknownReason,
    secondaryLabel,
    isPercussionOnly,
  } = detectKeyFromNotes(notes);
  const pitchedNotes = notes.filter((n) => n.channel !== 9);

  if (pitchedNotes.length < 2 || totalTicks <= 0) {
    return {
      key,
      keyStatus,
      keyUnknownReason,
      secondaryKey: secondaryLabel,
      chords: [],
      progressionSummary: [],
      isPercussionOnly,
    };
  }

  const bars = buildBarGrid(ppqn, timeSignatures, totalTicks);
  const firstNoteTick = pitchedNotes[0].startTick;

  const rawWindows: DetectedChord[] = [];
  let avgWindowTicks = ppqn * 2;

  for (const bar of bars) {
    if (bar.endTick <= firstNoteTick) continue;
    const barLen = Math.max(1, bar.endTick - bar.startTick);
    const subdivisions = bar.numerator >= 4 && barLen >= ppqn * 2 ? 2 : 1;
    const subTicks = Math.max(1, Math.round(barLen / subdivisions));
    avgWindowTicks = subTicks;

    for (let s = 0; s < subdivisions; s++) {
      const wStart = bar.startTick + s * subTicks;
      const wEnd = s === subdivisions - 1 ? bar.endTick : Math.min(bar.endTick, wStart + subTicks);
      if (wEnd <= wStart) continue;

      const winLen = wEnd - wStart;
      const pcEnergy = new Array<number>(12).fill(0);
      let lowestPitch: number | null = null;

      for (const n of pitchedNotes) {
        const nEnd = n.startTick + n.durationTick;
        if (nEnd <= wStart) continue;
        if (n.startTick >= wEnd) break;

        const overlap = Math.min(wEnd, nEnd) - Math.max(wStart, n.startTick);
        if (overlap <= 0) continue;

        const pc = ((n.pitch % 12) + 12) % 12;
        const weight = (overlap / winLen) * (0.5 + n.velocity / 200);
        pcEnergy[pc] += weight;

        if (lowestPitch === null || n.pitch < lowestPitch) {
          lowestPitch = n.pitch;
        }
      }

      const match = matchChordWindow(pcEnergy, lowestPitch, key);
      if (match) {
        rawWindows.push({
          symbol: match.symbol,
          root: match.root,
          bass: match.bass,
          startTick: wStart,
          endTick: wEnd,
          startBar: bar.barNumber,
          quality: match.quality,
          score: match.score,
        });
      }
    }
  }

  // Merge consecutive windows with the same chord symbol
  const chords: DetectedChord[] = [];
  for (const ch of rawWindows) {
    const prev = chords[chords.length - 1];
    if (prev && prev.symbol === ch.symbol && ch.startTick <= prev.endTick + avgWindowTicks) {
      prev.endTick = ch.endTick;
      prev.score = Math.max(prev.score, ch.score);
    } else {
      chords.push({ ...ch });
    }
  }

  // Build compact progression summary (collapse immediate repeats)
  const progressionSummary: string[] = [];
  for (const ch of chords) {
    if (progressionSummary[progressionSummary.length - 1] !== ch.symbol) {
      progressionSummary.push(ch.symbol);
    }
  }

  return {
    key,
    keyStatus,
    keyUnknownReason,
    secondaryKey: secondaryLabel,
    chords,
    progressionSummary,
    isPercussionOnly,
  };
}
