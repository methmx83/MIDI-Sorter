import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpDown,
  Database,
  FolderOpen,
  MousePointerClick,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import { BatchTrainingExportModal } from './components/BatchTrainingExportModal';
import { ExportCleanupModal } from './components/ExportCleanupModal';
import { FileListPane, type SortMode } from './components/FileListPane';
import { MidiPianoRoll } from './components/MidiPianoRoll';
import { TrainingTxtModal } from './components/TrainingTxtModal';
import type { MidiFileEntry, TriageStatus } from './types/midi';
import {
  loadAbbreviationProfile,
  saveAbbreviationProfile,
  type LibraryAbbreviation,
} from './utils/abbreviationProfile';
import {
  canUseNativeDirectoryPicker,
  deleteEntryFromDisk,
  downloadMidiBuffer,
  loadFromDataTransfer,
  loadFromFileList,
  moveEntryToSortedFolder,
  overwriteEntryOnDisk,
  pickFolderNative,
  renameEntryOnDisk,
  saveTextFileOnDisk,
  saveTrimmedCopyOnDisk,
  type LoadedFolderResult,
} from './utils/fileSystem';
import { detectMidiDuplicates } from './utils/midiDuplicates';
import { createDemoMidiFiles, parseMidiBuffer } from './utils/midiParser';
import { WebMidiPlayer, type MidiPlaybackState } from './utils/midiPlayer';
import {
  analyzeSilenceTrimSuggestion,
  trimMidiBuffer,
  type SmartTrimSuggestion,
} from './utils/midiTrimmer';

type FilterMode = 'all' | 'issues' | 'duplicates' | 'pending' | 'keep' | 'discard';

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

  const [leftWidthPct, setLeftWidthPct] = useState<number>(38);
  const [isDraggingSplit, setIsDraggingSplit] = useState<boolean>(false);
  const [isDragOverWindow, setIsDragOverWindow] = useState<boolean>(false);
  const [parseProgress, setParseProgress] = useState<{ done: number; total: number } | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [cleanupModalOpen, setCleanupModalOpen] = useState<boolean>(false);
  const [trainingTxtOpen, setTrainingTxtOpen] = useState<boolean>(false);
  const [batchExportModal, setBatchExportModal] = useState<{
    open: boolean;
    tab: 'export' | 'abbreviations';
  }>({ open: false, tab: 'export' });
  const [abbreviations, setAbbreviations] = useState<LibraryAbbreviation[]>(() =>
    loadAbbreviationProfile()
  );
  const [renameTrigger, setRenameTrigger] = useState<number>(0);

  const handleUpdateAbbreviations = useCallback((next: LibraryAbbreviation[]) => {
    setAbbreviations(next);
    saveAbbreviationProfile(next);
  }, []);

  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const parseRunIdRef = useRef<number>(0);

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
        const buf = await fileObj.arrayBuffer();
        const parsed = parseMidiBuffer(buf);
        return { ...item, file: fileObj, parsed };
      } catch (err) {
        return {
          ...item,
          parseError: err instanceof Error ? err.message : 'Fehler beim Lesen',
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

  // Resizable splitter drag
  useEffect(() => {
    if (!isDraggingSplit) return;
    const onMove = (e: MouseEvent) => {
      const container = workspaceRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setLeftWidthPct(Math.max(22, Math.min(62, pct)));
    };
    const onUp = () => setIsDraggingSplit(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [isDraggingSplit]);

  // Duplicate & variant fingerprinting across all parsed files
  const duplicateMap = useMemo(() => detectMidiDuplicates(entries), [entries]);

  // Counts & Filtered/Sorted list
  const stats = useMemo(() => {
    let issues = 0;
    let pending = 0;
    let keep = 0;
    let discard = 0;
    for (const e of entries) {
      if (e.parsed?.hasErrors || e.parsed?.hasWarnings || e.parseError) issues++;
      if (e.triage === 'pending') pending++;
      else if (e.triage === 'keep') keep++;
      else if (e.triage === 'discard') discard++;
    }
    return {
      total: entries.length,
      issues,
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
          (e.parsed?.isPercussionOnly ? 'drums percussion' : '');
        const md = e.parsed?.metadata;
        const metaMatch = md
          ? md.copyright.some((c) => c.toLowerCase().includes(q)) ||
            (md.sequenceName?.toLowerCase().includes(q) ?? false) ||
            md.instruments.some((ins) => ins.toLowerCase().includes(q)) ||
            md.markers.some((m) => m.text.toLowerCase().includes(q)) ||
            md.cues.some((c) => c.text.toLowerCase().includes(q)) ||
            md.textEvents.some((t) => t.text.toLowerCase().includes(q))
          : false;
        if (
          !e.relativePath.toLowerCase().includes(q) &&
          !keyLabel.includes(q) &&
          !metaMatch
        ) {
          return false;
        }
      }
      if (filterMode === 'issues') {
        return Boolean(e.parsed?.hasErrors || e.parsed?.hasWarnings || e.parseError);
      }
      if (filterMode === 'duplicates') {
        return duplicateMap.has(e.id);
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
      if (sortMode === 'key_asc' || sortMode === 'key_desc') {
        const bucket = (item: MidiFileEntry) => {
          if (item.parsed?.detectedKey) return 0;
          if (item.parsed?.isPercussionOnly) return 1;
          return 2;
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
      setEntries((prev) =>
        prev.map((item) => (item.id === id ? { ...item, triage: status } : item))
      );
      if (advanceNext) {
        const idx = visibleEntries.findIndex((e) => e.id === id);
        if (idx >= 0 && idx + 1 < visibleEntries.length) {
          setSelectedId(visibleEntries[idx + 1].id);
        }
      }
    },
    [visibleEntries]
  );

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
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cleanupModalOpen, trainingTxtOpen, visibleEntries, selectedId, selectedEntry, setTriageStatus]);

  const discardedEntries = useMemo(
    () => entries.filter((e) => e.triage === 'discard'),
    [entries]
  );

  const handleImmediateMoveSingle = async (entry: MidiFileEntry) => {
    if (!rootDirHandle || !canWriteToDisk) return;
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

      setEntries((prev) =>
        prev.map((item) =>
          item.id === entry.id
            ? {
                ...item,
                originalBuffer: origBuf,
                trimmedBuffer: trimmedBuf,
                parsed: newParsed,
                sizeBytes: trimmedBuf.byteLength,
                isTrimmed: true,
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
    setEntries((prev) =>
      prev.map((item) =>
        item.id === entry.id
          ? {
              ...item,
              parsed: restoredParsed,
              sizeBytes: entry.originalBuffer!.byteLength,
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
    try {
      await overwriteEntryOnDisk(entry, entry.trimmedBuffer);
      const updatedFile = entry.fileHandle ? await entry.fileHandle.getFile() : entry.file;
      setEntries((prev) =>
        prev.map((item) =>
          item.id === entry.id
            ? {
                ...item,
                file: updatedFile,
                originalBuffer: entry.trimmedBuffer,
                trimmedBuffer: undefined,
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

    if (canWriteToDisk && entry.fileHandle && entry.parentDirHandle) {
      const { fileHandle, file } = await renameEntryOnDisk(entry, newFilename);
      setEntries((prev) =>
        prev.map((item) =>
          item.id === entry.id
            ? {
                ...item,
                name: newFilename,
                relativePath: newRelPath,
                fileHandle,
                file,
              }
            : item
        )
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
        // @ts-expect-error webkitdirectory is a non-standard attribute supported across browsers
        webkitdirectory=""
        directory=""
        multiple
        className="hidden"
        onChange={handleFallbackFolderInput}
      />

      {/* Top Bar (3-zone compact DAW toolbar) */}
      <header className="h-[52px] px-4 bg-[#1c1f24] border-b border-[#2b313a] flex items-center justify-between gap-6 shrink-0">
        {/* Zone 1: Brand Title */}
        <div className="flex items-center gap-3 min-w-0 shrink-0">
          <span className="text-[15px] font-semibold tracking-tight text-white whitespace-nowrap">
            MIDI Sorter
          </span>
          {folderName && (
            <span className="hidden md:inline-flex items-center gap-1.5 text-xs text-[#8f98a6] truncate max-w-[220px]">
              <span aria-hidden="true">/</span>
              <span className="truncate text-[#c5ccd6]" title={folderName}>
                {folderName}
              </span>
            </span>
          )}
        </div>

        {/* Zone 2: Search, Filter & Sort Controls (active when folder loaded) */}
        {entries.length > 0 ? (
          <div className="hidden lg:flex items-center gap-3 flex-1 justify-center min-w-0">
            <div className="relative w-56">
              <Search className="w-3.5 h-3.5 text-[#78818e] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Datei oder Tonart filtern..."
                className="w-full pl-8 pr-2.5 py-1.5 text-xs rounded bg-[#14171b] border border-[#2d333d] text-[#e2e5ea] placeholder:text-[#68717e] focus:outline-none focus:border-[#4ea1d3]"
              />
            </div>

            <div className="flex items-center gap-0.5 p-0.5 rounded bg-[#14171b] border border-[#2d333d]">
              {(
                [
                  { id: 'all', label: `Alle (${stats.total})` },
                  { id: 'issues', label: `Auffällig (${stats.issues})` },
                  { id: 'duplicates', label: `Duplikate (${stats.duplicates})` },
                  { id: 'pending', label: `Offen (${stats.pending})` },
                  { id: 'keep', label: `Behalten (${stats.keep})` },
                  { id: 'discard', label: `Aussortiert (${stats.discard})` },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setFilterMode(tab.id)}
                  className={`px-2.5 py-1 rounded text-xs font-medium whitespace-nowrap shrink-0 transition-colors ${
                    filterMode === tab.id
                      ? 'bg-[#2a313b] text-white'
                      : 'text-[#8992a0] hover:text-[#dce2ea]'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <ArrowUpDown className="w-3.5 h-3.5 text-[#78818e]" />
              <select
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value as SortMode)}
                className="px-2 py-1.5 text-xs rounded bg-[#14171b] border border-[#2d333d] text-[#cfd5de] focus:outline-none focus:border-[#4ea1d3]"
                aria-label="Sortierung"
              >
                <option value="name">Name (A–Z)</option>
                <option value="name_desc">Name (Z–A)</option>
                <option value="key_asc">Tonart (A–Z)</option>
                <option value="key_desc">Tonart (Z–A)</option>
                <option value="issues_first">Auffällige zuerst</option>
                <option value="duplicates_first">Duplikat-Gruppen zuerst</option>
                <option value="notes_asc">Wenigste Noten zuerst</option>
                <option value="notes_desc">Meiste Noten zuerst</option>
                <option value="duration_asc">Kürzeste Dauer zuerst</option>
              </select>
            </div>
          </div>
        ) : (
          <div className="flex-1" />
        )}

        {/* Zone 3: Primary Action */}
        <div className="flex items-center gap-2.5 shrink-0">
          {entries.length > 0 && (
            <button
              type="button"
              onClick={() => setBatchExportModal({ open: true, tab: 'export' })}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-[#252b34] hover:bg-[#2e3642] border border-[#3a4351] text-[#dce4ee] transition-colors whitespace-nowrap shrink-0"
              title="Batch-Export für ML-Training & eigenes Kürzel-Profil"
            >
              <Database className="w-3.5 h-3.5 text-[#5eb1e6]" />
              Training-Export
            </button>
          )}
          {discardedEntries.length > 0 && (
            <button
              type="button"
              onClick={() => setCleanupModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-rose-700/85 hover:bg-rose-600 text-white transition-colors whitespace-nowrap shrink-0"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Bereinigen ({discardedEntries.length})
            </button>
          )}
          <button
            type="button"
            onClick={handleOpenFolderClick}
            className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded text-xs font-medium bg-[#3675a3] hover:bg-[#4187ba] text-white transition-colors whitespace-nowrap shrink-0"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            Ordner wählen
          </button>
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
            isDraggingSplit ? 'select-none cursor-col-resize' : ''
          }`}
        >
          {/* Left Pane: High-Density DAW File List */}
          <section
            style={{ width: `${leftWidthPct}%` }}
            className="flex flex-col min-w-[260px] min-h-0 bg-[#22252a] border-r border-[#2d333d] shrink-0"
          >
            {/* List Sub-Toolbar */}
            <div className="px-3 py-2 bg-[#1e2126] border-b border-[#2c323b] flex items-center justify-between gap-2 shrink-0">
              <div className="text-xs text-[#8d96a4] font-mono tabular-nums truncate">
                {parseProgress
                  ? `Analysiere ${parseProgress.done} / ${parseProgress.total}...`
                  : `${visibleEntries.length} von ${entries.length} Dateien`}
              </div>

              <button
                type="button"
                onClick={() => setHoverPreview((v) => !v)}
                className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-medium border transition-colors whitespace-nowrap ${
                  hoverPreview
                    ? 'bg-[#2a3441] border-[#4ea1d3]/70 text-[#d8ecfa]'
                    : 'bg-[#252930] border-[#343b46] text-[#98a1ae] hover:text-white'
                }`}
                title="Wenn aktiv, zeigt bereits das Überfahren mit der Maus die MIDI-Vorschau rechts an"
              >
                <MousePointerClick className="w-3 h-3" />
                Hover-Vorschau {hoverPreview ? 'An' : 'Aus'}
              </button>
            </div>

            {/* Compact mobile/tablet filter row when lg top controls are hidden */}
            <div className="flex lg:hidden px-3 py-2 bg-[#1c1f24] border-b border-[#2b313a] gap-2 shrink-0">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Datei oder Tonart..."
                className="flex-1 min-w-0 px-2.5 py-1 text-xs rounded bg-[#14171b] border border-[#2d333d] text-[#e2e5ea]"
              />
              <select
                value={filterMode}
                onChange={(e) => setFilterMode(e.target.value as FilterMode)}
                className="px-2 py-1 text-xs rounded bg-[#14171b] border border-[#2d333d] text-[#cfd5de]"
              >
                <option value="all">Alle ({stats.total})</option>
                <option value="issues">Auffällig ({stats.issues})</option>
                <option value="duplicates">Duplikate ({stats.duplicates})</option>
                <option value="pending">Offen ({stats.pending})</option>
                <option value="keep">Behalten ({stats.keep})</option>
                <option value="discard">Aussortiert ({stats.discard})</option>
              </select>
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

            {/* Keyboard Shortcut Hint Bar */}
            <div className="px-3 py-1.5 bg-[#1b1e23] border-t border-[#2b313a] text-[11px] text-[#757e8b] flex items-center justify-between gap-2 shrink-0">
              <span className="truncate">
                ↑↓ Navigation · F2 Umbenennen · K Behalten · X Aussortieren · Leertaste Play
              </span>
            </div>
          </section>

          {/* Resizable Splitter Handle */}
          <div
            role="separator"
            aria-orientation="vertical"
            onMouseDown={() => setIsDraggingSplit(true)}
            className="w-1 bg-[#252930] hover:bg-[#4ea1d3] cursor-col-resize transition-colors shrink-0"
            title="Breite anpassen"
          />

          {/* Right Pane: Visual MIDI Piano Roll & Inspector */}
          <section className="flex-1 flex flex-col min-w-0 min-h-0">
            <MidiPianoRoll
              entry={selectedEntry}
              playback={playback}
              autoPlay={autoPlay}
              onToggleAutoPlay={() => setAutoPlay((v) => !v)}
              onPlayPause={() => playerRef.current?.toggle()}
              onSeek={(sec) => playerRef.current?.seek(sec)}
              onVolumeChange={(vol) => playerRef.current?.setVolume(vol)}
              onTriage={(status) => {
                if (selectedEntry) {
                  setTriageStatus(selectedEntry.id, status, status !== 'pending');
                }
              }}
              canWriteToDisk={canWriteToDisk}
              onImmediateMoveToSorted={handleImmediateMoveSingle}
              onTrimMidi={handleTrimMidi}
              onRestoreOriginalMidi={handleRestoreOriginalMidi}
              onSaveTrimmedCopy={handleSaveTrimmedCopy}
              onOverwriteOriginal={handleOverwriteOriginal}
              onDownloadTrimmed={handleDownloadTrimmed}
              renameTrigger={renameTrigger}
              onRenameMidi={handleRenameMidi}
              onAnalyzeSmartTrim={handleAnalyzeSmartTrim}
              onOpenTrainingTxt={() => setTrainingTxtOpen(true)}
              duplicateInfo={selectedEntry ? duplicateMap.get(selectedEntry.id) ?? null : null}
              onSelectEntry={handleSelect}
            />
          </section>
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
        onExecuteDiskMove={handleExecuteDiskMoveAll}
        onExecuteDiskDelete={handleExecuteDiskDeleteAll}
      />

      {/* Training .TXT Metadata Generator Modal */}
      <TrainingTxtModal
        isOpen={trainingTxtOpen}
        entry={selectedEntry}
        canWriteToDisk={canWriteToDisk}
        abbreviations={abbreviations}
        onOpenAbbreviationProfile={() => {
          setTrainingTxtOpen(false);
          setBatchExportModal({ open: true, tab: 'abbreviations' });
        }}
        onClose={() => setTrainingTxtOpen(false)}
        onSaveToDisk={saveTextFileOnDisk}
      />

      {/* Batch Training Export & Custom Abbreviation Profile Modal */}
      <BatchTrainingExportModal
        isOpen={batchExportModal.open}
        initialTab={batchExportModal.tab}
        entries={entries}
        duplicateMap={duplicateMap}
        canWriteToDisk={canWriteToDisk}
        abbreviations={abbreviations}
        onChangeAbbreviations={handleUpdateAbbreviations}
        onSaveTextToDisk={saveTextFileOnDisk}
        onClose={() => setBatchExportModal((prev) => ({ ...prev, open: false }))}
      />
    </div>
  );
}
