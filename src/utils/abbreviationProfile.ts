import { DEFAULT_ARTICULATION_PRESETS } from './metadataPresets';

export interface LibraryAbbreviation {
  key: string;
  meaning: string;
}

const STORAGE_KEY = 'midi_sorter_abbr_profile_v1';
const MIGRATED_V2_KEY = 'midi_sorter_abbr_profile_v2_migrated';

const LIBRARY_BASE_ABBREVIATIONS: LibraryAbbreviation[] = [
  { key: 'CS', meaning: 'Cinematic Studio' },
  { key: 'CSS', meaning: 'Cinematic Studio Strings' },
  { key: 'Ark', meaning: 'Metropolis Ark' },
  { key: 'BL', meaning: 'Berlin Series / Benutzerdefinierte Library' },
  { key: 'D2', meaning: 'Damage 2' },
  { key: 'Vio', meaning: 'Violin / Streicher' },
  { key: 'Trump', meaning: 'Trumpet / Brass' },
  { key: 'Arp', meaning: 'Arpeggio' },
];

export const DEFAULT_ABBREVIATIONS: LibraryAbbreviation[] = [
  ...LIBRARY_BASE_ABBREVIATIONS,
  ...DEFAULT_ARTICULATION_PRESETS.filter((a) => a.abbr.trim().length > 0).map((a) => ({
    key: a.abbr,
    meaning: a.name,
  })),
];

export function loadAbbreviationProfile(): LibraryAbbreviation[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_ABBREVIATIONS.map((x) => ({ ...x }));
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_ABBREVIATIONS.map((x) => ({ ...x }));
    const valid = parsed.filter(
      (item): item is LibraryAbbreviation =>
        item &&
        typeof item.key === 'string' &&
        typeof item.meaning === 'string' &&
        item.key.trim().length > 0
    );
    if (valid.length === 0) return DEFAULT_ABBREVIATIONS.map((x) => ({ ...x }));

    // One-time non-destructive merge of new articulation abbreviations from Presets.md
    if (!window.localStorage.getItem(MIGRATED_V2_KEY)) {
      const existingKeys = new Set(valid.map((v) => v.key.trim().toLowerCase()));
      const merged = [...valid];
      for (const def of DEFAULT_ABBREVIATIONS) {
        if (!existingKeys.has(def.key.toLowerCase())) {
          merged.push({ ...def });
        }
      }
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
      window.localStorage.setItem(MIGRATED_V2_KEY, '1');
      return merged;
    }

    return valid;
  } catch {
    return DEFAULT_ABBREVIATIONS.map((x) => ({ ...x }));
  }
}

export function saveAbbreviationProfile(items: LibraryAbbreviation[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    window.localStorage.setItem(MIGRATED_V2_KEY, '1');
  } catch {
    // Ignore storage quota / privacy mode errors
  }
}
