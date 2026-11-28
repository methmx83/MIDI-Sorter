import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpDown,
  Database,
  Filter,
  FolderOpen,
  MousePointerClick,
  PanelRightClose,
  PanelRightOpen,
  Search,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Upload,
} from 'lucide-react';
import { BatchTrainingExportModal } from './components/BatchTrainingExportModal';
import { ExportCleanupModal } from './components/ExportCleanupModal';
import { FileListPane, type SortMode } from './components/FileListPane';
import { InspectorSidebar, type InspectorTab } from './components/InspectorSidebar';
import { MidiPianoRoll } from './components/MidiPianoRoll';
import { TrainingTxtModal } from './components/TrainingTxtModal';
import type {
  FieldProvenance,
  MidiDatasetMetadata,
  MidiFileEntry,
  TrackableMetaField,
  TriageStatus,
} from './types/midi';
import {
  loadAbbreviationProfile,
  saveAbbreviationProfile,
  type LibraryAbbreviation,
} from './utils/abbreviationProfile';
import {
  appendArticulationPreset,
  appendStringPreset,
  applyPresetOverrides,
  computeOverridesFromProfileChange,
  createDefaultMetadataPresets,
  fetchPresetsFromFile,
  loadPresetOverrides,
  resetCategoryInOverrides,
  savePresetOverrides,
  type MetadataPresetProfile,
  type PresetCategoryKey,
  type PresetOverrides,
} from './utils/metadataPresets';
import {
  backupOriginalBeforeOverwriteOnDisk,
  canUseNativeDirectoryPicker,
  deleteEntryFromDisk,
  downloadMidiBuffer,
  downloadTextFile,
  loadFromDataTransfer,
  loadFromFileList,
  moveEntryToSortedFolder,
  overwriteEntryOnDisk,
  pickFolderNative,
  readSidecarText,
  renameEntryOnDisk,
  saveSidecarTxtOnDisk,
  saveTextFileOnDisk,
  saveTrimmedCopyOnDisk,
  type LoadedFolderResult,
} from './utils/fileSystem';
import { computeSha256Hex } from './utils/hash';
import {
  ALL_TRACKABLE_FIELDS,
  createAutoMetadata,
  defaultSidecarFilename,
  defaultSidecarRelativePath,
  FILE_TYPE_LABELS,
  getInstrumentFamilyLabel,
  getMusicalRoleLabel,
  mergeAutoIntoExistingMetadata,
  ORIGIN_LABELS,
  rebuildImportantTracksFromTrackMeta,
  TRACK_CLASSIFIER_VERSION,
} from './utils/midiClassifier';
import {
  buildHydratedMetadata,
  saveLocalMetadataSnapshot,
  serializeMetadataSidecarTxt,
} from './utils/metadataSidecar';
import { getGmProgramName } from './utils/midiConstants';
import { detectMidiDuplicates } from './utils/midiDuplicates';
import { createDemoMidiFiles, parseMidiBuffer } from './utils/midiParser';
import { WebMidiPlayer, type MidiPlaybackState } from './utils/midiPlayer';
import {
  analyzeSilenceTrimSuggestion,
  trimMidiBuffer,
  type SmartTrimSuggestion,
} from './utils/midiTrimmer';

type FilterMode =
  | 'all'
  | 'eigenkomposition'
  | 'library'
  | 'issues'
  | 'exact_duplicates'
  | 'variants'
  | 'pending'
  | 'keep'
  | 'discard';

const PROTECT_ORIGINALS_STORAGE_KEY = 'midi_sorter_protect_originals_v1';
const INSPECTOR_OPEN_STORAGE_KEY = 'midi_sorter_inspector_open_v1';

function loadProtectOriginalsPref(): boolean {
  try {
    const raw = window.localStorage.getItem(PROTECT_ORIGINALS_STORAGE_KEY);
    if (raw === 'false') return false;
  } catch {
    // Ignore storage errors
  }
  return true;
}

function loadInspectorOpenPref(): boolean {
  try {
    const raw = window.localStorage.getItem(INSPECTOR_OPEN_STORAGE_KEY);
    if (raw === 'false') return false;
    if (raw === 'true') return true;
  } catch {
    // Ignore storage errors
  }
  return typeof window !== 'undefined' ? window.innerWidth >= 1120 : true;
}

export default function App() {
  const [entries, setEntries] = useState<MidiFileEntry[]>([]);
  const [folderName, setFolderName] = useState<string>('');
  const [rootDirHandle, setRootDirHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [canWriteToDisk, setCanWriteToDisk] = useState<boolean>(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [sortMode, setSortMode] = useState<SortMode>('name');
  const [hoverPreview, setHoverPreview] = useState<boolean>(false);
  const [autoPlay, setAutoPlay] = useState<boolean>(false);

  const [leftWidthPx, setLeftWidthPx] = useState<number>(300);
  const [rightWidthPx, setRightWidthPx] = useState<number>(340);
  const [draggingSplit, setDraggingSplit] = useState<'left' | 'right' | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState<boolean>(() => loadInspectorOpenPref());
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('metadata');
  const [isDragOverWindow, setIsDragOverWindow] = useState<boolean>(false);
  const [parseProgress, setParseProgress] = useState<{ done: number; total: number } | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [cleanupModalOpen, setCleanupModalOpen] = useState<boolean>(false);
  const [trainingTxtOpen, setTrainingTxtOpen] = useState<boolean>(false);
  const [batchExportModal, setBatchExportModal] = useState<{
    open: boolean;
    tab: 'export' | 'presets' | 'abbreviations';
  }>({ open: false, tab: 'export' });
  const [abbreviations, setAbbreviations] = useState<LibraryAbbreviation[]>(() =>
    loadAbbreviationProfile()
  );
  const [presetsBase, setPresetsBase] = useState<MetadataPresetProfile>(() =>
    createDefaultMetadataPresets()
  );
  const [presetOverrides, setPresetOverrides] = useState<PresetOverrides>(() =>
    loadPresetOverrides()
  );
  const [presetsLoadedFromFile, setPresetsLoadedFromFile] = useState<boolean>(false);

  const metadataPresets = useMemo(
    () => applyPresetOverrides(presetsBase, presetOverrides),
    [presetsBase, presetOverrides]
  );

  const handleReloadPresetsFromFile = useCallback(async (): Promise<boolean> => {
    const res = await fetchPresetsFromFile();
    setPresetsBase(res.profile);
    setPresetsLoadedFromFile(res.loadedFromFile);
    return res.loadedFromFile;
  }, []);

  useEffect(() => {
    void handleReloadPresetsFromFile();
  }, [handleReloadPresetsFromFile]);

  const [protectOriginals, setProtectOriginals] = useState<boolean>(() =>
    loadProtectOriginalsPref()
  );
  const [renameTrigger, setRenameTrigger] = useState<number>(0);

  const handleUpdateAbbreviations = useCallback((next: LibraryAbbreviation[]) => {
    setAbbreviations(next);
    saveAbbreviationProfile(next);
  }, []);

  const handleUpdateMetadataPresets = useCallback(
    (next: MetadataPresetProfile) => {
      setPresetOverrides((prev) => {
        const computed = computeOverridesFromProfileChange(presetsBase, prev, next);
        savePresetOverrides(computed);
        return computed;
      });
    },
    [presetsBase]
  );

  const handleResetPresetCategory = useCallback((category: PresetCategoryKey) => {
    setPresetOverrides((prev) => {
      const next = resetCategoryInOverrides(prev, category);
      savePresetOverrides(next);
      return next;
    });
  }, []);

  const handleAddMetadataPreset = useCallback(
    (category: PresetCategoryKey, value: string, abbr = '') => {
      setPresetOverrides((prev) => {
        const currentProfile = applyPresetOverrides(presetsBase, prev);
        const nextProfile =
          category === 'articulations'
            ? appendArticulationPreset(currentProfile, value, abbr)
            : appendStringPreset(currentProfile, category, value);
        if (nextProfile === currentProfile) return prev;
        const computed = computeOverridesFromProfileChange(presetsBase, prev, nextProfile);
        savePresetOverrides(computed);
        return computed;
      });
    },
    [presetsBase]
  );

  const handleSetProtectOriginals = useCallback((next: boolean) => {
    setProtectOriginals(next);
    try {
      window.localStorage.setItem(PROTECT_ORIGINALS_STORAGE_KEY, String(next));
    } catch {
      // Ignore storage errors
    }
  }, []);

  const handleToggleInspector = useCallback((force?: boolean) => {
    setInspectorOpen((prev) => {
      const next = typeof force === 'boolean' ? force : !prev;
      try {
        window.localStorage.setItem(INSPECTOR_OPEN_STORAGE_KEY, String(next));
      } catch {
        // Ignore storage errors
      }
      return next;
    });
  }, []);

  const handleOpenInspectorTab = useCallback(
    (tab: InspectorTab) => {
      setInspectorTab(tab);
      handleToggleInspector(true);
    },
    [handleToggleInspector]
  );

  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const parseRunIdRef = useRef<number>(0);
  const entriesRef = useRef<MidiFileEntry[]>([]);
  entriesRef.current = entries;
  const abbreviationsRef = useRef<LibraryAbbreviation[]>(abbreviations);
  abbreviationsRef.current = abbreviations;
  const folderNameRef = useRef<string>(folderName);
  folderNameRef.current = folderName;

  const playerRef = useRef<WebMidiPlayer | null>(null);
  if (!playerRef.current) {
    playerRef.current = new WebMidiPlayer();
  }

  const [playback, setPlayback] = useState<MidiPlaybackState>(() =>
    playerRef.current!.getState()
  );

  useEffect(() => {
    const player = playerRef.current!;
    const unsub = player.subscribe(setPlayback);
    void player.initWebMidi();
    void player.initSavedSoundFont();
    return () => {
      unsub();
      player.stop();
    };
  }, []);

  // Load folder result and parse all MIDI files incrementally without blocking UI
  const applyLoadedFolder = useCallback(async (result: LoadedFolderResult) => {
    parseRunIdRef.current += 1;
    const runId = parseRunIdRef.current;

    playerRef.current?.stop();
    setErrorBanner(null);
    setFolderName(result.folderName);
    setRootDirHandle(result.rootDirHandle);
    setCanWriteToDisk(result.canWriteToDisk);
    setFilterMode('all');
    setSearchQuery('');

    if (result.entries.length === 0) {
      setEntries([]);
      setSelectedId(null);
      setParseProgress(null);
      setErrorBanner('Im ausgewählten Ordner wurden keine .mid- oder .midi-Dateien gefunden.');
      return;
    }

    const initialEntries = result.entries;
    const firstId = initialEntries[0].id;
    setEntries(initialEntries);
    setSelectedId(firstId);
    setParseProgress({ done: 0, total: initialEntries.length });

    // Parse first file immediately for instant right-pane preview
    const parseSingle = async (item: MidiFileEntry): Promise<MidiFileEntry> => {
      try {
        const fileObj = item.file || (await item.fileHandle?.getFile());
        if (!fileObj) return { ...item, parseError: 'Datei nicht lesbar' };
        const [buf, sidecarText] = await Promise.all([
          fileObj.arrayBuffer(),
          readSidecarText(item),
        ]);
        const [parsed, sha256] = await Promise.all([
          Promise.resolve(parseMidiBuffer(buf)),
          computeSha256Hex(buf),
        ]);
        const baseEntry: MidiFileEntry = {
          ...item,
          file: fileObj,
          parsed,
          sha256,
          originalSha256: sha256,
        };
        const { meta, restoredTriage } = buildHydratedMetadata(
          baseEntry,
          sidecarText,
          abbreviationsRef.current,
          result.folderName
        );
        return {
          ...baseEntry,
          triage: restoredTriage ?? baseEntry.triage,
          datasetMeta: meta,
        };
      } catch (err) {
        const errorEntry: MidiFileEntry = {
          ...item,
          parseError: err instanceof Error ? err.message : 'Fehler beim Lesen',
        };
        const sidecarText = await readSidecarText(item);
        const { meta, restoredTriage } = buildHydratedMetadata(
          errorEntry,
          sidecarText,
          abbreviationsRef.current,
          result.folderName
        );
        return {
          ...errorEntry,
          triage: restoredTriage ?? errorEntry.triage,
          datasetMeta: meta,
        };
      }
    };

    const firstParsed = await parseSingle(initialEntries[0]);
    if (parseRunIdRef.current !== runId) return;

    const working = [...initialEntries];
    working[0] = firstParsed;
    setEntries([...working]);
    setParseProgress({ done: 1, total: working.length });

    // Parse remaining files in non-blocking batches
    const BATCH_SIZE = 20;
    for (let i = 1; i < working.length; i += BATCH_SIZE) {
      if (parseRunIdRef.current !== runId) return;
      const slice = working.slice(i, i + BATCH_SIZE);
      const parsedBatch = await Promise.all(slice.map(parseSingle));
      if (parseRunIdRef.current !== runId) return;

      for (let j = 0; j < parsedBatch.length; j++) {
        working[i + j] = parsedBatch[j];
      }
      setEntries([...working]);
      setParseProgress({
        done: Math.min(working.length, i + BATCH_SIZE),
        total: working.length,
      });

      await new Promise((r) => window.setTimeout(r, 0));
    }

    if (parseRunIdRef.current === runId) {
      setParseProgress(null);
    }
  }, []);

  const handleOpenFolderClick = async () => {
    setErrorBanner(null);
    if (canUseNativeDirectoryPicker()) {
      try {
        const result = await pickFolderNative();
        await applyLoadedFolder(result);
        return;
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }
        // Fallback to hidden webkitdirectory input if native picker is blocked
      }
    }
    folderInputRef.current?.click();
  };

  const handleFallbackFolderInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const result = loadFromFileList(files);
    await applyLoadedFolder(result);
    e.target.value = '';
  };

  const handleLoadDemo = async () => {
    const demoFiles = createDemoMidiFiles();
    const result = loadFromFileList(demoFiles);
    result.folderName = 'Demo-MIDI-Sammlung';
    await applyLoadedFolder(result);
  };

  // Drag & drop support across the entire window
  useEffect(() => {
    let dragCounter = 0;
    const onDragEnter = (e: DragEvent) => {
      e.preventDefault();
      dragCounter++;
      setIsDragOverWindow(true);
    };
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
    };
    const onDragLeave = (e: DragEvent) => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        setIsDragOverWindow(false);
      }
    };
    const onDrop = async (e: DragEvent) => {
      e.preventDefault();
      dragCounter = 0;
      setIsDragOverWindow(false);
      if (e.dataTransfer) {
        const result = await loadFromDataTransfer(e.dataTransfer);
        await applyLoadedFolder(result);
      }
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [applyLoadedFolder]);

  // Resizable splitter drag (left browser & right inspector)
  useEffect(() => {
    if (!draggingSplit) return;
    const onMove = (e: MouseEvent) => {
      const container = workspaceRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      if (draggingSplit === 'left') {
        const nextW = e.clientX - rect.left;
        const maxLeft = Math.max(260, rect.width - (inspectorOpen ? rightWidthPx : 0) - 360);
        setLeftWidthPx(Math.max(240, Math.min(maxLeft, nextW)));
      } else {
        const nextW = rect.right - e.clientX;
        const maxRight = Math.max(280, rect.width - leftWidthPx - 360);
        setRightWidthPx(Math.max(280, Math.min(Math.min(480, maxRight), nextW)));
      }
    };
    const onUp = () => setDraggingSplit(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [draggingSplit, inspectorOpen, leftWidthPx, rightWidthPx]);

  // Duplicate & variant fingerprinting across all parsed files
  const duplicateMap = useMemo(() => detectMidiDuplicates(entries), [entries]);

  // Counts & Filtered/Sorted list
  const stats = useMemo(() => {
    let eigen = 0;
    let library = 0;
    let issues = 0;
    let exactDuplicates = 0;
    let variants = 0;
    let pending = 0;
    let keep = 0;
    let discard = 0;
    for (const e of entries) {
      if (e.datasetMeta?.origin === 'eigenkomposition') eigen++;
      else if (e.datasetMeta?.origin === 'library') library++;
      if (e.parsed?.hasErrors || e.parsed?.hasWarnings || e.parseError) issues++;
      const dup = duplicateMap.get(e.id);
      if (dup) {
        if (dup.kind === 'byte_exact' || dup.kind === 'note_exact') exactDuplicates++;
        else variants++;
      }
      if (e.triage === 'pending') pending++;
      else if (e.triage === 'keep') keep++;
      else if (e.triage === 'discard') discard++;
    }
    return {
      total: entries.length,
      eigen,
      library,
      issues,
      exactDuplicates,
      variants,
      duplicates: duplicateMap.size,
      pending,
      keep,
      discard,
    };
  }, [entries, duplicateMap]);

  const visibleEntries = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = entries.filter((e) => {
      if (q) {
        const keyLabel =
          e.parsed?.detectedKey?.label.toLowerCase() ??
          (e.parsed?.isPercussionOnly
            ? 'drums percussion'
            : e.parsed?.keyStatus === 'unknown'
            ? 'unbekannt unknown'
            : '');
        const md = e.parsed?.metadata;
        const metaMatch = md
          ? md.copyright.some((c) => c.toLowerCase().includes(q)) ||
            (md.sequenceName?.toLowerCase().includes(q) ?? false) ||
            md.instruments.some((ins) => ins.toLowerCase().includes(q)) ||
            md.markers.some((m) => m.text.toLowerCase().includes(q)) ||
            md.cues.some((c) => c.text.toLowerCase().includes(q)) ||
            md.textEvents.some((t) => t.text.toLowerCase().includes(q))
          : false;
        const ds = e.datasetMeta;
        const datasetMetaMatch = ds
          ? ds.compositionId.toLowerCase().includes(q) ||
            ds.genre.toLowerCase().includes(q) ||
            ds.subgenres.some((s) => s.toLowerCase().includes(q)) ||
            ds.instrument.toLowerCase().includes(q) ||
            getInstrumentFamilyLabel(ds.instrumentFamily).toLowerCase().includes(q) ||
            ds.articulation.toLowerCase().includes(q) ||
            getMusicalRoleLabel(ds.musicalRole).toLowerCase().includes(q) ||
            ORIGIN_LABELS[ds.origin].toLowerCase().includes(q) ||
            FILE_TYPE_LABELS[ds.fileType].toLowerCase().includes(q) ||
            ds.moods.some((m) => m.toLowerCase().includes(q))
          : false;
        const shaMatch = (e.sha256?.toLowerCase().includes(q) ?? false) ||
          (e.originalSha256?.toLowerCase().includes(q) ?? false);
        const perf = e.parsed?.performance;
        const perfMatch = perf
          ? perf.programChanges.some((pc) =>
              getGmProgramName(pc.program).toLowerCase().includes(q)
            ) ||
            perf.channels.some(
              (ch) =>
                `ch ${ch.channel + 1}`.includes(q) ||
                `ch${ch.channel + 1}`.includes(q) ||
                `kanal ${ch.channel + 1}`.includes(q)
            )
          : false;
        const timelineMatch = e.parsed
          ? (!e.parsed.hasExplicitTempo && ('unbekannt'.includes(q) || 'kein tempo'.includes(q))) ||
            (e.parsed.hasTempoChanges && ('tempowechsel'.includes(q) || 'tempo'.includes(q))) ||
            (e.parsed.hasTimeSignatureChanges && ('taktwechsel'.includes(q) || 'taktart'.includes(q))) ||
            (e.parsed.isCompleteComposition && 'vollständig'.includes(q))
          : false;
        if (
          !e.relativePath.toLowerCase().includes(q) &&
          !keyLabel.includes(q) &&
          !metaMatch &&
          !datasetMetaMatch &&
          !shaMatch &&
          !perfMatch &&
          !timelineMatch
        ) {
          return false;
        }
      }
      if (filterMode === 'eigenkomposition') {
        return e.datasetMeta?.origin === 'eigenkomposition';
      }
      if (filterMode === 'library') {
        return e.datasetMeta?.origin === 'library';
      }
      if (filterMode === 'issues') {
        return Boolean(e.parsed?.hasErrors || e.parsed?.hasWarnings || e.parseError);
      }
      if (filterMode === 'exact_duplicates') {
        const dup = duplicateMap.get(e.id);
        return Boolean(dup && (dup.kind === 'byte_exact' || dup.kind === 'note_exact'));
      }
      if (filterMode === 'variants') {
        return duplicateMap.get(e.id)?.kind === 'variant';
      }
      if (filterMode === 'pending') return e.triage === 'pending';
      if (filterMode === 'keep') return e.triage === 'keep';
      if (filterMode === 'discard') return e.triage === 'discard';
      return true;
    });

    const sorted = [...filtered];
    sorted.sort((a, b) => {
      if (sortMode === 'name_desc') {
        return b.relativePath.localeCompare(a.relativePath, 'de', { sensitivity: 'base' });
      }
      if (sortMode === 'rating_desc') {
        const ra = a.datasetMeta?.rating ?? -1;
        const rb = b.datasetMeta?.rating ?? -1;
        if (ra !== rb) return rb - ra;
      }
      if (sortMode === 'key_asc' || sortMode === 'key_desc') {
        const bucket = (item: MidiFileEntry) => {
          if (item.parsed?.detectedKey) return 0;
          if (item.parsed?.isPercussionOnly) return 1;
          if (item.parsed?.keyStatus === 'unknown') return 2;
          return 3;
        };
        const ba = bucket(a);
        const bb = bucket(b);
        if (ba !== bb) return ba - bb;
        if (ba === 0) {
          const la = a.parsed!.detectedKey!.label;
          const lb = b.parsed!.detectedKey!.label;
          const cmp =
            sortMode === 'key_asc'
              ? la.localeCompare(lb, 'de', { sensitivity: 'base' })
              : lb.localeCompare(la, 'de', { sensitivity: 'base' });
          if (cmp !== 0) return cmp;
        }
      }
      if (sortMode === 'notes_asc') {
        const diff = (a.parsed?.notes.length ?? 0) - (b.parsed?.notes.length ?? 0);
        if (diff !== 0) return diff;
      }
      if (sortMode === 'notes_desc') {
        const diff = (b.parsed?.notes.length ?? 0) - (a.parsed?.notes.length ?? 0);
        if (diff !== 0) return diff;
      }
      if (sortMode === 'duration_asc') {
        const diff = (a.parsed?.totalDurationSec ?? 0) - (b.parsed?.totalDurationSec ?? 0);
        if (diff !== 0) return diff;
      }
      if (sortMode === 'issues_first') {
        const score = (item: MidiFileEntry) =>
          item.parsed?.hasErrors ? 0 : item.parsed?.hasWarnings ? 1 : 2;
        const diff = score(a) - score(b);
        if (diff !== 0) return diff;
      }
      if (sortMode === 'duplicates_first') {
        const da = duplicateMap.get(a.id);
        const db = duplicateMap.get(b.id);
        if (da && !db) return -1;
        if (!da && db) return 1;
        if (da && db) {
          const rank = (k: typeof da.kind) =>
            k === 'byte_exact' ? 0 : k === 'note_exact' ? 1 : 2;
          if (rank(da.kind) !== rank(db.kind)) return rank(da.kind) - rank(db.kind);
          if (da.groupId !== db.groupId) return da.groupId - db.groupId;
          if (da.similarity !== db.similarity) return db.similarity - da.similarity;
        }
      }
      return a.relativePath.localeCompare(b.relativePath, 'de', { sensitivity: 'base' });
    });

    return sorted;
  }, [entries, searchQuery, filterMode, sortMode, duplicateMap]);

  const selectedEntry = useMemo(
    () => entries.find((e) => e.id === selectedId) || null,
    [entries, selectedId]
  );

  // Sync audio player when selected file changes
  useEffect(() => {
    playerRef.current?.load(selectedEntry?.parsed ?? null, autoPlay);
  }, [selectedEntry?.id, selectedEntry?.parsed, autoPlay]);

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id);
  }, []);

  const setTriageStatus = useCallback(
    (id: string, status: TriageStatus, advanceNext = false) => {
      let updatedForDiskSync: MidiFileEntry | null = null;

      setEntries((prev) =>
        prev.map((item) => {
          if (item.id !== id) return item;
          const nextMeta: MidiDatasetMetadata | undefined = item.datasetMeta
            ? {
                ...item.datasetMeta,
                fieldProvenance: {
                  ...item.datasetMeta.fieldProvenance,
                  triage: 'manual',
                },
                sidecarDirty: true,
              }
            : undefined;
          const nextItem: MidiFileEntry = {
            ...item,
            triage: status,
            datasetMeta: nextMeta,
          };
          if (nextMeta) {
            saveLocalMetadataSnapshot(nextItem, nextMeta, status);
            if (canWriteToDisk && item.sidecarHandle) {
              updatedForDiskSync = nextItem;
            }
          }
          return nextItem;
        })
      );

      // Keep existing on-disk .txt sidecar in sync silently when triage changes
      if (updatedForDiskSync) {
        const target = updatedForDiskSync as MidiFileEntry;
        if (target.datasetMeta) {
          const txt = serializeMetadataSidecarTxt(target, target.datasetMeta);
          void saveSidecarTxtOnDisk(target, txt)
            .then((saved) => {
              setEntries((prev) =>
                prev.map((item) =>
                  item.id === target.id && item.datasetMeta
                    ? {
                        ...item,
                        sidecarHandle: saved.sidecarHandle,
                        sidecarFile: saved.sidecarFile,
                        sidecarRelativePath: saved.relativePath,
                        datasetMeta: {
                          ...item.datasetMeta,
                          sidecarLoaded: true,
                          sidecarDirty: false,
                          lastSavedAt: new Date().toISOString(),
                        },
                      }
                    : item
                )
              );
            })
            .catch(() => {
              // Keep local snapshot & dirty flag if disk write fails
            });
        }
      }

      if (advanceNext) {
        const idx = visibleEntries.findIndex((e) => e.id === id);
        if (idx >= 0 && idx + 1 < visibleEntries.length) {
          setSelectedId(visibleEntries[idx + 1].id);
        }
      }
    },
    [visibleEntries, canWriteToDisk]
  );

  const handleUpdateMetadata = useCallback(
    (entryId: string, updater: (prev: MidiDatasetMetadata) => MidiDatasetMetadata) => {
      setEntries((prev) =>
        prev.map((item) => {
          if (item.id !== entryId || !item.datasetMeta) return item;
          const nextMeta = updater(item.datasetMeta);
          const nextItem: MidiFileEntry = { ...item, datasetMeta: nextMeta };
          saveLocalMetadataSnapshot(nextItem, nextMeta, nextItem.triage);
          return nextItem;
        })
      );
    },
    []
  );

  const handleSaveSidecar = useCallback(async (entryId: string) => {
    const target = entriesRef.current.find((e) => e.id === entryId);
    if (!target || !target.datasetMeta) return;
    const txt = serializeMetadataSidecarTxt(target, target.datasetMeta);
    const saved = await saveSidecarTxtOnDisk(target, txt);
    const nowIso = new Date().toISOString();
    setEntries((prev) =>
      prev.map((item) => {
        if (item.id !== entryId || !item.datasetMeta) return item;
        const nextMeta: MidiDatasetMetadata = {
          ...item.datasetMeta,
          sourceLink: {
            ...item.datasetMeta.sourceLink,
            midiFile: item.relativePath,
            metadataFile: saved.relativePath,
            sha256: item.sha256 ?? item.datasetMeta.sourceLink.sha256,
          },
          sidecarLoaded: true,
          sidecarDirty: false,
          lastSavedAt: nowIso,
        };
        const nextItem: MidiFileEntry = {
          ...item,
          sidecarHandle: saved.sidecarHandle,
          sidecarFile: saved.sidecarFile,
          sidecarRelativePath: saved.relativePath,
          datasetMeta: nextMeta,
        };
        saveLocalMetadataSnapshot(nextItem, nextMeta, nextItem.triage);
        return nextItem;
      })
    );
  }, []);

  const handleConfirmAllAndSave = useCallback(
    async (entryId: string) => {
      const target = entriesRef.current.find((e) => e.id === entryId);
      if (!target || !target.datasetMeta) return;

      const allManual = {} as Record<TrackableMetaField, FieldProvenance>;
      for (const f of ALL_TRACKABLE_FIELDS) allManual[f] = 'manual';

      const confirmedMeta: MidiDatasetMetadata = {
        ...target.datasetMeta,
        reviewStatus: 'geprueft',
        fieldProvenance: allManual,
        sidecarDirty: !canWriteToDisk,
      };
      const updatedTarget: MidiFileEntry = { ...target, datasetMeta: confirmedMeta };

      if (canWriteToDisk && target.parentDirHandle) {
        const txt = serializeMetadataSidecarTxt(updatedTarget, confirmedMeta);
        const saved = await saveSidecarTxtOnDisk(updatedTarget, txt);
        const nowIso = new Date().toISOString();
        const savedMeta: MidiDatasetMetadata = {
          ...confirmedMeta,
          sourceLink: {
            ...confirmedMeta.sourceLink,
            midiFile: target.relativePath,
            metadataFile: saved.relativePath,
            sha256: target.sha256 ?? confirmedMeta.sourceLink.sha256,
          },
          sidecarLoaded: true,
          sidecarDirty: false,
          lastSavedAt: nowIso,
        };
        setEntries((prev) =>
          prev.map((item) => {
            if (item.id !== entryId) return item;
            const nextItem: MidiFileEntry = {
              ...item,
              sidecarHandle: saved.sidecarHandle,
              sidecarFile: saved.sidecarFile,
              sidecarRelativePath: saved.relativePath,
              datasetMeta: savedMeta,
            };
            saveLocalMetadataSnapshot(nextItem, savedMeta, nextItem.triage);
            return nextItem;
          })
        );
      } else {
        saveLocalMetadataSnapshot(updatedTarget, confirmedMeta, updatedTarget.triage);
        setEntries((prev) =>
          prev.map((item) => (item.id === entryId ? updatedTarget : item))
        );
      }
    },
    [canWriteToDisk]
  );

  const handleDownloadSidecar = useCallback((entryId: string) => {
    const target = entriesRef.current.find((e) => e.id === entryId);
    if (!target || !target.datasetMeta) return;
    const txt = serializeMetadataSidecarTxt(target, target.datasetMeta);
    downloadTextFile(defaultSidecarFilename(target.name), txt);
  }, []);

  const handleReclassifyAuto = useCallback(
    (entryId: string, options?: { forceTracks?: boolean }) => {
      setEntries((prev) =>
        prev.map((item) => {
          if (item.id !== entryId || !item.datasetMeta) return item;
          const freshAuto = createAutoMetadata(
            item,
            abbreviationsRef.current,
            folderNameRef.current
          );
          const merged = mergeAutoIntoExistingMetadata(item.datasetMeta, freshAuto);
          const nextTracks = options?.forceTracks
            ? freshAuto.trackMetadata
            : merged.trackMetadata;
          const nextMeta: MidiDatasetMetadata = {
            ...merged,
            trackMetadata: nextTracks,
            importantTracks:
              nextTracks && nextTracks.length > 0
                ? rebuildImportantTracksFromTrackMeta(nextTracks)
                : merged.importantTracks,
            sidecarDirty: true,
          };
          const nextItem: MidiFileEntry = { ...item, datasetMeta: nextMeta };
          saveLocalMetadataSnapshot(nextItem, nextMeta, nextItem.triage);
          return nextItem;
        })
      );
    },
    []
  );

  // Automatically refresh unconfirmed auto-detected track metadata when classifier rules update (e.g. HMR)
  useEffect(() => {
    setEntries((prev) => {
      if (prev.length === 0) return prev;
      let changed = false;
      const next = prev.map((item) => {
        if (!item.parsed || !item.datasetMeta) return item;
        const freshAuto = createAutoMetadata(
          item,
          abbreviationsRef.current,
          folderNameRef.current
        );
        const merged = mergeAutoIntoExistingMetadata(item.datasetMeta, freshAuto);
        if (JSON.stringify(merged.trackMetadata) !== JSON.stringify(item.datasetMeta.trackMetadata)) {
          changed = true;
          return { ...item, datasetMeta: merged };
        }
        return item;
      });
      return changed ? next : prev;
    });
  }, [TRACK_CLASSIFIER_VERSION]);

  const handleSidecarSavedFromModal = useCallback((entryId: string, rawTxt: string) => {
    setEntries((prev) =>
      prev.map((item) => {
        if (item.id !== entryId) return item;
        const { meta, restoredTriage } = buildHydratedMetadata(
          item,
          rawTxt,
          abbreviationsRef.current,
          folderNameRef.current
        );
        const nextItem: MidiFileEntry = {
          ...item,
          triage: restoredTriage ?? item.triage,
          datasetMeta: {
            ...meta,
            sidecarLoaded: true,
            sidecarDirty: false,
            lastSavedAt: new Date().toISOString(),
          },
        };
        saveLocalMetadataSnapshot(nextItem, nextItem.datasetMeta!, nextItem.triage);
        return nextItem;
      })
    );
  }, []);

  // Keyboard navigation & fast triage shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT')
      ) {
        return;
      }
      if (cleanupModalOpen || trainingTxtOpen || batchExportModal.open || visibleEntries.length === 0) return;

      const curIdx = visibleEntries.findIndex((item) => item.id === selectedId);

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const nextIdx = curIdx < 0 ? 0 : Math.min(visibleEntries.length - 1, curIdx + 1);
        setSelectedId(visibleEntries[nextIdx].id);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prevIdx = curIdx <= 0 ? 0 : curIdx - 1;
        setSelectedId(visibleEntries[prevIdx].id);
      } else if (e.key === ' ' && selectedEntry?.parsed) {
        e.preventDefault();
        playerRef.current?.toggle();
      } else if ((e.key === 'k' || e.key === 'K') && selectedId) {
        e.preventDefault();
        setTriageStatus(selectedId, 'keep', true);
      } else if (
        (e.key === 'x' || e.key === 'X' || e.key === 'Delete') &&
        selectedId
      ) {
        e.preventDefault();
        setTriageStatus(selectedId, 'discard', true);
      } else if ((e.key === 'u' || e.key === 'U') && selectedId) {
        e.preventDefault();
        setTriageStatus(selectedId, 'pending', false);
      } else if (e.key === 'F2' && selectedId) {
        e.preventDefault();
        setRenameTrigger((n) => n + 1);
      } else if (e.key === 'i' || e.key === 'I') {
        e.preventDefault();
        handleToggleInspector();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    cleanupModalOpen,
    trainingTxtOpen,
    batchExportModal.open,
    visibleEntries,
    selectedId,
    selectedEntry,
    setTriageStatus,
    handleToggleInspector,
  ]);

  const discardedEntries = useMemo(
    () => entries.filter((e) => e.triage === 'discard'),
    [entries]
  );

  const handleImmediateMoveSingle = async (entry: MidiFileEntry) => {
    if (!rootDirHandle || !canWriteToDisk) return;
    if (protectOriginals) {
      setErrorBanner(
        'Originalschutz ist aktiv: Dateien können nicht direkt verschoben werden. Du kannst den Schutz oben deaktivieren.'
      );
      return;
    }
    try {
      await moveEntryToSortedFolder(rootDirHandle, entry, '_Aussortiert');
      const idx = visibleEntries.findIndex((v) => v.id === entry.id);
      const nextId =
        idx >= 0 && idx + 1 < visibleEntries.length
          ? visibleEntries[idx + 1].id
          : idx > 0
          ? visibleEntries[idx - 1].id
          : null;
      setEntries((prev) => prev.filter((item) => item.id !== entry.id));
      if (selectedId === entry.id) {
        setSelectedId(nextId);
      }
    } catch (err) {
      setErrorBanner(
        err instanceof Error ? err.message : 'Verschieben fehlgeschlagen.'
      );
    }
  };

  const handleExecuteDiskMoveAll = async () => {
    if (protectOriginals) {
      throw new Error('Originalschutz ist aktiv. Bitte zuerst oben entsperren.');
    }
    if (!rootDirHandle) return;
    const toMove = entries.filter((e) => e.triage === 'discard');
    const movedIds = new Set<string>();
    for (const item of toMove) {
      await moveEntryToSortedFolder(rootDirHandle, item, '_Aussortiert');
      movedIds.add(item.id);
    }
    setEntries((prev) => prev.filter((item) => !movedIds.has(item.id)));
    if (selectedId && movedIds.has(selectedId)) {
      setSelectedId(null);
    }
  };

  const handleExecuteDiskDeleteAll = async () => {
    if (protectOriginals) {
      throw new Error('Originalschutz ist aktiv. Bitte zuerst oben entsperren.');
    }
    const toDelete = entries.filter((e) => e.triage === 'discard');
    const deletedIds = new Set<string>();
    for (const item of toDelete) {
      await deleteEntryFromDisk(item);
      deletedIds.add(item.id);
    }
    setEntries((prev) => prev.filter((item) => !deletedIds.has(item.id)));
    if (selectedId && deletedIds.has(selectedId)) {
      setSelectedId(null);
    }
  };

  const getEntrySourceBuffer = async (entry: MidiFileEntry): Promise<ArrayBuffer> => {
    if (entry.trimmedBuffer) return entry.trimmedBuffer;
    if (entry.originalBuffer) return entry.originalBuffer;
    const fileObj = entry.file || (await entry.fileHandle?.getFile());
    if (!fileObj) throw new Error('MIDI-Quelldatei konnte nicht gelesen werden.');
    return fileObj.arrayBuffer();
  };

  const handleTrimMidi = async (
    entry: MidiFileEntry,
    trimStartTick: number,
    trimEndTick: number | null
  ) => {
    try {
      playerRef.current?.stop();
      const origBuf =
        entry.originalBuffer ??
        (await (entry.file || (await entry.fileHandle?.getFile()))!.arrayBuffer());
      const currentBuf = await getEntrySourceBuffer(entry);
      const trimmedBuf = trimMidiBuffer(currentBuf, { trimStartTick, trimEndTick });
      const newParsed = parseMidiBuffer(trimmedBuf);
      const trimmedSha = await computeSha256Hex(trimmedBuf);

      setEntries((prev) =>
        prev.map((item) =>
          item.id === entry.id
            ? {
                ...item,
                originalBuffer: origBuf,
                trimmedBuffer: trimmedBuf,
                parsed: newParsed,
                sizeBytes: trimmedBuf.byteLength,
                sha256: trimmedSha,
                originalSha256: item.originalSha256 ?? item.sha256,
                isTrimmed: true,
                datasetMeta: item.datasetMeta
                  ? {
                      ...item.datasetMeta,
                      sourceLink: {
                        ...item.datasetMeta.sourceLink,
                        sha256: trimmedSha,
                        originalSha256:
                          item.datasetMeta.sourceLink.originalSha256 ??
                          item.originalSha256 ??
                          item.sha256 ??
                          null,
                      },
                      sidecarDirty: true,
                    }
                  : undefined,
              }
            : item
        )
      );
    } catch (err) {
      setErrorBanner(
        err instanceof Error ? err.message : 'Kürzen der MIDI-Datei fehlgeschlagen.'
      );
    }
  };

  const handleRestoreOriginalMidi = async (entry: MidiFileEntry) => {
    if (!entry.originalBuffer) return;
    playerRef.current?.stop();
    const restoredParsed = parseMidiBuffer(entry.originalBuffer);
    const restoredSha = entry.originalSha256 ?? (await computeSha256Hex(entry.originalBuffer));
    setEntries((prev) =>
      prev.map((item) =>
        item.id === entry.id
          ? {
              ...item,
              parsed: restoredParsed,
              sizeBytes: entry.originalBuffer!.byteLength,
              sha256: restoredSha,
              originalSha256: restoredSha,
              trimmedBuffer: undefined,
              isTrimmed: false,
            }
          : item
      )
    );
  };

  const handleSaveTrimmedCopy = async (entry: MidiFileEntry): Promise<string | void> => {
    if (!entry.trimmedBuffer) return;
    try {
      return await saveTrimmedCopyOnDisk(entry, entry.trimmedBuffer, '_trimmed');
    } catch (err) {
      setErrorBanner(
        err instanceof Error ? err.message : 'Speichern der Kopie fehlgeschlagen.'
      );
    }
  };

  const handleOverwriteOriginal = async (entry: MidiFileEntry) => {
    if (!entry.trimmedBuffer) return;
    if (protectOriginals) {
      setErrorBanner(
        'Originalschutz ist aktiv: Das Original darf nicht überschrieben werden. Bitte als Kopie speichern oder Schutz oben deaktivieren.'
      );
      return;
    }
    try {
      if (rootDirHandle) {
        await backupOriginalBeforeOverwriteOnDisk(rootDirHandle, entry);
      }
      await overwriteEntryOnDisk(entry, entry.trimmedBuffer);
      const updatedFile = entry.fileHandle ? await entry.fileHandle.getFile() : entry.file;
      const updatedSha = await computeSha256Hex(entry.trimmedBuffer);
      setEntries((prev) =>
        prev.map((item) =>
          item.id === entry.id
            ? {
                ...item,
                file: updatedFile,
                originalBuffer: entry.trimmedBuffer,
                trimmedBuffer: undefined,
                sha256: updatedSha,
                originalSha256: updatedSha,
                isTrimmed: false,
              }
            : item
        )
      );
    } catch (err) {
      setErrorBanner(
        err instanceof Error ? err.message : 'Überschreiben fehlgeschlagen.'
      );
    }
  };

  const handleDownloadTrimmed = (entry: MidiFileEntry) => {
    const buf = entry.trimmedBuffer || entry.originalBuffer;
    if (!buf) return;
    const dotIdx = entry.name.lastIndexOf('.');
    const base = dotIdx > 0 ? entry.name.slice(0, dotIdx) : entry.name;
    const ext = dotIdx > 0 ? entry.name.slice(dotIdx) : '.mid';
    downloadMidiBuffer(`${base}_trimmed${ext}`, buf);
  };

  const handleRenameMidi = async (entry: MidiFileEntry, newFilename: string) => {
    const newRelPath = entry.folderPath ? `${entry.folderPath}/${newFilename}` : newFilename;
    const newTitle = newFilename.replace(/\.(mid|midi)$/i, '');

    if (canWriteToDisk && entry.fileHandle && entry.parentDirHandle) {
      if (protectOriginals) {
        throw new Error('Originalschutz aktiv: Festplatten-Umbenennung ist gesperrt.');
      }
      const { fileHandle, file, sidecarHandle, sidecarFile, sidecarRelativePath } =
        await renameEntryOnDisk(entry, newFilename);
      setEntries((prev) =>
        prev.map((item) => {
          if (item.id !== entry.id) return item;
          const nextSidecarRel =
            sidecarRelativePath || defaultSidecarRelativePath(newRelPath);
          const nextMeta = item.datasetMeta
            ? {
                ...item.datasetMeta,
                title: newTitle,
                sourceLink: {
                  ...item.datasetMeta.sourceLink,
                  midiFile: newRelPath,
                  metadataFile: nextSidecarRel,
                },
                sidecarDirty: true,
              }
            : undefined;
          const nextItem: MidiFileEntry = {
            ...item,
            name: newFilename,
            relativePath: newRelPath,
            fileHandle,
            file,
            sidecarHandle: sidecarHandle ?? item.sidecarHandle,
            sidecarFile: sidecarFile ?? item.sidecarFile,
            sidecarRelativePath: sidecarRelativePath ?? item.sidecarRelativePath,
            datasetMeta: nextMeta,
          };
          if (nextMeta) {
            saveLocalMetadataSnapshot(nextItem, nextMeta, nextItem.triage);
          }
          return nextItem;
        })
      );
      return;
    }

    // Read-only / Demo mode: check duplicate name within same subfolder and rename in session
    const duplicate = entries.some(
      (item) =>
        item.id !== entry.id &&
        item.folderPath === entry.folderPath &&
        item.name.toLowerCase() === newFilename.toLowerCase()
    );
    if (duplicate) {
      throw new Error(`Eine Datei mit dem Namen „${newFilename}“ existiert bereits.`);
    }

    setEntries((prev) =>
      prev.map((item) =>
        item.id === entry.id
          ? {
              ...item,
              name: newFilename,
              relativePath: newRelPath,
              datasetMeta: item.datasetMeta
                ? {
                    ...item.datasetMeta,
                    title: newTitle,
                    sourceLink: {
                      ...item.datasetMeta.sourceLink,
                      midiFile: newRelPath,
                      metadataFile: defaultSidecarRelativePath(newRelPath),
                    },
                    sidecarDirty: true,
                  }
                : undefined,
            }
          : item
      )
    );
  };

  const handleAnalyzeSmartTrim = async (
    entry: MidiFileEntry
  ): Promise<SmartTrimSuggestion | null> => {
    if (!entry.parsed) return null;
    try {
      const buf = await getEntrySourceBuffer(entry);
      return analyzeSilenceTrimSuggestion(buf, entry.parsed);
    } catch (err) {
      setErrorBanner(
        err instanceof Error ? err.message : 'Analyse der MIDI-Stille fehlgeschlagen.'
      );
      return null;
    }
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-[#16181c] text-[#e2e5ea] overflow-hidden">
      {/* Hidden folder input fallback */}
      <input
        ref={folderInputRef}
        type="file"
        webkitdirectory=""
        multiple
        className="hidden"
        onChange={handleFallbackFolderInput}
      />

      {/* Clean Top Bar (Brand/Folder + Global Actions + Inspector Toggle) */}
      <header className="h-[48px] px-4 bg-[#1a1d22] border-b border-[#292f38] flex items-center justify-between gap-4 shrink-0">
        {/* Left: Brand Title & Active Folder */}
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-[15px] font-semibold tracking-tight text-white whitespace-nowrap">
            MIDI Sorter
          </span>
          {folderName && (
            <span className="inline-flex items-center gap-1.5 text-xs text-[#8f98a6] truncate max-w-[320px]">
              <span aria-hidden="true">/</span>
              <span className="truncate text-[#cfd6e0]" title={folderName}>
                {folderName}
              </span>
            </span>
          )}
        </div>

        {/* Right: Calm Global Actions */}
        <div className="flex items-center gap-2 shrink-0">
          {entries.length > 0 && (
            <button
              type="button"
              onClick={() => handleSetProtectOriginals(!protectOriginals)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium border transition-colors whitespace-nowrap shrink-0 ${
                protectOriginals
                  ? 'bg-emerald-950/50 border-emerald-700/60 text-emerald-300 hover:bg-emerald-950/80'
                  : 'bg-amber-950/50 border-amber-700/60 text-amber-200 hover:bg-amber-950/80'
              }`}
              title={
                protectOriginals
                  ? 'Originalschutz AKTIV: Originaldateien werden nicht überschrieben, umbenannt, verschoben oder gelöscht. Klicken zum Entsperren.'
                  : 'Originalschutz DEAKTIVIERT: Schreibzugriffe sind erlaubt. Klicken zum Aktivieren.'
              }
            >
              {protectOriginals ? (
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              ) : (
                <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
              )}
              <span className="hidden sm:inline">
                {protectOriginals ? 'Originalschutz' : 'Schutz aus'}
              </span>
            </button>
          )}
          {entries.length > 0 && (
            <button
              type="button"
              onClick={() => setBatchExportModal({ open: true, tab: 'export' })}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium bg-[#232932] hover:bg-[#2c3440] border border-[#36404e] text-[#dce4ee] transition-colors whitespace-nowrap shrink-0"
              title="Batch-Export für ML-Training & Kürzel-Profil"
            >
              <Database className="w-3.5 h-3.5 text-[#5eb1e6]" />
              <span className="hidden sm:inline">Export</span>
            </button>
          )}
          {discardedEntries.length > 0 && (
            <button
              type="button"
              onClick={() => setCleanupModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium bg-rose-700/85 hover:bg-rose-600 text-white transition-colors whitespace-nowrap shrink-0"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Bereinigen ({discardedEntries.length})
            </button>
          )}
          <button
            type="button"
            onClick={handleOpenFolderClick}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-[#3675a3] hover:bg-[#4187ba] text-white transition-colors whitespace-nowrap shrink-0"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            Ordner wählen
          </button>
          {entries.length > 0 && (
            <button
              type="button"
              onClick={() => handleToggleInspector()}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium border transition-colors whitespace-nowrap shrink-0 ${
                inspectorOpen
                  ? 'bg-[#263444] border-[#4ea1d3]/65 text-[#dff0ff]'
                  : 'bg-[#22272f] border-[#323a46] text-[#9aa4b2] hover:text-white'
              }`}
              title="Rechte Inspektor-Seitenleiste ein-/ausblenden (Taste I)"
            >
              {inspectorOpen ? (
                <PanelRightClose className="w-3.5 h-3.5 text-[#5eb1e6]" />
              ) : (
                <PanelRightOpen className="w-3.5 h-3.5" />
              )}
              <span className="hidden md:inline">Inspektor</span>
            </button>
          )}
        </div>
      </header>

      {/* Error banner if empty folder or read issue */}
      {errorBanner && (
        <div className="px-4 py-2 bg-amber-950/40 border-b border-amber-800/50 text-xs text-amber-200 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
            <span>{errorBanner}</span>
          </div>
          <button
            type="button"
            onClick={() => setErrorBanner(null)}
            className="text-amber-300 hover:text-white underline ml-4"
          >
            Schließen
          </button>
        </div>
      )}

      {/* Main Content: Empty State or Resizable Split Workspace */}
      {entries.length === 0 ? (
        <main className="flex-1 flex items-center justify-center p-6 bg-[#16181c]">
          <div className="w-full max-w-2xl rounded-lg bg-[#1d2026] border border-[#2c323c] p-8 text-center space-y-6">
            <div className="mx-auto w-12 h-12 rounded-lg bg-[#242c36] border border-[#34404f] flex items-center justify-center">
              <FolderOpen className="w-6 h-6 text-[#5eb1e6]" />
            </div>

            <div className="space-y-2 max-w-lg mx-auto">
              <h1 className="text-2xl font-semibold text-white tracking-tight text-balance">
                MIDI-Ordner visuell prüfen und unvollständige Dateien aussortieren
              </h1>
              <p className="text-sm text-[#9aa3b0] leading-relaxed">
                Wähle einen Ordner auf deiner Festplatte oder ziehe ihn direkt in dieses Fenster.
                Markierst du links eine Datei, siehst du rechts sofort die komplette Piano-Roll
                samt Notendichte, Taktstruktur und automatischer Fehlerprüfung.
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
              <button
                type="button"
                onClick={handleOpenFolderClick}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded bg-[#3675a3] hover:bg-[#4187ba] text-sm font-medium text-white transition-colors"
              >
                <FolderOpen className="w-4 h-4" />
                MIDI-Ordner auswählen
              </button>
              <button
                type="button"
                onClick={handleLoadDemo}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded bg-[#252932] hover:bg-[#2d333e] border border-[#363d49] text-sm font-medium text-[#cfd5de] transition-colors"
              >
                Mit Beispiel-MIDIs testen
              </button>
            </div>

            <div className="pt-4 border-t border-[#292e37] grid grid-cols-1 sm:grid-cols-3 gap-4 text-left text-xs text-[#8c95a3]">
              <div>
                <div className="font-medium text-[#d4dae2] mb-1">100% Lokal im Browser</div>
                Deine MIDI-Dateien verlassen deinen Rechner nicht und werden direkt lokal gelesen.
              </div>
              <div>
                <div className="font-medium text-[#d4dae2] mb-1">Sofortige Fehlererkennung</div>
                Erkennt leere Dateien, abgeschnittene Spuren, fehlende End-of-Track-Marker und große Lücken.
              </div>
              <div>
                <div className="font-medium text-[#d4dae2] mb-1">Schnelle Tastatur-Sortierung</div>
                Mit ↑ / ↓ durchblättern, K zum Behalten, X oder Entf zum Aussortieren.
              </div>
            </div>
          </div>
        </main>
      ) : (
        <main
          ref={workspaceRef}
          className={`flex-1 flex min-h-0 overflow-hidden ${
            draggingSplit ? 'select-none cursor-col-resize' : ''
          }`}
        >
          {/* Column 1 (Left): DAW File Browser with integrated Search, Filter & Sort */}
          <section
            style={{ width: `${leftWidthPx}px` }}
            className="flex flex-col min-w-[240px] min-h-0 bg-[#1e2126] border-r border-[#2a303a] shrink-0"
          >
            {/* Browser Search, Filter & Sort Header */}
            <div className="p-2.5 bg-[#1a1d22] border-b border-[#292f38] space-y-2 shrink-0">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-[#78818e] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Suche: Datei, Genre, Instrument..."
                  className="w-full pl-8 pr-2.5 py-1.5 text-xs rounded bg-[#13161a] border border-[#2b313b] text-[#e2e5ea] placeholder:text-[#66707e] focus:outline-none focus:border-[#4ea1d3]"
                />
              </div>

              <div className="grid grid-cols-2 gap-1.5">
                <div className="relative flex items-center">
                  <Filter className="w-3 h-3 text-[#78818e] absolute left-2 pointer-events-none" />
                  <select
                    value={filterMode}
                    onChange={(e) => setFilterMode(e.target.value as FilterMode)}
                    className="w-full pl-6 pr-2 py-1 text-[11.5px] rounded bg-[#13161a] border border-[#2b313b] text-[#cfd5de] focus:outline-none focus:border-[#4ea1d3]"
                    aria-label="Filter"
                  >
                    <option value="all">Alle ({stats.total})</option>
                    {stats.eigen > 0 && (
                      <option value="eigenkomposition">Eigene ({stats.eigen})</option>
                    )}
                    {stats.library > 0 && (
                      <option value="library">Library ({stats.library})</option>
                    )}
                    <option value="pending">Offen ({stats.pending})</option>
                    <option value="keep">Behalten ({stats.keep})</option>
                    <option value="discard">Aussortiert ({stats.discard})</option>
                    <option value="issues">Auffällig ({stats.issues})</option>
                    <option value="exact_duplicates">Duplikate ({stats.exactDuplicates})</option>
                    <option value="variants">Varianten ({stats.variants})</option>
                  </select>
                </div>

                <div className="relative flex items-center">
                  <ArrowUpDown className="w-3 h-3 text-[#78818e] absolute left-2 pointer-events-none" />
                  <select
                    value={sortMode}
                    onChange={(e) => setSortMode(e.target.value as SortMode)}
                    className="w-full pl-6 pr-2 py-1 text-[11.5px] rounded bg-[#13161a] border border-[#2b313b] text-[#cfd5de] focus:outline-none focus:border-[#4ea1d3]"
                    aria-label="Sortierung"
                  >
                    <option value="name">Name (A–Z)</option>
                    <option value="name_desc">Name (Z–A)</option>
                    <option value="rating_desc">Bewertung ↓</option>
                    <option value="key_asc">Tonart (A–Z)</option>
                    <option value="key_desc">Tonart (Z–A)</option>
                    <option value="issues_first">Auffällige</option>
                    <option value="duplicates_first">Duplikate</option>
                    <option value="notes_asc">Wenigste Noten</option>
                    <option value="notes_desc">Meiste Noten</option>
                    <option value="duration_asc">Kürzeste Dauer</option>
                  </select>
                </div>
              </div>

              <div className="flex items-center justify-between gap-2 pt-0.5">
                <div className="text-[11px] text-[#838d9b] font-mono tabular-nums truncate">
                  {parseProgress
                    ? `Analysiere ${parseProgress.done} / ${parseProgress.total}...`
                    : `${visibleEntries.length} / ${entries.length} Dateien`}
                </div>

                <button
                  type="button"
                  onClick={() => setHoverPreview((v) => !v)}
                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] font-medium border transition-colors whitespace-nowrap ${
                    hoverPreview
                      ? 'bg-[#253342] border-[#4ea1d3]/70 text-[#d8ecfa]'
                      : 'bg-[#20242b] border-[#2f3641] text-[#8f98a6] hover:text-white'
                  }`}
                  title="Wenn aktiv, zeigt bereits das Überfahren mit der Maus die MIDI-Vorschau"
                >
                  <MousePointerClick className="w-3 h-3" />
                  Hover {hoverPreview ? 'An' : 'Aus'}
                </button>
              </div>
            </div>

            <FileListPane
              entries={visibleEntries}
              selectedId={selectedId}
              hoverPreview={hoverPreview}
              sortMode={sortMode}
              duplicateMap={duplicateMap}
              onChangeSort={setSortMode}
              onSelect={handleSelect}
              onQuickTriage={(id, status) => setTriageStatus(id, status, false)}
              onRequestRename={() => setRenameTrigger((n) => n + 1)}
            />

            {/* Compact Shortcut Hint Bar */}
            <div className="px-3 py-1.5 bg-[#181b20] border-t border-[#292f38] text-[10.5px] text-[#707986] flex items-center justify-between gap-2 shrink-0">
              <span className="truncate">
                ↑↓ · K Behalten · X Weg · Space Play · I Inspektor
              </span>
            </div>
          </section>

          {/* Resizable Splitter 1 (Browser <-> Piano Roll) */}
          <div
            role="separator"
            aria-orientation="vertical"
            onMouseDown={() => setDraggingSplit('left')}
            className="w-1 bg-[#22262d] hover:bg-[#4ea1d3] cursor-col-resize transition-colors shrink-0"
            title="Browser-Breite anpassen"
          />

          {/* Column 2 (Center): Main Piano-Roll Stage */}
          <section className="flex-1 flex flex-col min-w-[340px] min-h-0">
            <MidiPianoRoll
              entry={selectedEntry}
              playback={playback}
              autoPlay={autoPlay}
              onToggleAutoPlay={() => setAutoPlay((v) => !v)}
              onPlayPause={() => playerRef.current?.toggle()}
              onSeek={(sec) => playerRef.current?.seek(sec)}
              onVolumeChange={(vol) => playerRef.current?.setVolume(vol)}
              onTempoChange={(bpm) => playerRef.current?.setPlaybackBpm(bpm)}
              onSelectMidiOutput={(id) => playerRef.current?.setMidiOutput(id)}
              onRefreshMidiOutputs={() => playerRef.current?.refreshMidiOutputs()}
              onChangeMidiChannelRouting={(routing) =>
                playerRef.current?.setMidiChannelRouting(routing)
              }
              onMidiPanic={() => playerRef.current?.panicMidi()}
              onLoadSoundFont={(file) => void playerRef.current?.loadSoundFontFile(file)}
              onUnloadSoundFont={() => playerRef.current?.unloadSoundFont()}
              onSelectSoundFontSource={(id) =>
                void playerRef.current?.selectSoundFontSource(id)
              }
              onRefreshSoundFontLibrary={() =>
                void playerRef.current?.refreshSoundFontLibrary()
              }
              onSelectSf2Preset={(id) => playerRef.current?.setSf2Preset(id)}
              onToggleReverb={() =>
                playerRef.current?.setReverbEnabled(!playback.reverbEnabled)
              }
              onTriage={(status) => {
                if (selectedEntry) {
                  setTriageStatus(selectedEntry.id, status, status !== 'pending');
                }
              }}
              canWriteToDisk={canWriteToDisk}
              protectOriginals={protectOriginals}
              onToggleProtectOriginals={() => handleSetProtectOriginals(!protectOriginals)}
              onTrimMidi={handleTrimMidi}
              onRestoreOriginalMidi={handleRestoreOriginalMidi}
              onSaveTrimmedCopy={handleSaveTrimmedCopy}
              onOverwriteOriginal={handleOverwriteOriginal}
              onDownloadTrimmed={handleDownloadTrimmed}
              renameTrigger={renameTrigger}
              onRenameMidi={handleRenameMidi}
              onAnalyzeSmartTrim={handleAnalyzeSmartTrim}
              duplicateInfo={selectedEntry ? duplicateMap.get(selectedEntry.id) ?? null : null}
              onOpenInspectorTab={handleOpenInspectorTab}
            />
          </section>

          {/* Column 3 (Right): Collapsible 3-Tab Inspector Sidebar */}
          {inspectorOpen && (
            <>
              <div
                role="separator"
                aria-orientation="vertical"
                onMouseDown={() => setDraggingSplit('right')}
                className="w-1 bg-[#22262d] hover:bg-[#4ea1d3] cursor-col-resize transition-colors shrink-0"
                title="Inspektor-Breite anpassen"
              />
              <aside
                style={{ width: `${rightWidthPx}px` }}
                className="flex flex-col min-w-[280px] max-w-[480px] min-h-0 bg-[#171b20] border-l border-[#292f38] shrink-0"
              >
                <InspectorSidebar
                  entry={selectedEntry}
                  activeTab={inspectorTab}
                  onChangeTab={setInspectorTab}
                  onClose={() => handleToggleInspector(false)}
                  canWriteToDisk={canWriteToDisk}
                  protectOriginals={protectOriginals}
                  duplicateInfo={selectedEntry ? duplicateMap.get(selectedEntry.id) ?? null : null}
                  metadataPresets={metadataPresets}
                  onAddMetadataPreset={handleAddMetadataPreset}
                  onOpenPresetsManager={() =>
                    setBatchExportModal({ open: true, tab: 'presets' })
                  }
                  onSeek={(sec) => playerRef.current?.seek(sec)}
                  onSelectEntry={handleSelect}
                  onOpenTrainingTxt={() => setTrainingTxtOpen(true)}
                  onUpdateMetadata={handleUpdateMetadata}
                  onConfirmAllAndSave={handleConfirmAllAndSave}
                  onSaveSidecar={handleSaveSidecar}
                  onDownloadSidecar={handleDownloadSidecar}
                  onReclassifyAuto={handleReclassifyAuto}
                  onImmediateMoveToSorted={handleImmediateMoveSingle}
                  mutedTracks={playback.mutedTracks}
                  soloTracks={playback.soloTracks}
                  onToggleTrackMute={(idx) => playerRef.current?.toggleTrackMute(idx)}
                  onToggleTrackSolo={(idx) => playerRef.current?.toggleTrackSolo(idx)}
                  onClearTrackMuteSolo={() => playerRef.current?.clearTrackMuteSolo()}
                />
              </aside>
            </>
          )}
        </main>
      )}

      {/* Drag & Drop Full-Window Overlay */}
      {isDragOverWindow && (
        <div className="fixed inset-0 z-50 bg-[#12161b]/85 border-2 border-dashed border-[#4ea1d3] flex items-center justify-center pointer-events-none">
          <div className="px-6 py-5 rounded-lg bg-[#1d2229] border border-[#384352] text-center space-y-2">
            <Upload className="w-8 h-8 text-[#5eb1e6] mx-auto" />
            <p className="text-base font-medium text-white">
              MIDI-Ordner oder Dateien hier ablegen
            </p>
            <p className="text-xs text-[#919aa6]">
              Alle Unterordner werden automatisch nach .mid / .midi durchsucht.
            </p>
          </div>
        </div>
      )}

      {/* Export / Disk Cleanup Modal */}
      <ExportCleanupModal
        isOpen={cleanupModalOpen}
        onClose={() => setCleanupModalOpen(false)}
        discardedEntries={discardedEntries}
        folderName={folderName}
        canWriteToDisk={canWriteToDisk}
        protectOriginals={protectOriginals}
        onUnlockProtection={() => handleSetProtectOriginals(false)}
        onExecuteDiskMove={handleExecuteDiskMoveAll}
        onExecuteDiskDelete={handleExecuteDiskDeleteAll}
      />

      {/* Training .TXT Metadata Generator Modal */}
      <TrainingTxtModal
        isOpen={trainingTxtOpen}
        entry={selectedEntry}
        canWriteToDisk={canWriteToDisk}
        abbreviations={abbreviations}
        metadataPresets={metadataPresets}
        onAddMetadataPreset={handleAddMetadataPreset}
        onOpenPresetsManager={() => {
          setTrainingTxtOpen(false);
          setBatchExportModal({ open: true, tab: 'presets' });
        }}
        onOpenAbbreviationProfile={() => {
          setTrainingTxtOpen(false);
          setBatchExportModal({ open: true, tab: 'abbreviations' });
        }}
        onClose={() => setTrainingTxtOpen(false)}
        onSaveToDisk={saveTextFileOnDisk}
        onSidecarSaved={handleSidecarSavedFromModal}
      />

      {/* Batch Training Export, Metadata Presets & Custom Abbreviation Profile Modal */}
      <BatchTrainingExportModal
        isOpen={batchExportModal.open}
        initialTab={batchExportModal.tab}
        entries={entries}
        duplicateMap={duplicateMap}
        canWriteToDisk={canWriteToDisk}
        abbreviations={abbreviations}
        onChangeAbbreviations={handleUpdateAbbreviations}
        metadataPresets={metadataPresets}
        presetsLoadedFromFile={presetsLoadedFromFile}
        onChangeMetadataPresets={handleUpdateMetadataPresets}
        onResetPresetCategory={handleResetPresetCategory}
        onReloadPresetsFromFile={handleReloadPresetsFromFile}
        onSaveTextToDisk={saveTextFileOnDisk}
        onClose={() => setBatchExportModal((prev) => ({ ...prev, open: false }))}
      />
    </div>
  );
}
