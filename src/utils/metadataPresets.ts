export interface ArticulationPreset {
  abbr: string;
  name: string;
}

export interface MetadataPresetProfile {
  genres: string[];
  subgenres: string[];
  moods: string[];
  instruments: string[];
  instrumentFamilies: string[];
  roles: string[];
  articulations: ArticulationPreset[];
  workStatuses: string[];
}

export type PresetCategoryKey = keyof MetadataPresetProfile;
export type StringPresetCategoryKey = Exclude<PresetCategoryKey, 'articulations'>;

export interface PresetOverrides {
  added: {
    genres: string[];
    subgenres: string[];
    moods: string[];
    instruments: string[];
    instrumentFamilies: string[];
    roles: string[];
    articulations: ArticulationPreset[];
    workStatuses: string[];
  };
  removed: Record<PresetCategoryKey, string[]>;
}

export const PRESETS_MD_PUBLIC_PATH = 'assets/aistudio/Presets.md';

const OVERRIDES_STORAGE_KEY = 'midi_sorter_metadata_preset_overrides_v2';
const LEGACY_STORAGE_KEY = 'midi_sorter_metadata_presets_v1';

export const DEFAULT_GENRE_PRESETS: string[] = [
  'Orchestral',
  'Hybrid Orchestral',
  'Hip-Hop',
  'Underground-Hip-Hop',
  'Metal',
  'Pop',
  'R&B',
  'Trap',
];

export const DEFAULT_SUBGENRE_PRESETS: string[] = [
  ...DEFAULT_GENRE_PRESETS,
  'Cinematic',
  'Trailer',
  'Epic',
  'Dark',
  'Hybrid',
  'Film Score',
  'Soundtrack',
  'Neoclassical',
  'Boom Bap',
  'Old-School',
  'Drill',
  'Lo-Fi',
  'Gangsta Rap',
  'Melodic Trap',
  'Dark Trap',
  'Symphonic Metal',
  'Nu-Metal',
  'Dark Pop',
  'Neo-Soul',
  'Action',
  'Ambient',
  'Acoustic',
  'Live-Drums',
];

export const DEFAULT_MOOD_PRESETS: string[] = [
  'Action',
  'Adventurous',
  'Aggressive',
  'Airy',
  'Angry',
  'Atmospheric',
  'Boom Bap',
  'Catchy',
  'Chilled',
  'Cinematic',
  'Classic',
  'Club',
  'Creepy',
  'Dancing',
  'Danger',
  'Dark',
  'Deep',
  'Depressing',
  'Dirty',
  'Dramatic',
  'Emotional',
  'Energetic',
  'Epic',
  'Experimental',
  'Gangster Attitude',
  'Gangster Style',
  'Good Time',
  'Groovy',
  'hard-hitting',
  'Haunting',
  'Heroic',
  'High-Energy',
  'Hopeful',
  'Inspirational',
  'Lost',
  'Lyrical',
  'Melancholic',
  'Motivational',
  'Mysterious',
  'Narrative',
  'Party',
  'Powerful',
  'Rebellious',
  'Romantic',
  'Sad',
  'Scary',
  'Smooth',
  'Storytelling',
  'Street',
  'Underground',
  'Old-school',
];

export const DEFAULT_INSTRUMENT_PRESETS: string[] = [
  '808',
  'bass-heavy',
  'electronic-instruments',
  'Drums',
  'Kick',
  'Claps',
  'Snare',
  'Percussion',
  'HiHat',
  'Shaker',
  'Tambourine',
  'Openhat',
  'Crash',
  'Cinematic Drums',
  'Cinematic Percussions',
  'Low Drums',
  'Dhol',
  'Timpani',
  'Taiko',
  'Toms',
  'Djembe',
  'Cymbals',
  'Drum Loop',
  'Sub Bass',
  'Bass',
  'Bass Guitar',
  'Pulsing Bass',
  'Synth Bass',
  'Synth',
  'Synth Keys',
  'Synth Pad',
  'Synth Lead',
  'Arpeggio',
  'Atmosphere',
  'Acoustic Guitar',
  'E-Guitar',
  'Piano',
  'Keys',
  'Celesta',
  'Pluck',
  'Gongs',
  'Tubular Bells',
  'Strings',
  'Low Strings',
  'Mid Strings',
  'High Strings',
  'Double Bass',
  'Cello',
  'Viola',
  'Violin',
  'Woodwind',
  'Bassoon',
  'Clarinet',
  'Oboe',
  'Whistle',
  'Flute',
  'Brass',
  'Low Brass',
  'Horn',
  'French Horn',
  'Trombone',
  'Trumpet',
  'Tuba',
  'Choir',
  'Vox',
  'Male Voice',
  'Female Voice',
  'Loop',
];

export const DEFAULT_INSTRUMENT_FAMILY_PRESETS: string[] = [
  'Orchester / Ensemble',
  'Streicher',
  'Blechbläser',
  'Holzbläser',
  'Tasten / Piano',
  'Synth',
  'Gitarre / Zupfinstrument',
  'Bass',
  'Drums / Percussion',
  'Chor / Vocal',
  'FX / Sonstiges',
  'Unbekannt',
];

export const DEFAULT_ROLE_PRESETS: string[] = [
  'Melodie',
  'Gegenmelodie',
  'Harmonie',
  'Bass',
  'Low-End',
  'Drums',
  'Percussion',
  'Rhythmus',
  'Akzent',
  'Rhythmischer Akzent',
  'Ostinato / Arp',
  'Layer',
  'Pad/ Atmo',
  'Full Arrangement',
  'FX / Textur',
  'Normal',
  'None',
  'Unbekannt',
];

export const DEFAULT_ARTICULATION_PRESETS: ArticulationPreset[] = [
  { abbr: 'Ens', name: 'Ensemble' },
  { abbr: 'Leg', name: 'Legato' },
  { abbr: 'Sord', name: 'Con sordino' },
  { abbr: 'Sus', name: 'Sustain' },
  { abbr: 'Pizz', name: 'Pizzicato' },
  { abbr: 'Spic', name: 'Spiccato' },
  { abbr: 'Stac', name: 'Staccato' },
  { abbr: 'Staccis', name: 'Staccatissimo' },
  { abbr: 'Marc', name: 'Marcato' },
  { abbr: 'Mart', name: 'Martelé' },
  { abbr: '8va', name: '8va (Ottava)' },
  { abbr: 'Uni', name: 'Unison (Unisono)' },
  { abbr: 'Port', name: 'Portato' },
  { abbr: 'Tenu', name: 'Tenuto' },
  { abbr: 'Dt', name: 'Détaché' },
  { abbr: 'Trem', name: 'Tremolo' },
  { abbr: 'Sul-pon', name: 'Sul ponticello' },
  { abbr: 'Sul-tas', name: 'Sul tasto' },
  { abbr: 'Flag', name: 'Flageolett' },
  { abbr: 'Cres', name: 'Crescendo' },
  { abbr: 'Swell', name: 'Swell' },
  { abbr: 'Gliss', name: 'Glissandi (Glissando)' },
  { abbr: '', name: 'One-Shots' },
  { abbr: '', name: 'Hits' },
  { abbr: '', name: 'None' },
  { abbr: '', name: 'Normal' },
];

export const DEFAULT_WORK_STATUS_PRESETS: string[] = [
  'final',
  'entwurf',
  'skizze',
  'idee',
  'wip',
  'unvollständig',
];

export function createDefaultMetadataPresets(): MetadataPresetProfile {
  return {
    genres: [...DEFAULT_GENRE_PRESETS],
    subgenres: [...DEFAULT_SUBGENRE_PRESETS],
    moods: [...DEFAULT_MOOD_PRESETS],
    instruments: [...DEFAULT_INSTRUMENT_PRESETS],
    instrumentFamilies: [...DEFAULT_INSTRUMENT_FAMILY_PRESETS],
    roles: [...DEFAULT_ROLE_PRESETS],
    articulations: DEFAULT_ARTICULATION_PRESETS.map((a) => ({ ...a })),
    workStatuses: [...DEFAULT_WORK_STATUS_PRESETS],
  };
}

export function createEmptyPresetOverrides(): PresetOverrides {
  return {
    added: {
      genres: [],
      subgenres: [],
      moods: [],
      instruments: [],
      instrumentFamilies: [],
      roles: [],
      articulations: [],
      workStatuses: [],
    },
    removed: {
      genres: [],
      subgenres: [],
      moods: [],
      instruments: [],
      instrumentFamilies: [],
      roles: [],
      articulations: [],
      workStatuses: [],
    },
  };
}

function dedupeStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const clean = item.trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

function dedupeArticulations(items: ArticulationPreset[]): ArticulationPreset[] {
  const seen = new Set<string>();
  const out: ArticulationPreset[] = [];
  for (const item of items) {
    const name = item.name.trim();
    const abbr = item.abbr.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ abbr, name });
  }
  return out;
}

function stripMarkdownFormatting(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

function classifyHeading(rawHeading: string): PresetCategoryKey | null {
  const norm = rawHeading
    .toLowerCase()
    .replace(/[:\-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (norm.includes('subgenre') || norm.includes('sub genre') || norm.includes('substil')) {
    return 'subgenres';
  }
  if (norm.includes('genre') || norm.includes('hauptstil')) {
    return 'genres';
  }
  if (norm.includes('mood') || norm.includes('stimmung')) {
    return 'moods';
  }
  if (norm.includes('familie') || norm.includes('family')) {
    return 'instrumentFamilies';
  }
  if (norm.includes('instrument')) {
    return 'instruments';
  }
  if (norm.includes('rolle') || norm.includes('role')) {
    return 'roles';
  }
  if (norm.includes('artikulation') || norm.includes('articulation')) {
    return 'articulations';
  }
  if (norm.includes('werkstatus') || norm === 'status' || norm.includes('work status')) {
    return 'workStatuses';
  }
  return null;
}

/**
 * Parses `public/assets/aistudio/Presets.md` directly into a MetadataPresetProfile.
 * Any missing section falls back gracefully to built-in defaults.
 */
export function parsePresetsMarkdown(markdown: string): MetadataPresetProfile {
  const defaults = createDefaultMetadataPresets();
  const parsed: Partial<Record<PresetCategoryKey, unknown[]>> = {};

  let currentCategory: PresetCategoryKey | null = null;
  const lines = markdown.replace(/^\uFEFF/, '').split(/\r?\n/);

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    // Markdown heading (e.g. "## Genre Liste:", "### Allgemeine Artikulationen")
    const headingMatch = trimmed.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      currentCategory = classifyHeading(headingMatch[1]);
      continue;
    }

    if (!currentCategory) continue;

    // Bullet list line (e.g. "- Orchestral", "* Dark", "- Spic | **Spiccato**")
    const bulletMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    if (!bulletMatch) continue;

    const body = bulletMatch[1].trim();
    if (!body) continue;

    if (!parsed[currentCategory]) {
      parsed[currentCategory] = [];
    }

    if (currentCategory === 'articulations') {
      const pipeIdx = body.indexOf('|');
      if (pipeIdx >= 0) {
        const abbr = stripMarkdownFormatting(body.slice(0, pipeIdx));
        const name = stripMarkdownFormatting(body.slice(pipeIdx + 1));
        if (name) {
          parsed.articulations!.push({ abbr, name });
        }
      } else {
        const name = stripMarkdownFormatting(body);
        if (name) {
          parsed.articulations!.push({ abbr: '', name });
        }
      }
    } else {
      const clean = stripMarkdownFormatting(body);
      if (clean) {
        parsed[currentCategory]!.push(clean);
      }
    }
  }

  return {
    genres:
      parsed.genres && parsed.genres.length > 0
        ? dedupeStrings(parsed.genres as string[])
        : defaults.genres,
    subgenres:
      parsed.subgenres && parsed.subgenres.length > 0
        ? dedupeStrings(parsed.subgenres as string[])
        : defaults.subgenres,
    moods:
      parsed.moods && parsed.moods.length > 0
        ? dedupeStrings(parsed.moods as string[])
        : defaults.moods,
    instruments:
      parsed.instruments && parsed.instruments.length > 0
        ? dedupeStrings(parsed.instruments as string[])
        : defaults.instruments,
    instrumentFamilies:
      parsed.instrumentFamilies && parsed.instrumentFamilies.length > 0
        ? dedupeStrings(parsed.instrumentFamilies as string[])
        : defaults.instrumentFamilies,
    roles:
      parsed.roles && parsed.roles.length > 0
        ? dedupeStrings(parsed.roles as string[])
        : defaults.roles,
    articulations:
      parsed.articulations && parsed.articulations.length > 0
        ? dedupeArticulations(parsed.articulations as ArticulationPreset[])
        : defaults.articulations,
    workStatuses:
      parsed.workStatuses && parsed.workStatuses.length > 0
        ? dedupeStrings(parsed.workStatuses as string[])
        : defaults.workStatuses,
  };
}

export async function fetchPresetsFromFile(): Promise<{
  profile: MetadataPresetProfile;
  loadedFromFile: boolean;
}> {
  const baseUrl = import.meta.env.BASE_URL || '/';
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const url = `${normalizedBase}${PRESETS_MD_PUBLIC_PATH}?t=${Date.now()}`;

  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
      return { profile: createDefaultMetadataPresets(), loadedFromFile: false };
    }
    const text = await response.text();
    if (!text.trim()) {
      return { profile: createDefaultMetadataPresets(), loadedFromFile: false };
    }
    return { profile: parsePresetsMarkdown(text), loadedFromFile: true };
  } catch {
    return { profile: createDefaultMetadataPresets(), loadedFromFile: false };
  }
}

function sanitizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return dedupeStrings(raw.filter((x): x is string => typeof x === 'string'));
}

function sanitizeArtArray(raw: unknown): ArticulationPreset[] {
  if (!Array.isArray(raw)) return [];
  const list: ArticulationPreset[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === 'string' ? rec.name.trim() : '';
    const abbr = typeof rec.abbr === 'string' ? rec.abbr.trim() : '';
    if (name) list.push({ abbr, name });
  }
  return dedupeArticulations(list);
}

/**
 * Loads browser-local preset overrides (items added or hidden in the UI).
 * Base items come live from `Presets.md` so editing `Presets.md` always takes effect immediately.
 */
export function loadPresetOverrides(): PresetOverrides {
  const empty = createEmptyPresetOverrides();
  try {
    const raw = window.localStorage.getItem(OVERRIDES_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PresetOverrides>;
      return {
        added: {
          genres: sanitizeStringArray(parsed.added?.genres),
          subgenres: sanitizeStringArray(parsed.added?.subgenres),
          moods: sanitizeStringArray(parsed.added?.moods),
          instruments: sanitizeStringArray(parsed.added?.instruments),
          instrumentFamilies: sanitizeStringArray(parsed.added?.instrumentFamilies),
          roles: sanitizeStringArray(parsed.added?.roles),
          articulations: sanitizeArtArray(parsed.added?.articulations),
          workStatuses: sanitizeStringArray(parsed.added?.workStatuses),
        },
        removed: {
          genres: sanitizeStringArray(parsed.removed?.genres),
          subgenres: sanitizeStringArray(parsed.removed?.subgenres),
          moods: sanitizeStringArray(parsed.removed?.moods),
          instruments: sanitizeStringArray(parsed.removed?.instruments),
          instrumentFamilies: sanitizeStringArray(parsed.removed?.instrumentFamilies),
          roles: sanitizeStringArray(parsed.removed?.roles),
          articulations: sanitizeStringArray(parsed.removed?.articulations),
          workStatuses: sanitizeStringArray(parsed.removed?.workStatuses),
        },
      };
    }

    // One-time migration: preserve any custom items from legacy v1 full-snapshot storage
    const legacyRaw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw) as Record<string, unknown>;
      const defaults = createDefaultMetadataPresets();
      const migrated = createEmptyPresetOverrides();

      const migrateStrings = (cat: 'genres' | 'subgenres' | 'moods' | 'instruments') => {
        const legacyItems = sanitizeStringArray(legacy[cat]);
        const defaultSet = new Set(defaults[cat].map((s) => s.toLowerCase()));
        migrated.added[cat] = legacyItems.filter((s) => !defaultSet.has(s.toLowerCase()));
      };
      migrateStrings('genres');
      migrateStrings('subgenres');
      migrateStrings('moods');
      migrateStrings('instruments');

      const legacyArts = sanitizeArtArray(legacy.articulations);
      const defaultArtSet = new Set(defaults.articulations.map((a) => a.name.toLowerCase()));
      migrated.added.articulations = legacyArts.filter(
        (a) => !defaultArtSet.has(a.name.toLowerCase())
      );

      savePresetOverrides(migrated);
      return migrated;
    }
  } catch {
    // Ignore storage errors
  }
  return empty;
}

export function savePresetOverrides(overrides: PresetOverrides): void {
  try {
    window.localStorage.setItem(OVERRIDES_STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // Ignore storage quota / privacy mode errors
  }
}

/**
 * Merges live `Presets.md` base profile with browser-local user overrides.
 */
export function applyPresetOverrides(
  base: MetadataPresetProfile,
  overrides: PresetOverrides
): MetadataPresetProfile {
  const mergeStrings = (cat: StringPresetCategoryKey): string[] => {
    const removedSet = new Set(overrides.removed[cat].map((s) => s.toLowerCase()));
    const combined = [...base[cat], ...overrides.added[cat]];
    return dedupeStrings(combined.filter((s) => !removedSet.has(s.toLowerCase())));
  };

  const removedArtSet = new Set(overrides.removed.articulations.map((s) => s.toLowerCase()));
  const artMap = new Map<string, ArticulationPreset>();
  for (const a of base.articulations) {
    const key = a.name.toLowerCase();
    if (!removedArtSet.has(key)) {
      artMap.set(key, { ...a });
    }
  }
  for (const a of overrides.added.articulations) {
    const key = a.name.toLowerCase();
    if (!removedArtSet.has(key)) {
      artMap.set(key, { ...a });
    }
  }

  return {
    genres: mergeStrings('genres'),
    subgenres: mergeStrings('subgenres'),
    moods: mergeStrings('moods'),
    instruments: mergeStrings('instruments'),
    instrumentFamilies: mergeStrings('instrumentFamilies'),
    roles: mergeStrings('roles'),
    articulations: Array.from(artMap.values()),
    workStatuses: mergeStrings('workStatuses'),
  };
}

/**
 * Computes updated PresetOverrides when a user modifies a single category in the UI.
 */
export function computeOverridesFromProfileChange(
  base: MetadataPresetProfile,
  prevOverrides: PresetOverrides,
  nextProfile: MetadataPresetProfile
): PresetOverrides {
  const next = createEmptyPresetOverrides();

  const stringCategories: StringPresetCategoryKey[] = [
    'genres',
    'subgenres',
    'moods',
    'instruments',
    'instrumentFamilies',
    'roles',
    'workStatuses',
  ];

  for (const cat of stringCategories) {
    const baseSet = new Set(base[cat].map((s) => s.toLowerCase()));
    const nextSet = new Set(nextProfile[cat].map((s) => s.toLowerCase()));
    next.added[cat] = nextProfile[cat].filter((s) => !baseSet.has(s.toLowerCase()));
    next.removed[cat] = base[cat].filter((s) => !nextSet.has(s.toLowerCase()));
  }

  const baseArtMap = new Map(base.articulations.map((a) => [a.name.toLowerCase(), a]));
  const nextArtSet = new Set(nextProfile.articulations.map((a) => a.name.toLowerCase()));
  next.added.articulations = nextProfile.articulations.filter((a) => {
    const baseItem = baseArtMap.get(a.name.toLowerCase());
    if (!baseItem) return true;
    return baseItem.abbr !== a.abbr || baseItem.name !== a.name;
  });
  next.removed.articulations = base.articulations
    .filter((a) => !nextArtSet.has(a.name.toLowerCase()))
    .map((a) => a.name);

  // Keep prevOverrides signature for callers; return clean diff
  void prevOverrides;
  return next;
}

export function appendStringPreset(
  profile: MetadataPresetProfile,
  category: StringPresetCategoryKey,
  rawValue: string
): MetadataPresetProfile {
  const trimmed = rawValue.trim();
  if (!trimmed) return profile;
  const list = profile[category];
  if (list.some((item) => item.toLowerCase() === trimmed.toLowerCase())) {
    return profile;
  }
  return {
    ...profile,
    [category]: [...list, trimmed],
  };
}

export function appendArticulationPreset(
  profile: MetadataPresetProfile,
  rawName: string,
  rawAbbr = ''
): MetadataPresetProfile {
  const name = rawName.trim();
  const abbr = rawAbbr.trim();
  if (!name) return profile;
  if (profile.articulations.some((a) => a.name.toLowerCase() === name.toLowerCase())) {
    return profile;
  }
  return {
    ...profile,
    articulations: [...profile.articulations, { abbr, name }],
  };
}

export function resetCategoryInOverrides(
  overrides: PresetOverrides,
  category: PresetCategoryKey
): PresetOverrides {
  return {
    added: {
      ...overrides.added,
      [category]: [],
    },
    removed: {
      ...overrides.removed,
      [category]: [],
    },
  };
}
