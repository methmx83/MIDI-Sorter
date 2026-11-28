import type {
  FieldProvenance,
  InstrumentFamily,
  MetadataReviewStatus,
  MidiDatasetMetadata,
  MidiDatasetSection,
  MidiFileEntry,
  MidiFileType,
  MidiOrigin,
  MusicalRole,
  TrackMetadataEntry,
  TriageStatus,
  TrackableMetaField,
} from '../types/midi';
import type { LibraryAbbreviation } from './abbreviationProfile';
import {
  ALL_TRACKABLE_FIELDS,
  buildAutoTrackMetadata,
  createAutoMetadata,
  defaultSidecarRelativePath,
  mergeAutoIntoExistingMetadata,
  rebuildImportantTracksFromTrackMeta,
} from './midiClassifier';
import { buildBarGrid, tickToBarNumber } from './midiTimeline';

export interface ParsedSidecarResult {
  meta: Partial<MidiDatasetMetadata>;
  triage?: TriageStatus;
  explicitProvenance: Partial<Record<TrackableMetaField, FieldProvenance>>;
}

function unquoteYaml(raw: string): string {
  let v = raw.trim();
  // Strip inline comment outside quotes
  if (!v.startsWith('"') && !v.startsWith("'")) {
    const hashIdx = v.indexOf(' #');
    if (hashIdx >= 0) v = v.slice(0, hashIdx).trim();
  }
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    const inner = v.slice(1, -1);
    return inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return v;
}

function parseOriginValue(val: string): MidiOrigin | null {
  const low = val.trim().toLowerCase();
  if (low === 'eigenkomposition' || low === 'own' || low === 'own-composition') {
    return 'eigenkomposition';
  }
  if (low === 'library' || low === 'library-midi' || low === 'kontakt') {
    return 'library';
  }
  if (low === 'unbekannt' || low === 'unknown') return 'unbekannt';
  return null;
}

function parseFileTypeValue(val: string): MidiFileType | null {
  const low = val.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (low === 'full_track' || low === 'full') return 'full_track';
  if (low === 'pattern') return 'pattern';
  if (low === 'phrase') return 'phrase';
  if (low === 'loop') return 'loop';
  if (low === 'einzelspur' || low === 'single_track' || low === 'stem') return 'einzelspur';
  if (low === 'unbekannt' || low === 'unknown') return 'unbekannt';
  return null;
}

function parseInstrumentFamilyValue(val: string): InstrumentFamily | null {
  const trimmed = val.trim();
  if (!trimmed) return null;
  const low = trimmed.toLowerCase().replace(/[\s/-]+/g, '_');
  const map: Record<string, InstrumentFamily> = {
    strings: 'strings',
    streicher: 'strings',
    brass: 'brass',
    blechblaeser: 'brass',
    blechbläser: 'brass',
    woodwinds: 'woodwinds',
    holzblaeser: 'woodwinds',
    holzbläser: 'woodwinds',
    keys: 'keys',
    piano: 'keys',
    tasten: 'keys',
    tasten_piano: 'keys',
    synth: 'synth',
    guitar_plucked: 'guitar_plucked',
    guitar: 'guitar_plucked',
    gitarre: 'guitar_plucked',
    gitarre_zupfinstrument: 'guitar_plucked',
    bass: 'bass',
    drums_percussion: 'drums_percussion',
    drums: 'drums_percussion',
    percussion: 'drums_percussion',
    choir_vocal: 'choir_vocal',
    choir: 'choir_vocal',
    chor: 'choir_vocal',
    chor_vocal: 'choir_vocal',
    orchestra_ensemble: 'orchestra_ensemble',
    orchester: 'orchestra_ensemble',
    orchester_ensemble: 'orchestra_ensemble',
    fx_other: 'fx_other',
    fx: 'fx_other',
    fx_sonstiges: 'fx_other',
    unbekannt: 'unbekannt',
  };
  return map[low] ?? trimmed;
}

function parseMusicalRoleValue(val: string): MusicalRole | null {
  const trimmed = val.trim();
  if (!trimmed) return null;
  const low = trimmed.toLowerCase().replace(/[\s/-]+/g, '_');
  const map: Record<string, MusicalRole> = {
    melodie: 'melodie',
    melody: 'melodie',
    gegenmelodie: 'gegenmelodie',
    counter_melody: 'gegenmelodie',
    harmonie: 'harmonie',
    harmony: 'harmonie',
    bass: 'bass',
    percussion: 'percussion',
    ostinato_arp: 'ostinato_arp',
    ostinato: 'ostinato_arp',
    arp: 'ostinato_arp',
    arrangement: 'arrangement',
    full_arrangement: 'arrangement',
    fx: 'fx',
    fx_textur: 'fx',
    unbekannt: 'unbekannt',
  };
  return map[low] ?? trimmed;
}

function parseTriageValue(val: string): TriageStatus | undefined {
  const low = val.trim().toLowerCase();
  if (low === 'keep' || low === 'behalten') return 'keep';
  if (low === 'discard' || low === 'aussortieren' || low === 'aussortiert') return 'discard';
  if (low === 'pending' || low === 'offen') return 'pending';
  return undefined;
}

function parseReviewStatusValue(val: string): MetadataReviewStatus | null {
  const low = val.trim().toLowerCase();
  if (low === 'geprueft' || low === 'geprüft' || low === 'bestaetigt' || low === 'bestätigt') {
    return 'geprueft';
  }
  if (low === 'in_arbeit' || low === 'in arbeit') return 'in_arbeit';
  if (low === 'offen') return 'offen';
  return null;
}

const PROVENANCE_KEY_MAP: Record<string, TrackableMetaField> = {
  herkunft: 'origin',
  origin: 'origin',
  dateityp: 'fileType',
  fileType: 'fileType',
  genre: 'genre',
  hauptstil: 'genre',
  subgenre: 'subgenres',
  substil: 'subgenres',
  subgenres: 'subgenres',
  instrument: 'instrument',
  instrumentenfamilie: 'instrumentFamily',
  instrumentFamily: 'instrumentFamily',
  artikulation: 'articulation',
  articulation: 'articulation',
  musikalische_rolle: 'musicalRole',
  musicalRole: 'musicalRole',
  meine_bewertung: 'rating',
  rating: 'rating',
  bearbeitungsstatus: 'triage',
  triage: 'triage',
  status: 'workStatus',
  workStatus: 'workStatus',
  stimmung: 'moods',
  moods: 'moods',
};

/**
 * Parses both existing hand-written YAML-style `.txt` files (like Division_Orchestral.txt)
 * and extended MIDI Sorter `.txt` metadata sidecars.
 */
export function parseMetadataSidecarTxt(content: string): ParsedSidecarResult {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);

  const meta: Partial<MidiDatasetMetadata> = {};
  const explicitProvenance: Partial<Record<TrackableMetaField, FieldProvenance>> = {};
  let triage: TriageStatus | undefined;

  let currentTopSection = '';
  let currentSubList = '';
  let currentSectionObj: Partial<MidiDatasetSection> | null = null;
  let currentTrackObj: Partial<TrackMetadataEntry> | null = null;

  const sections: MidiDatasetSection[] = [];
  const trackMetadata: TrackMetadataEntry[] = [];
  const importantTracks: MidiDatasetMetadata['importantTracks'] = {
    hauptmelodie: [],
    gegenmelodie: [],
    harmonie: [],
    bass: [],
    rhythmischesFundament: [],
  };
  let sawImportantTracks = false;
  const subgenres: string[] = [];
  let sawSubgenres = false;
  const moods: string[] = [];
  let sawMoods = false;
  const whyILike: string[] = [];
  let sawWhyILike = false;
  const specialFeatures: string[] = [];
  let sawSpecialFeatures = false;
  const libraryAbbreviations: Array<{ key: string; meaning: string }> = [];
  let sawAbbr = false;

  const keyObj: { grundton?: string; modus?: string; sicherheit?: string } = {};
  const sourceObj: Partial<MidiDatasetMetadata['sourceLink']> = {};
  let sawSource = false;

  const flushSectionObj = () => {
    if (
      currentSectionObj &&
      currentSectionObj.name &&
      typeof currentSectionObj.vonTakt === 'number' &&
      typeof currentSectionObj.bisTakt === 'number'
    ) {
      sections.push({
        name: currentSectionObj.name,
        vonTakt: currentSectionObj.vonTakt,
        bisTakt: currentSectionObj.bisTakt,
      });
    }
    currentSectionObj = null;
  };

  const flushTrackObj = () => {
    if (currentTrackObj && currentTrackObj.trackName) {
      trackMetadata.push({
        trackIndex:
          typeof currentTrackObj.trackIndex === 'number' &&
          Number.isFinite(currentTrackObj.trackIndex)
            ? currentTrackObj.trackIndex
            : trackMetadata.length,
        trackName: currentTrackObj.trackName,
        noteCount:
          typeof currentTrackObj.noteCount === 'number' &&
          Number.isFinite(currentTrackObj.noteCount)
            ? currentTrackObj.noteCount
            : 0,
        instrument: currentTrackObj.instrument || currentTrackObj.trackName,
        instrumentFamily: currentTrackObj.instrumentFamily || 'unbekannt',
        articulation: currentTrackObj.articulation || 'Normal / Gemischt',
        musicalRole: currentTrackObj.musicalRole || 'unbekannt',
        confirmed: Boolean(currentTrackObj.confirmed),
      });
    }
    currentTrackObj = null;
  };

  for (const rawLine of lines) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;

    const indent = rawLine.length - rawLine.trimStart().length;
    const trimmed = rawLine.trim();

    if (indent === 0) {
      flushSectionObj();
      flushTrackObj();
      currentSubList = '';
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx < 0) continue;
      const key = trimmed.slice(0, colonIdx).trim();
      const rest = trimmed.slice(colonIdx + 1).trim();
      const val = unquoteYaml(rest);
      currentTopSection = key;

      if (key === 'titel' && val) meta.title = val;
      else if (key === 'composition_id' && val) meta.compositionId = val;
      else if (key === 'herkunft' && val) {
        const parsedOrigin = parseOriginValue(val);
        if (parsedOrigin) meta.origin = parsedOrigin;
      } else if (key === 'dateityp' && val) {
        const parsedType = parseFileTypeValue(val);
        if (parsedType) meta.fileType = parsedType;
      } else if (key === 'mehrspur_modus' && val) {
        meta.isMultiTrackMeta = val.toLowerCase() === 'true' || val.toLowerCase() === 'ja';
      } else if (key === 'status' && val) {
        meta.workStatus = val;
      } else if (key === 'bearbeitungsstatus' && val) {
        triage = parseTriageValue(val);
      } else if ((key === 'pruefstatus' || key === 'prüfstatus') && val) {
        const rs = parseReviewStatusValue(val);
        if (rs) meta.reviewStatus = rs;
      } else if ((key === 'hauptstil' || key === 'genre') && val) {
        meta.genre = val;
      } else if ((key === 'substil' || key === 'subgenre') && rest === '[]') {
        sawSubgenres = true;
      } else if (key === 'instrument' && val) {
        meta.instrument = val;
      } else if (key === 'instrumentenfamilie' && val) {
        const fam = parseInstrumentFamilyValue(val);
        if (fam) meta.instrumentFamily = fam;
      } else if (key === 'artikulation' && val) {
        meta.articulation = val;
      } else if (key === 'musikalische_rolle' && val) {
        const role = parseMusicalRoleValue(val);
        if (role) meta.musicalRole = role;
      } else if (key === 'meine_bewertung' && val && val !== 'null' && val !== 'unbewertet') {
        const n = Number(val);
        if (Number.isFinite(n) && n >= 1 && n <= 10) {
          meta.rating = Math.round(n);
        }
      } else if (key === 'stimmung' && rest === '[]') {
        sawMoods = true;
      } else if (key === 'warum_ich_das_projekt_mag' && rest === '[]') {
        sawWhyILike = true;
      } else if (key === 'besondere_merkmale' && rest === '[]') {
        sawSpecialFeatures = true;
      }
      continue;
    }

    // Indented content
    if (currentTopSection === 'substil' || currentTopSection === 'subgenre') {
      if (trimmed.startsWith('- ')) {
        sawSubgenres = true;
        const item = unquoteYaml(trimmed.slice(2));
        if (item) subgenres.push(item);
      }
    } else if (currentTopSection === 'stimmung') {
      if (trimmed.startsWith('- ')) {
        sawMoods = true;
        const item = unquoteYaml(trimmed.slice(2));
        if (item) moods.push(item);
      }
    } else if (currentTopSection === 'warum_ich_das_projekt_mag') {
      if (trimmed.startsWith('- ')) {
        sawWhyILike = true;
        const item = unquoteYaml(trimmed.slice(2));
        if (item) whyILike.push(item);
      }
    } else if (currentTopSection === 'besondere_merkmale') {
      if (trimmed.startsWith('- ')) {
        sawSpecialFeatures = true;
        const item = unquoteYaml(trimmed.slice(2));
        if (item) specialFeatures.push(item);
      }
    } else if (currentTopSection === 'tonart') {
      const idx = trimmed.indexOf(':');
      if (idx > 0) {
        const k = trimmed.slice(0, idx).trim();
        const v = unquoteYaml(trimmed.slice(idx + 1));
        if (k === 'grundton') keyObj.grundton = v;
        if (k === 'modus') keyObj.modus = v;
        if (k === 'sicherheit') keyObj.sicherheit = v;
      }
    } else if (currentTopSection === 'wichtige_spuren') {
      sawImportantTracks = true;
      if (trimmed.startsWith('- ')) {
        const item = unquoteYaml(trimmed.slice(2));
        if (item && currentSubList) {
          if (currentSubList === 'hauptmelodie') importantTracks.hauptmelodie.push(item);
          else if (currentSubList === 'gegenmelodie') importantTracks.gegenmelodie.push(item);
          else if (currentSubList === 'harmonie') importantTracks.harmonie.push(item);
          else if (currentSubList === 'bass') importantTracks.bass.push(item);
          else if (currentSubList === 'rhythmisches_fundament')
            importantTracks.rhythmischesFundament.push(item);
        }
      } else {
        const idx = trimmed.indexOf(':');
        if (idx > 0) {
          currentSubList = trimmed.slice(0, idx).trim();
        }
      }
    } else if (currentTopSection === 'abschnitte') {
      if (trimmed.startsWith('- ')) {
        flushSectionObj();
        currentSectionObj = {};
        const afterDash = trimmed.slice(2).trim();
        const idx = afterDash.indexOf(':');
        if (idx > 0) {
          const k = afterDash.slice(0, idx).trim();
          const v = unquoteYaml(afterDash.slice(idx + 1));
          if (k === 'name') currentSectionObj.name = v;
          if (k === 'von_takt') currentSectionObj.vonTakt = Number(v);
          if (k === 'bis_takt') currentSectionObj.bisTakt = Number(v);
        }
      } else if (currentSectionObj) {
        const idx = trimmed.indexOf(':');
        if (idx > 0) {
          const k = trimmed.slice(0, idx).trim();
          const v = unquoteYaml(trimmed.slice(idx + 1));
          if (k === 'name') currentSectionObj.name = v;
          if (k === 'von_takt') currentSectionObj.vonTakt = Number(v);
          if (k === 'bis_takt') currentSectionObj.bisTakt = Number(v);
        }
      }
    } else if (
      currentTopSection === 'library_abkürzungen' ||
      currentTopSection === 'library_abkuerzungen'
    ) {
      sawAbbr = true;
      const idx = trimmed.indexOf(':');
      if (idx > 0) {
        const k = trimmed.slice(0, idx).trim();
        const v = unquoteYaml(trimmed.slice(idx + 1));
        if (k && v) libraryAbbreviations.push({ key: k, meaning: v });
      }
    } else if (currentTopSection === 'quelle') {
      sawSource = true;
      const idx = trimmed.indexOf(':');
      if (idx > 0) {
        const k = trimmed.slice(0, idx).trim();
        const v = unquoteYaml(trimmed.slice(idx + 1));
        if (k === 'midi_datei' && v) sourceObj.midiFile = v;
        else if (k === 'metadaten_datei' && v) sourceObj.metadataFile = v;
        else if (k === 'sha256' && v && v !== 'null') sourceObj.sha256 = v;
        else if (k === 'original_datei' && v && v !== 'null') sourceObj.originalFile = v;
        else if (k === 'original_sha256' && v && v !== 'null') sourceObj.originalSha256 = v;
        else if (k === 'parent_composition_id' && v && v !== 'null')
          sourceObj.parentCompositionId = v;
        else if (k === 'quell_spur_index' && v && v !== 'null') {
          const n = Number(v);
          if (Number.isFinite(n)) sourceObj.sourceTrackIndex = n;
        } else if (k === 'quell_spur_name' && v && v !== 'null') {
          sourceObj.sourceTrackName = v;
        } else if (k === 'start_tick_offset' && v && v !== 'null') {
          const n = Number(v);
          if (Number.isFinite(n)) sourceObj.startTickOffset = n;
        } else if (k === 'segment_takte' && v && v.includes('-')) {
          const [a, b] = v.split('-').map((s) => Number(s.trim()));
          if (Number.isFinite(a) && Number.isFinite(b)) {
            sourceObj.segmentBars = { fromBar: a, toBar: b };
          }
        }
      }
    } else if (currentTopSection === 'spuren_metadaten') {
      const applyTrackKv = (k: string, v: string) => {
        if (!currentTrackObj) return;
        if (k === 'spur_index') currentTrackObj.trackIndex = Number(v);
        else if (k === 'spur' || k === 'name') currentTrackObj.trackName = v;
        else if (k === 'noten') currentTrackObj.noteCount = Number(v);
        else if (k === 'instrument') currentTrackObj.instrument = v;
        else if (k === 'instrumentenfamilie') {
          const fam = parseInstrumentFamilyValue(v);
          if (fam) currentTrackObj.instrumentFamily = fam;
        } else if (k === 'artikulation') currentTrackObj.articulation = v;
        else if (k === 'musikalische_rolle') {
          const role = parseMusicalRoleValue(v);
          if (role) currentTrackObj.musicalRole = role;
        } else if (k === 'bestaetigt' || k === 'bestätigt') {
          currentTrackObj.confirmed = v.toLowerCase() === 'true' || v.toLowerCase() === 'ja';
        }
      };

      if (trimmed.startsWith('- ')) {
        flushTrackObj();
        currentTrackObj = {};
        const afterDash = trimmed.slice(2).trim();
        const idx = afterDash.indexOf(':');
        if (idx > 0) {
          applyTrackKv(afterDash.slice(0, idx).trim(), unquoteYaml(afterDash.slice(idx + 1)));
        }
      } else if (currentTrackObj) {
        const idx = trimmed.indexOf(':');
        if (idx > 0) {
          applyTrackKv(trimmed.slice(0, idx).trim(), unquoteYaml(trimmed.slice(idx + 1)));
        }
      }
    } else if (currentTopSection === 'feld_herkunft') {
      const idx = trimmed.indexOf(':');
      if (idx > 0) {
        const rawKey = trimmed.slice(0, idx).trim();
        const rawVal = unquoteYaml(trimmed.slice(idx + 1)).toLowerCase();
        const mapped = PROVENANCE_KEY_MAP[rawKey];
        if (mapped) {
          explicitProvenance[mapped] =
            rawVal === 'manuell' || rawVal === 'manual' || rawVal === 'bestätigt'
              ? 'manual'
              : 'auto';
        }
      }
    }
  }

  flushSectionObj();
  flushTrackObj();

  if (sawSubgenres) meta.subgenres = subgenres;
  if (sawMoods) meta.moods = moods;
  if (sawWhyILike) meta.whyILike = whyILike;
  if (sawSpecialFeatures) meta.specialFeatures = specialFeatures;
  if (sawImportantTracks) meta.importantTracks = importantTracks;
  if (sections.length > 0) meta.sections = sections;
  if (trackMetadata.length > 0) meta.trackMetadata = trackMetadata;
  if (sawAbbr) meta.libraryAbbreviations = libraryAbbreviations;
  if (keyObj.grundton && keyObj.modus) {
    meta.keyOverride = {
      grundton: keyObj.grundton,
      modus: keyObj.modus,
      sicherheit: keyObj.sicherheit || 'sicher',
    };
  }
  if (sawSource) {
    meta.sourceLink = {
      midiFile: sourceObj.midiFile || '',
      metadataFile: sourceObj.metadataFile || '',
      sha256: sourceObj.sha256 ?? null,
      originalFile: sourceObj.originalFile ?? null,
      originalSha256: sourceObj.originalSha256 ?? null,
      parentCompositionId: sourceObj.parentCompositionId ?? null,
      sourceTrackIndex: sourceObj.sourceTrackIndex ?? null,
      sourceTrackName: sourceObj.sourceTrackName ?? null,
      startTickOffset: sourceObj.startTickOffset ?? null,
      segmentBars: sourceObj.segmentBars ?? null,
    };
  }

  return { meta, triage, explicitProvenance };
}

/**
 * Hydrates a MidiFileEntry's full dataset metadata by combining:
 * 1. Fresh auto-classification
 * 2. Optional local browser persistence (for read-only/triage state)
 * 3. Optional `.txt` sidecar file from disk (highest priority!)
 */
export function buildHydratedMetadata(
  entry: MidiFileEntry,
  sidecarText: string | null,
  abbreviations: LibraryAbbreviation[],
  folderHint?: string
): { meta: MidiDatasetMetadata; restoredTriage?: TriageStatus } {
  const auto = createAutoMetadata(entry, abbreviations, folderHint);
  const localSnap = loadLocalMetadataSnapshot(entry);

  let working = auto;
  let restoredTriage: TriageStatus | undefined;

  // Apply local snapshot first (lower priority than actual .txt file on disk)
  if (localSnap) {
    working = mergeAutoIntoExistingMetadata(
      {
        ...auto,
        ...localSnap.meta,
        fieldProvenance: {
          ...auto.fieldProvenance,
          ...localSnap.meta.fieldProvenance,
        },
        sourceLink: {
          ...auto.sourceLink,
          ...localSnap.meta.sourceLink,
          midiFile: entry.relativePath,
          metadataFile: entry.sidecarRelativePath || defaultSidecarRelativePath(entry.relativePath),
          sha256: entry.sha256 ?? localSnap.meta.sourceLink?.sha256 ?? null,
        },
        sidecarLoaded: false,
        sidecarDirty: Boolean(localSnap.meta.sidecarDirty),
      },
      auto
    );
    restoredTriage = localSnap.triage;
  }

  // Apply on-disk `.txt` sidecar (source of truth!)
  if (sidecarText && sidecarText.trim().length > 0) {
    const parsed = parseMetadataSidecarTxt(sidecarText);
    const hasExplicitProv = Object.keys(parsed.explicitProvenance).length > 0;
    const prov: Record<TrackableMetaField, FieldProvenance> = { ...working.fieldProvenance };

    // If a file was hand-written without `feld_herkunft`, any field present in the .txt counts as manual/confirmed
    const markPresent = (field: TrackableMetaField, present: boolean) => {
      if (parsed.explicitProvenance[field]) {
        prov[field] = parsed.explicitProvenance[field]!;
      } else if (!hasExplicitProv && present) {
        prov[field] = 'manual';
      }
    };

    markPresent('origin', Boolean(parsed.meta.origin));
    markPresent('fileType', Boolean(parsed.meta.fileType));
    markPresent('genre', Boolean(parsed.meta.genre));
    markPresent('subgenres', parsed.meta.subgenres !== undefined);
    markPresent('instrument', Boolean(parsed.meta.instrument));
    markPresent('instrumentFamily', Boolean(parsed.meta.instrumentFamily));
    markPresent('articulation', Boolean(parsed.meta.articulation));
    markPresent('musicalRole', Boolean(parsed.meta.musicalRole));
    markPresent('rating', parsed.meta.rating !== undefined && parsed.meta.rating !== null);
    markPresent('triage', parsed.triage !== undefined);
    markPresent('workStatus', Boolean(parsed.meta.workStatus));
    markPresent('moods', parsed.meta.moods !== undefined);

    const parsedTracks = parsed.meta.trackMetadata;
    const hydratedTrackMeta =
      parsedTracks && parsedTracks.length > 0
        ? parsedTracks.map((tr) => {
            if (tr.confirmed) return tr;
            const autoMatch = auto.trackMetadata?.find(
              (a) => a.trackIndex === tr.trackIndex || a.trackName === tr.trackName
            );
            return autoMatch ? { ...autoMatch, confirmed: false } : tr;
          })
        : entry.parsed
        ? buildAutoTrackMetadata(entry.parsed, abbreviations, parsed.meta.importantTracks)
        : working.trackMetadata;

    const mergedImportantTracks =
      parsedTracks && parsedTracks.length > 0 && hydratedTrackMeta && hydratedTrackMeta.length > 0
        ? rebuildImportantTracksFromTrackMeta(hydratedTrackMeta)
        : parsed.meta.importantTracks ?? working.importantTracks;

    const effectiveFileType = parsed.meta.fileType ?? working.fileType;
    const effectiveMultiTrack =
      parsed.meta.isMultiTrackMeta !== undefined
        ? parsed.meta.isMultiTrackMeta
        : effectiveFileType === 'full_track' ||
          (hydratedTrackMeta !== undefined &&
            hydratedTrackMeta.length >= 2 &&
            (parsed.meta.musicalRole ?? working.musicalRole) === 'arrangement');

    const sidecarMerged: MidiDatasetMetadata = {
      ...working,
      ...parsed.meta,
      compositionId: parsed.meta.compositionId || working.compositionId,
      title: parsed.meta.title || working.title,
      origin: parsed.meta.origin ?? working.origin,
      fileType: effectiveFileType,
      isMultiTrackMeta: effectiveMultiTrack,
      workStatus: parsed.meta.workStatus ?? working.workStatus,
      reviewStatus:
        parsed.meta.reviewStatus ??
        (!hasExplicitProv ? 'geprueft' : working.reviewStatus),
      genre: parsed.meta.genre ?? working.genre,
      subgenres: parsed.meta.subgenres ?? working.subgenres,
      instrument: parsed.meta.instrument ?? working.instrument,
      instrumentFamily: parsed.meta.instrumentFamily ?? working.instrumentFamily,
      articulation: parsed.meta.articulation ?? working.articulation,
      musicalRole: parsed.meta.musicalRole ?? working.musicalRole,
      trackMetadata: hydratedTrackMeta,
      rating: parsed.meta.rating !== undefined ? parsed.meta.rating : working.rating,
      moods: parsed.meta.moods ?? working.moods,
      whyILike: parsed.meta.whyILike ?? working.whyILike,
      specialFeatures: parsed.meta.specialFeatures ?? working.specialFeatures,
      importantTracks: mergedImportantTracks,
      sections: parsed.meta.sections ?? working.sections,
      libraryAbbreviations: parsed.meta.libraryAbbreviations ?? working.libraryAbbreviations,
      keyOverride: parsed.meta.keyOverride ?? working.keyOverride,
      fieldProvenance: prov,
      sourceLink: {
        ...working.sourceLink,
        ...(parsed.meta.sourceLink || {}),
        midiFile: entry.relativePath,
        metadataFile: entry.sidecarRelativePath || defaultSidecarRelativePath(entry.relativePath),
        sha256: entry.sha256 ?? parsed.meta.sourceLink?.sha256 ?? working.sourceLink.sha256,
        originalFile:
          parsed.meta.sourceLink?.originalFile ||
          working.sourceLink.originalFile ||
          entry.relativePath,
        originalSha256:
          parsed.meta.sourceLink?.originalSha256 ||
          working.sourceLink.originalSha256 ||
          entry.originalSha256 ||
          entry.sha256 ||
          null,
      },
      sidecarLoaded: true,
      sidecarDirty: false,
    };

    working = sidecarMerged;
    if (parsed.triage !== undefined) {
      restoredTriage = parsed.triage;
    }
  }

  return { meta: working, restoredTriage };
}

function yamlStr(val: string): string {
  return `"${val.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function pushYamlList(
  lines: string[],
  key: string,
  items: string[],
  indent = ''
): void {
  if (items.length === 0) {
    lines.push(`${indent}${key}: []`);
    return;
  }
  lines.push(`${indent}${key}:`);
  for (const item of items) {
    lines.push(`${indent}  - ${yamlStr(item)}`);
  }
}

function triageToGerman(triage: TriageStatus): string {
  if (triage === 'keep') return 'behalten';
  if (triage === 'discard') return 'aussortieren';
  return 'offen';
}

/**
 * Serializes MidiDatasetMetadata + ParsedMidi into the clean, human-readable YAML-style `.txt`
 * sidecar format (100% compatible with existing `.txt` files and Python `yaml.safe_load`).
 */
export function serializeMetadataSidecarTxt(
  entry: MidiFileEntry,
  meta: MidiDatasetMetadata
): string {
  const parsed = entry.parsed;
  const lines: string[] = [];

  lines.push(`titel: ${yamlStr(meta.title || entry.name.replace(/\.(mid|midi)$/i, ''))}`);
  lines.push(`composition_id: ${yamlStr(meta.compositionId)}`);
  lines.push(`herkunft: ${yamlStr(meta.origin)}`);
  lines.push(`dateityp: ${yamlStr(meta.fileType)}`);
  lines.push(`mehrspur_modus: ${meta.isMultiTrackMeta ? 'true' : 'false'}`);
  lines.push(`status: ${yamlStr(meta.workStatus)}`);
  lines.push(`bearbeitungsstatus: ${yamlStr(triageToGerman(entry.triage))}`);
  lines.push(`pruefstatus: ${yamlStr(meta.reviewStatus)}`);
  lines.push('');

  lines.push(`hauptstil: ${yamlStr(meta.genre || 'unbekannt')}`);
  pushYamlList(lines, 'substil', meta.subgenres);
  lines.push('');

  lines.push(`instrument: ${yamlStr(meta.instrument || 'unbekannt')}`);
  lines.push(`instrumentenfamilie: ${yamlStr(meta.instrumentFamily)}`);
  lines.push(`artikulation: ${yamlStr(meta.articulation || 'Normal / Gemischt')}`);
  lines.push(`musikalische_rolle: ${yamlStr(meta.musicalRole)}`);
  lines.push('');

  // Musical key (prefer manual keyOverride if present, else parsed)
  let grundton = 'unbekannt';
  let modus = 'unbekannt';
  let sicherheit = 'unbekannt';
  if (meta.keyOverride) {
    grundton = meta.keyOverride.grundton;
    modus = meta.keyOverride.modus;
    sicherheit = meta.keyOverride.sicherheit;
  } else if (parsed) {
    if (parsed.isPercussionOnly) {
      grundton = '-';
      modus = 'percussion';
      sicherheit = 'sicher';
    } else if (parsed.detectedKey) {
      const rawRoot = parsed.detectedKey.label.replace(/-(Dur|Moll)$/i, '');
      grundton = rawRoot.charAt(0).toUpperCase() + rawRoot.slice(1);
      modus = parsed.detectedKey.mode;
      const c = parsed.detectedKey.confidence;
      sicherheit = c >= 76 ? 'sicher' : c >= 58 ? 'mittel' : 'unsicher';
    } else if (parsed.metadata.embeddedKeySignature) {
      const raw = parsed.metadata.embeddedKeySignature;
      const rawRoot = raw.replace(/-(Dur|Moll)$/i, '');
      grundton = rawRoot.charAt(0).toUpperCase() + rawRoot.slice(1);
      modus = /moll$/i.test(raw) ? 'minor' : 'major';
      sicherheit = 'sicher';
    }
  }

  lines.push('tonart:');
  lines.push(`  grundton: ${yamlStr(grundton)}`);
  lines.push(`  modus: ${yamlStr(modus)}`);
  lines.push(`  sicherheit: ${yamlStr(sicherheit)}`);
  lines.push('');

  if (parsed) {
    const barGrid = buildBarGrid(parsed.ppqn, parsed.timeSignatures, parsed.totalTicks);
    const taktart = parsed.hasExplicitTimeSignature
      ? parsed.primaryTimeSignature
      : `${parsed.primaryTimeSignature} (Standard)`;
    lines.push(`taktart: ${yamlStr(taktart)}`);

    if (parsed.hasExplicitTimeSignature && parsed.timeSignatures.length > 1) {
      lines.push('taktart_wechsel:');
      for (const ts of parsed.timeSignatures) {
        lines.push(`  - takt: ${ts.bar ?? tickToBarNumber(barGrid, ts.tick)}`);
        lines.push(`    taktart: ${yamlStr(`${ts.numerator}/${ts.denominator}`)}`);
      }
    }

    if (parsed.hasExplicitTempo) {
      lines.push(`tempo_bpm: ${Math.round(parsed.primaryBpm)}`);
      if (parsed.tempos.length > 1) {
        lines.push('tempo_wechsel:');
        for (const t of parsed.tempos) {
          lines.push(`  - takt: ${tickToBarNumber(barGrid, t.tick)}`);
          lines.push(`    bpm: ${Math.round(t.bpm)}`);
        }
      }
    } else {
      lines.push('tempo_bpm: "unbekannt" # Keine Tempoangabe (0x51) in MIDI');
    }
  } else {
    lines.push('taktart: "unbekannt"');
    lines.push('tempo_bpm: "unbekannt"');
  }
  lines.push('');

  pushYamlList(lines, 'stimmung', meta.moods);
  lines.push('');

  if (meta.rating !== null) {
    lines.push(`meine_bewertung: ${meta.rating}`);
  } else {
    lines.push('meine_bewertung: null');
  }
  pushYamlList(lines, 'warum_ich_das_projekt_mag', meta.whyILike);
  lines.push('');

  lines.push('wichtige_spuren:');
  pushYamlList(lines, 'hauptmelodie', meta.importantTracks.hauptmelodie, '  ');
  pushYamlList(lines, 'gegenmelodie', meta.importantTracks.gegenmelodie, '  ');
  pushYamlList(lines, 'harmonie', meta.importantTracks.harmonie, '  ');
  pushYamlList(lines, 'bass', meta.importantTracks.bass, '  ');
  pushYamlList(
    lines,
    'rhythmisches_fundament',
    meta.importantTracks.rhythmischesFundament,
    '  '
  );
  lines.push('');

  if (meta.isMultiTrackMeta && meta.trackMetadata && meta.trackMetadata.length > 0) {
    lines.push('spuren_metadaten:');
    for (const tr of meta.trackMetadata) {
      lines.push(`  - spur: ${yamlStr(tr.trackName)}`);
      lines.push(`    spur_index: ${tr.trackIndex}`);
      lines.push(`    noten: ${tr.noteCount}`);
      lines.push(`    instrument: ${yamlStr(tr.instrument)}`);
      lines.push(`    instrumentenfamilie: ${yamlStr(tr.instrumentFamily)}`);
      lines.push(`    artikulation: ${yamlStr(tr.articulation)}`);
      lines.push(`    musikalische_rolle: ${yamlStr(tr.musicalRole)}`);
      lines.push(`    bestaetigt: ${tr.confirmed ? 'true' : 'false'}`);
    }
    lines.push('');
  }

  lines.push('abschnitte:');
  for (const sec of meta.sections) {
    lines.push(`  - name: ${yamlStr(sec.name)}`);
    lines.push(`    von_takt: ${sec.vonTakt}`);
    lines.push(`    bis_takt: ${sec.bisTakt}`);
  }
  lines.push('');

  pushYamlList(lines, 'besondere_merkmale', meta.specialFeatures);
  lines.push('');

  lines.push('library_abkürzungen:');
  if (meta.libraryAbbreviations.length === 0) {
    lines.push('  # keine speziellen Abkürzungen erkannt');
  } else {
    for (const abbr of meta.libraryAbbreviations) {
      lines.push(`  ${abbr.key}: ${yamlStr(abbr.meaning)}`);
    }
  }
  lines.push('');

  lines.push('quelle:');
  lines.push(`  midi_datei: ${yamlStr(meta.sourceLink.midiFile || entry.relativePath)}`);
  lines.push(
    `  metadaten_datei: ${yamlStr(
      meta.sourceLink.metadataFile || defaultSidecarRelativePath(entry.relativePath)
    )}`
  );
  lines.push(`  sha256: ${meta.sourceLink.sha256 ? yamlStr(meta.sourceLink.sha256) : 'null'}`);
  lines.push(
    `  original_datei: ${
      meta.sourceLink.originalFile ? yamlStr(meta.sourceLink.originalFile) : 'null'
    }`
  );
  lines.push(
    `  original_sha256: ${
      meta.sourceLink.originalSha256 ? yamlStr(meta.sourceLink.originalSha256) : 'null'
    }`
  );
  if (meta.sourceLink.parentCompositionId) {
    lines.push(`  parent_composition_id: ${yamlStr(meta.sourceLink.parentCompositionId)}`);
  }
  if (
    meta.sourceLink.sourceTrackIndex !== null &&
    meta.sourceLink.sourceTrackIndex !== undefined
  ) {
    lines.push(`  quell_spur_index: ${meta.sourceLink.sourceTrackIndex}`);
  }
  if (meta.sourceLink.sourceTrackName) {
    lines.push(`  quell_spur_name: ${yamlStr(meta.sourceLink.sourceTrackName)}`);
  }
  if (
    meta.sourceLink.startTickOffset !== null &&
    meta.sourceLink.startTickOffset !== undefined
  ) {
    lines.push(`  start_tick_offset: ${meta.sourceLink.startTickOffset}`);
  }
  if (meta.sourceLink.segmentBars) {
    lines.push(
      `  segment_takte: ${yamlStr(
        `${meta.sourceLink.segmentBars.fromBar}-${meta.sourceLink.segmentBars.toBar}`
      )}`
    );
  }
  lines.push('');

  lines.push('feld_herkunft:');
  const provEntries: Array<[string, TrackableMetaField]> = [
    ['herkunft', 'origin'],
    ['dateityp', 'fileType'],
    ['hauptstil', 'genre'],
    ['substil', 'subgenres'],
    ['instrument', 'instrument'],
    ['instrumentenfamilie', 'instrumentFamily'],
    ['artikulation', 'articulation'],
    ['musikalische_rolle', 'musicalRole'],
    ['meine_bewertung', 'rating'],
    ['bearbeitungsstatus', 'triage'],
    ['status', 'workStatus'],
    ['stimmung', 'moods'],
  ];
  for (const [yamlKey, field] of provEntries) {
    const val = meta.fieldProvenance[field] === 'manual' ? 'manuell' : 'auto';
    lines.push(`  ${yamlKey}: ${yamlStr(val)}`);
  }

  return lines.join('\n') + '\n';
}

export function countConfirmedFields(meta?: MidiDatasetMetadata): {
  confirmed: number;
  total: number;
} {
  if (!meta) return { confirmed: 0, total: ALL_TRACKABLE_FIELDS.length };
  let confirmed = 0;
  for (const f of ALL_TRACKABLE_FIELDS) {
    if (meta.fieldProvenance[f] === 'manual') confirmed++;
  }
  return { confirmed, total: ALL_TRACKABLE_FIELDS.length };
}

// --- Lightweight Local Persistence Store (survives reload even in read-only mode) ---

const LOCAL_META_STORAGE_KEY = 'midi_sorter_dataset_meta_v1';
const MAX_LOCAL_RECORDS = 1500;

interface LocalMetaSnapshot {
  triage: TriageStatus;
  meta: Partial<MidiDatasetMetadata>;
  updatedAt: number;
}

let cachedLocalMap: Record<string, LocalMetaSnapshot> | null = null;

function readLocalStore(): Record<string, LocalMetaSnapshot> {
  if (cachedLocalMap) return cachedLocalMap;
  try {
    const raw = window.localStorage.getItem(LOCAL_META_STORAGE_KEY);
    if (!raw) {
      cachedLocalMap = {};
      return cachedLocalMap;
    }
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      cachedLocalMap = parsed as Record<string, LocalMetaSnapshot>;
      return cachedLocalMap;
    }
  } catch {
    // Ignore storage errors
  }
  cachedLocalMap = {};
  return cachedLocalMap;
}

function flushLocalStore(store: Record<string, LocalMetaSnapshot>): void {
  try {
    const keys = Object.keys(store);
    if (keys.length > MAX_LOCAL_RECORDS) {
      keys.sort((a, b) => (store[a].updatedAt || 0) - (store[b].updatedAt || 0));
      const excess = keys.length - MAX_LOCAL_RECORDS;
      for (let i = 0; i < excess; i++) {
        delete store[keys[i]];
      }
    }
    window.localStorage.setItem(LOCAL_META_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Ignore quota errors
  }
}

function localStorageKeysForEntry(entry: MidiFileEntry): string[] {
  const keys: string[] = [];
  if (entry.sha256) keys.push(`sha:${entry.sha256}`);
  if (entry.originalSha256 && entry.originalSha256 !== entry.sha256) {
    keys.push(`sha:${entry.originalSha256}`);
  }
  keys.push(`path:${entry.relativePath.toLowerCase()}::${entry.sizeBytes}`);
  return keys;
}

export function loadLocalMetadataSnapshot(entry: MidiFileEntry): LocalMetaSnapshot | null {
  const store = readLocalStore();
  for (const key of localStorageKeysForEntry(entry)) {
    if (store[key]) return store[key];
  }
  return null;
}

export function saveLocalMetadataSnapshot(
  entry: MidiFileEntry,
  meta: MidiDatasetMetadata,
  triage: TriageStatus
): void {
  const store = readLocalStore();
  const primaryKey = entry.sha256
    ? `sha:${entry.sha256}`
    : `path:${entry.relativePath.toLowerCase()}::${entry.sizeBytes}`;
  store[primaryKey] = {
    triage,
    meta,
    updatedAt: Date.now(),
  };
  flushLocalStore(store);
}
