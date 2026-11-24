import React, { useEffect, useState } from 'react';
import { Check, Copy, Download, FileText, RotateCcw, Save, X } from 'lucide-react';
import type { MidiFileEntry } from '../types/midi';
import type { LibraryAbbreviation } from '../utils/abbreviationProfile';
import { downloadTextFile } from '../utils/fileSystem';
import {
  buildTrainingTxtDraft,
  serializeTrainingTxt,
  type TrainingTxtDraft,
} from '../utils/trainingTxtGenerator';

interface TrainingTxtModalProps {
  isOpen: boolean;
  entry: MidiFileEntry | null;
  canWriteToDisk: boolean;
  abbreviations: LibraryAbbreviation[];
  onOpenAbbreviationProfile?: () => void;
  onClose: () => void;
  onSaveToDisk: (entry: MidiFileEntry, filename: string, content: string) => Promise<string>;
}

const splitCsv = (val: string): string[] =>
  val
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const splitLines = (val: string): string[] =>
  val
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

export const TrainingTxtModal: React.FC<TrainingTxtModalProps> = ({
  isOpen,
  entry,
  canWriteToDisk,
  abbreviations,
  onOpenAbbreviationProfile,
  onClose,
  onSaveToDisk,
}) => {
  const [draft, setDraft] = useState<TrainingTxtDraft | null>(null);
  const [rawText, setRawText] = useState<string>('');
  const [manualRawEdited, setManualRawEdited] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !entry) return;
    const initial = buildTrainingTxtDraft(entry, abbreviations);
    setDraft(initial);
    setRawText(serializeTrainingTxt(initial));
    setManualRawEdited(false);
    setCopied(false);
    setStatusMessage(null);
    setErrorMessage(null);
  }, [isOpen, entry, abbreviations]);

  if (!isOpen || !entry || !draft) return null;

  const updateDraft = (updater: (prev: TrainingTxtDraft) => TrainingTxtDraft) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = updater(prev);
      setRawText(serializeTrainingTxt(next));
      setManualRawEdited(false);
      return next;
    });
  };

  const targetFilename = `${(draft.titel || entry.name.replace(/\.(mid|midi)$/i, '')).trim()}.txt`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(rawText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setErrorMessage('Kopieren in die Zwischenablage nicht möglich.');
    }
  };

  const handleDownload = () => {
    downloadTextFile(targetFilename, rawText);
    setStatusMessage(`Datei „${targetFilename}“ heruntergeladen.`);
    setErrorMessage(null);
  };

  const handleSaveDisk = async () => {
    setSaving(true);
    setErrorMessage(null);
    try {
      const savedName = await onSaveToDisk(entry, targetFilename, rawText);
      setStatusMessage(`Gespeichert als „${savedName}“ direkt neben der MIDI-Datei.`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Speichern fehlgeschlagen.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="w-full max-w-4xl max-h-[90vh] flex flex-col rounded-lg bg-[#1c2026] border border-[#313844] shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[#181c21] border-b border-[#2b313a] flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <FileText className="w-4 h-4 text-[#5eb1e6] shrink-0" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-white truncate">
                Trainings-TXT erstellen — {entry.name}
              </h2>
              <p className="text-xs text-[#8892a0] truncate">
                Automatisch aus Tonart, Tempo, Taktart, Spuren, Abschnitten &amp; Akkorden vorbefüllt.
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

        {/* Body: Left quick form + Right live .txt preview */}
        <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-[#2b313a] overflow-hidden">
          {/* Left: Structured Training Fields */}
          <div className="p-4 overflow-y-auto space-y-3 text-xs">
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1 block">
                <span className="text-[#98a3b3] font-medium">Titel</span>
                <input
                  type="text"
                  value={draft.titel}
                  onChange={(e) =>
                    updateDraft((d) => ({ ...d, titel: e.target.value }))
                  }
                  className="w-full px-2.5 py-1.5 rounded bg-[#13171b] border border-[#2f3742] text-[#e6ecf4] focus:outline-none focus:border-[#4ea1d3]"
                />
              </label>

              <label className="space-y-1 block">
                <span className="text-[#98a3b3] font-medium">Status</span>
                <select
                  value={draft.status}
                  onChange={(e) =>
                    updateDraft((d) => ({ ...d, status: e.target.value }))
                  }
                  className="w-full px-2.5 py-1.5 rounded bg-[#13171b] border border-[#2f3742] text-[#e6ecf4] focus:outline-none focus:border-[#4ea1d3]"
                >
                  <option value="final">final</option>
                  <option value="skizze">skizze</option>
                  <option value="idee">idee</option>
                  <option value="wip">wip</option>
                  <option value="unvollständig">unvollständig</option>
                </select>
              </label>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1 block">
                <span className="text-[#98a3b3] font-medium">Hauptstil</span>
                <input
                  type="text"
                  value={draft.hauptstil}
                  onChange={(e) =>
                    updateDraft((d) => ({ ...d, hauptstil: e.target.value }))
                  }
                  placeholder="z. B. orchestral, piano, electronic"
                  className="w-full px-2.5 py-1.5 rounded bg-[#13171b] border border-[#2f3742] text-[#e6ecf4] focus:outline-none focus:border-[#4ea1d3]"
                />
              </label>

              <label className="space-y-1 block">
                <span className="text-[#98a3b3] font-medium">
                  Meine Bewertung ({draft.meineBewertung}/10)
                </span>
                <input
                  type="range"
                  min={1}
                  max={10}
                  value={draft.meineBewertung}
                  onChange={(e) =>
                    updateDraft((d) => ({
                      ...d,
                      meineBewertung: Number(e.target.value),
                    }))
                  }
                  className="w-full accent-[#5eb1e6] mt-2 cursor-pointer"
                />
              </label>
            </div>

            <label className="space-y-1 block">
              <span className="text-[#98a3b3] font-medium">
                Substil (kommagetrennt)
              </span>
              <input
                type="text"
                value={draft.substil.join(', ')}
                onChange={(e) =>
                  updateDraft((d) => ({ ...d, substil: splitCsv(e.target.value) }))
                }
                placeholder="cinematic, dark, trailer"
                className="w-full px-2.5 py-1.5 rounded bg-[#13171b] border border-[#2f3742] text-[#e6ecf4] focus:outline-none focus:border-[#4ea1d3]"
              />
            </label>

            <label className="space-y-1 block">
              <span className="text-[#98a3b3] font-medium">
                Stimmung (kommagetrennt)
              </span>
              <input
                type="text"
                value={draft.stimmung.join(', ')}
                onChange={(e) =>
                  updateDraft((d) => ({ ...d, stimmung: splitCsv(e.target.value) }))
                }
                placeholder="düster, dramatisch, traurig"
                className="w-full px-2.5 py-1.5 rounded bg-[#13171b] border border-[#2f3742] text-[#e6ecf4] focus:outline-none focus:border-[#4ea1d3]"
              />
            </label>

            <label className="space-y-1 block">
              <span className="text-[#98a3b3] font-medium">
                Warum ich das Projekt mag (eine Zeile pro Punkt)
              </span>
              <textarea
                rows={2}
                value={draft.warumMagIch.join('\n')}
                onChange={(e) =>
                  updateDraft((d) => ({
                    ...d,
                    warumMagIch: splitLines(e.target.value),
                  }))
                }
                className="w-full px-2.5 py-1.5 rounded bg-[#13171b] border border-[#2f3742] text-[#e6ecf4] focus:outline-none focus:border-[#4ea1d3] resize-none"
              />
            </label>

            <label className="space-y-1 block">
              <span className="text-[#98a3b3] font-medium">
                Besondere Merkmale (eine Zeile pro Punkt)
              </span>
              <textarea
                rows={3}
                value={draft.besondereMerkmale.join('\n')}
                onChange={(e) =>
                  updateDraft((d) => ({
                    ...d,
                    besondereMerkmale: splitLines(e.target.value),
                  }))
                }
                className="w-full px-2.5 py-1.5 rounded bg-[#13171b] border border-[#2f3742] text-[#e6ecf4] focus:outline-none focus:border-[#4ea1d3] resize-none"
              />
            </label>

            <div className="pt-1 flex items-center justify-between gap-2 text-[11px] text-[#7c8796]">
              <span>
                Spuren, Abschnitte, Tonart ({draft.grundton} {draft.modus}), Taktart ({draft.taktart}) und BPM ({draft.tempoBpm}) wurden automatisch ermittelt.
              </span>
              {onOpenAbbreviationProfile && (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onOpenAbbreviationProfile();
                  }}
                  className="text-[#7cc4f0] hover:underline whitespace-nowrap shrink-0"
                >
                  Kürzel-Profil
                </button>
              )}
            </div>
          </div>

          {/* Right: Live Editable .txt Output */}
          <div className="p-4 flex flex-col min-h-[320px] bg-[#14181d]">
            <div className="flex items-center justify-between gap-2 mb-2 shrink-0">
              <span className="text-xs font-mono text-[#90a1b5]">
                {targetFilename}
              </span>
              {manualRawEdited && (
                <button
                  type="button"
                  onClick={() => {
                    setRawText(serializeTrainingTxt(draft));
                    setManualRawEdited(false);
                  }}
                  className="inline-flex items-center gap-1 text-[11px] text-[#7cc4f0] hover:underline"
                >
                  <RotateCcw className="w-3 h-3" />
                  Aus Feldern zurücksetzen
                </button>
              )}
            </div>
            <textarea
              value={rawText}
              onChange={(e) => {
                setRawText(e.target.value);
                setManualRawEdited(true);
              }}
              spellCheck={false}
              className="flex-1 w-full p-3 rounded bg-[#0f1216] border border-[#28303b] text-xs font-mono leading-relaxed text-[#d7e2ee] focus:outline-none focus:border-[#4ea1d3] resize-none"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 bg-[#181c21] border-t border-[#2b313a] flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="text-xs min-h-[16px]">
            {errorMessage && <span className="text-rose-400">{errorMessage}</span>}
            {!errorMessage && statusMessage && (
              <span className="text-emerald-400">{statusMessage}</span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-[#252b34] hover:bg-[#303844] border border-[#363f4d] text-[#dce3ec] transition-colors whitespace-nowrap"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  Kopiert
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  Kopieren
                </>
              )}
            </button>

            <button
              type="button"
              onClick={handleDownload}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-[#2a3846] hover:bg-[#344658] border border-[#4ea1d3]/60 text-[#dcebf7] transition-colors whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              Herunterladen (.txt)
            </button>

            {canWriteToDisk && (
              <button
                type="button"
                disabled={saving}
                onClick={handleSaveDisk}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded text-xs font-medium bg-[#3675a3] hover:bg-[#4187ba] disabled:opacity-40 text-white transition-colors whitespace-nowrap"
              >
                <Save className="w-3.5 h-3.5" />
                {saving ? 'Speichere...' : 'Im Ordner speichern (.txt)'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
