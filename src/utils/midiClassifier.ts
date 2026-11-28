import type {
  FieldProvenance,
  InstrumentFamily,
  MidiDatasetMetadata,
  MidiFileEntry,
  MidiFileType,
  MidiNote,
  MidiOrigin,
  MusicalRole,
  ParsedMidi,
  TrackMetadataEntry,
  TrackableMetaField,
} from '../types/midi';
import {
  DEFAULT_ABBREVIATIONS,
  type LibraryAbbreviation,
} from './abbreviationProfile';
import {
  DEFAULT_ARTICULATION_PRESETS,
  DEFAULT_GENRE_PRESETS,
} from './metadataPresets';
import { getGmProgramName, getMidiCcLabel } from './midiConstants';
import { buildBarGrid, tickToBarNumber } from './midiTimeline';
import { analyzeMidiHarmony } from './musicTheory';

export const TRACK_CLASSIFIER_VERSION = 2;

export const ORIGIN_LABELS: Record<MidiOrigin, string> = {
  eigenkomposition: 'Eigenkomposition',
  library: 'Library',
  unbekannt: 'Unbekannt',
};

export const FILE_TYPE_LABELS: Record<MidiFileType, string> = {
  full_track: 'Full Track',
  pattern: 'Pattern',
  phrase: 'Phrase',
  loop: 'Loop',
  einzelspur: 'Einzelspur',
  unbekannt: 'Unbekannt',
};

export const INSTRUMENT_FAMILY_LABELS: Record<string, string> = {
  strings: 'Streicher',
  brass: 'Blechbläser',
  woodwinds: 'Holzbläser',
  keys: 'Tasten / Piano',
  synth: 'Synth',
  guitar_plucked: 'Gitarre / Zupfinstrument',
  bass: 'Bass',
  drums_percussion: 'Drums / Percussion',
  choir_vocal: 'Chor / Vocal',
  orchestra_ensemble: 'Orchester / Ensemble',
  fx_other: 'FX / Sonstiges',
  unbekannt: 'Unbekannt',
};

export const MUSICAL_ROLE_LABELS: Record<string, string> = {
  melodie: 'Melodie',
  gegenmelodie: 'Gegenmelodie',
  harmonie: 'Harmonie',
  bass: 'Bass',
  percussion: 'Percussion',
  ostinato_arp: 'Ostinato / Arp',
  arrangement: 'Full Arrangement',
  fx: 'FX / Textur',
  unbekannt: 'Unbekannt',
};

const FAMILY_LABEL_TO_ID: Record<string, string> = Object.fromEntries(
  Object.entries(INSTRUMENT_FAMILY_LABELS).map(([id, label]) => [label.toLowerCase(), id])
);

const ROLE_LABEL_TO_ID: Record<string, string> = Object.fromEntries(
  Object.entries(MUSICAL_ROLE_LABELS).map(([id, label]) => [label.toLowerCase(), id])
);

export function getInstrumentFamilyLabel(family: string): string {
  if (!family) return 'Unbekannt';
  return INSTRUMENT_FAMILY_LABELS[family] ?? family;
}

export function getMusicalRoleLabel(role: string): string {
  if (!role) return 'Unbekannt';
  return MUSICAL_ROLE_LABELS[role] ?? role;
}

export function toFamilyPresetOption(rawLabel: string): { value: string; label: string } {
  const clean = rawLabel.trim();
  const canonicalId = FAMILY_LABEL_TO_ID[clean.toLowerCase()];
  if (canonicalId) {
    return { value: canonicalId, label: INSTRUMENT_FAMILY_LABELS[canonicalId] };
  }
  return { value: clean, label: clean };
}

export function toRolePresetOption(rawLabel: string): { value: string; label: string } {
  const clean = rawLabel.trim();
  const canonicalId = ROLE_LABEL_TO_ID[clean.toLowerCase()];
  if (canonicalId) {
    return { value: canonicalId, label: MUSICAL_ROLE_LABELS[canonicalId] };
  }
  return { value: clean, label: clean };
}

export const ARTICULATION_SUGGESTIONS: string[] = DEFAULT_ARTICULATION_PRESETS.map(
  (a) => a.name
);

export const GENRE_SUGGESTIONS: string[] = [...DEFAULT_GENRE_PRESETS];

export const ALL_TRACKABLE_FIELDS: TrackableMetaField[] = [
  'origin',
  'fileType',
  'genre',
  'subgenres',
  'instrument',
  'instrumentFamily',
  'articulation',
  'musicalRole',
  'rating',
  'triage',
  'workStatus',
  'moods',
];

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stableShortHash(input: string): string {
  // Fast deterministic FNV-1a 32-bit hash for stable composition IDs when SHA-256 isn't ready
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function generateCompositionId(entry: MidiFileEntry): string {
  const stem = entry.name
    .replace(/\.(mid|midi)$/i, '')
    .toLowerCase()
    .replace(/[äöüß]/g, (ch) =>
      ch === 'ä' ? 'ae' : ch === 'ö' ? 'oe' : ch === 'ü' ? 'ue' : 'ss'
    )
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 22);
  const hashPart = (entry.originalSha256 || entry.sha256)
    ? (entry.originalSha256 || entry.sha256)!.slice(0, 8).toLowerCase()
    : stableShortHash(`${entry.relativePath}::${entry.sizeBytes}`);
  return `cmp-${stem || 'midi'}-${hashPart}`;
}

export function defaultSidecarRelativePath(relativePath: string): string {
  return relativePath.replace(/\.(mid|midi)$/i, '') + '.txt';
}

export function defaultSidecarFilename(filename: string): string {
  return filename.replace(/\.(mid|midi)$/i, '') + '.txt';
}

function normalizeForTokens(input: string): string {
  return input
    // Split CamelCase boundaries (e.g. BooBass -> Boo Bass, LowChoir -> Low Choir, CelloSpic -> Cello Spic)
    .replace(/([a-zäöüß])([A-ZÄÖÜ])/g, '$1 $2')
    .replace(/([A-ZÄÖÜ]+)([A-ZÄÖÜ][a-zäöüß])/g, '$1 $2')
    .toLowerCase()
    // Replace common separators with spaces
    .replace(/[_/\\.,;:()[\]{}+-]+/g, ' ')
    // Separate trailing digits from letters except protected tokens (808, 8va, 8dio, d2)
    .replace(/\b(?!808\b|8va\b|8dio\b|d2\b)([a-zäöüß]+)(\d+)\b/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface TrackNameClassification {
  instrument: string;
  instrumentFamily: InstrumentFamily;
  articulation: string;
  musicalRole: MusicalRole;
  matchedInstrumentFromName: boolean;
  matchedArticulationFromName: boolean;
  matchedRoleFromName: boolean;
}

const INSTRUMENT_DEFAULT_FAMILY: Record<string, InstrumentFamily> = {
  '808': 'bass',
  'bass-heavy': 'bass',
  'electronic-instruments': 'synth',
  Drums: 'drums_percussion',
  Kick: 'drums_percussion',
  Claps: 'drums_percussion',
  Snare: 'drums_percussion',
  Percussion: 'drums_percussion',
  HiHat: 'drums_percussion',
  Shaker: 'drums_percussion',
  Tambourine: 'drums_percussion',
  Openhat: 'drums_percussion',
  Crash: 'drums_percussion',
  'Cinematic Drums': 'drums_percussion',
  'Cinematic Percussions': 'drums_percussion',
  'Low Drums': 'drums_percussion',
  Dhol: 'drums_percussion',
  Timpani: 'drums_percussion',
  Taiko: 'drums_percussion',
  Toms: 'drums_percussion',
  Djembe: 'drums_percussion',
  Cymbals: 'drums_percussion',
  'Drum Loop': 'drums_percussion',
  'Sub Bass': 'bass',
  Bass: 'bass',
  'Bass Guitar': 'bass',
  'Pulsing Bass': 'bass',
  'Synth Bass': 'bass',
  Synth: 'synth',
  'Synth Keys': 'synth',
  'Synth Pad': 'synth',
  'Synth Lead': 'synth',
  Arpeggio: 'synth',
  Atmosphere: 'fx_other',
  'Acoustic Guitar': 'guitar_plucked',
  'E-Guitar': 'guitar_plucked',
  Piano: 'keys',
  Keys: 'keys',
  Celesta: 'keys',
  Pluck: 'guitar_plucked',
  Gongs: 'drums_percussion',
  'Tubular Bells': 'drums_percussion',
  Strings: 'strings',
  'Low Strings': 'strings',
  'Mid Strings': 'strings',
  'High Strings': 'strings',
  'Double Bass': 'strings',
  Cello: 'strings',
  Viola: 'strings',
  Violin: 'strings',
  Woodwind: 'woodwinds',
  Bassoon: 'woodwinds',
  Clarinet: 'woodwinds',
  Oboe: 'woodwinds',
  Whistle: 'woodwinds',
  Flute: 'woodwinds',
  Brass: 'brass',
  'Low Brass': 'brass',
  Horn: 'brass',
  'French Horn': 'brass',
  Trombone: 'brass',
  Trumpet: 'brass',
  Tuba: 'brass',
  Choir: 'choir_vocal',
  Vox: 'choir_vocal',
  'Male Voice': 'choir_vocal',
  'Female Voice': 'choir_vocal',
  Loop: 'fx_other',
};

export function getDefaultFamilyForInstrument(instrument: string): InstrumentFamily | null {
  const clean = instrument.trim();
  if (!clean) return null;
  if (INSTRUMENT_DEFAULT_FAMILY[clean]) return INSTRUMENT_DEFAULT_FAMILY[clean];
  const low = clean.toLowerCase();
  for (const [key, fam] of Object.entries(INSTRUMENT_DEFAULT_FAMILY)) {
    if (key.toLowerCase() === low) return fam;
  }
  return null;
}

function inferOrigin(entry: MidiFileEntry, folderHint?: string): MidiOrigin {
  const pathText = normalizeForTokens(`${folderHint || ''} ${entry.relativePath}`);
  if (
    /\bown\s?comp|\beigenkomposition|\beigene|\bmy\s?(tracks|songs|midi|music)|\bmeine\s?(songs|tracks|stuecke|komposition)/.test(
      pathText
    )
  ) {
    return 'eigenkomposition';
  }
  if (
    /\blibrary\s?midi|\blibrary|\blibraries|\bkontakt|\bsample\s?pack|\bmidi\s?pack|\blive\s?drums|\bdamage\s?drums|\bkits\b|\bdrum\s?loops|\bmelody\s?loops|\b808\s+midi/.test(
      pathText
    )
  ) {
    return 'library';
  }
  return 'unbekannt';
}

function inferFileType(entry: MidiFileEntry, parsed: ParsedMidi | null): MidiFileType {
  const pathText = normalizeForTokens(entry.relativePath);
  const nameOnly = normalizeForTokens(entry.name);

  if (/\bfull\s?track\b|\bfull\b|\bcomplete\b|\bmaster\b|\btrailermix\b/.test(pathText)) {
    return 'full_track';
  }
  if (/\bloop(s)?\b/.test(pathText)) {
    return 'loop';
  }
  if (/\bphrase(s)?\b|\briff(s)?\b|\blick(s)?\b|\bfill(s)?\b|\bmelod(y|ie)\s?line/.test(pathText)) {
    return 'phrase';
  }
  if (/\bpattern(s)?\b|\bgroove(s)?\b|\bbeat(s)?\b|\bkits?\b|\bdrum\s?kit/.test(pathText)) {
    return 'pattern';
  }
  if (
    /\beinzelspur\b|\bstem(s)?\b|\bsolo\b|\binstruments\b|\b808\s*midi\b|\bpiano\s*midi\b|\bhihats?\b/.test(
      pathText
    )
  ) {
    return 'einzelspur';
  }

  if (parsed) {
    const activeTracks = parsed.tracks.filter((t) => t.noteCount > 0).length;
    if (parsed.isCompleteComposition || (activeTracks >= 3 && parsed.barCount >= 24)) {
      return 'full_track';
    }
    if (activeTracks >= 3 && parsed.barCount >= 16 && !/\bloop\b|\bpattern\b/.test(nameOnly)) {
      return 'full_track';
    }
    if (parsed.isPercussionOnly) {
      return parsed.barCount <= 8 ? 'pattern' : 'loop';
    }
    if (activeTracks <= 1) {
      if (parsed.barCount <= 4) return 'loop';
      if (parsed.barCount <= 12) return 'phrase';
      return 'einzelspur';
    }
    if (parsed.barCount <= 8) return 'pattern';
    return 'full_track';
  }

  return 'unbekannt';
}

function inferGenreAndSubgenres(
  entry: MidiFileEntry,
  parsed: ParsedMidi | null,
  folderHint?: string
): { genre: string; subgenres: string[] } {
  const pathText = normalizeForTokens(`${folderHint || ''} ${entry.relativePath}`);
  const trackText = parsed
    ? normalizeForTokens(
        [
          parsed.metadata.sequenceName || '',
          ...parsed.tracks.map((t) => t.name),
          ...parsed.metadata.instruments,
          ...parsed.metadata.textEvents.map((t) => t.text),
        ].join(' ')
      )
    : '';
  const combined = `${pathText} ${trackText}`;

  let genre = '';
  const subs = new Set<string>();

  // Priority 1: Explicit folder/path genre cues aligned to Presets.md
  if (/\bhybrid[-_\s]?orchestr/.test(pathText)) {
    genre = 'Hybrid Orchestral';
  } else if (/\borchestr/.test(pathText)) {
    genre = /\bhybrid\b|\bsynth\b|\b808\b|\belectronic\b/.test(combined)
      ? 'Hybrid Orchestral'
      : 'Orchestral';
  } else if (/\bunderground[-_\s]?hip[-_\s]?hop\b|\bunderground\b/.test(pathText)) {
    genre = 'Underground-Hip-Hop';
  } else if (/\btrap\b/.test(pathText)) {
    genre = 'Trap';
  } else if (/\bhip[-_\s]?hop\b|\bboombap\b|\bboom[-_\s]?bap\b/.test(pathText)) {
    genre = /\bunderground\b/.test(combined) ? 'Underground-Hip-Hop' : 'Hip-Hop';
    if (/\bboom[-_\s]?bap\b|\bboombap\b/.test(combined)) subs.add('Boom Bap');
  } else if (/\bmetal\b/.test(pathText)) {
    genre = 'Metal';
  } else if (/\br&b\b|\brnb\b|\bsoul\b/.test(pathText)) {
    genre = 'R&B';
  } else if (/\bpop\b/.test(pathText)) {
    genre = 'Pop';
  } else if (/\blive[-_\s]?drums\b/.test(pathText)) {
    genre = 'Metal';
    subs.add('Live-Drums');
  } else if (/\brock\b/.test(pathText)) {
    genre = 'Metal';
  }

  // Priority 2: Content-based genre detection if path didn't specify
  if (!genre) {
    const hasOrchestralCues =
      /orchestr|string|cello|viol|brass|horn|trump|timpani|choir|ark|cs_|spic|stac|marc|leg|basson|taiko|djun|dhol|oboe|flute|cinematic|trailer/i.test(
        combined
      );
    const hasHybridCues = /hybrid|synth|808|sub\s?bass|pulsing\s?bass|electronic/i.test(
      combined
    );

    if (hasOrchestralCues && hasHybridCues) {
      genre = 'Hybrid Orchestral';
    } else if (hasOrchestralCues) {
      genre = 'Orchestral';
    } else if (/808|hihat|drill|trap/i.test(combined)) {
      genre = 'Trap';
    } else if (/underground/i.test(combined)) {
      genre = 'Underground-Hip-Hop';
    } else if (/hiphop|hip-hop|beat|boombap|boom bap/i.test(combined)) {
      genre = 'Hip-Hop';
    } else if (/metal|djent|distort|e-guitar/i.test(combined)) {
      genre = 'Metal';
    } else if (/r&b|rnb|soul|rhodes/i.test(combined)) {
      genre = 'R&B';
    } else if (/piano|klavier|grand|keys/i.test(combined)) {
      genre = 'Orchestral';
      subs.add('Neoclassical');
    } else if (/synth|arp|edm|electro|techno|house|bassline/i.test(combined)) {
      genre = 'Hybrid Orchestral';
    } else if (parsed?.isPercussionOnly) {
      genre = 'Hip-Hop';
    } else {
      genre = 'Orchestral';
    }
  }

  // Subgenre enrichment aligned to DEFAULT_SUBGENRE_PRESETS
  if (/\bcinematic\b/.test(combined) || genre === 'Orchestral' || genre === 'Hybrid Orchestral') {
    subs.add('Cinematic');
  }
  if (/\btrailer\b/.test(combined)) subs.add('Trailer');
  if (/\bhybrid\b/.test(combined)) subs.add('Hybrid');
  if (/\bepic\b|\bheroic\b/.test(combined)) subs.add('Epic');
  if (/\bdark\b|\bdüster\b|\babgrund\b|\bshadow\b/.test(combined)) subs.add('Dark');
  if (/\bboom[-_\s]?bap\b|\bboombap\b/.test(combined)) subs.add('Boom Bap');
  if (/\bold[-_\s]?school\b/.test(combined)) subs.add('Old-School');
  if (/\bdrill\b/.test(combined)) subs.add('Drill');
  if (/\blive[-_\s]?drums\b/.test(pathText)) subs.add('Live-Drums');
  if (/\bdamage\b|\baction\b/.test(combined)) subs.add('Action');
  if (/\blo[-_\s]?fi\b/.test(combined)) subs.add('Lo-Fi');
  if (/\bambient\b|\batmosphere\b/.test(combined)) subs.add('Ambient');
  if (/\bacoustic\b|\bakustik\b/.test(combined)) subs.add('Acoustic');
  if (
    parsed?.detectedKey?.mode === 'minor' &&
    (genre === 'Orchestral' || genre === 'Hybrid Orchestral') &&
    subs.size < 3
  ) {
    subs.add('Dark');
  }
  if (
    parsed &&
    parsed.primaryBpm >= 115 &&
    (genre === 'Orchestral' || genre === 'Hybrid Orchestral') &&
    (/spic|marc|epic|trailer|battl|taiko|djun/i.test(combined) || parsed.tracks.length >= 6)
  ) {
    subs.add('Trailer');
  }

  return { genre, subgenres: Array.from(subs).slice(0, 5) };
}

type PercArticulationStyle = 'hits' | 'oneshots' | null;

function computeTrackPolyphony(notes: MidiNote[], ppqn: number): number {
  if (notes.length === 0) return 1;
  const quant = Math.max(1, Math.round(ppqn / 4));
  const buckets = new Map<number, number>();
  for (const n of notes) {
    const b = Math.round(n.startTick / quant);
    buckets.set(b, (buckets.get(b) || 0) + 1);
  }
  let groups = 0;
  let total = 0;
  for (const cnt of buckets.values()) {
    groups++;
    total += cnt;
  }
  return groups > 0 ? total / groups : 1;
}

export function classifyTrackName(
  rawName: string,
  options?: {
    abbreviations?: LibraryAbbreviation[];
    notes?: MidiNote[];
    ppqn?: number;
    isPercussionOnly?: boolean;
    gmPrograms?: number[];
  }
): TrackNameClassification {
  const abbreviations = options?.abbreviations ?? DEFAULT_ABBREVIATIONS;
  const notes = options?.notes ?? [];
  const ppqn = options?.ppqn ?? 480;
  const isPercussionOnly = options?.isPercussionOnly ?? false;
  const gmPrograms = options?.gmPrograms ?? [];

  const gmNames = gmPrograms.map((p) => getGmProgramName(p)).join(' ');
  const nameTokensStr = normalizeForTokens(rawName);
  const combined = normalizeForTokens(`${rawName} ${gmNames}`);
  const tokens = nameTokensStr ? nameTokensStr.split(' ') : [];
  const tokenSet = new Set(tokens);
  const hasToken = (...keys: string[]) => keys.some((k) => tokenSet.has(k));

  // Context cues parsed from the track name
  const isOrchestralLib = hasToken(
    'ark',
    'css',
    'cs',
    'bl',
    '8dio',
    'cine',
    'spitfire',
    'bbcso',
    'albion',
    'berlin',
    'ot',
    'lass',
    'tina',
    'josh',
    'drama'
  );
  const isDamage2 =
    hasToken('d2', 'damage', 'armakit') ||
    (hasToken('arma') && hasToken('kit')) ||
    (hasToken('monster') && hasToken('low', 'lows', 'mid', 'mids', 'hi', 'high'));

  const isVoice1 =
    /\b(violin|violine|volin|vio|vln)\s+(1|i)\b/.test(nameTokensStr) || hasToken('v1');
  const isVoice2 =
    /\b(violin|violine|volin|vio|vln)\s+(2|ii)\b/.test(nameTokensStr) || hasToken('v2');
  const isSolo =
    hasToken('solo', 'tina', 'jenny') || /\bjosh\s+bell\b/.test(nameTokensStr);
  const hasLow = hasToken('low', 'lows', 'sub', 'deep');
  const hasMid = hasToken('mid', 'mids');
  const hasHigh = hasToken('hi', 'high', 'highs');
  const hasEns = hasToken('ens', 'ensemble');
  const hasUni = hasToken('uni', 'unison', 'unisono');
  const has8va = hasToken('8va', 'ottava');
  const hasDrama = hasToken('drama');
  const hasHarmWord = hasToken('harm');
  const hasSoft = hasToken('soft', 'gentle', 'quiet');

  // 1) Explicit articulation detection from track name
  let articulation = '';
  let matchedArticulationFromName = false;

  const artPatterns: Array<[RegExp, string]> = [
    [/\bstaccis\b|\bstaccatissimo\b/i, 'Staccatissimo'],
    [/\bspic(c|cato)?\b/i, 'Spiccato'],
    [/\bstac(c|cato)?\b/i, 'Staccato'],
    [/\bmarc(ato)?\b/i, 'Marcato'],
    [/\bmart(el[eé])?\b/i, 'Martelé'],
    [/\bleg(ato)?\b/i, 'Legato'],
    [/\bpizz(icato)?\b/i, 'Pizzicato'],
    [/\bflag(eolett)?\b|\bharmonics?\b/i, 'Flageolett'],
    [/\bcres(c|cendo)?\b/i, 'Crescendo'],
    [/\bswell(s)?\b/i, 'Swell'],
    [/\btrem(olo)?\b/i, 'Tremolo'],
    [/\bsord(ino)?\b|\bcon\s+sordino\b/i, 'Con sordino'],
    [/\bsul\s+pon(ticello)?\b/i, 'Sul ponticello'],
    [/\bsul\s+tas(to)?\b/i, 'Sul tasto'],
    [/\bgliss(ando|andi)?\b/i, 'Glissandi (Glissando)'],
    [/\bport(ato)?\b/i, 'Portato'],
    [/\btenu(to)?\b/i, 'Tenuto'],
    [/\bdt\b|\bd[eé]tach[eé]\b/i, 'Détaché'],
    [/\bsus(tain(ed)?)?\b/i, 'Sustain'],
    [/\bone\s*shots?\b/i, 'One-Shots'],
    [/\bhits?\b/i, 'Hits'],
  ];

  for (const [rx, label] of artPatterns) {
    if (rx.test(nameTokensStr)) {
      articulation = label;
      matchedArticulationFromName = true;
      break;
    }
  }

  // Fallback to user-configured articulation abbreviations (excluding Ens/8va/Uni which are modifiers)
  if (!articulation) {
    const knownArtNames = new Set(DEFAULT_ARTICULATION_PRESETS.map((a) => a.name.toLowerCase()));
    for (const abbr of abbreviations) {
      const k = abbr.key.trim();
      if (!k) continue;
      const kLow = k.toLowerCase();
      if (kLow === 'ens' || kLow === '8va' || kLow === 'uni') continue;
      const rx = new RegExp(`\\b${escapeRegExp(k)}\\b`, 'i');
      if (rx.test(nameTokensStr)) {
        const m = abbr.meaning.toLowerCase();
        if (
          knownArtNames.has(m) ||
          /spiccato|staccato|staccatissimo|legato|marcato|martel|sustain|sordino|pizzicato|flageolett|harmonics|crescendo|swell|gliss|portato|tenuto|detach|tremolo|ponticello|tasto|one-shots|hits/.test(
            m
          )
        ) {
          articulation = abbr.meaning;
          matchedArticulationFromName = true;
          break;
        }
      }
    }
  }

  // 2) Instrument & Instrument Family detection (aligned to Presets.md)
  let instrument = '';
  let instrumentFamily: InstrumentFamily = 'unbekannt';
  let percStyle: PercArticulationStyle = null;
  let matchedInstrumentFromName = false;
  let isJenny = false;
  let isCimbasso = false;
  let isCineHorn = false;

  const setInst = (inst: string, fam: InstrumentFamily, pStyle: PercArticulationStyle = null) => {
    instrument = inst;
    instrumentFamily = fam;
    percStyle = pStyle;
    matchedInstrumentFromName = true;
  };

  // Priority A: Choir / Vocal (before generic Low/High/Solo)
  if (hasToken('jenny')) {
    isJenny = true;
    setInst('Choir', 'choir_vocal');
  } else if (
    hasToken(
      'choir',
      'chor',
      'men',
      'women',
      'woman',
      'man',
      'alto',
      'soprano',
      'tenor',
      'bariton',
      'baritone'
    )
  ) {
    setInst('Choir', 'choir_vocal');
  } else if (/\bfemale\s+voice\b/.test(nameTokensStr)) {
    setInst('Female Voice', 'choir_vocal');
  } else if (/\bmale\s+voice\b/.test(nameTokensStr)) {
    setInst('Male Voice', 'choir_vocal');
  } else if (hasToken('vox', 'vocal', 'vocals', 'voice', 'voices')) {
    setInst('Vox', 'choir_vocal');
  }
  // Priority B: Damage 2 & Drums / Percussion
  else if (isDamage2) {
    if (hasLow) {
      setInst('Low Drums', 'drums_percussion', 'hits');
    } else if (hasToken('monster') && (hasHigh || hasMid)) {
      setInst('Cinematic Percussions', 'drums_percussion', 'hits');
    } else {
      setInst('Cinematic Drums', 'drums_percussion', 'hits');
    }
  } else if (/\bopen\s*hats?\b|\boh\b/.test(nameTokensStr)) {
    setInst('Openhat', 'drums_percussion', 'oneshots');
  } else if (/\bhi\s*hats?\b|\bhh\b/.test(nameTokensStr)) {
    setInst('HiHat', 'drums_percussion', 'oneshots');
  } else if (/\bcinematic\s+drums?\b/.test(nameTokensStr)) {
    setInst('Cinematic Drums', 'drums_percussion', 'hits');
  } else if (/\bcinematic\s+perc(ussion)?s?\b/.test(nameTokensStr)) {
    setInst('Cinematic Percussions', 'drums_percussion', 'hits');
  } else if (/\blow\s+(drums?|boom)\b|\bboom\b/.test(nameTokensStr)) {
    setInst('Low Drums', 'drums_percussion', 'hits');
  } else if (/\bdrum\s+loops?\b/.test(nameTokensStr)) {
    setInst('Drum Loop', 'drums_percussion', 'hits');
  } else if (hasToken('taiko', 'taikos')) {
    setInst('Taiko', 'drums_percussion', 'hits');
  } else if (hasToken('timp', 'timpani', 'pauke', 'pauken')) {
    setInst('Timpani', 'drums_percussion', 'hits');
  } else if (hasToken('dhol', 'dhols', 'dohl', 'dohls')) {
    setInst('Dhol', 'drums_percussion', 'hits');
  } else if (hasToken('djun', 'djuns')) {
    setInst('Drums', 'drums_percussion', 'hits');
  } else if (hasToken('djembe', 'djembes')) {
    setInst('Djembe', 'drums_percussion', 'hits');
  } else if (/\btam\s*tam\b|\bgongs?\b/.test(nameTokensStr)) {
    setInst('Gongs', 'drums_percussion', 'hits');
  } else if (
    /\btubular\s+bells?\b|\bglocken?\b|\bchimes?\b/.test(nameTokensStr) ||
    (hasToken('bell', 'bells') && !/\bjosh\s+bell\b/.test(nameTokensStr))
  ) {
    setInst('Tubular Bells', 'drums_percussion', 'hits');
  } else if (hasToken('tom', 'toms')) {
    setInst('Toms', 'drums_percussion', 'hits');
  } else if (hasToken('kick', 'kicks', 'bd')) {
    setInst('Kick', 'drums_percussion', 'oneshots');
  } else if (hasToken('clap', 'claps')) {
    setInst('Claps', 'drums_percussion', 'oneshots');
  } else if (hasToken('snare', 'snares', 'snr')) {
    setInst('Snare', 'drums_percussion', 'oneshots');
  } else if (hasToken('rim', 'rimshot', 'rimshots')) {
    setInst('Percussion', 'drums_percussion', 'oneshots');
  } else if (hasToken('shaker', 'shakers')) {
    setInst('Shaker', 'drums_percussion', 'oneshots');
  } else if (hasToken('tambourine', 'tambourines', 'tamb')) {
    setInst('Tambourine', 'drums_percussion', 'oneshots');
  } else if (hasToken('crash', 'crashes')) {
    setInst('Crash', 'drums_percussion', 'oneshots');
  } else if (hasToken('cymbal', 'cymbals', 'cym', 'ride')) {
    setInst('Cymbals', 'drums_percussion', 'oneshots');
  } else if (hasToken('perc', 'percussion', 'percussions')) {
    setInst('Percussion', 'drums_percussion', 'hits');
  } else if (hasToken('drum', 'drums', 'kit', 'kits', 'groove')) {
    setInst('Drums', 'drums_percussion', 'hits');
  }
  // Priority C: Woodwinds (before Bass because Bassoon/Basson contains bass)
  else if (hasToken('bassoon', 'bassoons', 'basson', 'bassons', 'bsn', 'fagott', 'fagotte')) {
    setInst('Bassoon', 'woodwinds');
  } else if (
    hasToken('clarinet', 'clarinets', 'clarinett', 'clarinetts', 'klarinette', 'klarinetten', 'cl')
  ) {
    setInst('Clarinet', 'woodwinds');
  } else if (hasToken('oboe', 'oboes', 'oboen', 'ob')) {
    setInst('Oboe', 'woodwinds');
  } else if (hasToken('flute', 'flutes', 'flöte', 'flöten', 'floete', 'piccolo', 'picc', 'fl')) {
    setInst('Flute', 'woodwinds');
  } else if (hasToken('whistle', 'whistles')) {
    setInst('Whistle', 'woodwinds');
  } else if (hasToken('woodwind', 'woodwinds', 'holzbläser', 'holzblaeser', 'ww')) {
    setInst('Woodwind', 'woodwinds');
  }
  // Priority D: Brass
  else if (hasToken('cimbasso', 'cimbassi', 'cimb')) {
    isCimbasso = true;
    setInst('Low Brass', 'brass');
  } else if (/\blow\s+brass\b/.test(nameTokensStr)) {
    setInst('Low Brass', 'brass');
  } else if (/\bfrench\s+horns?\b|\bfhn\b/.test(nameTokensStr)) {
    setInst('French Horn', 'brass');
  } else if (/\bcine\s+horns?\b/.test(nameTokensStr)) {
    isCineHorn = true;
    setInst('Horn', 'brass');
  } else if (hasToken('horn', 'horns', 'hn', 'hns')) {
    setInst('Horn', 'brass');
  } else if (
    hasToken('trumpet', 'trumpets', 'trompete', 'trompeten', 'trump', 'trp', 'tpt', 'tpts')
  ) {
    setInst('Trumpet', 'brass');
  } else if (hasToken('trombone', 'trombones', 'posaune', 'posaunen', 'trb', 'tbn', 'tbns')) {
    setInst('Trombone', 'brass');
  } else if (hasToken('tuba', 'tubas', 'tba')) {
    setInst('Tuba', 'brass');
  } else if (hasToken('brass', 'blech')) {
    setInst('Brass', 'brass');
  }
  // Priority E: Piano / Keys
  else if (hasToken('celesta', 'celeste')) {
    setInst('Celesta', 'keys');
  } else if (
    hasToken('piano', 'pianos', 'klavier', 'grand') ||
    /\bvintage\s+d\b/.test(nameTokensStr)
  ) {
    setInst('Piano', 'keys');
  } else if (hasToken('epiano', 'rhodes', 'wurlitzer', 'keys', 'organ', 'orgel', 'harpsichord')) {
    setInst('Keys', 'keys');
  }
  // Priority F: Strings (including orchestral Double Bass & implicit Ark/BL/CSS string registers)
  else if (
    /\b(contrabass|kontrabass|double\s+bass|upright\s+bass)\b/.test(nameTokensStr) ||
    hasToken('cb', 'db', 'dbs') ||
    (hasToken('bass', 'basses') &&
      !hasToken('synth', 'sub', '808', 'boo', 'guitar', 'pulsing', 'pulse') &&
      (isOrchestralLib ||
        hasToken('spic', 'spicc', 'spiccato', 'stac', 'stacc', 'staccato', 'pizz', 'pizzicato', 'leg', 'legato', 'marc', 'trem', 'sord', 'flag')))
  ) {
    setInst('Double Bass', 'strings');
  } else if (hasToken('cello', 'cellos', 'celli', 'vc', 'vcl', 'tina')) {
    setInst('Cello', 'strings');
  } else if (hasToken('viola', 'violas', 'vla', 'vlas', 'bratsche', 'bratschen')) {
    setInst('Viola', 'strings');
  } else if (
    hasToken('violin', 'violins', 'violine', 'violinen', 'volin', 'vio', 'vln', 'vlns', 'geige', 'geigen') ||
    /\bjosh\s+bell\b/.test(nameTokensStr)
  ) {
    setInst('Violin', 'strings');
  } else if (/\blow\s+strings?\b/.test(nameTokensStr)) {
    setInst('Low Strings', 'strings');
  } else if (/\bmid\s+strings?\b/.test(nameTokensStr)) {
    setInst('Mid Strings', 'strings');
  } else if (/\b(high|hi)\s+strings?\b/.test(nameTokensStr)) {
    setInst('High Strings', 'strings');
  } else if (hasToken('string', 'strings', 'streicher', 'str')) {
    setInst('Strings', 'strings');
  }
  // Priority G: Synth / Bass / Guitar / FX
  else if (hasToken('808')) {
    setInst('808', 'bass');
  } else if (/\b(sub|deep)\s+bass\b/.test(nameTokensStr)) {
    setInst('Sub Bass', 'bass');
  } else if (/\bpuls(e|ing)\s+bass\b/.test(nameTokensStr)) {
    setInst('Pulsing Bass', 'bass');
  } else if (/\bsynth\s+bass\b/.test(nameTokensStr)) {
    setInst('Synth Bass', 'bass');
  } else if (/\b(bass\s+guitar|boo\s+bass)\b/.test(nameTokensStr)) {
    setInst('Bass', 'bass');
  } else if (/\bbass\s+heavy\b/.test(nameTokensStr)) {
    setInst('bass-heavy', 'bass');
  } else if (hasToken('bass')) {
    setInst('Bass', 'bass');
  } else if (/\b(acoustic\s+guitar|akustik\s+gitarre)\b/.test(nameTokensStr)) {
    setInst('Acoustic Guitar', 'guitar_plucked');
  } else if (
    /\be\s+guitar\b|\belectric\s+guitar\b/.test(nameTokensStr) ||
    hasToken('guitar', 'guitars', 'gitarre', 'gitarren', 'gitar')
  ) {
    setInst('E-Guitar', 'guitar_plucked');
  } else if (hasToken('pluck', 'plucks', 'harp', 'harps', 'harfe', 'harfen')) {
    setInst('Pluck', 'guitar_plucked');
  } else if (/\bsynth\s+keys\b/.test(nameTokensStr)) {
    setInst('Synth Keys', 'synth');
  } else if (/\bsynth\s+pad\b/.test(nameTokensStr) || hasToken('pad', 'pads')) {
    setInst('Synth Pad', 'synth');
  } else if (/\bsynth\s+lead\b/.test(nameTokensStr) || hasToken('lead', 'leads')) {
    setInst('Synth Lead', 'synth');
  } else if (hasToken('arp', 'arpeggio', 'arpeggios')) {
    setInst('Arpeggio', 'synth');
  } else if (hasToken('synth', 'nexus', 'serum', 'omnisphere', 'sylenth', 'massive')) {
    setInst('Synth', 'synth');
  } else if (hasToken('atmosphere', 'atmo', 'drone', 'drones', 'fx', 'sfx', 'riser', 'braam')) {
    setInst('Atmosphere', 'fx_other');
  }
  // Priority H: Implicit Orchestral Strings (e.g. ARK-Hi_Spic_Uni, BL-Ens_Sus, High_Cres, Low_Sus_Ark, Mid_Stac_Ark)
  else if (
    (hasHigh || hasMid || hasLow || hasEns) &&
    (isOrchestralLib || matchedArticulationFromName || hasUni || has8va)
  ) {
    if (hasLow) setInst('Low Strings', 'strings');
    else if (hasMid) setInst('Mid Strings', 'strings');
    else if (hasHigh) setInst('High Strings', 'strings');
    else setInst('Strings', 'strings');
  } else if (hasToken('loop', 'loops')) {
    setInst('Loop', 'fx_other');
  }

  // Fallback to GM program / drum channel when track name didn't identify the instrument
  if (!matchedInstrumentFromName) {
    if (isPercussionOnly) {
      instrument = 'Drums';
      instrumentFamily = 'drums_percussion';
      percStyle = 'hits';
    } else if (gmPrograms.length > 0) {
      const prog = gmPrograms[0];
      const firstGm = getGmProgramName(prog);
      let fam: InstrumentFamily = 'unbekannt';
      if (prog <= 7) fam = 'keys';
      else if (prog <= 15) fam = 'drums_percussion';
      else if (prog <= 23) fam = 'keys';
      else if (prog <= 31) fam = 'guitar_plucked';
      else if (prog <= 39) fam = 'bass';
      else if (prog <= 51) fam = 'strings';
      else if (prog <= 55) fam = 'choir_vocal';
      else if (prog <= 63) fam = 'brass';
      else if (prog <= 79) fam = 'woodwinds';
      else if (prog <= 103) fam = 'synth';
      else fam = 'fx_other';
      instrument = firstGm;
      instrumentFamily = fam;
    } else if (/\b(strings?|streicher)\b/.test(combined)) {
      instrument = 'Strings';
      instrumentFamily = 'strings';
    }
  }

  // 3) Smart articulation fallback when not explicitly named in track label
  const resolvedPercStyle = percStyle as PercArticulationStyle;
  if (!articulation) {
    if (instrumentFamily === 'drums_percussion' || isPercussionOnly) {
      articulation = resolvedPercStyle === 'oneshots' ? 'One-Shots' : 'Hits';
    } else if (isJenny) {
      articulation = 'Legato';
    } else if (instrument === 'Arpeggio') {
      articulation = 'Normal';
    } else if (instrumentFamily === 'strings') {
      if (hasDrama) {
        articulation = 'Sustain';
      } else if (
        isSolo ||
        instrument === 'Violin' ||
        instrument === 'Viola' ||
        instrument === 'Cello'
      ) {
        articulation = 'Legato';
      } else {
        articulation = 'Sustain';
      }
    } else if (
      matchedInstrumentFromName &&
      (instrumentFamily === 'brass' ||
        instrumentFamily === 'keys' ||
        instrumentFamily === 'bass' ||
        instrumentFamily === 'choir_vocal' ||
        instrumentFamily === 'synth' ||
        instrumentFamily === 'woodwinds')
    ) {
      articulation = 'Sustain';
    } else if (notes.length >= 8) {
      let shortCount = 0;
      let longCount = 0;
      for (const n of notes) {
        if (n.durationSec <= 0.22) shortCount++;
        if (n.durationSec >= 0.85) longCount++;
      }
      if (shortCount / notes.length >= 0.72) articulation = 'Spiccato';
      else if (longCount / notes.length >= 0.55) articulation = 'Sustain';
      else articulation = 'Legato';
    } else {
      articulation = 'Sustain';
    }
  }

  // 4) Musical Role classification (aligned to Presets.md & user naming conventions)
  let musicalRole: MusicalRole = 'unbekannt';
  let matchedRoleFromName = false;
  const setRole = (role: MusicalRole) => {
    musicalRole = role;
    matchedRoleFromName = true;
  };

  const avgPoly = notes.length > 0 ? computeTrackPolyphony(notes, ppqn) : 1;

  if (articulation === 'Crescendo') {
    setRole('Akzent');
  } else if (articulation === 'Flageolett') {
    setRole('harmonie');
  } else if (hasHarmWord) {
    setRole('harmonie');
  } else if (hasUni && articulation === 'Sustain') {
    setRole('Layer');
  } else if (instrumentFamily === 'drums_percussion' || isPercussionOnly) {
    if (hasLow || instrument === 'Low Drums') {
      setRole('Low-End');
    } else if (
      instrument === 'Crash' ||
      instrument === 'Tubular Bells' ||
      instrument === 'Openhat' ||
      instrument === 'Shaker'
    ) {
      setRole('Akzent');
    } else {
      setRole('Rhythmus');
    }
  } else if (instrumentFamily === 'choir_vocal') {
    if (isJenny || hasLow) {
      setRole('Akzent');
    } else if (articulation === 'Staccato') {
      setRole('Rhythmischer Akzent');
    } else if (
      articulation === 'Marcato' ||
      articulation === 'Legato' ||
      hasToken('bariton', 'baritone', 'alto', 'solo')
    ) {
      setRole('gegenmelodie');
    } else {
      setRole('harmonie');
    }
  } else if (instrumentFamily === 'bass') {
    setRole('Low-End');
  } else if (articulation === 'Spiccato') {
    if (has8va) {
      setRole('Rhythmischer Akzent');
    } else {
      setRole('ostinato_arp');
    }
  } else if (articulation === 'Staccato') {
    if (instrumentFamily === 'strings' || (instrumentFamily === 'woodwinds' && instrument === 'Flute')) {
      setRole('ostinato_arp');
    } else {
      setRole('Rhythmischer Akzent');
    }
  } else if (instrumentFamily === 'strings') {
    if (hasLow || instrument === 'Double Bass' || instrument === 'Low Strings') {
      setRole('Low-End');
    } else if (hasEns || instrument === 'High Strings' || instrument === 'Strings') {
      setRole('harmonie');
    } else if (isVoice1 || isSolo) {
      setRole('melodie');
    } else if (isVoice2 || instrument === 'Viola') {
      setRole('gegenmelodie');
    } else if (instrument === 'Violin') {
      setRole('melodie');
    } else if (articulation === 'Sustain') {
      setRole('harmonie');
    } else {
      setRole('gegenmelodie');
    }
  } else if (instrumentFamily === 'brass') {
    if (isCimbasso) {
      setRole('Akzent');
    } else if (hasLow || instrument === 'Low Brass' || instrument === 'Tuba') {
      setRole('Low-End');
    } else if (isCineHorn) {
      setRole('melodie');
    } else if (hasSoft) {
      setRole('gegenmelodie');
    } else if (articulation === 'Sustain' && avgPoly >= 2.15) {
      setRole('harmonie');
    } else {
      setRole('gegenmelodie');
    }
  } else if (instrumentFamily === 'woodwinds') {
    if (articulation === 'Sustain') {
      setRole('harmonie');
    } else {
      setRole('gegenmelodie');
    }
  } else if (instrumentFamily === 'keys') {
    if (hasLow) {
      setRole('Low-End');
    } else if (hasToken('cold')) {
      setRole('Akzent');
    } else if (hasToken('ascend')) {
      setRole('gegenmelodie');
    } else {
      setRole('melodie');
    }
  } else if (instrumentFamily === 'synth') {
    if (instrument === 'Synth Pad') {
      setRole('harmonie');
    } else if (instrument === 'Arpeggio') {
      setRole('gegenmelodie');
    } else if (instrument === 'Synth Lead') {
      setRole('melodie');
    } else {
      setRole('harmonie');
    }
  } else if (instrumentFamily === 'fx_other') {
    setRole('fx');
  } else if (hasToken('gegenmelodie')) {
    setRole('gegenmelodie');
  } else if (hasToken('melodie', 'melody', 'theme', 'thema')) {
    setRole('melodie');
  } else if (hasToken('chord', 'chords', 'harmonie', 'harmony')) {
    setRole('harmonie');
  } else if (notes.length > 0) {
    let pitchSum = 0;
    for (const n of notes) pitchSum += n.pitch;
    const avgPitch = pitchSum / notes.length;
    if (avgPitch < 48 && avgPoly < 1.6) musicalRole = 'Low-End';
    else if (avgPoly >= 2.15) musicalRole = 'harmonie';
    else musicalRole = 'melodie';
  }

  return {
    instrument,
    instrumentFamily,
    articulation,
    musicalRole,
    matchedInstrumentFromName,
    matchedArticulationFromName,
    matchedRoleFromName,
  };
}

function inferInstrumentAndArticulationFromText(
  combined: string,
  abbreviations: LibraryAbbreviation[],
  notes: MidiNote[],
  isPercussionOnly: boolean,
  gmPrograms: number[]
): {
  instrument: string;
  instrumentFamily: InstrumentFamily;
  articulation: string;
} {
  const res = classifyTrackName(combined, {
    abbreviations,
    notes,
    isPercussionOnly,
    gmPrograms,
  });
  return {
    instrument: res.instrument,
    instrumentFamily: res.instrumentFamily,
    articulation: res.articulation,
  };
}

export function buildAutoTrackMetadata(
  parsed: ParsedMidi | null,
  abbreviations: LibraryAbbreviation[],
  importantTracks?: MidiDatasetMetadata['importantTracks']
): TrackMetadataEntry[] {
  if (!parsed) return [];
  const activeTracks = parsed.tracks.filter((t) => t.noteCount > 0);
  if (activeTracks.length === 0) return [];

  const notesByTrack = new Map<number, MidiNote[]>();
  for (const n of parsed.notes) {
    const arr = notesByTrack.get(n.trackIndex) || [];
    arr.push(n);
    notesByTrack.set(n.trackIndex, arr);
  }

  const progsByTrack = new Map<number, number[]>();
  for (const pc of parsed.performance.programChanges) {
    const arr = progsByTrack.get(pc.trackIndex) || [];
    arr.push(pc.program);
    progsByTrack.set(pc.trackIndex, arr);
  }

  const matchInList = (list: string[] | undefined, name: string): boolean => {
    if (!list || list.length === 0) return false;
    const norm = name.trim().toLowerCase();
    return list.some((x) => x.trim().toLowerCase() === norm);
  };

  return activeTracks.map((tr) => {
    const trNotes = notesByTrack.get(tr.index) || [];
    const trProgs = progsByTrack.get(tr.index) || [];
    const isDrumOnly = tr.channels.length > 0 && tr.channels.every((ch) => ch === 9);

    const classified = classifyTrackName(tr.name, {
      abbreviations,
      notes: trNotes,
      ppqn: parsed.ppqn,
      isPercussionOnly: isDrumOnly,
      gmPrograms: trProgs,
    });

    let musicalRole: MusicalRole = classified.musicalRole;

    // Respect explicit importantTracks overrides when hydrating legacy sidecars without trackMetadata
    if (importantTracks) {
      if (matchInList(importantTracks.hauptmelodie, tr.name)) musicalRole = 'melodie';
      else if (matchInList(importantTracks.gegenmelodie, tr.name)) musicalRole = 'gegenmelodie';
      else if (matchInList(importantTracks.harmonie, tr.name)) musicalRole = 'harmonie';
      else if (matchInList(importantTracks.bass, tr.name)) musicalRole = 'Low-End';
      else if (matchInList(importantTracks.rhythmischesFundament, tr.name)) {
        if (!classified.matchedRoleFromName) {
          musicalRole = 'Rhythmus';
        }
      }
    }

    return {
      trackIndex: tr.index,
      trackName: tr.name,
      noteCount: tr.noteCount,
      instrument: classified.instrument || tr.name,
      instrumentFamily: classified.instrumentFamily,
      articulation: classified.articulation,
      musicalRole,
      confirmed: false,
    };
  });
}

export function rebuildImportantTracksFromTrackMeta(
  tracks: TrackMetadataEntry[]
): MidiDatasetMetadata['importantTracks'] {
  const result: MidiDatasetMetadata['importantTracks'] = {
    hauptmelodie: [],
    gegenmelodie: [],
    harmonie: [],
    bass: [],
    rhythmischesFundament: [],
  };
  for (const tr of tracks) {
    const norm = tr.musicalRole.trim().toLowerCase();
    if (norm === 'melodie') result.hauptmelodie.push(tr.trackName);
    else if (norm === 'gegenmelodie') result.gegenmelodie.push(tr.trackName);
    else if (
      norm === 'harmonie' ||
      norm === 'layer' ||
      norm.includes('pad') ||
      norm.includes('atmo')
    ) {
      result.harmonie.push(tr.trackName);
    } else if (norm === 'bass' || norm === 'low-end' || norm === 'low end') {
      result.bass.push(tr.trackName);
    } else if (
      norm === 'percussion' ||
      norm === 'ostinato_arp' ||
      norm === 'drums' ||
      norm === 'rhythmus' ||
      norm === 'akzent' ||
      norm === 'rhythmischer akzent'
    ) {
      result.rhythmischesFundament.push(tr.trackName);
    }
  }
  return result;
}

function inferInstrumentAndArticulation(
  entry: MidiFileEntry,
  parsed: ParsedMidi | null,
  fileType: MidiFileType,
  abbreviations: LibraryAbbreviation[]
): {
  instrument: string;
  instrumentFamily: InstrumentFamily;
  articulation: string;
} {
  const activeTracks = parsed ? parsed.tracks.filter((t) => t.noteCount > 0) : [];
  const pathAndName = normalizeForTokens(`${entry.folderPath} ${entry.name}`);
  const trackNames = normalizeForTokens(activeTracks.map((t) => t.name).join(' '));
  const gmNames = parsed
    ? normalizeForTokens(
        parsed.performance.programChanges.map((pc) => getGmProgramName(pc.program)).join(' ')
      )
    : '';
  const combined = `${pathAndName} ${trackNames} ${gmNames}`;

  if (fileType === 'full_track' && activeTracks.length >= 2) {
    if (/orchestr|string|cello|viol|brass|horn|timpani|choir|taiko/i.test(combined)) {
      return {
        instrument: 'Full Orchestra',
        instrumentFamily: 'orchestra_ensemble',
        articulation: 'Normal / Gemischt',
      };
    }
    return {
      instrument: `Multi-Track (${activeTracks.length} Spuren)`,
      instrumentFamily: 'orchestra_ensemble',
      articulation: 'Normal / Gemischt',
    };
  }

  return inferInstrumentAndArticulationFromText(
    combined,
    abbreviations,
    parsed?.notes ?? [],
    Boolean(parsed?.isPercussionOnly),
    parsed ? parsed.performance.programChanges.map((pc) => pc.program) : []
  );
}

function estimateAveragePolyphony(parsed: ParsedMidi): number {
  if (parsed.notes.length === 0) return 0;
  const quant = Math.max(1, Math.round(parsed.ppqn / 4));
  const buckets = new Map<number, number>();
  for (const n of parsed.notes) {
    const b = Math.round(n.startTick / quant);
    buckets.set(b, (buckets.get(b) || 0) + 1);
  }
  let groups = 0;
  let total = 0;
  for (const cnt of buckets.values()) {
    groups++;
    total += cnt;
  }
  return groups > 0 ? total / groups : 1;
}

function inferMusicalRole(
  entry: MidiFileEntry,
  parsed: ParsedMidi | null,
  fileType: MidiFileType,
  instrumentFamily: InstrumentFamily,
  articulation: string
): MusicalRole {
  const pathText = normalizeForTokens(entry.relativePath);

  if (fileType === 'full_track' && parsed && parsed.tracks.filter((t) => t.noteCount > 0).length >= 3) {
    return 'arrangement';
  }
  if (instrumentFamily === 'drums_percussion' || parsed?.isPercussionOnly) {
    return 'percussion';
  }
  if (instrumentFamily === 'bass' || /\b808\b|\bbass\b/.test(pathText)) {
    return 'bass';
  }
  if (/\bgegenmelodie\b|\bcounter[-_\s]?melody\b/.test(pathText)) {
    return 'gegenmelodie';
  }
  if (/\bmelod(y|ie)\b|\blead\b|\bsolo\b|\btheme\b|\bthema\b/.test(pathText)) {
    return 'melodie';
  }
  if (/\bchord(s)?\b|\bharmon|\bpad\b|\bprogression\b/.test(pathText)) {
    return 'harmonie';
  }
  if (/\barp(eggio)?\b|\bostinato\b/.test(pathText) || articulation === 'Arpeggio' || articulation === 'Ostinato') {
    return 'ostinato_arp';
  }
  if (instrumentFamily === 'fx_other') {
    return 'fx';
  }

  if (parsed && parsed.notes.length > 0) {
    let pitchSum = 0;
    for (const n of parsed.notes) pitchSum += n.pitch;
    const avgPitch = pitchSum / parsed.notes.length;
    const avgPoly = estimateAveragePolyphony(parsed);

    if (avgPitch < 48 && avgPoly < 1.6) return 'bass';
    if (avgPoly >= 2.2) return 'harmonie';
    if (articulation === 'Spiccato' && avgPitch < 62) return 'ostinato_arp';
    return 'melodie';
  }

  return 'unbekannt';
}

function classifyImportantTracks(
  entry: MidiFileEntry,
  parsed: ParsedMidi
): MidiDatasetMetadata['importantTracks'] {
  const result: MidiDatasetMetadata['importantTracks'] = {
    hauptmelodie: [],
    gegenmelodie: [],
    harmonie: [],
    bass: [],
    rhythmischesFundament: [],
  };

  const baseTitle = entry.name.replace(/\.(mid|midi)$/i, '');
  const notesByTrack = new Map<number, MidiNote[]>();
  for (const n of parsed.notes) {
    const arr = notesByTrack.get(n.trackIndex) || [];
    arr.push(n);
    notesByTrack.set(n.trackIndex, arr);
  }

  const melodicCandidates: Array<{
    name: string;
    avgPitch: number;
    noteCount: number;
  }> = [];

  for (const tr of parsed.tracks) {
    if (tr.noteCount === 0) continue;
    const trNotes = notesByTrack.get(tr.index) || [];
    const label =
      parsed.tracks.length === 1 && /^Spur \d+$/i.test(tr.name) ? baseTitle : tr.name;
    const lower = label.toLowerCase();

    const isDrumChannelOnly =
      tr.channels.length > 0 && tr.channels.every((ch) => ch === 9);
    const isPercName =
      /drum|perc|timpani|djun|dhol|dohl|taiko|snare|kick|hat|battery|cymbal|tom/i.test(lower);

    if (isDrumChannelOnly || isPercName) {
      result.rhythmischesFundament.push(label);
      continue;
    }

    let pitchSum = 0;
    for (const n of trNotes) pitchSum += n.pitch;
    const avgPitch = trNotes.length > 0 ? pitchSum / trNotes.length : 60;

    let chordGroups = 0;
    let groupedNotes = 0;
    const bucketCounts = new Map<number, number>();
    const quant = Math.max(1, Math.round(parsed.ppqn / 4));
    for (const n of trNotes) {
      const b = Math.round(n.startTick / quant);
      bucketCounts.set(b, (bucketCounts.get(b) || 0) + 1);
    }
    for (const cnt of bucketCounts.values()) {
      chordGroups++;
      groupedNotes += cnt;
    }
    const avgSimul = chordGroups > 0 ? groupedNotes / chordGroups : 1;

    const isBassName = /\bbass\b|sub|contrabass|tuba|808/i.test(lower);
    const isHarmonyName =
      /pad|sus|ens|ensemble|chord|harm|choir|strings/i.test(lower) &&
      !/solo|lead|melod/i.test(lower);
    const isRhythmOstinato =
      /spic|stac|marc|ostinato|arp/i.test(lower) && avgPitch < 62;

    if (isBassName || (avgPitch < 48 && avgSimul < 1.6)) {
      result.bass.push(label);
    } else if (isRhythmOstinato) {
      result.rhythmischesFundament.push(label);
    } else if (isHarmonyName || avgSimul >= 2.15) {
      result.harmonie.push(label);
    } else {
      melodicCandidates.push({
        name: label,
        avgPitch,
        noteCount: tr.noteCount,
      });
    }
  }

  melodicCandidates.sort(
    (a, b) => b.avgPitch - a.avgPitch || b.noteCount - a.noteCount
  );

  for (let i = 0; i < melodicCandidates.length; i++) {
    if (i === 0) result.hauptmelodie.push(melodicCandidates[i].name);
    else if (i === 1) result.gegenmelodie.push(melodicCandidates[i].name);
    else result.harmonie.push(melodicCandidates[i].name);
  }

  return result;
}

function buildAutoSections(parsed: ParsedMidi): MidiDatasetMetadata['sections'] {
  const barGrid = buildBarGrid(parsed.ppqn, parsed.timeSignatures, parsed.totalTicks);
  const totalBars = Math.max(1, barGrid.length);

  if (parsed.metadata.markers.length > 0) {
    const markerBars = parsed.metadata.markers
      .map((m) => ({
        name: m.text,
        bar: Math.max(1, Math.min(totalBars, tickToBarNumber(barGrid, m.tick))),
      }))
      .sort((a, b) => a.bar - b.bar);

    const sections: MidiDatasetMetadata['sections'] = [];
    if (markerBars[0].bar > 1) {
      sections.push({
        name: 'Vorlauf / Intro',
        vonTakt: 1,
        bisTakt: markerBars[0].bar - 1,
      });
    }
    for (let i = 0; i < markerBars.length; i++) {
      const cur = markerBars[i];
      const next = markerBars[i + 1];
      const bisTakt = next ? Math.max(cur.bar, next.bar - 1) : totalBars;
      sections.push({ name: cur.name, vonTakt: cur.bar, bisTakt });
    }
    return sections;
  }

  if (totalBars <= 8) {
    return [{ name: 'Hauptteil', vonTakt: 1, bisTakt: totalBars }];
  }

  if (totalBars <= 24) {
    const mid = Math.max(2, Math.round(totalBars * 0.25));
    const endStart = Math.max(mid + 2, Math.round(totalBars * 0.75));
    return [
      { name: 'Intro', vonTakt: 1, bisTakt: mid },
      { name: 'Hauptteil', vonTakt: mid + 1, bisTakt: endStart - 1 },
      { name: 'Finale', vonTakt: endStart, bisTakt: totalBars },
    ];
  }

  const introEnd = Math.max(2, Math.min(12, Math.round(totalBars * 0.14)));
  const buildEnd = Math.max(introEnd + 2, Math.round(totalBars * 0.42));
  const bridgeEnd = Math.max(buildEnd + 2, Math.round(totalBars * 0.72));
  return [
    { name: 'Intro', vonTakt: 1, bisTakt: introEnd },
    { name: 'Aufbau', vonTakt: introEnd + 1, bisTakt: buildEnd },
    { name: 'Bridge', vonTakt: buildEnd + 1, bisTakt: bridgeEnd },
    { name: 'Finale', vonTakt: bridgeEnd + 1, bisTakt: totalBars },
  ];
}

function detectAbbreviations(
  entry: MidiFileEntry,
  parsed: ParsedMidi | null,
  profile: LibraryAbbreviation[]
): Array<{ key: string; meaning: string }> {
  const combined = [
    entry.name,
    ...(parsed ? parsed.tracks.map((t) => t.name) : []),
    ...(parsed ? parsed.metadata.instruments : []),
  ].join(' ');
  const normalized = combined.replace(/[_-]+/g, ' ');

  const found: Array<{ key: string; meaning: string }> = [];
  const seen = new Set<string>();

  for (const item of profile) {
    const k = item.key.trim();
    if (!k) continue;
    const regex = new RegExp(`\\b${escapeRegExp(k)}\\b`, 'i');
    if (regex.test(normalized) && !seen.has(k.toLowerCase())) {
      seen.add(k.toLowerCase());
      found.push({ key: k, meaning: item.meaning });
    }
  }

  return found;
}

function inferMoods(parsed: ParsedMidi | null, entry: MidiFileEntry): string[] {
  const pathText = entry.relativePath.toLowerCase();
  const moods = new Set<string>();

  if (/dark|düster|abgrund|shadow|annihil/i.test(pathText)) moods.add('Dark');
  if (/epic|fearless|division/i.test(pathText)) moods.add('Epic');
  if (/heroic|hero/i.test(pathText)) moods.add('Heroic');
  if (/sad|traurig|rain/i.test(pathText)) moods.add('Sad');
  if (/melanch/i.test(pathText)) moods.add('Melancholic');
  if (/stress|action|trailer|battle/i.test(pathText)) {
    moods.add('Action');
    moods.add('Dramatic');
  }
  if (/aggress|angry|rage|brutal/i.test(pathText)) moods.add('Aggressive');
  if (/creepy|horror|scary|haunt/i.test(pathText)) moods.add('Haunting');
  if (/myst|secret|enig/i.test(pathText)) moods.add('Mysterious');
  if (/chill|calm|smooth|lofi/i.test(pathText)) moods.add('Chilled');
  if (/gangst|street|underground/i.test(pathText)) moods.add('Street');
  if (/boombap|boom[-_\s]?bap/i.test(pathText)) moods.add('Boom Bap');
  if (/cinematic|orchestr/i.test(pathText)) moods.add('Cinematic');

  if (parsed) {
    if (parsed.isPercussionOnly) {
      moods.add('Energetic');
      moods.add('hard-hitting');
    } else if (parsed.detectedKey?.mode === 'minor') {
      if (parsed.primaryBpm >= 112) {
        moods.add('Dark');
        moods.add('Dramatic');
        moods.add('High-Energy');
      } else {
        moods.add('Melancholic');
        moods.add('Emotional');
      }
    } else if (parsed.detectedKey?.mode === 'major') {
      if (parsed.primaryBpm >= 112) {
        moods.add('Energetic');
        moods.add('Heroic');
      } else {
        moods.add('Hopeful');
        moods.add('Lyrical');
      }
    }
  }

  return Array.from(moods).slice(0, 4);
}

function buildAutoSpecialFeatures(parsed: ParsedMidi | null): string[] {
  if (!parsed) return [];
  const features: string[] = [];

  const harmony = analyzeMidiHarmony(
    parsed.notes,
    parsed.ppqn,
    parsed.timeSignatures,
    parsed.totalTicks
  );
  if (harmony.progressionSummary.length >= 2) {
    features.push(`Akkordfolge: ${harmony.progressionSummary.slice(0, 8).join(' → ')}`);
  }

  if (parsed.notes.length >= 16) {
    const shortNotes = parsed.notes.filter((n) => n.durationSec <= 0.25).length;
    if (shortNotes / parsed.notes.length >= 0.65) {
      features.push('Kurze rhythmische Noten / Ostinato-Charakter');
    }
  }

  if (parsed.notes.length > 0) {
    let minVel = 127;
    let maxVel = 0;
    for (const n of parsed.notes) {
      if (n.velocity < minVel) minVel = n.velocity;
      if (n.velocity > maxVel) maxVel = n.velocity;
    }
    if (maxVel - minVel >= 45) {
      features.push(`Große Dynamikspanne (Velocity ${minVel}–${maxVel})`);
    }
  }

  if (parsed.leadingBars >= 1) {
    features.push(`Vorlauf von ${parsed.leadingBars} Takt(en) vor der ersten Note`);
  }

  if (parsed.performance.programChanges.length > 0) {
    const uniqueProgs = Array.from(
      new Set(parsed.performance.programChanges.map((p) => p.program))
    ).slice(0, 4);
    features.push(`GM-Programme: ${uniqueProgs.map((p) => getGmProgramName(p)).join(', ')}`);
  }

  const exprParts: string[] = [];
  if (parsed.performance.controlChanges.length > 0) {
    const distinctCcs = Array.from(
      new Set(parsed.performance.controlChanges.map((c) => c.controller))
    ).slice(0, 4);
    exprParts.push(`CC (${distinctCcs.map((cc) => `${cc} ${getMidiCcLabel(cc)}`).join(', ')})`);
  }
  if (parsed.performance.pitchBends.length > 0) {
    exprParts.push(`Pitch Bend (${parsed.performance.pitchBends.length}×)`);
  }
  if (parsed.performance.aftertouch.length > 0) {
    exprParts.push(`Aftertouch (${parsed.performance.aftertouch.length}×)`);
  }
  if (exprParts.length > 0) {
    features.push(`Expression / Controller: ${exprParts.join(' · ')}`);
  }

  return features;
}

export function createAutoMetadata(
  entry: MidiFileEntry,
  abbreviations?: LibraryAbbreviation[],
  folderHint?: string
): MidiDatasetMetadata {
  const parsed = entry.parsed;
  const profile =
    abbreviations && abbreviations.length > 0 ? abbreviations : DEFAULT_ABBREVIATIONS;
  const title = entry.name.replace(/\.(mid|midi)$/i, '');

  const origin = inferOrigin(entry, folderHint);
  const fileType = inferFileType(entry, parsed);
  const { genre, subgenres } = inferGenreAndSubgenres(entry, parsed, folderHint);
  const { instrument, instrumentFamily, articulation } = inferInstrumentAndArticulation(
    entry,
    parsed,
    fileType,
    profile
  );
  const musicalRole = inferMusicalRole(entry, parsed, fileType, instrumentFamily, articulation);
  const moods = inferMoods(parsed, entry);

  const workStatus =
    !parsed || parsed.hasErrors || entry.triage === 'discard'
      ? 'unvollständig'
      : parsed.hasWarnings || parsed.barCount < 8
      ? 'skizze'
      : 'final';

  const trackMetadata = buildAutoTrackMetadata(parsed, profile);
  const importantTracks =
    trackMetadata.length > 0
      ? rebuildImportantTracksFromTrackMeta(trackMetadata)
      : parsed
      ? classifyImportantTracks(entry, parsed)
      : {
          hauptmelodie: [],
          gegenmelodie: [],
          harmonie: [],
          bass: [],
          rhythmischesFundament: [],
        };

  // For single-track files where the track name itself clearly gave a role, align top-level musicalRole
  const effectiveMusicalRole =
    fileType !== 'full_track' &&
    trackMetadata.length === 1 &&
    trackMetadata[0].musicalRole !== 'unbekannt'
      ? trackMetadata[0].musicalRole
      : musicalRole;

  const isMultiTrackMeta =
    fileType === 'full_track' ||
    (trackMetadata.length >= 2 && effectiveMusicalRole === 'arrangement');

  const sections = parsed
    ? buildAutoSections(parsed)
    : [{ name: 'Hauptteil', vonTakt: 1, bisTakt: 1 }];

  const libraryAbbreviations = detectAbbreviations(entry, parsed, profile);
  const specialFeatures = buildAutoSpecialFeatures(parsed);

  const provenance: Record<TrackableMetaField, FieldProvenance> = {
    origin: 'auto',
    fileType: 'auto',
    genre: 'auto',
    subgenres: 'auto',
    instrument: 'auto',
    instrumentFamily: 'auto',
    articulation: 'auto',
    musicalRole: 'auto',
    rating: 'auto',
    triage: 'auto',
    workStatus: 'auto',
    moods: 'auto',
  };

  return {
    compositionId: generateCompositionId(entry),
    title,
    origin,
    fileType,
    isMultiTrackMeta,
    workStatus,
    reviewStatus: 'offen',
    genre,
    subgenres,
    instrument,
    instrumentFamily,
    articulation,
    musicalRole: effectiveMusicalRole,
    trackMetadata,
    rating: null,
    moods,
    whyILike: [],
    specialFeatures,
    importantTracks,
    sections,
    libraryAbbreviations,
    keyOverride: null,
    fieldProvenance: provenance,
    sourceLink: {
      midiFile: entry.relativePath,
      metadataFile: entry.sidecarRelativePath || defaultSidecarRelativePath(entry.relativePath),
      sha256: entry.sha256 ?? null,
      originalFile: entry.relativePath,
      originalSha256: entry.originalSha256 ?? entry.sha256 ?? null,
      parentCompositionId: null,
      sourceTrackIndex: null,
      sourceTrackName: null,
      startTickOffset: null,
      segmentBars: null,
    },
    sidecarLoaded: false,
    sidecarDirty: false,
  };
}

/**
 * Merges freshly auto-detected metadata into an existing metadata object while strictly
 * preserving every field marked as 'manual' (user-confirmed).
 */
export function mergeAutoIntoExistingMetadata(
  existing: MidiDatasetMetadata,
  auto: MidiDatasetMetadata
): MidiDatasetMetadata {
  const prov = { ...existing.fieldProvenance };
  const isManual = (f: TrackableMetaField) => prov[f] === 'manual';

  const mergedTrackMetadata =
    existing.trackMetadata && existing.trackMetadata.length > 0
      ? existing.trackMetadata.map((exTr) => {
          if (exTr.confirmed) return exTr;
          const autoMatch = auto.trackMetadata?.find(
            (a) => a.trackIndex === exTr.trackIndex || a.trackName === exTr.trackName
          );
          return autoMatch ? { ...autoMatch, confirmed: false } : exTr;
        })
      : auto.trackMetadata;

  return {
    ...existing,
    compositionId: existing.compositionId || auto.compositionId,
    title: existing.title || auto.title,
    origin: isManual('origin') ? existing.origin : auto.origin,
    fileType: isManual('fileType') ? existing.fileType : auto.fileType,
    workStatus: isManual('workStatus') ? existing.workStatus : auto.workStatus,
    genre: isManual('genre') ? existing.genre : auto.genre,
    subgenres: isManual('subgenres') ? existing.subgenres : auto.subgenres,
    instrument: isManual('instrument') ? existing.instrument : auto.instrument,
    instrumentFamily: isManual('instrumentFamily')
      ? existing.instrumentFamily
      : auto.instrumentFamily,
    articulation: isManual('articulation') ? existing.articulation : auto.articulation,
    musicalRole: isManual('musicalRole') ? existing.musicalRole : auto.musicalRole,
    isMultiTrackMeta:
      existing.isMultiTrackMeta !== undefined
        ? existing.isMultiTrackMeta
        : auto.isMultiTrackMeta,
    trackMetadata: mergedTrackMetadata,
    rating: isManual('rating') ? existing.rating : existing.rating ?? auto.rating,
    moods: isManual('moods') ? existing.moods : auto.moods,
    importantTracks:
      mergedTrackMetadata && mergedTrackMetadata.length > 0
        ? rebuildImportantTracksFromTrackMeta(mergedTrackMetadata)
        : existing.sidecarLoaded &&
          (existing.importantTracks.hauptmelodie.length > 0 ||
            existing.importantTracks.harmonie.length > 0 ||
            existing.importantTracks.bass.length > 0 ||
            existing.importantTracks.rhythmischesFundament.length > 0)
        ? existing.importantTracks
        : auto.importantTracks,
    sections:
      existing.sidecarLoaded && existing.sections.length > 0
        ? existing.sections
        : auto.sections,
    specialFeatures:
      existing.sidecarLoaded && existing.specialFeatures.length > 0
        ? existing.specialFeatures
        : auto.specialFeatures,
    libraryAbbreviations:
      existing.sidecarLoaded && existing.libraryAbbreviations.length > 0
        ? existing.libraryAbbreviations
        : auto.libraryAbbreviations,
    sourceLink: {
      ...auto.sourceLink,
      ...existing.sourceLink,
      midiFile: auto.sourceLink.midiFile,
      metadataFile: auto.sourceLink.metadataFile,
      sha256: auto.sourceLink.sha256 ?? existing.sourceLink.sha256,
      originalFile: existing.sourceLink.originalFile || auto.sourceLink.originalFile,
      originalSha256:
        existing.sourceLink.originalSha256 || auto.sourceLink.originalSha256,
    },
    fieldProvenance: prov,
  };
}
