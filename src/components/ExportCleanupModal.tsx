import React, { useState } from 'react';
import { CheckCircle2, Copy, Download, FolderInput, Trash2, X } from 'lucide-react';
import type { MidiFileEntry } from '../types/midi';
import { buildCleanupScript } from '../utils/fileSystem';

interface ExportCleanupModalProps {
  isOpen: boolean;
  onClose: () => void;
  discardedEntries: MidiFileEntry[];
  folderName: string;
  canWriteToDisk: boolean;
  onExecuteDiskMove: () => Promise<void>;
  onExecuteDiskDelete: () => Promise<void>;
}

export const ExportCleanupModal: React.FC<ExportCleanupModalProps> = ({
  isOpen,
  onClose,
  discardedEntries,
  folderName,
  canWriteToDisk,
  onExecuteDiskMove,
  onExecuteDiskDelete,
}) => {
  const [scriptAction, setScriptAction] = useState<'move' | 'delete'>('move');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [resultMessage, setResultMessage] = useState<string | null>(null);

  if (!isOpen) return null;

  const downloadScript = (format: 'bat' | 'ps1' | 'sh' | 'txt') => {
    const content = buildCleanupScript(discardedEntries, format, scriptAction);
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const prefix = scriptAction === 'move' ? 'midi_aussortieren' : 'midi_loeschen';
    a.download = format === 'txt' ? 'aussortierte_midis.txt' : `${prefix}.${format}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const copyPaths = async () => {
    const text = discardedEntries.map((e) => e.relativePath).join('\n');
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const handleDiskMove = async () => {
    setBusy(true);
    setResultMessage(null);
    try {
      await onExecuteDiskMove();
      setResultMessage(
        `${discardedEntries.length} Datei(en) wurden in „_Aussortiert“ verschoben.`
      );
    } finally {
      setBusy(false);
    }
  };

  const handleDiskDelete = async () => {
    if (!confirmDelete) return;
    setBusy(true);
    setResultMessage(null);
    try {
      await onExecuteDiskDelete();
      setResultMessage(`${discardedEntries.length} Datei(en) wurden endgültig gelöscht.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-lg bg-[#1e2228] border border-[#323944] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3.5 border-b border-[#2d333d] flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-white">
              Aussortierte MIDI-Dateien bereinigen ({discardedEntries.length})
            </h3>
            <p className="text-xs text-[#8d96a4] mt-0.5">Ordner: {folderName}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded text-[#8d96a4] hover:text-white hover:bg-[#2a303a] transition-colors"
            aria-label="Schließen"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-5 max-h-[75vh] overflow-y-auto">
          {resultMessage && (
            <div className="px-3.5 py-2.5 rounded bg-emerald-950/50 border border-emerald-700/50 text-xs text-emerald-200 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>{resultMessage}</span>
            </div>
          )}

          {/* File list preview */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-[#b5bec9]">
                Markierte Dateien ({discardedEntries.length})
              </span>
              <button
                type="button"
                onClick={copyPaths}
                className="inline-flex items-center gap-1.5 text-xs text-[#7ab8e0] hover:text-white transition-colors"
              >
                <Copy className="w-3.5 h-3.5" />
                {copied ? 'Kopiert!' : 'Pfade kopieren'}
              </button>
            </div>
            <div className="max-h-36 overflow-y-auto rounded bg-[#16191d] border border-[#2a3039] p-2 space-y-1 font-mono text-xs text-[#a5aeb9]">
              {discardedEntries.map((e) => (
                <div key={e.id} className="truncate">
                  {e.relativePath}
                </div>
              ))}
            </div>
          </div>

          {canWriteToDisk ? (
            <div className="space-y-3 pt-1 border-t border-[#2d333d]">
              <p className="text-xs text-[#9ca5b2]">
                Direkte Ordner-Berechtigung aktiv — du kannst die Dateien direkt auf deiner
                Festplatte verschieben oder löschen:
              </p>
              <div className="flex flex-wrap gap-2.5">
                <button
                  type="button"
                  disabled={busy || discardedEntries.length === 0}
                  onClick={handleDiskMove}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded bg-[#3675a3] hover:bg-[#4187ba] disabled:opacity-40 text-xs font-medium text-white transition-colors"
                >
                  <FolderInput className="w-4 h-4" />
                  In „_Aussortiert“ verschieben (Sicher)
                </button>
              </div>

              <div className="pt-2 border-t border-[#282d36] space-y-2">
                <label className="flex items-center gap-2 text-xs text-[#c5ccd6] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={confirmDelete}
                    onChange={(e) => setConfirmDelete(e.target.checked)}
                    className="rounded border-[#434c59] bg-[#16191d] accent-rose-500"
                  />
                  Ja, markierte Dateien endgültig ohne Papierkorb löschen
                </label>
                <button
                  type="button"
                  disabled={busy || !confirmDelete || discardedEntries.length === 0}
                  onClick={handleDiskDelete}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded bg-rose-700 hover:bg-rose-600 disabled:opacity-40 text-xs font-medium text-white transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                  Endgültig löschen
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3 pt-1 border-t border-[#2d333d]">
              <p className="text-xs text-[#9ca5b2] leading-relaxed">
                Aus Sicherheitsgründen erlaubt der Browser im Sandbox-Modus kein direktes Löschen
                auf der Festplatte. Lade hier ein fertiges Bereinigungs-Skript herunter, lege es in
                deinen Ordner <span className="text-[#dce2ea] font-mono">{folderName}</span> und
                starte es per Doppelklick:
              </p>

              <div className="flex items-center gap-2 p-1 rounded bg-[#16191d] border border-[#2a3039] w-fit">
                <button
                  type="button"
                  onClick={() => setScriptAction('move')}
                  className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                    scriptAction === 'move'
                      ? 'bg-[#2a313c] text-white'
                      : 'text-[#8e97a4] hover:text-white'
                  }`}
                >
                  In „_Aussortiert“ verschieben
                </button>
                <button
                  type="button"
                  onClick={() => setScriptAction('delete')}
                  className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                    scriptAction === 'delete'
                      ? 'bg-rose-900/50 text-rose-200'
                      : 'text-[#8e97a4] hover:text-white'
                  }`}
                >
                  Direkt löschen
                </button>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => downloadScript('bat')}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded bg-[#3675a3] hover:bg-[#4187ba] text-xs font-medium text-white transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  Windows (.bat)
                </button>
                <button
                  type="button"
                  onClick={() => downloadScript('ps1')}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded bg-[#272d36] hover:bg-[#323a46] border border-[#3a424f] text-xs font-medium text-[#dce2ea] transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  PowerShell (.ps1)
                </button>
                <button
                  type="button"
                  onClick={() => downloadScript('sh')}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded bg-[#272d36] hover:bg-[#323a46] border border-[#3a424f] text-xs font-medium text-[#dce2ea] transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  macOS / Linux (.sh)
                </button>
                <button
                  type="button"
                  onClick={() => downloadScript('txt')}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded bg-[#272d36] hover:bg-[#323a46] border border-[#3a424f] text-xs font-medium text-[#dce2ea] transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  Dateiliste (.txt)
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
