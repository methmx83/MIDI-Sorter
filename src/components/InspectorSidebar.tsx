import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Bookmark,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Copy,
  Copyright,
  Download,
  FileCheck2,
  FileText,
  Hash,
  Info,
  Layers,
  Link2,
  Lock,
  Music2,
  RefreshCw,
  Save,
  ShieldAlert,
  Sliders,
  Sparkles,
  Tag,
  X,
  XCircle,
} from 'lucide-react';
import type {
  FieldProvenance,
  InstrumentFamily,
  MidiDatasetMetadata,
  MidiFileEntry,
  MidiFileType,
  MidiOrigin,
  MusicalRole,
  TrackMetadataEntry,
  TrackableMetaField,
} from '../types/midi';
import {
  FILE_TYPE_LABELS,
  getDefaultFamilyForInstrument,
  getMusicalRoleLabel,
  ORIGIN_LABELS,
  rebuildImportantTracksFromTrackMeta,
  toFamilyPresetOption,
  toRolePresetOption,
} from '../utils/midiClassifier';
import type { MetadataPresetProfile, PresetCategoryKey } from '../utils/metadataPresets';
import { PresetMultiSelect, PresetSingleSelect } from './PresetSelectControls';
import { getGmProgramName, getMidiCcLabel } from '../utils/midiConstants';
import type { DuplicateMatchInfo } from '../utils/midiDuplicates';
import { countConfirmedFields } from '../utils/metadataSidecar';
import { formatBytes, formatDuration, midiPitchToName } from '../utils/midiParser';
import { buildBarGrid, tickToBarNumber, tickToSeconds } from '../utils/midiTimeline';
import { analyzeMidiHarmony } from '../utils/musicTheory';

export type InspectorTab = 'metadata' | 'tracks' | 'details' | 'diagnostics';

interface InspectorSidebarProps {
  entry: MidiFileEntry | null;
  activeTab: InspectorTab;
  onChangeTab: (tab: InspectorTab) => void;
  onClose: () => void;
  canWriteToDisk: boolean;
  protectOriginals: boolean;
  duplicateInfo: DuplicateMatchInfo | null;
  metadataPresets: MetadataPresetProfile;
  onAddMetadataPreset: (category: PresetCategoryKey, value: string, abbr?: string) => void;
  onOpenPresetsManager?: () => void;
  onSeek: (sec: number) => void;
  onSelectEntry: (id: string) => void;
  onOpenTrainingTxt: (entry: MidiFileEntry) => void;
  onUpdateMetadata: (
    entryId: string,
    updater: (prev: MidiDatasetMetadata) => MidiDatasetMetadata
  ) => void;
  onConfirmAllAndSave: (entryId: string) => Promise<void>;
  onSaveSidecar: (entryId: string) => Promise<void>;
  onDownloadSidecar: (entryId: string) => void;
  onReclassifyAuto: (entryId: string, options?: { forceTracks?: boolean }) => void;
  onImmediateMoveToSorted?: (entry: MidiFileEntry) => void;
  mutedTracks: Set<number>;
  soloTracks: Set<number>;
  onToggleTrackMute: (trackIndex: number) => void;
  onToggleTrackSolo: (trackIndex: number) => void;
  onClearTrackMuteSolo: () => void;
}

const ORIGIN_OPTIONS: MidiOrigin[] = ['eigenkomposition', 'library', 'unbekannt'];
const FILE_TYPE_OPTIONS: MidiFileType[] = [
  'full_track',
  'pattern',
  'phrase',
  'loop',
  'einzelspur',
  'unbekannt',
];

const ProvenancePill: React.FC<{
  provenance: FieldProvenance;
  onToggle: () => void;
}> = ({ provenance, onToggle }) => {
  const isManual = provenance === 'manual';
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium border transition-colors ${
        isManual
          ? 'bg-emerald-950/50 border-emerald-700/60 text-emerald-300 hover:bg-emerald-900/50'
          : 'bg-sky-950/40 border-sky-800/50 text-sky-300/90 hover:bg-sky-900/40'
      }`}
      title={
        isManual
          ? 'Manuell bestätigt · Klick zum Zurücksetzen auf Auto'
          : 'Automatisch erkannt · Klick zum Bestätigen'
      }
    >
      {isManual ? <Check className="w-2.5 h-2.5" /> : <Sparkles className="w-2.5 h-2.5" />}
      {isManual ? 'Bestätigt' : 'Auto'}
    </button>
  );
};

export const InspectorSidebar: React.FC<InspectorSidebarProps> = ({
  entry,
  activeTab,
  onChangeTab,
  onClose,
  canWriteToDisk,
  protectOriginals,
  duplicateInfo,
  metadataPresets,
  onAddMetadataPreset,
  onOpenPresetsManager,
  onSeek,
  onSelectEntry,
  onOpenTrainingTxt,
  onUpdateMetadata,
  onConfirmAllAndSave,
  onSaveSidecar,
  onDownloadSidecar,
  onReclassifyAuto,
  onImmediateMoveToSorted,
  mutedTracks,
  soloTracks,
  onToggleTrackMute,
  onToggleTrackSolo,
  onClearTrackMuteSolo,
}) => {
  const [saving, setSaving] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<'id' | 'sha' | null>(null);
  const [expandedTrackIndex, setExpandedTrackIndex] = useState<number | null>(null);

  const articulationOptions = useMemo(
    () =>
      metadataPresets.articulations.map((a) => ({
        value: a.name,
        label: a.name,
        badge: a.abbr || undefined,
      })),
    [metadataPresets.articulations]
  );

  const familyOptions = useMemo(
    () => metadataPresets.instrumentFamilies.map(toFamilyPresetOption),
    [metadataPresets.instrumentFamilies]
  );

  const roleOptions = useMemo(
    () => metadataPresets.roles.map(toRolePresetOption),
    [metadataPresets.roles]
  );

  useEffect(() => {
    setExpandedTrackIndex(null);
  }, [entry?.id]);

  const parsed = entry?.parsed ?? null;
  const meta = entry?.datasetMeta ?? null;

  const barGrid = useMemo(
    () => (parsed ? buildBarGrid(parsed.ppqn, parsed.timeSignatures, parsed.totalTicks) : []),
    [parsed]
  );

  const harmony = useMemo(() => {
    if (!parsed) return null;
    return analyzeMidiHarmony(
      parsed.notes,
      parsed.ppqn,
      parsed.timeSignatures,
      parsed.totalTicks
    );
  }, [parsed]);

  const ccGroups = useMemo(() => {
    if (!parsed) return [];
    const map = new Map<
      number,
      {
        controller: number;
        label: string;
        count: number;
        minVal: number;
        maxVal: number;
        firstSec: number;
      }
    >();
    for (const cc of parsed.performance.controlChanges) {
      const ex = map.get(cc.controller);
      if (!ex) {
        map.set(cc.controller, {
          controller: cc.controller,
          label: getMidiCcLabel(cc.controller),
          count: 1,
          minVal: cc.value,
          maxVal: cc.value,
          firstSec: cc.sec,
        });
      } else {
        ex.count++;
        if (cc.value < ex.minVal) ex.minVal = cc.value;
        if (cc.value > ex.maxVal) ex.maxVal = cc.value;
      }
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
  }, [parsed]);

  const diagnosticCount =
    (parsed?.issues.length ?? 0) + (entry?.parseError ? 1 : 0) + (duplicateInfo ? 1 : 0);

  const copyText = async (text: string, which: 'id' | 'sha') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(which);
      window.setTimeout(() => setCopiedKey(null), 1600);
    } catch {
      // Ignore clipboard failure
    }
  };

  if (!entry) {
    return (
      <div className="flex-1 flex flex-col min-h-0 bg-[#181c22]">
        <div className="px-3.5 h-10 bg-[#1b1f26] border-b border-[#2a313c] flex items-center justify-between shrink-0">
          <span className="text-xs font-semibold text-[#b8c2cf]">Inspektor</span>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded text-[#7f8896] hover:text-white hover:bg-[#272e38]"
            title="Inspektor ausblenden (I)"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex-1 flex items-center justify-center p-6 text-center text-xs text-[#7b8594]">
          Wähle links eine MIDI-Datei aus, um Metadaten, MIDI-Details und Prüfhinweise anzuzeigen.
        </div>
      </div>
    );
  }

  const { confirmed, total } = countConfirmedFields(meta ?? undefined);

  const setField = <K extends keyof MidiDatasetMetadata>(
    field: K,
    value: MidiDatasetMetadata[K],
    trackKey?: TrackableMetaField
  ) => {
    onUpdateMetadata(entry.id, (prev) => ({
      ...prev,
      [field]: value,
      reviewStatus: prev.reviewStatus === 'offen' ? 'in_arbeit' : prev.reviewStatus,
      fieldProvenance: trackKey
        ? { ...prev.fieldProvenance, [trackKey]: 'manual' }
        : prev.fieldProvenance,
      sidecarDirty: true,
    }));
  };

  const toggleProvenance = (trackKey: TrackableMetaField) => {
    onUpdateMetadata(entry.id, (prev) => ({
      ...prev,
      fieldProvenance: {
        ...prev.fieldProvenance,
        [trackKey]: prev.fieldProvenance[trackKey] === 'manual' ? 'auto' : 'manual',
      },
      sidecarDirty: true,
    }));
  };

  const handleSaveClick = async () => {
    setSaving(true);
    setSaveFeedback(null);
    try {
      await onSaveSidecar(entry.id);
      setSaveFeedback('In .txt gespeichert');
      window.setTimeout(() => setSaveFeedback(null), 2200);
    } catch {
      setSaveFeedback('Fehler beim Speichern');
    } finally {
      setSaving(false);
    }
  };

  const handleConfirmAllClick = async () => {
    setSaving(true);
    setSaveFeedback(null);
    try {
      await onConfirmAllAndSave(entry.id);
      setSaveFeedback(canWriteToDisk ? 'Bestätigt & gespeichert' : 'Alle bestätigt');
      window.setTimeout(() => setSaveFeedback(null), 2200);
    } catch {
      setSaveFeedback('Fehler beim Speichern');
    } finally {
      setSaving(false);
    }
  };

  const formatTickBar = (tick: number) => tickToBarNumber(barGrid, tick);
  const trackCount = meta?.trackMetadata?.length ?? 0;

  const metadataFooter = meta ? (
    <div className="p-3 bg-[#1b1f26] border-t border-[#2a313c] space-y-2 shrink-0">
      {saveFeedback && (
        <div className="text-[11px] text-emerald-300 font-medium text-center">
          {saveFeedback}
        </div>
      )}

      <button
        type="button"
        disabled={saving}
        onClick={handleConfirmAllClick}
        className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded text-xs font-medium bg-emerald-700/90 hover:bg-emerald-600 disabled:opacity-40 text-white transition-colors"
        title="Alle Felder als bestätigt markieren und speichern"
      >
        <CheckCheck className="w-3.5 h-3.5" />
        {canWriteToDisk ? 'Alle bestätigen & speichern (.txt)' : 'Alle bestätigen'}
      </button>

      <div className="grid grid-cols-2 gap-1.5">
        {canWriteToDisk ? (
          <button
            type="button"
            disabled={saving}
            onClick={handleSaveClick}
            className="inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded text-[11px] font-medium bg-[#253646] hover:bg-[#2f4559] border border-[#4ea1d3]/60 disabled:opacity-40 text-[#dcebf7] transition-colors"
          >
            <Save className="w-3 h-3" />
            Speichern (.txt)
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onDownloadSidecar(entry.id)}
            className="inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded text-[11px] font-medium bg-[#253646] hover:bg-[#2f4559] border border-[#4ea1d3]/60 text-[#dcebf7] transition-colors"
          >
            <Download className="w-3 h-3" />
            .txt laden
          </button>
        )}

        <button
          type="button"
          onClick={() =>
            onReclassifyAuto(entry.id, { forceTracks: activeTab === 'tracks' })
          }
          className="inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded text-[11px] font-medium bg-[#202630] hover:bg-[#29313e] border border-[#313b4a] text-[#b4c2d1] hover:text-white transition-colors"
          title={
            activeTab === 'tracks'
              ? 'Alle Spuren anhand der Spurnamen neu erkennen'
              : 'Auto-Erkennung für unbestätigte Felder und Spuren neu ausführen'
          }
        >
          <RefreshCw className="w-3 h-3" />
          {activeTab === 'tracks' ? 'Spuren neu' : 'Auto neu'}
        </button>
      </div>
    </div>
  ) : null;

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[#171b20]">
      {/* Tab Header */}
      <div className="px-2 h-10 bg-[#1b1f26] border-b border-[#2a313c] flex items-center justify-between gap-1 shrink-0">
        <div className="flex items-center gap-0.5 min-w-0 overflow-x-auto">
          <button
            type="button"
            onClick={() => onChangeTab('metadata')}
            className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[11.5px] font-medium transition-colors whitespace-nowrap ${
              activeTab === 'metadata'
                ? 'bg-[#283240] text-white'
                : 'text-[#8994a3] hover:text-[#dce4ee] hover:bg-[#222730]'
            }`}
          >
            <Tag className="w-3 h-3 text-[#5eb1e6] shrink-0" />
            <span>Metadaten</span>
          </button>

          <button
            type="button"
            onClick={() => onChangeTab('tracks')}
            className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[11.5px] font-medium transition-colors whitespace-nowrap ${
              activeTab === 'tracks'
                ? 'bg-[#283240] text-white'
                : 'text-[#8994a3] hover:text-[#dce4ee] hover:bg-[#222730]'
            }`}
            title="Besetzung & einzelne MIDI-Spuren zuordnen"
          >
            <Layers className="w-3 h-3 text-[#5eb1e6] shrink-0" />
            <span>Spuren</span>
            {trackCount > 0 && (
              <span className="px-1 py-0 rounded-full text-[9.5px] font-mono bg-[#222b36] text-[#9eb6cc]">
                {trackCount}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => onChangeTab('details')}
            className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[11.5px] font-medium transition-colors whitespace-nowrap ${
              activeTab === 'details'
                ? 'bg-[#283240] text-white'
                : 'text-[#8994a3] hover:text-[#dce4ee] hover:bg-[#222730]'
            }`}
          >
            <Info className="w-3 h-3 text-[#7cc4f0] shrink-0" />
            <span>MIDI</span>
          </button>

          <button
            type="button"
            onClick={() => onChangeTab('diagnostics')}
            className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[11.5px] font-medium transition-colors whitespace-nowrap ${
              activeTab === 'diagnostics'
                ? 'bg-[#283240] text-white'
                : 'text-[#8994a3] hover:text-[#dce4ee] hover:bg-[#222730]'
            }`}
          >
            <ShieldAlert
              className={`w-3 h-3 shrink-0 ${
                parsed?.hasErrors
                  ? 'text-rose-400'
                  : parsed?.hasWarnings || duplicateInfo
                  ? 'text-amber-400'
                  : 'text-[#838f9f]'
              }`}
            />
            <span>Prüfung</span>
            {diagnosticCount > 0 && (
              <span
                className={`px-1 py-0 rounded-full text-[9.5px] font-mono font-semibold ${
                  parsed?.hasErrors
                    ? 'bg-rose-500/25 text-rose-200'
                    : 'bg-amber-500/25 text-amber-200'
                }`}
              >
                {diagnosticCount}
              </span>
            )}
          </button>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded text-[#7f8896] hover:text-white hover:bg-[#272e38] shrink-0"
          title="Inspektor ausblenden (Taste I)"
          aria-label="Inspektor ausblenden"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* TAB 1: METADATEN */}
      {activeTab === 'metadata' && meta && (
        <>
          <div className="flex-1 overflow-y-auto p-3.5 space-y-4 text-xs">
            {/* Sidecar Status Banner */}
            <div className="p-2.5 rounded-md bg-[#1c222a] border border-[#2a3340] flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                {meta.sidecarLoaded && !meta.sidecarDirty ? (
                  <FileCheck2 className="w-4 h-4 text-emerald-400 shrink-0" />
                ) : (
                  <FileText
                    className={`w-4 h-4 shrink-0 ${
                      meta.sidecarDirty ? 'text-amber-300' : 'text-[#7b899b]'
                    }`}
                  />
                )}
                <div className="min-w-0">
                  <div className="font-medium text-[#dce5f0] truncate">
                    {meta.sidecarDirty
                      ? 'Ungespeicherte Änderungen'
                      : meta.sidecarLoaded
                      ? '.txt-Datei verbunden'
                      : 'Automatischer Entwurf'}
                  </div>
                  <div className="text-[11px] text-[#7e8c9e] font-mono">
                    {confirmed}/{total} Felder bestätigt
                  </div>
                </div>
              </div>

              {parsed && parsed.notes.length > 0 && (
                <button
                  type="button"
                  onClick={() => onOpenTrainingTxt(entry)}
                  className="px-2 py-1 rounded text-[11px] font-medium bg-[#222d2a] hover:bg-[#2a3934] border border-emerald-700/50 text-emerald-200 transition-colors whitespace-nowrap shrink-0"
                  title="Vollständige .txt-Datei ansehen & bearbeiten"
                >
                  .txt ansehen
                </button>
              )}
            </div>

            {/* Herkunft */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium text-[#95a2b3]">Herkunft</span>
                <ProvenancePill
                  provenance={meta.fieldProvenance.origin}
                  onToggle={() => toggleProvenance('origin')}
                />
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {ORIGIN_OPTIONS.map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => setField('origin', opt, 'origin')}
                    className={`px-2 py-1.5 rounded text-[11px] font-medium border transition-colors truncate ${
                      meta.origin === opt
                        ? opt === 'eigenkomposition'
                          ? 'bg-emerald-600/25 border-emerald-500/70 text-emerald-200'
                          : opt === 'library'
                          ? 'bg-violet-600/25 border-violet-500/70 text-violet-200'
                          : 'bg-[#2d3642] border-[#4f5d70] text-white'
                        : 'bg-[#1c2128] border-[#2b333e] text-[#8d98a7] hover:text-white'
                    }`}
                  >
                    {opt === 'eigenkomposition' ? 'Eigene' : ORIGIN_LABELS[opt]}
                  </button>
                ))}
              </div>
            </div>

            {/* Dateityp */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium text-[#95a2b3]">Dateityp</span>
                <ProvenancePill
                  provenance={meta.fieldProvenance.fileType}
                  onToggle={() => toggleProvenance('fileType')}
                />
              </div>
              <div className="flex flex-wrap gap-1.5">
                {FILE_TYPE_OPTIONS.map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() =>
                      onUpdateMetadata(entry.id, (prev) => ({
                        ...prev,
                        fileType: opt,
                        isMultiTrackMeta: opt === 'full_track',
                        musicalRole:
                          opt === 'full_track' ? 'arrangement' : prev.musicalRole,
                        reviewStatus:
                          prev.reviewStatus === 'offen' ? 'in_arbeit' : prev.reviewStatus,
                        fieldProvenance: {
                          ...prev.fieldProvenance,
                          fileType: 'manual',
                        },
                        sidecarDirty: true,
                      }))
                    }
                    className={`px-2 py-1 rounded text-[11px] font-medium border transition-colors ${
                      meta.fileType === opt
                        ? 'bg-[#263f54] border-[#5eb1e6]/70 text-[#e4f3ff]'
                        : 'bg-[#1c2128] border-[#2b333e] text-[#8d98a7] hover:text-white'
                    }`}
                  >
                    {FILE_TYPE_LABELS[opt]}
                  </button>
                ))}
              </div>
            </div>

            {/* Bewertung 1-10 */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium text-[#95a2b3]">
                  Persönliche Bewertung {meta.rating !== null ? `(${meta.rating}/10)` : ''}
                </span>
                <ProvenancePill
                  provenance={meta.fieldProvenance.rating}
                  onToggle={() => toggleProvenance('rating')}
                />
              </div>
              <div className="grid grid-cols-10 gap-1">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((val) => {
                  const active = meta.rating === val;
                  const filled = meta.rating !== null && val <= meta.rating;
                  return (
                    <button
                      key={val}
                      type="button"
                      onClick={() =>
                        setField('rating', meta.rating === val ? null : val, 'rating')
                      }
                      className={`h-7 rounded text-[11px] font-mono font-semibold border transition-colors ${
                        active
                          ? 'bg-amber-500 border-amber-300 text-[#141006]'
                          : filled
                          ? 'bg-amber-500/20 border-amber-600/50 text-amber-200 hover:bg-amber-500/35'
                          : 'bg-[#1c2128] border-[#2b333e] text-[#848f9e] hover:text-white hover:border-[#414c5c]'
                      }`}
                      title={`Bewertung ${val} von 10`}
                    >
                      {val}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Stil & Stimmung */}
            <div className="space-y-3 pt-2 border-t border-[#232a34]">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-[#728296]">
                  Stil &amp; Stimmung
                </span>
                {onOpenPresetsManager && (
                  <button
                    type="button"
                    onClick={onOpenPresetsManager}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] font-medium bg-[#1d242d] hover:bg-[#26303d] border border-[#2d3846] text-[#8bc9ef] hover:text-white transition-colors whitespace-nowrap"
                    title="Eigene Genre-, Mood-, Instrument- und Artikulations-Presets verwalten"
                  >
                    <Sliders className="w-2.5 h-2.5" />
                    Presets
                  </button>
                )}
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between gap-1">
                  <span className="text-[11px] font-medium text-[#95a2b3]">Genre</span>
                  <ProvenancePill
                    provenance={meta.fieldProvenance.genre}
                    onToggle={() => toggleProvenance('genre')}
                  />
                </div>
                <PresetSingleSelect
                  value={meta.genre}
                  options={metadataPresets.genres}
                  onChange={(val) => setField('genre', val, 'genre')}
                  onAddPreset={(val) => onAddMetadataPreset('genres', val)}
                  placeholder="Genre auswählen…"
                  searchPlaceholder="Genre suchen oder eigenes eingeben…"
                />
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between gap-1">
                  <span className="text-[11px] font-medium text-[#95a2b3]">Subgenre</span>
                  <ProvenancePill
                    provenance={meta.fieldProvenance.subgenres}
                    onToggle={() => toggleProvenance('subgenres')}
                  />
                </div>
                <PresetMultiSelect
                  values={meta.subgenres}
                  options={metadataPresets.subgenres}
                  onChange={(vals) => setField('subgenres', vals, 'subgenres')}
                  onAddPreset={(val) => onAddMetadataPreset('subgenres', val)}
                  placeholder="Subgenres auswählen…"
                  searchPlaceholder="Subgenre filtern oder hinzufügen…"
                  chipTone="sky"
                />
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between gap-1">
                  <span className="text-[11px] font-medium text-[#95a2b3]">Stimmung (Mood)</span>
                  <ProvenancePill
                    provenance={meta.fieldProvenance.moods}
                    onToggle={() => toggleProvenance('moods')}
                  />
                </div>
                <PresetMultiSelect
                  values={meta.moods}
                  options={metadataPresets.moods}
                  onChange={(vals) => setField('moods', vals, 'moods')}
                  onAddPreset={(val) => onAddMetadataPreset('moods', val)}
                  placeholder="Moods auswählen…"
                  searchPlaceholder="Mood suchen (z. B. Dark, Epic)…"
                  chipTone="violet"
                />
              </div>
            </div>

            {/* Werkstatus */}
            <div className="space-y-1 pt-2 border-t border-[#232a34]">
              <div className="flex items-center justify-between gap-1">
                <span className="text-[11px] font-medium text-[#95a2b3]">Werkstatus</span>
                <ProvenancePill
                  provenance={meta.fieldProvenance.workStatus}
                  onToggle={() => toggleProvenance('workStatus')}
                />
              </div>
              <PresetSingleSelect
                value={meta.workStatus}
                options={metadataPresets.workStatuses}
                onChange={(val) => setField('workStatus', val, 'workStatus')}
                onAddPreset={(val) => onAddMetadataPreset('workStatuses', val)}
                placeholder="Werkstatus…"
                searchPlaceholder="Status suchen oder eingeben…"
              />
            </div>

            {/* Composition-ID & Verknüpfung */}
            <div className="space-y-2 pt-2 border-t border-[#232a34]">
              <div className="space-y-1">
                <span className="text-[11px] font-medium text-[#7f8c9d]">Composition-ID</span>
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={meta.compositionId}
                    onChange={(e) => setField('compositionId', e.target.value)}
                    className="flex-1 min-w-0 px-2 py-1 rounded bg-[#13171c] border border-[#2a3340] font-mono text-[11px] text-[#9dd0f5] focus:outline-none focus:border-[#4ea1d3]"
                  />
                  <button
                    type="button"
                    onClick={() => copyText(meta.compositionId, 'id')}
                    className="p-1.5 rounded bg-[#1e242d] hover:bg-[#28303c] border border-[#2e3846] text-[#9fb2c7] hover:text-white shrink-0"
                    title="Composition-ID kopieren"
                  >
                    {copiedKey === 'id' ? (
                      <Check className="w-3 h-3 text-emerald-400" />
                    ) : (
                      <Copy className="w-3 h-3" />
                    )}
                  </button>
                </div>
              </div>

              <div
                className="flex items-start gap-1.5 text-[11px] text-[#7c8a9b]"
                title={`Original: ${meta.sourceLink.originalFile || meta.sourceLink.midiFile}`}
              >
                <Link2 className="w-3.5 h-3.5 text-[#5eb1e6] shrink-0 mt-0.5" />
                <span className="font-mono text-[10.5px] text-[#8fa2b8] break-all">
                  {meta.sourceLink.metadataFile}
                </span>
              </div>
            </div>
          </div>

          {metadataFooter}
        </>
      )}

      {/* TAB 2: BESETZUNG / SPUREN */}
      {activeTab === 'tracks' && meta && (
        <>
          <div className="flex-1 overflow-y-auto p-3.5 space-y-3 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[#728296] flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-[#5eb1e6]" />
                Besetzung / Spuren
              </span>
              <div className="inline-flex rounded bg-[#13171c] border border-[#2a3340] p-0.5">
                <button
                  type="button"
                  onClick={() => setField('isMultiTrackMeta', false)}
                  className={`px-2 py-0.5 rounded text-[10.5px] font-medium transition-colors ${
                    !meta.isMultiTrackMeta
                      ? 'bg-[#28384a] text-[#e2f2ff]'
                      : 'text-[#8490a0] hover:text-white'
                  }`}
                  title="Einzelnes Instrument / Loop / Phrase beschreiben"
                >
                  Einzelspur
                </button>
                <button
                  type="button"
                  onClick={() => setField('isMultiTrackMeta', true)}
                  className={`px-2 py-0.5 rounded text-[10.5px] font-medium transition-colors ${
                    meta.isMultiTrackMeta
                      ? 'bg-[#28384a] text-[#e2f2ff]'
                      : 'text-[#8490a0] hover:text-white'
                  }`}
                  title="Ganzer Song / Beat: Instrument, Artikulation & Rolle pro Spur verwalten"
                >
                  Full-Track
                </button>
              </div>
            </div>

            {meta.isMultiTrackMeta ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2 text-[11px] text-[#7f8c9d] leading-snug">
                  <span>
                    Klicke eine Spur zum Bearbeiten · <strong className="text-[#a7b6c8]">M/S</strong> zum Vorhören.
                  </span>
                  {(mutedTracks.size > 0 || soloTracks.size > 0) && (
                    <button
                      type="button"
                      onClick={onClearTrackMuteSolo}
                      className="text-[10.5px] text-[#7cc4f0] hover:underline whitespace-nowrap shrink-0"
                    >
                      Alle an
                    </button>
                  )}
                </div>

                {meta.trackMetadata && meta.trackMetadata.length > 0 ? (
                  <div className="space-y-1">
                    {meta.trackMetadata.map((tr) => {
                      const isOpen = expandedTrackIndex === tr.trackIndex;
                      const isMuted = mutedTracks.has(tr.trackIndex);
                      const isSolo = soloTracks.has(tr.trackIndex);
                      const updateTrack = (patch: Partial<TrackMetadataEntry>) => {
                        onUpdateMetadata(entry.id, (prev) => {
                          const nextTracks = (prev.trackMetadata || []).map((t) =>
                            t.trackIndex === tr.trackIndex
                              ? { ...t, ...patch, confirmed: true }
                              : t
                          );
                          return {
                            ...prev,
                            trackMetadata: nextTracks,
                            importantTracks: rebuildImportantTracksFromTrackMeta(nextTracks),
                            reviewStatus:
                              prev.reviewStatus === 'offen' ? 'in_arbeit' : prev.reviewStatus,
                            sidecarDirty: true,
                          };
                        });
                      };

                      const roleNorm = tr.musicalRole.trim().toLowerCase();
                      const roleColor =
                        roleNorm === 'melodie'
                          ? 'text-emerald-300 bg-emerald-950/50 border-emerald-700/50'
                          : roleNorm === 'gegenmelodie'
                          ? 'text-teal-300 bg-teal-950/50 border-teal-700/50'
                          : roleNorm === 'harmonie' ||
                            roleNorm === 'layer' ||
                            roleNorm.includes('pad') ||
                            roleNorm.includes('atmo')
                          ? 'text-sky-300 bg-sky-950/50 border-sky-700/50'
                          : roleNorm === 'bass' || roleNorm === 'low-end' || roleNorm === 'low end'
                          ? 'text-amber-300 bg-amber-950/50 border-amber-700/50'
                          : roleNorm === 'percussion' ||
                            roleNorm === 'ostinato_arp' ||
                            roleNorm === 'drums' ||
                            roleNorm === 'rhythmus' ||
                            roleNorm === 'akzent' ||
                            roleNorm === 'rhythmischer akzent'
                          ? 'text-violet-300 bg-violet-950/50 border-violet-700/50'
                          : 'text-[#9aa6b5] bg-[#202630] border-[#303846]';

                      return (
                        <div
                          key={`${tr.trackIndex}-${tr.trackName}`}
                          className="rounded bg-[#1a2028] border border-[#28313d] overflow-hidden"
                        >
                          <div className="px-2 py-1 flex items-center gap-1 hover:bg-[#212832] transition-colors">
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedTrackIndex(isOpen ? null : tr.trackIndex)
                              }
                              className="flex-1 min-w-0 text-left flex items-center gap-1.5 py-0.5"
                            >
                              {isOpen ? (
                                <ChevronDown className="w-3 h-3 text-[#7c899b] shrink-0" />
                              ) : (
                                <ChevronRight className="w-3 h-3 text-[#7c899b] shrink-0" />
                              )}
                              <span
                                className={`flex-1 min-w-0 truncate text-[11.5px] font-medium ${
                                  isMuted ? 'text-[#6c7685] line-through' : 'text-[#dce5f0]'
                                }`}
                                title={`${tr.trackName} (${tr.noteCount} Noten)`}
                              >
                                {tr.trackName}
                              </span>
                              <span
                                className={`px-1.5 py-0 rounded border text-[9.5px] font-medium whitespace-nowrap shrink-0 ${roleColor}`}
                              >
                                {getMusicalRoleLabel(tr.musicalRole)}
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={() => onToggleTrackMute(tr.trackIndex)}
                              className={`w-5 h-5 rounded text-[9.5px] font-mono font-bold border transition-colors shrink-0 ${
                                isMuted
                                  ? 'bg-amber-500/25 border-amber-400/70 text-amber-200'
                                  : 'bg-[#151a20] border-[#2c3542] text-[#7a8696] hover:text-white'
                              }`}
                              title="Spur stummschalten (Mute)"
                            >
                              M
                            </button>
                            <button
                              type="button"
                              onClick={() => onToggleTrackSolo(tr.trackIndex)}
                              className={`w-5 h-5 rounded text-[9.5px] font-mono font-bold border transition-colors shrink-0 ${
                                isSolo
                                  ? 'bg-emerald-500/25 border-emerald-400/70 text-emerald-200'
                                  : 'bg-[#151a20] border-[#2c3542] text-[#7a8696] hover:text-white'
                              }`}
                              title="Nur diese Spur vorhören (Solo)"
                            >
                              S
                            </button>
                          </div>

                          {isOpen && (
                            <div className="px-2.5 pb-2.5 pt-1.5 border-t border-[#242d38] bg-[#14181e] space-y-2">
                              <div className="space-y-1">
                                <span className="text-[10px] text-[#7f8c9d]">Instrument</span>
                                <PresetSingleSelect
                                  size="xs"
                                  value={tr.instrument}
                                  options={metadataPresets.instruments}
                                  onChange={(val) => {
                                    const matchedFamily = getDefaultFamilyForInstrument(val);
                                    updateTrack(
                                      matchedFamily
                                        ? { instrument: val, instrumentFamily: matchedFamily }
                                        : { instrument: val }
                                    );
                                  }}
                                  onAddPreset={(val) => onAddMetadataPreset('instruments', val)}
                                  placeholder="Instrument wählen…"
                                  searchPlaceholder="Instrument suchen…"
                                />
                              </div>
                              <div className="grid grid-cols-2 gap-1.5">
                                <div className="space-y-1">
                                  <span className="text-[10px] text-[#7f8c9d]">Familie</span>
                                  <PresetSingleSelect
                                    size="xs"
                                    value={tr.instrumentFamily}
                                    options={familyOptions}
                                    onChange={(val) =>
                                      updateTrack({
                                        instrumentFamily: val as InstrumentFamily,
                                      })
                                    }
                                    onAddPreset={(val) =>
                                      onAddMetadataPreset('instrumentFamilies', val)
                                    }
                                    placeholder="Familie…"
                                    searchPlaceholder="Familie suchen…"
                                  />
                                </div>
                                <div className="space-y-1">
                                  <span className="text-[10px] text-[#7f8c9d]">Rolle</span>
                                  <PresetSingleSelect
                                    size="xs"
                                    value={tr.musicalRole}
                                    options={roleOptions}
                                    onChange={(val) =>
                                      updateTrack({
                                        musicalRole: val as MusicalRole,
                                      })
                                    }
                                    onAddPreset={(val) => onAddMetadataPreset('roles', val)}
                                    placeholder="Rolle…"
                                    searchPlaceholder="Rolle suchen…"
                                  />
                                </div>
                              </div>
                              <div className="space-y-1">
                                <span className="text-[10px] text-[#7f8c9d]">Artikulation</span>
                                <PresetSingleSelect
                                  size="xs"
                                  value={tr.articulation}
                                  options={articulationOptions}
                                  onChange={(val) => updateTrack({ articulation: val })}
                                  onAddPreset={(val) => onAddMetadataPreset('articulations', val)}
                                  placeholder="Artikulation wählen…"
                                  searchPlaceholder="Kürzel (Spic) oder Name…"
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="p-2 rounded bg-[#1a2028] border border-[#28313d] text-[11px] text-[#8390a0]">
                    Keine einzelnen Notenspuren erkannt.
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-[11px] font-medium text-[#95a2b3]">Instrument</span>
                    <ProvenancePill
                      provenance={meta.fieldProvenance.instrument}
                      onToggle={() => toggleProvenance('instrument')}
                    />
                  </div>
                  <PresetSingleSelect
                    value={meta.instrument}
                    options={metadataPresets.instruments}
                    onChange={(val) => {
                      const matchedFamily = getDefaultFamilyForInstrument(val);
                      if (matchedFamily) {
                        onUpdateMetadata(entry.id, (prev) => ({
                          ...prev,
                          instrument: val,
                          instrumentFamily: matchedFamily,
                          reviewStatus:
                            prev.reviewStatus === 'offen' ? 'in_arbeit' : prev.reviewStatus,
                          fieldProvenance: {
                            ...prev.fieldProvenance,
                            instrument: 'manual',
                            instrumentFamily: 'manual',
                          },
                          sidecarDirty: true,
                        }));
                      } else {
                        setField('instrument', val, 'instrument');
                      }
                    }}
                    onAddPreset={(val) => onAddMetadataPreset('instruments', val)}
                    placeholder="Instrument auswählen…"
                    searchPlaceholder="Instrument suchen (z. B. Cello, 808)…"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2.5">
                  <div className="space-y-1">
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-[11px] font-medium text-[#95a2b3]">Familie</span>
                      <ProvenancePill
                        provenance={meta.fieldProvenance.instrumentFamily}
                        onToggle={() => toggleProvenance('instrumentFamily')}
                      />
                    </div>
                    <PresetSingleSelect
                      value={meta.instrumentFamily}
                      options={familyOptions}
                      onChange={(val) =>
                        setField(
                          'instrumentFamily',
                          val as InstrumentFamily,
                          'instrumentFamily'
                        )
                      }
                      onAddPreset={(val) => onAddMetadataPreset('instrumentFamilies', val)}
                      placeholder="Familie…"
                      searchPlaceholder="Familie suchen…"
                    />
                  </div>

                  <div className="space-y-1">
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-[11px] font-medium text-[#95a2b3]">Rolle</span>
                      <ProvenancePill
                        provenance={meta.fieldProvenance.musicalRole}
                        onToggle={() => toggleProvenance('musicalRole')}
                      />
                    </div>
                    <PresetSingleSelect
                      value={meta.musicalRole}
                      options={roleOptions}
                      onChange={(val) =>
                        setField('musicalRole', val as MusicalRole, 'musicalRole')
                      }
                      onAddPreset={(val) => onAddMetadataPreset('roles', val)}
                      placeholder="Rolle…"
                      searchPlaceholder="Rolle suchen (z. B. Rhythmus)…"
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-[11px] font-medium text-[#95a2b3]">Artikulation</span>
                    <ProvenancePill
                      provenance={meta.fieldProvenance.articulation}
                      onToggle={() => toggleProvenance('articulation')}
                    />
                  </div>
                  <PresetSingleSelect
                    value={meta.articulation}
                    options={articulationOptions}
                    onChange={(val) => setField('articulation', val, 'articulation')}
                    onAddPreset={(val) => onAddMetadataPreset('articulations', val)}
                    placeholder="Artikulation…"
                    searchPlaceholder="Kürzel (Spic) oder Name…"
                  />
                </div>
              </div>
            )}
          </div>

          {metadataFooter}
        </>
      )}

      {/* TAB 2: MIDI DETAILS */}
      {activeTab === 'details' && (
        <div className="flex-1 overflow-y-auto p-3.5 space-y-4 text-xs">
          {!parsed ? (
            <div className="text-rose-300">
              {entry.parseError || 'MIDI-Datei konnte nicht gelesen werden.'}
            </div>
          ) : (
            <>
              {/* Overview Grid */}
              <div className="grid grid-cols-2 gap-2">
                <div className="p-2 rounded bg-[#1c2128] border border-[#28303b]">
                  <div className="text-[10px] text-[#7c8899]">Noten · Spuren</div>
                  <div className="font-mono text-[#dce5f0] font-medium mt-0.5">
                    {parsed.notes.length} · {parsed.trackCount}{' '}
                    {parsed.trackCount === 1 ? 'Spur' : 'Spuren'}
                  </div>
                </div>
                <div className="p-2 rounded bg-[#1c2128] border border-[#28303b]">
                  <div className="text-[10px] text-[#7c8899]">Takte · Dauer</div>
                  <div className="font-mono text-[#dce5f0] font-medium mt-0.5">
                    {parsed.barCount} T · {formatDuration(parsed.totalDurationSec)}
                  </div>
                </div>
                <div className="p-2 rounded bg-[#1c2128] border border-[#28303b]">
                  <div className="text-[10px] text-[#7c8899]">Tonumfang</div>
                  <div className="font-mono text-[#dce5f0] font-medium mt-0.5">
                    {parsed.notes.length > 0
                      ? `${midiPitchToName(parsed.minPitch)} – ${midiPitchToName(parsed.maxPitch)}`
                      : '—'}
                  </div>
                </div>
                <div className="p-2 rounded bg-[#1c2128] border border-[#28303b]">
                  <div className="text-[10px] text-[#7c8899]">Dateigröße</div>
                  <div className="font-mono text-[#dce5f0] font-medium mt-0.5">
                    {formatBytes(entry.sizeBytes)}
                  </div>
                </div>
              </div>

              {/* Tonart & Akkordfolge */}
              {harmony && (harmony.key || harmony.chords.length > 0 || harmony.isPercussionOnly) && (
                <div className="space-y-1.5 pt-2 border-t border-[#232a34]">
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#728296]">
                    <Music2 className="w-3.5 h-3.5 text-[#5eb1e6]" />
                    Tonart &amp; Akkordfolge
                  </div>
                  {harmony.key ? (
                    <div className="text-xs text-[#dce8f5]">
                      <span className="font-semibold">{harmony.key.label}</span>{' '}
                      <span className="text-[#8293a6] font-mono">
                        ({harmony.key.confidence}% · Parallele: {harmony.key.relativeLabel})
                      </span>
                    </div>
                  ) : harmony.isPercussionOnly ? (
                    <div className="text-xs text-[#8fc8e8]">Drums / Percussion</div>
                  ) : (
                    <div className="text-xs text-[#8b95a3]">
                      {harmony.keyUnknownReason || 'Tonart unbekannt'}
                    </div>
                  )}

                  {harmony.chords.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-1">
                      {harmony.chords.slice(0, 32).map((ch, idx) => (
                        <button
                          key={`${ch.startTick}-${ch.symbol}-${idx}`}
                          type="button"
                          onClick={() => {
                            if (parsed.totalTicks > 0 && parsed.totalDurationSec > 0) {
                              onSeek(tickToSeconds(parsed, ch.startTick));
                            }
                          }}
                          className="px-1.5 py-0.5 rounded bg-[#202832] hover:bg-[#2a3645] border border-[#303c4a] text-[11px] font-mono font-semibold text-[#cde7fb] transition-colors"
                          title={`Takt ${ch.startBar} · Zum Akkord springen`}
                        >
                          {ch.symbol}
                        </button>
                      ))}
                      {harmony.chords.length > 32 && (
                        <span className="text-[11px] font-mono text-[#7c8c9e] self-center">
                          +{harmony.chords.length - 32}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Spuren */}
              {parsed.tracks.length > 0 && (
                <div className="space-y-1.5 pt-2 border-t border-[#232a34]">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-[#728296]">
                      Spuren ({parsed.tracks.filter((t) => t.noteCount > 0).length} mit Noten)
                    </div>
                    {(mutedTracks.size > 0 || soloTracks.size > 0) && (
                      <button
                        type="button"
                        onClick={onClearTrackMuteSolo}
                        className="text-[10.5px] text-[#7cc4f0] hover:underline"
                      >
                        Alle an
                      </button>
                    )}
                  </div>
                  <div className="space-y-1">
                    {parsed.tracks
                      .filter((t) => t.noteCount > 0)
                      .map((tr) => {
                        const isMuted = mutedTracks.has(tr.index);
                        const isSolo = soloTracks.has(tr.index);
                        return (
                          <div
                            key={tr.index}
                            className="flex items-center justify-between gap-1.5 px-2 py-1 rounded bg-[#1c2128] border border-[#28303b]"
                          >
                            <span
                              className={`flex-1 min-w-0 truncate ${
                                isMuted ? 'text-[#6c7685] line-through' : 'text-[#d6e0ec]'
                              }`}
                              title={tr.name}
                            >
                              {tr.name}
                            </span>
                            <span className="font-mono text-[10.5px] text-[#8391a3] whitespace-nowrap shrink-0">
                              {tr.noteCount}N
                              {tr.channels.length > 0
                                ? ` · Ch ${tr.channels.map((c) => c + 1).join(',')}`
                                : ''}
                            </span>
                            <button
                              type="button"
                              onClick={() => onToggleTrackMute(tr.index)}
                              className={`w-5 h-5 rounded text-[9.5px] font-mono font-bold border transition-colors shrink-0 ${
                                isMuted
                                  ? 'bg-amber-500/25 border-amber-400/70 text-amber-200'
                                  : 'bg-[#151a20] border-[#2c3542] text-[#7a8696] hover:text-white'
                              }`}
                              title="Spur stummschalten (Mute)"
                            >
                              M
                            </button>
                            <button
                              type="button"
                              onClick={() => onToggleTrackSolo(tr.index)}
                              className={`w-5 h-5 rounded text-[9.5px] font-mono font-bold border transition-colors shrink-0 ${
                                isSolo
                                  ? 'bg-emerald-500/25 border-emerald-400/70 text-emerald-200'
                                  : 'bg-[#151a20] border-[#2c3542] text-[#7a8696] hover:text-white'
                              }`}
                              title="Nur diese Spur vorhören (Solo)"
                            >
                              S
                            </button>
                          </div>
                        );
                      })}
                  </div>
                </div>
              )}

              {/* Tempo & Taktart */}
              <div className="space-y-1.5 pt-2 border-t border-[#232a34]">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-[#728296]">
                  Tempo &amp; Taktart
                </div>
                <div className="space-y-1">
                  {!parsed.hasExplicitTempo ? (
                    <div className="px-2 py-1 rounded bg-[#242016] border border-amber-700/40 text-[11px] text-amber-200/90">
                      Kein Tempo-Tag im Header (120 BPM Standard)
                    </div>
                  ) : (
                    parsed.tempos.slice(0, 12).map((t, idx) => (
                      <button
                        key={`tempo-${t.tick}-${idx}`}
                        type="button"
                        onClick={() => onSeek(t.sec)}
                        className="w-full text-left flex items-center justify-between gap-2 px-2 py-1 rounded bg-[#1c2128] hover:bg-[#232a34] border border-[#28303b] transition-colors"
                      >
                        <span className="font-mono text-[#7cc4f0]">
                          T{formatTickBar(t.tick)} ({formatDuration(t.sec)})
                        </span>
                        <span className="font-mono font-semibold text-[#dce8f5]">
                          {Math.round(t.bpm * 10) / 10} BPM
                        </span>
                      </button>
                    ))
                  )}
                  {parsed.hasExplicitTimeSignature &&
                    parsed.timeSignatures.slice(0, 8).map((ts, idx) => (
                      <button
                        key={`ts-${ts.tick}-${idx}`}
                        type="button"
                        onClick={() => onSeek(ts.sec)}
                        className="w-full text-left flex items-center justify-between gap-2 px-2 py-1 rounded bg-[#1c2128] hover:bg-[#232a34] border border-[#28303b] transition-colors"
                      >
                        <span className="font-mono text-[#5fd4c2]">
                          Taktart · T{ts.bar}
                        </span>
                        <span className="font-mono font-semibold text-[#dce8f5]">
                          {ts.numerator}/{ts.denominator}
                        </span>
                      </button>
                    ))}
                </div>
              </div>

              {/* Kanäle & GM Programme */}
              {parsed.performance.channels.length > 0 && (
                <div className="space-y-1.5 pt-2 border-t border-[#232a34]">
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#728296]">
                    <Sliders className="w-3.5 h-3.5 text-[#5eb1e6]" />
                    Kanäle &amp; Programme
                  </div>
                  <div className="space-y-1">
                    {parsed.performance.channels.map((ch) => (
                      <div
                        key={ch.channel}
                        className="px-2 py-1 rounded bg-[#1c2128] border border-[#28303b] flex flex-wrap items-center gap-x-2 gap-y-0.5"
                      >
                        <span className="font-mono font-semibold text-[#cde7fb]">
                          Ch {ch.channel + 1}
                          {ch.isDrum ? ' (Drums)' : ''}
                        </span>
                        <span className="font-mono text-[11px] text-[#8b98a8]">
                          {ch.noteCount}N
                        </span>
                        {ch.programs.length > 0 && (
                          <span className="text-[11px] text-[#7be090]">
                            {ch.programs.map((p) => getGmProgramName(p)).join(', ')}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* CC / Pitch Bend / Aftertouch */}
              {(ccGroups.length > 0 ||
                parsed.performance.pitchBends.length > 0 ||
                parsed.performance.aftertouch.length > 0) && (
                <div className="space-y-1.5 pt-2 border-t border-[#232a34]">
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#728296]">
                    <Activity className="w-3.5 h-3.5 text-[#6fd17e]" />
                    Controller &amp; Expression
                  </div>
                  <div className="space-y-1">
                    {ccGroups.map((grp) => (
                      <button
                        key={grp.controller}
                        type="button"
                        onClick={() => onSeek(grp.firstSec)}
                        className="w-full text-left flex items-center justify-between gap-2 px-2 py-1 rounded bg-[#1c2128] hover:bg-[#232a34] border border-[#28303b]"
                      >
                        <span className="text-[#d6e2ee] truncate">
                          <span className="font-mono text-[#7cc4f0]">CC {grp.controller}</span> ·{' '}
                          {grp.label}
                        </span>
                        <span className="font-mono text-[10.5px] text-[#8d9cb0] shrink-0">
                          {grp.count}×
                        </span>
                      </button>
                    ))}
                    {parsed.performance.pitchBends.length > 0 && (
                      <button
                        type="button"
                        onClick={() => onSeek(parsed.performance.pitchBends[0].sec)}
                        className="w-full text-left flex items-center justify-between gap-2 px-2 py-1 rounded bg-[#1c2128] hover:bg-[#232a34] border border-[#28303b]"
                      >
                        <span className="text-[#f0cf85]">Pitch Bend</span>
                        <span className="font-mono text-[10.5px] text-[#8d9cb0]">
                          {parsed.performance.pitchBends.length}×
                        </span>
                      </button>
                    )}
                    {parsed.performance.aftertouch.length > 0 && (
                      <button
                        type="button"
                        onClick={() => onSeek(parsed.performance.aftertouch[0].sec)}
                        className="w-full text-left flex items-center justify-between gap-2 px-2 py-1 rounded bg-[#1c2128] hover:bg-[#232a34] border border-[#28303b]"
                      >
                        <span className="text-[#cfa4f5]">Aftertouch</span>
                        <span className="font-mono text-[10.5px] text-[#8d9cb0]">
                          {parsed.performance.aftertouch.length}×
                        </span>
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Marker, Text, Copyright */}
              {(parsed.metadata.markers.length > 0 ||
                parsed.metadata.copyright.length > 0 ||
                parsed.metadata.textEvents.length > 0) && (
                <div className="space-y-1.5 pt-2 border-t border-[#232a34]">
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#728296]">
                    <Bookmark className="w-3.5 h-3.5 text-[#e6b450]" />
                    Marker &amp; eingebettete Texte
                  </div>
                  {parsed.metadata.copyright.map((c, idx) => (
                    <div
                      key={`cp-${idx}`}
                      className="flex items-start gap-1.5 text-[11px] text-[#b9c6d6]"
                    >
                      <Copyright className="w-3.5 h-3.5 text-[#7ea8c9] shrink-0 mt-0.5" />
                      <span>{c}</span>
                    </div>
                  ))}
                  {[...parsed.metadata.markers, ...parsed.metadata.cues, ...parsed.metadata.textEvents]
                    .sort((a, b) => a.tick - b.tick)
                    .slice(0, 20)
                    .map((ev, idx) => (
                      <button
                        key={`${ev.type}-${ev.tick}-${idx}`}
                        type="button"
                        onClick={() => onSeek(ev.sec)}
                        className="w-full text-left flex items-baseline gap-2 px-2 py-1 rounded bg-[#1c2128] hover:bg-[#232a34] border border-[#28303b]"
                      >
                        <span className="font-mono text-[10.5px] text-[#7c8a9b] shrink-0">
                          T{formatTickBar(ev.tick)}
                        </span>
                        <span className="text-[#d6dfe9] truncate">{ev.text}</span>
                      </button>
                    ))}
                </div>
              )}

              {/* SHA-256 & Pfad */}
              <div className="space-y-1.5 pt-2 border-t border-[#232a34]">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-[#728296]">
                  Datei &amp; Integrität
                </div>
                <div className="text-[11px] font-mono text-[#8896a8] break-all">
                  {entry.relativePath}
                </div>
                {entry.sha256 && (
                  <div className="flex items-center gap-1.5">
                    <Hash className="w-3.5 h-3.5 text-[#7c8c9e] shrink-0" />
                    <code className="text-[10.5px] font-mono text-[#a8d8f5] truncate flex-1">
                      {entry.sha256}
                    </code>
                    <button
                      type="button"
                      onClick={() => copyText(entry.sha256!, 'sha')}
                      className="px-1.5 py-0.5 rounded bg-[#1f2630] hover:bg-[#2a3442] border border-[#313b4a] text-[10px] text-[#c7d5e5] shrink-0"
                    >
                      {copiedKey === 'sha' ? 'Kopiert' : 'Copy'}
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* TAB 3: PRÜFUNG & DUPLIKATE */}
      {activeTab === 'diagnostics' && (
        <div className="flex-1 overflow-y-auto p-3.5 space-y-4 text-xs">
          {/* Issues */}
          <div className="space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[#728296]">
              Qualitätsprüfung
            </div>

            {entry.parseError && (
              <div className="p-2.5 rounded bg-rose-950/40 border border-rose-800/50 text-rose-200 flex items-start gap-2">
                <XCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                <div>
                  <div className="font-semibold">Lesefehler</div>
                  <div className="text-[11px] opacity-85 mt-0.5">{entry.parseError}</div>
                </div>
              </div>
            )}

            {parsed && parsed.issues.length > 0 ? (
              <div className="space-y-1.5">
                {parsed.issues.map((issue) => (
                  <div
                    key={issue.code}
                    className={`p-2.5 rounded border flex items-start gap-2 ${
                      issue.severity === 'error'
                        ? 'bg-rose-950/35 border-rose-800/50 text-rose-200'
                        : 'bg-amber-950/30 border-amber-800/40 text-amber-200'
                    }`}
                  >
                    {issue.severity === 'error' ? (
                      <XCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                    ) : (
                      <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                    )}
                    <div>
                      <div className="font-semibold">{issue.label}</div>
                      <div className="text-[11px] opacity-85 mt-0.5">{issue.detail}</div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              !entry.parseError && (
                <div className="p-2.5 rounded bg-emerald-950/30 border border-emerald-800/40 text-emerald-200 flex items-center gap-2">
                  <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>Keine Strukturfehler oder Auffälligkeiten gefunden.</span>
                </div>
              )
            )}
          </div>

          {/* Duplicates & Variants */}
          <div className="space-y-2 pt-2 border-t border-[#232a34]">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[#728296]">
              Duplikate &amp; Varianten
            </div>

            {duplicateInfo && duplicateInfo.peers.length > 0 ? (
              <div className="space-y-2">
                <div
                  className={`p-2.5 rounded border text-xs ${
                    duplicateInfo.kind === 'byte_exact'
                      ? 'bg-amber-950/30 border-amber-700/50 text-amber-200'
                      : duplicateInfo.kind === 'note_exact'
                      ? 'bg-sky-950/30 border-sky-700/50 text-sky-200'
                      : 'bg-violet-950/30 border-violet-700/50 text-violet-200'
                  }`}
                >
                  <div className="font-semibold flex items-center gap-1.5">
                    <Copy className="w-3.5 h-3.5 shrink-0" />
                    Gruppe #{duplicateInfo.groupId} ·{' '}
                    {duplicateInfo.kind === 'byte_exact'
                      ? 'Byte-identisch (100%)'
                      : duplicateInfo.kind === 'note_exact'
                      ? 'Noten-identisch (100%)'
                      : `Variante (${duplicateInfo.similarity}%)`}
                  </div>
                </div>

                <div className="space-y-1">
                  {duplicateInfo.peers.map((peer) => (
                    <button
                      key={peer.id}
                      type="button"
                      onClick={() => onSelectEntry(peer.id)}
                      className="w-full text-left p-2 rounded bg-[#1c2128] hover:bg-[#242c36] border border-[#2a3340] transition-colors space-y-0.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-[#dce5f0] truncate">
                          {peer.name.replace(/\.(mid|midi)$/i, '')}
                        </span>
                        <span className="font-mono text-[10.5px] text-[#7cc4f0] shrink-0">
                          {peer.matchType === 'byte_exact'
                            ? 'SHA='
                            : peer.matchType === 'note_exact'
                            ? 'Noten='
                            : `${peer.similarity}%`}
                        </span>
                      </div>
                      <div className="text-[10.5px] text-[#7c8a9b] truncate">
                        {peer.relativePath}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="text-[#808c9d]">
                Keine Duplikate oder ähnlichen Varianten im aktuellen Ordner gefunden.
              </div>
            )}
          </div>

          {/* Direct Disk Move Action */}
          {canWriteToDisk && onImmediateMoveToSorted && (
            <div className="space-y-2 pt-2 border-t border-[#232a34]">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-[#728296]">
                Datei-Aktion
              </div>
              <button
                type="button"
                disabled={protectOriginals}
                onClick={() => onImmediateMoveToSorted(entry)}
                className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded text-xs font-medium bg-rose-700/80 hover:bg-rose-600 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
                title={
                  protectOriginals
                    ? 'Originalschutz aktiv – oben entsperren zum Verschieben'
                    : 'MIDI-Datei (inkl. .txt) sofort in _Aussortiert verschieben'
                }
              >
                {protectOriginals && <Lock className="w-3.5 h-3.5" />}
                Sofort in _Aussortiert verschieben
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
