import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Check,
  Database,
  Download,
  FileText,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import type { MidiFileEntry } from '../types/midi';
import {
  DEFAULT_ABBREVIATIONS,
  type LibraryAbbreviation,
} from '../utils/abbreviationProfile';
import { downloadTextFile } from '../utils/fileSystem';
import type { DuplicateMatchInfo } from '../utils/midiDuplicates';
import {
  buildDatasetJsonlRecord,
  buildTrainingTxtDraft,
  serializeTrainingTxt,
} from '../utils/trainingTxtGenerator';

interface BatchTrainingExportModalProps {
  isOpen: boolean;
  initialTab?: 'export' | 'abbreviations';
  entries: MidiFileEntry[];
  duplicateMap: Map<string, DuplicateMatchInfo>;
  canWriteToDisk: boolean;
  abbreviations: LibraryAbbreviation[];
  onChangeAbbreviations: (next: LibraryAbbreviation[]) => void;
  onSaveTextToDisk: (entry: MidiFileEntry, filename: string, content: string) => Promise<string>;
  onClose: () => void;
}

export const BatchTrainingExportModal: React.FC<BatchTrainingExportModalProps> = ({
  isOpen,
  initialTab = 'export',
  entries,
  duplicateMap,
  canWriteToDisk,
  abbreviations,
  onChangeAbbreviations,
  onSaveTextToDisk,
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState<'export' | 'abbreviations'>(initialTab);
  const [scope, setScope] = useState<'keep' | 'valid'>('keep');
  const [dedupeMode, setDedupeMode] = useState<'none' | 'exact' | 'all'>('exact');

  const [newKey, setNewKey] = useState<string>('');
  const [newMeaning, setNewMeaning] = useState<string>('');
  const [abbrError, setAbbrError] = useState<string | null>(null);

  const [exportBusy, setExportBusy] = useState<boolean>(false);
  const [exportProgress, setExportProgress] = useState<{ done: number; total: number } | null>(null);
  const [exportResult, setExportResult] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  React.useEffect(() => {
    if (isOpen) {
      setActiveTab(initialTab);
      setExportResult(null);
      setExportError(null);
      setExportProgress(null);
    }
  }, [isOpen, initialTab]);

  const keepEntries = useMemo(
    () => entries.filter((e) => e.triage === 'keep' && e.parsed && e.parsed.notes.length > 0),
    [entries]
  );

  const validEntries = useMemo(
    () => entries.filter((e) => e.triage !== 'discard' && e.parsed && e.parsed.notes.length > 0 && !e.parsed.hasErrors),
    [entries]
  );

  // Auto-select valid if user hasn't marked any keep files yet
  const effectiveScope = scope === 'keep' && keepEntries.length === 0 ? 'valid' : scope;

  const targetEntries = useMemo(() => {
    const base = effectiveScope === 'keep' ? keepEntries : validEntries;
    if (dedupeMode === 'none') return base;

    const seenHashes = new Set<string>();
    const seenExactNoteGroups = new Set<number>();
    const seenAllGroups = new Set<number>();

    return base.filter((item) => {
      const dup = duplicateMap.get(item.id);
      if (dedupeMode === 'exact') {
        if (item.sha256) {
          if (seenHashes.has(item.sha256)) return false;
          seenHashes.add(item.sha256);
        }
        if (dup && (dup.kind === 'byte_exact' || dup.kind === 'note_exact')) {
          if (seenExactNoteGroups.has(dup.groupId)) return false;
          seenExactNoteGroups.add(dup.groupId);
        }
        return true;
      }

      if (!dup) return true;
      if (seenAllGroups.has(dup.groupId)) return false;
      seenAllGroups.add(dup.groupId);
      return true;
    });
  }, [effectiveScope, keepEntries, validEntries, dedupeMode, duplicateMap]);

  const { exactCountInBase, variantCountInBase } = useMemo(() => {
    const base = effectiveScope === 'keep' ? keepEntries : validEntries;
    let exact = 0;
    let variant = 0;
    for (const e of base) {
      const dup = duplicateMap.get(e.id);
      if (!dup) continue;
      if (dup.kind === 'byte_exact' || dup.kind === 'note_exact') exact++;
      else variant++;
    }
    return { exactCountInBase: exact, variantCountInBase: variant };
  }, [effectiveScope, keepEntries, validEntries, duplicateMap]);

  if (!isOpen) return null;

  const handleSaveAllTxtToDisk = async () => {
    if (targetEntries.length === 0) return;
    setExportBusy(true);
    setExportError(null);
    setExportResult(null);
    setExportProgress({ done: 0, total: targetEntries.length });

    try {
      let saved = 0;
      for (const item of targetEntries) {
        const draft = buildTrainingTxtDraft(item, abbreviations);
        const txt = serializeTrainingTxt(draft);
        const baseName = item.name.replace(/\.(mid|midi)$/i, '');
        await onSaveTextToDisk(item, `${baseName}.txt`, txt);
        saved++;
        setExportProgress({ done: saved, total: targetEntries.length });
      }
      setExportResult(
        `${saved} Trainings-.txt-Dateien erfolgreich direkt neben den MIDI-Dateien gespeichert.`
      );
    } catch (err) {
      setExportError(
        err instanceof Error ? err.message : 'Fehler beim Speichern der .txt-Dateien.'
      );
    } finally {
      setExportBusy(false);
    }
  };

  const handleDownloadJsonl = () => {
    if (targetEntries.length === 0) return;
    const lines = targetEntries.map((item) => {
      const draft = buildTrainingTxtDraft(item, abbreviations);
      const txt = serializeTrainingTxt(draft);
      return buildDatasetJsonlRecord(item, draft, txt);
    });
    downloadTextFile('midi_training_dataset.jsonl', lines.join('\n') + '\n');
    setExportResult(
      `JSONL-Dataset mit ${targetEntries.length} Einträgen als „midi_training_dataset.jsonl“ heruntergeladen.`
    );
    setExportError(null);
  };

  const handleDownloadCombinedTxt = () => {
    if (targetEntries.length === 0) return;
    const blocks = targetEntries.map((item) => {
      const draft = buildTrainingTxtDraft(item, abbreviations);
      const txt = serializeTrainingTxt(draft);
      return `# === ${item.relativePath} ===\n${txt}`;
    });
    downloadTextFile('alle_training_beschreibungen.txt', blocks.join('\n'));
    setExportResult(
      `${targetEntries.length} Beschreibungen gebündelt als „alle_training_beschreibungen.txt“ heruntergeladen.`
    );
    setExportError(null);
  };

  const handleAddAbbreviation = (e: React.FormEvent) => {
    e.preventDefault();
    const k = newKey.trim();
    const m = newMeaning.trim();
    if (!k || !m) {
      setAbbrError('Bitte sowohl Kürzel als auch Bedeutung angeben.');
      return;
    }
    if (abbreviations.some((a) => a.key.toLowerCase() === k.toLowerCase())) {
      setAbbrError(`Das Kürzel „${k}“ existiert bereits.`);
      return;
    }
    onChangeAbbreviations([...abbreviations, { key: k, meaning: m }]);
    setNewKey('');
    setNewMeaning('');
    setAbbrError(null);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="w-full max-w-3xl max-h-[88vh] flex flex-col rounded-lg bg-[#1c2026] border border-[#313844] shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[#181c21] border-b border-[#2b313a] flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <Database className="w-4 h-4 text-[#5eb1e6] shrink-0" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-white truncate">
                Trainings-Dataset Export &amp; Kürzel-Profil
              </h2>
              <p className="text-xs text-[#8892a0] truncate">
                Batch-Export für dein eigenes MIDI-Modell inklusive persönlicher Library-Abkürzungen.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded text-[#8c95a3] hover:text-white hover:bg-[#272d36] transition-colors"
            aria-label="Schließen"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab Bar */}
        <div className="px-5 pt-2.5 bg-[#181c21] border-b border-[#2b313a] flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setActiveTab('export')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-t text-xs font-medium border-b-2 transition-colors ${
              activeTab === 'export'
                ? 'border-[#5eb1e6] text-white bg-[#1c2026]'
                : 'border-transparent text-[#8d96a4] hover:text-[#dce2ea]'
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            Batch-Export ({targetEntries.length} Dateien)
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('abbreviations')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-t text-xs font-medium border-b-2 transition-colors ${
              activeTab === 'abbreviations'
                ? 'border-[#5eb1e6] text-white bg-[#1c2026]'
                : 'border-transparent text-[#8d96a4] hover:text-[#dce2ea]'
            }`}
          >
            <BookOpen className="w-3.5 h-3.5" />
            Mein Kürzel-Profil ({abbreviations.length})
          </button>
        </div>

        {/* Body */}
        {activeTab === 'export' ? (
          <div className="p-5 overflow-y-auto space-y-4 text-xs">
            {/* Scope Selection */}
            <div className="space-y-2">
              <div className="font-medium text-[#cfd7e3]">Welche MIDI-Dateien exportieren?</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <button
                  type="button"
                  disabled={keepEntries.length === 0}
                  onClick={() => setScope('keep')}
                  className={`p-3 rounded border text-left transition-colors ${
                    effectiveScope === 'keep'
                      ? 'bg-[#212e3b] border-[#5eb1e6]/70 text-white'
                      : 'bg-[#15191e] border-[#2b323d] text-[#98a2b0] hover:border-[#3c4656]'
                  } disabled:opacity-45 disabled:cursor-not-allowed`}
                >
                  <div className="font-semibold flex items-center justify-between">
                    <span>Nur „Behalten“ (K)</span>
                    <span className="font-mono text-[#7cc4f0]">{keepEntries.length}</span>
                  </div>
                  <div className="text-[11px] text-[#838d9b] mt-0.5">
                    Ideal für kuratierte, geprüfte Final-Tracks.
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setScope('valid')}
                  className={`p-3 rounded border text-left transition-colors ${
                    effectiveScope === 'valid'
                      ? 'bg-[#212e3b] border-[#5eb1e6]/70 text-white'
                      : 'bg-[#15191e] border-[#2b323d] text-[#98a2b0] hover:border-[#3c4656]'
                  }`}
                >
                  <div className="font-semibold flex items-center justify-between">
                    <span>Alle gültigen Dateien</span>
                    <span className="font-mono text-[#7cc4f0]">{validEntries.length}</span>
                  </div>
                  <div className="text-[11px] text-[#838d9b] mt-0.5">
                    Alle intakten MIDIs (ohne „Aussortiert“ und ohne Fehler).
                  </div>
                </button>
              </div>
            </div>

            {/* Duplicate & Variant Handling Options */}
            {(exactCountInBase > 0 || variantCountInBase > 0) && (
              <div className="p-3 rounded bg-[#231f16] border border-amber-700/40 space-y-2">
                <div className="font-medium text-amber-200 flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <span>
                    Deduplizierung: {exactCountInBase} exakte Duplikate · {variantCountInBase} musikalische Varianten
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {(
                    [
                      { id: 'exact', label: 'Nur exakte Duplikate entfernen (Empfohlen)' },
                      { id: 'all', label: 'Duplikate + Varianten entfernen' },
                      { id: 'none', label: 'Alle behalten' },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setDedupeMode(opt.id)}
                      className={`px-2.5 py-1 rounded text-[11px] font-medium border transition-colors ${
                        dedupeMode === opt.id
                          ? 'bg-amber-500/20 border-amber-400/70 text-amber-100'
                          : 'bg-[#171510] border-[#3d3423] text-[#c7b999] hover:text-white'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Export Actions */}
            <div className="space-y-2.5 pt-1">
              <div className="font-medium text-[#cfd7e3]">Export-Format wählen</div>

              {canWriteToDisk && (
                <div className="p-3.5 rounded bg-[#151a20] border border-[#2d3b4a] flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="font-semibold text-[#e6eef7]">
                      Einzelne .txt-Dateien direkt im Ordner speichern
                    </div>
                    <div className="text-[11px] text-[#8894a3] mt-0.5">
                      Schreibt für jede MIDI-Datei eine passende <code>&lt;Name&gt;.txt</code> direkt daneben auf deine Festplatte.
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={exportBusy || targetEntries.length === 0}
                    onClick={handleSaveAllTxtToDisk}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded text-xs font-medium bg-[#3675a3] hover:bg-[#4187ba] disabled:opacity-40 text-white transition-colors whitespace-nowrap"
                  >
                    <Save className="w-3.5 h-3.5" />
                    {exportProgress
                      ? `Speichere ${exportProgress.done}/${exportProgress.total}...`
                      : `${targetEntries.length}× .txt speichern`}
                  </button>
                </div>
              )}

              <div className="p-3.5 rounded bg-[#151a20] border border-[#2b323d] flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="font-semibold text-[#e6eef7]">
                    Kombiniertes JSONL-Dataset für KI-/Modell-Training (.jsonl)
                  </div>
                  <div className="text-[11px] text-[#8894a3] mt-0.5">
                    Eine JSON-Zeile pro Song inkl. Tonart, Tempo, Taktart, Spuren, Akkordfolge und fertiger <code>training_txt</code>.
                  </div>
                </div>
                <button
                  type="button"
                  disabled={exportBusy || targetEntries.length === 0}
                  onClick={handleDownloadJsonl}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded text-xs font-medium bg-[#253646] hover:bg-[#2f4559] border border-[#4ea1d3]/60 disabled:opacity-40 text-[#dcebf7] transition-colors whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5" />
                  JSONL herunterladen
                </button>
              </div>

              <div className="p-3.5 rounded bg-[#151a20] border border-[#2b323d] flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="font-semibold text-[#e6eef7]">
                    Alle .txt-Beschreibungen als Sammeldatei (.txt)
                  </div>
                  <div className="text-[11px] text-[#8894a3] mt-0.5">
                    Alle generierten YAML-Blöcke hintereinander in einer Textdatei zum schnellen Prüfen.
                  </div>
                </div>
                <button
                  type="button"
                  disabled={exportBusy || targetEntries.length === 0}
                  onClick={handleDownloadCombinedTxt}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded text-xs font-medium bg-[#22272f] hover:bg-[#2c333d] border border-[#353d4a] disabled:opacity-40 text-[#d5dce6] transition-colors whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5" />
                  Sammel-.txt laden
                </button>
              </div>
            </div>

            {exportResult && (
              <div className="p-3 rounded bg-emerald-950/40 border border-emerald-700/50 text-emerald-200 flex items-center gap-2">
                <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>{exportResult}</span>
              </div>
            )}
            {exportError && (
              <div className="p-3 rounded bg-rose-950/40 border border-rose-700/50 text-rose-200">
                {exportError}
              </div>
            )}
          </div>
        ) : (
          <div className="p-5 overflow-y-auto space-y-4 text-xs flex-1 min-h-0">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[#94a0b0]">
                Diese Abkürzungen werden lokal im Browser gespeichert und automatisch in Dateinamen &amp; Spuren erkannt.
              </p>
              <button
                type="button"
                onClick={() =>
                  onChangeAbbreviations(DEFAULT_ABBREVIATIONS.map((x) => ({ ...x })))
                }
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] bg-[#22272f] hover:bg-[#2b313c] border border-[#343c48] text-[#9aa3b0] hover:text-white transition-colors"
              >
                <RotateCcw className="w-3 h-3" />
                Standard
              </button>
            </div>

            {/* Add new abbreviation */}
            <form onSubmit={handleAddAbbreviation} className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={newKey}
                onChange={(e) => {
                  setNewKey(e.target.value);
                  if (abbrError) setAbbrError(null);
                }}
                placeholder="Kürzel (z. B. BL)"
                className="w-36 px-2.5 py-1.5 rounded bg-[#13171b] border border-[#2f3742] text-[#e6ecf4] font-mono focus:outline-none focus:border-[#4ea1d3]"
              />
              <input
                type="text"
                value={newMeaning}
                onChange={(e) => {
                  setNewMeaning(e.target.value);
                  if (abbrError) setAbbrError(null);
                }}
                placeholder="Bedeutung (z. B. Berlin Orchestra)"
                className="flex-1 min-w-[180px] px-2.5 py-1.5 rounded bg-[#13171b] border border-[#2f3742] text-[#e6ecf4] focus:outline-none focus:border-[#4ea1d3]"
              />
              <button
                type="submit"
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded font-medium bg-[#3675a3] hover:bg-[#4187ba] text-white transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                Hinzufügen
              </button>
            </form>
            {abbrError && <p className="text-rose-400">{abbrError}</p>}

            {/* Editable list */}
            <div className="border border-[#2b323d] rounded divide-y divide-[#252b34] bg-[#14181d]">
              {abbreviations.map((item, idx) => (
                <div
                  key={`${item.key}-${idx}`}
                  className="flex items-center gap-2 px-3 py-2"
                >
                  <input
                    type="text"
                    value={item.key}
                    onChange={(e) => {
                      const next = abbreviations.map((a, i) =>
                        i === idx ? { ...a, key: e.target.value } : a
                      );
                      onChangeAbbreviations(next);
                    }}
                    className="w-28 px-2 py-1 rounded bg-[#1c2128] border border-[#2d3540] font-mono text-[#a5d8ff] focus:outline-none focus:border-[#4ea1d3]"
                  />
                  <span className="text-[#5e6875]">:</span>
                  <input
                    type="text"
                    value={item.meaning}
                    onChange={(e) => {
                      const next = abbreviations.map((a, i) =>
                        i === idx ? { ...a, meaning: e.target.value } : a
                      );
                      onChangeAbbreviations(next);
                    }}
                    className="flex-1 px-2 py-1 rounded bg-[#1c2128] border border-[#2d3540] text-[#dce4ee] focus:outline-none focus:border-[#4ea1d3]"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      onChangeAbbreviations(abbreviations.filter((_, i) => i !== idx))
                    }
                    className="p-1 rounded text-[#7f8896] hover:text-rose-400 hover:bg-[#232830] transition-colors"
                    title="Kürzel entfernen"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
