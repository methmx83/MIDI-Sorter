export interface LibraryAbbreviation {
  key: string;
  meaning: string;
}

const STORAGE_KEY = 'midi_sorter_abbr_profile_v1';

export const DEFAULT_ABBREVIATIONS: LibraryAbbreviation[] = [
  { key: 'CS', meaning: 'Cinematic Studio' },
  { key: 'Ark', meaning: 'Metropolis Ark' },
  { key: 'BL', meaning: 'Benutzerdefinierte Library / Abkürzung' },
  { key: 'Spic', meaning: 'Spiccato' },
  { key: 'Stac', meaning: 'Staccato' },
  { key: 'Leg', meaning: 'Legato' },
  { key: 'Marc', meaning: 'Marcato' },
  { key: 'Sus', meaning: 'Sustain' },
  { key: 'Uni', meaning: 'Unisono' },
  { key: 'Flag', meaning: 'Flageolett / Harmonics' },
  { key: 'Vio', meaning: 'Violin / Streicher' },
  { key: 'Ens', meaning: 'Ensemble' },
  { key: 'Trump', meaning: 'Trompete / Brass' },
  { key: 'Arp', meaning: 'Arpeggio' },
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
    return valid.length > 0 ? valid : DEFAULT_ABBREVIATIONS.map((x) => ({ ...x }));
  } catch {
    return DEFAULT_ABBREVIATIONS.map((x) => ({ ...x }));
  }
}

export function saveAbbreviationProfile(items: LibraryAbbreviation[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Ignore storage quota / privacy mode errors
  }
}
