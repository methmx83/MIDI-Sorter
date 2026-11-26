import React, { useEffect, useRef } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  FileText,
  Pencil,
  Scissors,
  Trash2,
  XCircle,
} from 'lucide-react';
import type { MidiFileEntry, TriageStatus } from '../types/midi';
import type { DuplicateMatchInfo } from '../utils/midiDuplicates';
import { formatDuration } from '../utils/midiParser';

export type SortMode =
  | 'name'
  | 'name_desc'
  | 'key_asc'
  | 'key_desc'
  | 'notes_asc'
  | 'notes_desc'
  | 'duration_asc'
  | 'issues_first'
  | 'duplicates_first';

interface FileListPaneProps {
  entries: MidiFileEntry[];
  selectedId: string | null;
  hoverPreview: boolean;
  sortMode: SortMode;
  duplicateMap?: Map<string, DuplicateMatchInfo>;
  onChangeSort: (mode: SortMode) => void;
  onSelect: (id: string) => void;
  onQuickTriage: (id: string, status: TriageStatus) => void;
  onRequestRename: (id: string) => void;
}

const MidiFileIcon: React.FC<{ dimmed?: boolean }> = ({ dimmed }) => (
  <svg
    viewBox="0 0 16 16"
    className={`w-4 h-4 shrink-0 ${dimmed ? 'opacity-45' : ''}`}
    aria-hidden="true"
  >
    <rect x="1" y="2" width="14" height="12" rx="1.5" fill="#2d6ea3" />
    <rect x="3" y="4.5" width="4" height="1.6" rx="0.4" fill="#9bd3ff" />
    <rect x="6.5" y="7.2" width="5" height="1.6" rx="0.4" fill="#cce9ff" />
    <rect x="9" y="9.9" width="4" height="1.6" rx="0.4" fill="#9bd3ff" />
  </svg>
);

export const FileListPane: React.FC<FileListPaneProps> = ({
  entries,
  selectedId,
  hoverPreview,
  sortMode,
  duplicateMap,
  onChangeSort,
  onSelect,
  onQuickTriage,
  onRequestRename,
}) => {
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  useEffect(() => {
    if (!selectedId) return;
    const el = rowRefs.current.get(selectedId);
    if (el) {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedId]);

  const toggleNameSort = () => {
    onChangeSort(sortMode === 'name' ? 'name_desc' : 'name');
  };

  const toggleKeySort = () => {
    onChangeSort(sortMode === 'key_asc' ? 'key_desc' : 'key_asc');
  };

  const toggleNotesSort = () => {
    onChangeSort(sortMode === 'notes_desc' ? 'notes_asc' : 'notes_desc');
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[#22252a]">
      {/* Column Header Bar */}
      <div className="flex items-center gap-2 px-3 h-7 bg-[#1b1e23] border-b border-[#2b313a] text-[11px] font-medium text-[#7e8794] select-none shrink-0">
        <button
          type="button"
          onClick={toggleNameSort}
          className={`flex-1 min-w-0 flex items-center gap-1 text-left transition-colors ${
            sortMode === 'name' || sortMode === 'name_desc'
              ? 'text-[#d2dce8]'
              : 'hover:text-[#cfd5de]'
          }`}
          title="Nach Dateiname sortieren"
        >
          <span className="truncate">Datei</span>
          {sortMode === 'name' && <ArrowUp className="w-3 h-3 text-[#5eb1e6] shrink-0" />}
          {sortMode === 'name_desc' && <ArrowDown className="w-3 h-3 text-[#5eb1e6] shrink-0" />}
        </button>

        <button
          type="button"
          onClick={toggleKeySort}
          className={`w-[72px] shrink-0 flex items-center gap-1 text-left transition-colors ${
            sortMode === 'key_asc' || sortMode === 'key_desc'
              ? 'text-[#d2dce8]'
              : 'hover:text-[#cfd5de]'
          }`}
          title="Nach erkannter Tonart sortieren"
        >
          <span>Tonart</span>
          {sortMode === 'key_asc' && <ArrowUp className="w-3 h-3 text-[#5eb1e6] shrink-0" />}
          {sortMode === 'key_desc' && <ArrowDown className="w-3 h-3 text-[#5eb1e6] shrink-0" />}
        </button>

        <button
          type="button"
          onClick={toggleNotesSort}
          className={`w-[76px] shrink-0 flex items-center justify-end gap-1 text-right transition-colors ${
            sortMode === 'notes_asc' || sortMode === 'notes_desc' || sortMode === 'duration_asc'
              ? 'text-[#d2dce8]'
              : 'hover:text-[#cfd5de]'
          }`}
          title="Nach Notenanzahl sortieren"
        >
          {sortMode === 'notes_asc' && <ArrowUp className="w-3 h-3 text-[#5eb1e6] shrink-0" />}
          {(sortMode === 'notes_desc' || sortMode === 'duration_asc') && (
            <ArrowDown className="w-3 h-3 text-[#5eb1e6] shrink-0" />
          )}
          <span>Noten · Zeit</span>
        </button>
      </div>

      {entries.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-6 text-center text-sm text-[#7f8894]">
          Keine passenden MIDI-Dateien für den aktuellen Filter gefunden.
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto overflow-x-hidden select-none py-1">
          {entries.map((item) => {
            const isSelected = item.id === selectedId;
            const parsed = item.parsed;
            const isDiscard = item.triage === 'discard';
            const isKeep = item.triage === 'keep';
            const dup = duplicateMap?.get(item.id);

            return (
              <div
                key={item.id}
                ref={(node) => {
                  if (node) rowRefs.current.set(item.id, node);
                  else rowRefs.current.delete(item.id);
                }}
                role="option"
                aria-selected={isSelected}
                onClick={() => onSelect(item.id)}
                onMouseEnter={() => {
                  if (hoverPreview) onSelect(item.id);
                }}
                className={`group flex items-center gap-2 px-3 h-8 cursor-pointer text-[13px] transition-colors duration-75 ${
                  isSelected
                    ? 'bg-[#363c46] text-white'
                    : 'text-[#cfd4dc] hover:bg-[#2b3038]'
                }`}
              >
                {/* Column 1: MIDI icon + filename + status/hover actions */}
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <MidiFileIcon dimmed={isDiscard} />
                  <span
                    className={`truncate ${
                      isDiscard ? 'line-through text-[#7c838e]' : ''
                    }`}
                    title={item.relativePath}
                  >
                    {item.name.replace(/\.(mid|midi)$/i, '')}
                  </span>
                  {item.folderPath && (
                    <span className="hidden xl:inline text-[11px] text-[#6d7582] truncate max-w-[96px]">
                      {item.folderPath}
                    </span>
                  )}

                  {/* Status icons & quick hover actions anchored to trailing edge of Column 1 */}
                  <div className="ml-auto flex items-center gap-1.5 shrink-0 pl-1">
                    {dup && (() => {
                      const badgeCls =
                        dup.kind === 'byte_exact'
                          ? 'text-amber-300'
                          : dup.kind === 'note_exact'
                          ? 'text-sky-300'
                          : 'text-violet-300';
                      const badgePrefix =
                        dup.kind === 'byte_exact'
                          ? 'SHA'
                          : dup.kind === 'note_exact'
                          ? '≡'
                          : '~';
                      const badgeTitle =
                        dup.kind === 'byte_exact'
                          ? `Byte-identisches Duplikat (SHA-256 identisch · Gruppe #${dup.groupId}, ${dup.peers.length + 1} Dateien)`
                          : dup.kind === 'note_exact'
                          ? `Noten-identisches Duplikat (gleiche Noten, anderer Header/Vorlauf · Gruppe #${dup.groupId}, ${dup.peers.length + 1} Dateien)`
                          : `Musikalische Variante (${dup.similarity}% Ähnlichkeit · Gruppe #${dup.groupId}, ${dup.peers.length + 1} Dateien)`;

                      return (
                        <span
                          className={`inline-flex items-center gap-0.5 text-[10px] font-mono tabular-nums ${badgeCls}`}
                          title={badgeTitle}
                        >
                          <Copy className="w-2.5 h-2.5" />
                          {badgePrefix}#{dup.groupId}
                        </span>
                      );
                    })()}
                    {parsed && parsed.metadata.totalCount > 0 && (() => {
                      const md = parsed.metadata;
                      const hints: string[] = [];
                      if (md.copyright.length > 0) hints.push(`Copyright: ${md.copyright[0]}`);
                      if (md.markers.length > 0) {
                        hints.push(
                          `Marker: ${md.markers
                            .slice(0, 3)
                            .map((m) => m.text)
                            .join(', ')}${md.markers.length > 3 ? '…' : ''}`
                        );
                      }
                      if (md.textEvents.length > 0) hints.push(`Text: ${md.textEvents[0].text}`);
                      if (md.instruments.length > 0) hints.push(`Instrument: ${md.instruments[0]}`);
                      return (
                        <span title={hints.join('\n') || `${md.totalCount} MIDI-Metadaten`}>
                          <FileText className="w-3 h-3 text-[#7ea8c9]" />
                        </span>
                      );
                    })()}
                    {item.isTrimmed && (
                      <span title="Gekürzt (Trim)">
                        <Scissors className="w-3 h-3 text-[#5eb1e6]" />
                      </span>
                    )}
                    {parsed?.hasErrors && (
                      <span title={parsed.issues[0]?.label || 'Fehlerhaft'}>
                        <XCircle className="w-3.5 h-3.5 text-rose-400" />
                      </span>
                    )}
                    {!parsed?.hasErrors && parsed?.hasWarnings && (
                      <span title={parsed.issues[0]?.label || 'Auffällig'}>
                        <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                      </span>
                    )}

                    {/* Quick hover Rename / Keep / Discard buttons */}
                    <div className="hidden group-hover:flex items-center gap-0.5">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelect(item.id);
                          onRequestRename(item.id);
                        }}
                        className="p-1 rounded text-[#8b94a1] hover:text-[#7cc4f0] hover:bg-[#3a414c] transition-colors"
                        title="Umbenennen (F2)"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onQuickTriage(item.id, isKeep ? 'pending' : 'keep');
                        }}
                        className={`p-1 rounded transition-colors ${
                          isKeep
                            ? 'text-emerald-300 bg-emerald-500/20'
                            : 'text-[#8b94a1] hover:text-emerald-300 hover:bg-[#3a414c]'
                        }`}
                        title="Behalten"
                      >
                        <Check className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onQuickTriage(item.id, isDiscard ? 'pending' : 'discard');
                        }}
                        className={`p-1 rounded transition-colors ${
                          isDiscard
                            ? 'text-rose-300 bg-rose-500/20'
                            : 'text-[#8b94a1] hover:text-rose-300 hover:bg-[#3a414c]'
                        }`}
                        title="Aussortieren"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>

                    {/* Persistent triage status icon when not hovering */}
                    {(isKeep || isDiscard) && (
                      <div className="flex group-hover:hidden items-center w-4 justify-center">
                        {isKeep && <Check className="w-3.5 h-3.5 text-emerald-400" />}
                        {isDiscard && <Trash2 className="w-3.5 h-3.5 text-rose-400" />}
                      </div>
                    )}
                  </div>
                </div>

                {/* Column 2: Detected Musical Key */}
                <div className="w-[72px] shrink-0 text-[11px] font-mono tabular-nums truncate">
                  {parsed?.detectedKey ? (
                    <span
                      className={isSelected ? 'text-[#bce2ff] font-medium' : 'text-[#8ec5eb]'}
                      title={`Tonart: ${parsed.detectedKey.label} (${parsed.detectedKey.confidence}% · Parallele: ${parsed.detectedKey.relativeLabel})`}
                    >
                      {parsed.detectedKey.label}
                    </span>
                  ) : parsed?.isPercussionOnly ? (
                    <span
                      className="text-[#789cb5]"
                      title="Schlagzeug / Percussion (Kanal 10)"
                    >
                      Drums
                    </span>
                  ) : parsed?.keyStatus === 'unknown' ? (
                    <span
                      className="text-[#6f7987]"
                      title={parsed.keyUnknownReason || 'Tonart unbekannt'}
                    >
                      Unbekannt
                    </span>
                  ) : (
                    <span className="text-[#565f6b]">—</span>
                  )}
                </div>

                {/* Column 3: Compact tabular note count & duration */}
                <div
                  className="w-[76px] shrink-0 text-[11px] font-mono tabular-nums text-[#7e8794] text-right"
                  title={
                    parsed
                      ? [
                          parsed.hasExplicitTempo
                            ? parsed.hasTempoChanges
                              ? `Tempowechsel (${parsed.tempos.length}×)`
                              : `${parsed.primaryBpm} BPM`
                            : 'Keine Tempoangabe (0x51)',
                          parsed.hasTimeSignatureChanges
                            ? `Taktwechsel (${parsed.timeSignatures.length}×)`
                            : parsed.hasExplicitTimeSignature
                            ? parsed.primaryTimeSignature
                            : `${parsed.primaryTimeSignature} (Std.)`,
                          parsed.isCompleteComposition ? 'Vollständige Komposition' : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')
                      : undefined
                  }
                >
                  {parsed
                    ? `${parsed.notes.length}N · ${formatDuration(parsed.totalDurationSec)}`
                    : '—'}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

