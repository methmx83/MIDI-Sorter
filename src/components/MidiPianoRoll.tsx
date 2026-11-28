import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Cable,
  Check,
  Copy,
  Download,
  Gauge,
  Lock,
  Maximize2,
  Minus,
  Music,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Scissors,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
  Wand2,
  X,
  XCircle,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { MidiFileEntry, MidiNote, TriageStatus } from '../types/midi';
import type { DuplicateMatchInfo } from '../utils/midiDuplicates';
import { formatDuration, midiPitchToName } from '../utils/midiParser';
import type { MidiChannelRouting, MidiPlaybackState } from '../utils/midiPlayer';
import {
  buildBarGrid,
  nearestBarSnapTick,
  secondsToTick,
  tickToBarFraction,
  tickToBarNumber,
  tickToSeconds,
} from '../utils/midiTimeline';
import {
  computeBarEndTick,
  computeBarStartTick,
  type SmartTrimSuggestion,
} from '../utils/midiTrimmer';
import { analyzeMidiHarmony } from '../utils/musicTheory';

interface MidiPianoRollProps {
  entry: MidiFileEntry | null;
  playback: MidiPlaybackState;
  autoPlay: boolean;
  onToggleAutoPlay: () => void;
  onPlayPause: () => void;
  onSeek: (sec: number) => void;
  onVolumeChange: (vol: number) => void;
  onTempoChange: (bpm: number | null) => void;
  onSelectMidiOutput: (outputId: string | null) => void;
  onRefreshMidiOutputs: () => void;
  onChangeMidiChannelRouting: (routing: MidiChannelRouting) => void;
  onMidiPanic: () => void;
  onLoadSoundFont: (file: File) => void;
  onUnloadSoundFont: () => void;
  onSelectSoundFontSource: (sourceId: string) => void;
  onRefreshSoundFontLibrary: () => void;
  onSelectSf2Preset: (presetId: string | null) => void;
  onToggleReverb: () => void;
  onTriage: (status: TriageStatus) => void;
  canWriteToDisk: boolean;
  protectOriginals: boolean;
  onToggleProtectOriginals?: () => void;
  onTrimMidi: (
    entry: MidiFileEntry,
    trimStartTick: number,
    trimEndTick: number | null
  ) => Promise<void>;
  onRestoreOriginalMidi: (entry: MidiFileEntry) => Promise<void>;
  onSaveTrimmedCopy: (entry: MidiFileEntry) => Promise<string | void>;
  onOverwriteOriginal: (entry: MidiFileEntry) => Promise<void>;
  onDownloadTrimmed: (entry: MidiFileEntry) => void;
  renameTrigger: number;
  onRenameMidi: (entry: MidiFileEntry, newFilename: string) => Promise<void>;
  onAnalyzeSmartTrim: (entry: MidiFileEntry) => Promise<SmartTrimSuggestion | null>;
  duplicateInfo?: DuplicateMatchInfo | null;
  onOpenInspectorTab?: (tab: 'metadata' | 'tracks' | 'details' | 'diagnostics') => void;
}

const TRACK_COLORS = [
  '#6fd17e', // DAW Mint Green (default primary)
  '#5bb6e5', // Sky Blue
  '#e6b450', // Warm Amber
  '#c685e8', // Soft Violet
  '#ec7878', // Coral Red
  '#5fd4c2', // Teal
  '#e89b5e', // Peach
  '#a5d66b', // Lime
];

const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);

export const MidiPianoRoll: React.FC<MidiPianoRollProps> = ({
  entry,
  playback,
  autoPlay,
  onToggleAutoPlay,
  onPlayPause,
  onSeek,
  onVolumeChange,
  onTempoChange,
  onSelectMidiOutput,
  onRefreshMidiOutputs,
  onChangeMidiChannelRouting,
  onMidiPanic,
  onLoadSoundFont,
  onUnloadSoundFont,
  onSelectSoundFontSource,
  onRefreshSoundFontLibrary,
  onSelectSf2Preset,
  onToggleReverb,
  onTriage,
  canWriteToDisk,
  protectOriginals,
  onToggleProtectOriginals,
  onTrimMidi,
  onRestoreOriginalMidi,
  onSaveTrimmedCopy,
  onOverwriteOriginal,
  onDownloadTrimmed,
  renameTrigger,
  onRenameMidi,
  onAnalyzeSmartTrim,
  duplicateInfo,
  onOpenInspectorTab,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const sf2InputRef = useRef<HTMLInputElement | null>(null);
  const [size, setSize] = useState({ width: 800, height: 500 });
  const [zoomX, setZoomX] = useState<number>(1);
  const [scrollX, setScrollX] = useState<number>(0);
  const [fullPitchRange, setFullPitchRange] = useState<boolean>(false);
  const [colorByTrack, setColorByTrack] = useState<boolean>(false);
  const [showVelocity, setShowVelocity] = useState<boolean>(true);
  const [showChords, setShowChords] = useState<boolean>(true);
  const showMetadata = true;
  const [volume, setVolume] = useState<number>(0.75);
  const [isEditingBpm, setIsEditingBpm] = useState<boolean>(false);
  const [bpmDraft, setBpmDraft] = useState<string>('');
  const [confirmOverwrite, setConfirmOverwrite] = useState<boolean>(false);
  const [hoveredNote, setHoveredNote] = useState<{
    note: MidiNote;
    x: number;
    y: number;
  } | null>(null);

  // Interactive Trim state
  const [trimMode, setTrimMode] = useState<boolean>(false);
  const [trimStartTick, setTrimStartTick] = useState<number>(0);
  const [trimEndTick, setTrimEndTick] = useState<number | null>(null);
  const [snapToBars, setSnapToBars] = useState<boolean>(false);
  const [draggingHandle, setDraggingHandle] = useState<'start' | 'end' | null>(null);
  const [hoverHandle, setHoverHandle] = useState<'start' | 'end' | null>(null);
  const [trimBusy, setTrimBusy] = useState<boolean>(false);
  const [trimNotice, setTrimNotice] = useState<string | null>(null);
  const [smartSuggestion, setSmartSuggestion] = useState<SmartTrimSuggestion | null>(null);
  const [allowSmartTrimComplete, setAllowSmartTrimComplete] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('midi_sorter_allow_smart_trim_complete_v1') === 'true';
    } catch {
      return false;
    }
  });
  const suppressNextClickRef = useRef<boolean>(false);

  const toggleAllowSmartTrimComplete = (next: boolean) => {
    setAllowSmartTrimComplete(next);
    try {
      window.localStorage.setItem('midi_sorter_allow_smart_trim_complete_v1', String(next));
    } catch {
      // ignore storage errors
    }
  };

  // Inline Rename state
  const [isRenaming, setIsRenaming] = useState<boolean>(false);
  const [renameBase, setRenameBase] = useState<string>('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState<boolean>(false);

  const splitExtension = (name: string): { base: string; ext: string } => {
    const match = name.match(/^(.*?)(\.(?:mid|midi))$/i);
    if (match) return { base: match[1], ext: match[2] };
    return { base: name, ext: '.mid' };
  };

  const openRenameMode = () => {
    if (!entry) return;
    const { base } = splitExtension(entry.name);
    setRenameBase(base);
    setRenameError(null);
    setIsRenaming(true);
    window.setTimeout(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }, 0);
  };

  useEffect(() => {
    if (renameTrigger > 0 && entry) {
      openRenameMode();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renameTrigger]);

  // Reset zoom/scroll/trim/rename UI when switching files
  useEffect(() => {
    setZoomX(1);
    setScrollX(0);
    setHoveredNote(null);
    setTrimMode(false);
    setDraggingHandle(null);
    setHoverHandle(null);
    setTrimNotice(null);
    setSmartSuggestion(null);
    setIsRenaming(false);
    setRenameError(null);
    setIsEditingBpm(false);
    setConfirmOverwrite(false);
  }, [entry?.id]);

  useEffect(() => {
    setConfirmOverwrite(false);
  }, [entry?.isTrimmed, protectOriginals]);

  const runSmartTrimSilence = async () => {
    if (!entry || !parsed) return;
    setTrimBusy(true);
    try {
      const suggestion = await onAnalyzeSmartTrim(entry);
      if (!suggestion) return;
      setTrimMode(true);
      setTrimStartTick(suggestion.trimStartTick);
      setTrimEndTick(suggestion.trimEndTick ?? parsed.totalTicks);
      setSmartSuggestion(suggestion);
    } finally {
      setTrimBusy(false);
    }
  };

  // Measure canvas container cleanly
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const item of entries) {
        const { width, height } = item.contentRect;
        if (width > 10 && height > 10) {
          setSize({ width: Math.floor(width), height: Math.floor(height) });
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const parsed = entry?.parsed ?? null;
  const smartTrimBlocked = Boolean(parsed?.isCompleteComposition && !allowSmartTrimComplete);

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

  const pitchBounds = useMemo(() => {
    if (!parsed || fullPitchRange) {
      return { low: 21, high: 108 }; // Standard 88-key piano range A0..C8
    }
    const pad = 4;
    const low = Math.max(0, parsed.minPitch - pad);
    const high = Math.min(127, parsed.maxPitch + pad);
    if (high - low < 18) {
      const center = Math.round((low + high) / 2);
      return {
        low: Math.max(0, center - 10),
        high: Math.min(127, center + 10),
      };
    }
    return { low, high };
  }, [parsed, fullPitchRange]);

  const RULER_HEIGHT = 26;
  const CHORD_LANE_HEIGHT =
    showChords && harmony && harmony.chords.length > 0 ? 22 : 0;
  const plotTop = RULER_HEIGHT + CHORD_LANE_HEIGHT;
  const PIANO_GUTTER_WIDTH = 44;
  const VELOCITY_HEIGHT = showVelocity ? 56 : 0;

  const plotWidth = Math.max(100, size.width - PIANO_GUTTER_WIDTH);
  const plotHeight = Math.max(100, size.height - plotTop - VELOCITY_HEIGHT);
  const virtualWidth = plotWidth * zoomX;
  const maxScrollX = Math.max(0, virtualWidth - plotWidth);
  const clampedScrollX = Math.min(scrollX, maxScrollX);

  // Render Piano-Roll Canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.width * dpr;
    canvas.height = size.height * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.scale(dpr, dpr);

    // Base deep DAW background
    ctx.fillStyle = '#151b1f';
    ctx.fillRect(0, 0, size.width, size.height);

    const pitchCount = pitchBounds.high - pitchBounds.low + 1;
    const rowH = plotHeight / pitchCount;

    // 1. Pitch rows (alternating black-key tint & octave C lines)
    ctx.save();
    ctx.beginPath();
    ctx.rect(PIANO_GUTTER_WIDTH, plotTop, plotWidth, plotHeight);
    ctx.clip();

    for (let p = pitchBounds.low; p <= pitchBounds.high; p++) {
      const idxFromTop = pitchBounds.high - p;
      const y = plotTop + idxFromTop * rowH;
      const noteInOctave = p % 12;

      if (BLACK_KEYS.has(noteInOctave)) {
        ctx.fillStyle = '#12171b';
        ctx.fillRect(PIANO_GUTTER_WIDTH, y, plotWidth, rowH);
      }

      if (noteInOctave === 0) {
        ctx.fillStyle = '#253038';
        ctx.fillRect(PIANO_GUTTER_WIDTH, Math.round(y + rowH) - 1, plotWidth, 1);
      } else if (rowH >= 6) {
        ctx.fillStyle = '#1b2328';
        ctx.fillRect(PIANO_GUTTER_WIDTH, Math.round(y + rowH) - 1, plotWidth, 1);
      }
    }

    // 2. Vertical Bar / Beat Grid (supports time signature changes)
    if (parsed && parsed.totalTicks > 0 && barGrid.length > 0) {
      const pxPerTick = virtualWidth / parsed.totalTicks;
      const avgBarPx = (parsed.totalTicks / barGrid.length) * pxPerTick;
      const barStep = avgBarPx < 22 ? Math.ceil(22 / Math.max(1, avgBarPx)) : 1;

      for (let i = 0; i < barGrid.length; i++) {
        const bar = barGrid[i];
        const x = PIANO_GUTTER_WIDTH + bar.startTick * pxPerTick - clampedScrollX;
        const barPx = (bar.endTick - bar.startTick) * pxPerTick;

        if (x >= PIANO_GUTTER_WIDTH - 2 && x <= size.width + 2) {
          const isMajor = i % barStep === 0 || bar.isTimeSigChange;
          if (isMajor) {
            ctx.fillStyle = bar.isTimeSigChange
              ? '#3d5870'
              : i % 4 === 0
              ? '#2b363f'
              : '#202930';
            ctx.fillRect(Math.round(x), plotTop, 1, plotHeight + VELOCITY_HEIGHT);
          }
        }

        // Beat lines when zoomed in enough
        if (barPx > 56) {
          ctx.fillStyle = '#192127';
          for (let beatIdx = 1; beatIdx < bar.numerator; beatIdx++) {
            const beatTick = bar.startTick + beatIdx * bar.ticksPerBeat;
            if (beatTick >= bar.endTick - 1) break;
            const bx = PIANO_GUTTER_WIDTH + beatTick * pxPerTick - clampedScrollX;
            if (bx >= PIANO_GUTTER_WIDTH && bx <= size.width) {
              ctx.fillRect(Math.round(bx), plotTop, 1, plotHeight);
            }
          }
        }
      }

      const endX = PIANO_GUTTER_WIDTH + barGrid[barGrid.length - 1].endTick * pxPerTick - clampedScrollX;
      if (endX >= PIANO_GUTTER_WIDTH - 2 && endX <= size.width + 2) {
        ctx.fillStyle = '#202930';
        ctx.fillRect(Math.round(endX), plotTop, 1, plotHeight + VELOCITY_HEIGHT);
      }

      // 3. Trailing empty space hint if notes end far before totalTicks
      if (parsed.notes.length > 0) {
        let maxNoteEndTick = 0;
        for (const n of parsed.notes) {
          const end = n.startTick + n.durationTick;
          if (end > maxNoteEndTick) maxNoteEndTick = end;
        }
        const trailingRatio = (parsed.totalTicks - maxNoteEndTick) / parsed.totalTicks;
        if (trailingRatio > 0.25) {
          const emptyX = PIANO_GUTTER_WIDTH + maxNoteEndTick * pxPerTick - clampedScrollX;
          ctx.fillStyle = 'rgba(217, 119, 6, 0.06)';
          ctx.fillRect(
            Math.max(PIANO_GUTTER_WIDTH, emptyX),
            plotTop,
            size.width - Math.max(PIANO_GUTTER_WIDTH, emptyX),
            plotHeight
          );
        }
      }

      // 4. Render MIDI Notes
      const noteHeight = Math.max(2.5, Math.min(18, rowH - (rowH > 5 ? 1.5 : 0.4)));
      const noteYOffset = (rowH - noteHeight) / 2;

      for (const note of parsed.notes) {
        if (note.pitch < pitchBounds.low || note.pitch > pitchBounds.high) continue;
        const x = PIANO_GUTTER_WIDTH + note.startTick * pxPerTick - clampedScrollX;
        const w = Math.max(2, note.durationTick * pxPerTick);
        if (x + w < PIANO_GUTTER_WIDTH || x > size.width) continue;

        const idxFromTop = pitchBounds.high - note.pitch;
        const y = plotTop + idxFromTop * rowH + noteYOffset;

        const baseColor = colorByTrack
          ? TRACK_COLORS[note.trackIndex % TRACK_COLORS.length]
          : note.channel === 9
          ? '#65b7d8'
          : '#72d180';

        const alpha = 0.52 + (note.velocity / 127) * 0.48;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = baseColor;
        ctx.fillRect(x, y, w, noteHeight);

        if (noteHeight >= 5 && w >= 4) {
          ctx.globalAlpha = 0.35;
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(x, y, w, 1);
        }
      }
      ctx.globalAlpha = 1;
    }

    ctx.restore();

    // 5. Velocity Lane at bottom
    if (showVelocity) {
      const velTop = plotTop + plotHeight;
      ctx.fillStyle = '#11161a';
      ctx.fillRect(PIANO_GUTTER_WIDTH, velTop, plotWidth, VELOCITY_HEIGHT);
      ctx.fillStyle = '#273038';
      ctx.fillRect(PIANO_GUTTER_WIDTH, velTop, plotWidth, 1);

      if (parsed && parsed.totalTicks > 0) {
        const pxPerTick = virtualWidth / parsed.totalTicks;
        const maxBarH = VELOCITY_HEIGHT - 10;
        for (const note of parsed.notes) {
          const x = PIANO_GUTTER_WIDTH + note.startTick * pxPerTick - clampedScrollX;
          if (x < PIANO_GUTTER_WIDTH || x > size.width) continue;
          const h = Math.max(2, (note.velocity / 127) * maxBarH);
          const color = colorByTrack
            ? TRACK_COLORS[note.trackIndex % TRACK_COLORS.length]
            : '#5ec26e';
          ctx.fillStyle = color;
          ctx.globalAlpha = 0.7;
          ctx.fillRect(Math.round(x), velTop + VELOCITY_HEIGHT - h - 2, 2, h);
        }
        ctx.globalAlpha = 1;
      }
    }

    // 6. Top Timeline Bar Ruler
    ctx.fillStyle = '#1b2025';
    ctx.fillRect(PIANO_GUTTER_WIDTH, 0, plotWidth, RULER_HEIGHT);
    ctx.fillStyle = '#2c343d';
    ctx.fillRect(0, RULER_HEIGHT - 1, size.width, 1);

    if (parsed && parsed.totalTicks > 0 && barGrid.length > 0) {
      const pxPerTick = virtualWidth / parsed.totalTicks;
      const avgBarPx = (parsed.totalTicks / barGrid.length) * pxPerTick;
      const labelStep = avgBarPx < 36 ? Math.ceil(36 / Math.max(1, avgBarPx)) : 1;

      ctx.font = '500 10px "JetBrains Mono", monospace';
      ctx.textBaseline = 'middle';

      let lastLabelX = -100;
      for (let i = 0; i < barGrid.length; i++) {
        const bar = barGrid[i];
        const x = PIANO_GUTTER_WIDTH + bar.startTick * pxPerTick - clampedScrollX;
        if (x < PIANO_GUTTER_WIDTH - 24 || x > size.width) continue;

        const shouldDraw = i % labelStep === 0 || bar.isTimeSigChange;
        if (!shouldDraw || x - lastLabelX < 24) continue;
        lastLabelX = x;

        ctx.fillStyle = bar.isTimeSigChange ? '#5eb1e6' : '#38434e';
        ctx.fillRect(Math.round(x), RULER_HEIGHT - 6, 1, 5);
        ctx.fillStyle = bar.isTimeSigChange ? '#9dd6fa' : '#8b95a2';
        ctx.fillText(
          bar.isTimeSigChange ? `${bar.barNumber} (${bar.numerator}/${bar.denominator})` : `${bar.barNumber}`,
          Math.round(x) + 4,
          RULER_HEIGHT / 2
        );
      }

      // 6a-pre. Compact Tempo & Time-Signature change tags on the ruler
      if (parsed.hasTempoChanges || parsed.hasTimeSignatureChanges) {
        const changeTags: Array<{ tick: number; text: string; color: string; bg: string }> = [];
        for (const t of parsed.tempos) {
          if (t.tick > 0) {
            changeTags.push({
              tick: t.tick,
              text: `♩=${Math.round(t.bpm)}`,
              color: '#5eb1e6',
              bg: 'rgba(94, 177, 230, 0.18)',
            });
          }
        }
        for (const ts of parsed.timeSignatures) {
          if (ts.tick > 0) {
            changeTags.push({
              tick: ts.tick,
              text: `${ts.numerator}/${ts.denominator}`,
              color: '#5fd4c2',
              bg: 'rgba(95, 212, 194, 0.18)',
            });
          }
        }
        if (changeTags.length > 0) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(PIANO_GUTTER_WIDTH, 0, plotWidth, RULER_HEIGHT - 1);
          ctx.clip();
          ctx.font = '600 9px "JetBrains Mono", monospace';
          ctx.textBaseline = 'middle';
          for (const tag of changeTags) {
            const tx = Math.round(PIANO_GUTTER_WIDTH + tag.tick * pxPerTick - clampedScrollX);
            if (tx < PIANO_GUTTER_WIDTH - 48 || tx > size.width) continue;
            ctx.fillStyle = tag.color;
            ctx.fillRect(tx, 1, 1.5, RULER_HEIGHT - 2);
            const tw = Math.min(64, Math.ceil(ctx.measureText(tag.text).width) + 6);
            ctx.fillStyle = tag.bg;
            ctx.fillRect(tx + 2, 13, tw, 11);
            ctx.fillStyle = tag.color;
            ctx.fillText(tag.text, tx + 4, 18.5);
          }
          ctx.restore();
        }
      }

      // 6a. Render MIDI Markers & Cue Points in Bar Ruler + subtle guide lines
      if (showMetadata && (parsed.metadata.markers.length > 0 || parsed.metadata.cues.length > 0)) {
        const timelineFlags = [
          ...parsed.metadata.markers.map((m) => ({ ...m, color: '#e6b450' })),
          ...parsed.metadata.cues.map((c) => ({ ...c, color: '#5fd4c2' })),
        ];

        // Vertical dashed guide lines across the note plot
        ctx.save();
        ctx.beginPath();
        ctx.rect(PIANO_GUTTER_WIDTH, plotTop, plotWidth, plotHeight);
        ctx.clip();
        ctx.setLineDash([3, 4]);
        ctx.lineWidth = 1;
        for (const flag of timelineFlags) {
          const fx = PIANO_GUTTER_WIDTH + flag.tick * pxPerTick - clampedScrollX;
          if (fx < PIANO_GUTTER_WIDTH || fx > size.width) continue;
          ctx.strokeStyle = 'rgba(230, 180, 80, 0.25)';
          ctx.beginPath();
          ctx.moveTo(Math.round(fx) + 0.5, plotTop);
          ctx.lineTo(Math.round(fx) + 0.5, plotTop + plotHeight);
          ctx.stroke();
        }
        ctx.restore();

        // Compact marker flag tags in the top ruler
        ctx.save();
        ctx.beginPath();
        ctx.rect(PIANO_GUTTER_WIDTH, 0, plotWidth, RULER_HEIGHT - 1);
        ctx.clip();
        ctx.font = '600 9.5px "JetBrains Mono", monospace';
        ctx.textBaseline = 'middle';

        for (const flag of timelineFlags) {
          const fx = Math.round(PIANO_GUTTER_WIDTH + flag.tick * pxPerTick - clampedScrollX);
          if (fx < PIANO_GUTTER_WIDTH - 60 || fx > size.width) continue;

          ctx.fillStyle = flag.color;
          ctx.fillRect(fx, 2, 1.5, RULER_HEIGHT - 3);

          const labelWidth = Math.min(92, Math.ceil(ctx.measureText(flag.text).width) + 8);
          ctx.fillStyle = 'rgba(230, 180, 80, 0.18)';
          ctx.fillRect(fx + 2, 3, labelWidth, 13);

          ctx.save();
          ctx.beginPath();
          ctx.rect(fx + 3, 3, labelWidth - 2, 13);
          ctx.clip();
          ctx.fillStyle = '#f5cd79';
          ctx.fillText(flag.text, fx + 5, 9.5);
          ctx.restore();
        }
        ctx.restore();
      }
    }

    // 6b. Chord Timeline Lane (right below Bar Ruler)
    if (CHORD_LANE_HEIGHT > 0 && parsed && parsed.totalTicks > 0 && harmony) {
      ctx.fillStyle = '#171c22';
      ctx.fillRect(PIANO_GUTTER_WIDTH, RULER_HEIGHT, plotWidth, CHORD_LANE_HEIGHT);
      ctx.fillStyle = '#29323c';
      ctx.fillRect(0, plotTop - 1, size.width, 1);

      const pxPerTick = virtualWidth / parsed.totalTicks;
      const playTick =
        parsed.totalDurationSec > 0 && (playback.isPlaying || playback.currentSec > 0)
          ? secondsToTick(parsed, playback.currentSec)
          : -1;

      ctx.save();
      ctx.beginPath();
      ctx.rect(PIANO_GUTTER_WIDTH, RULER_HEIGHT, plotWidth, CHORD_LANE_HEIGHT - 1);
      ctx.clip();

      ctx.font = '600 10.5px "JetBrains Mono", monospace';
      ctx.textBaseline = 'middle';

      for (let i = 0; i < harmony.chords.length; i++) {
        const ch = harmony.chords[i];
        const x0 = PIANO_GUTTER_WIDTH + ch.startTick * pxPerTick - clampedScrollX;
        const x1 = PIANO_GUTTER_WIDTH + ch.endTick * pxPerTick - clampedScrollX;
        if (x1 < PIANO_GUTTER_WIDTH || x0 > size.width) continue;

        const isActiveChord = playTick >= ch.startTick && playTick < ch.endTick;
        const w = Math.max(1, x1 - x0);
        ctx.fillStyle = isActiveChord
          ? 'rgba(94, 177, 230, 0.22)'
          : i % 2 === 0
          ? 'rgba(94, 177, 230, 0.08)'
          : 'rgba(94, 177, 230, 0.04)';
        ctx.fillRect(x0, RULER_HEIGHT, w, CHORD_LANE_HEIGHT - 1);

        ctx.fillStyle = isActiveChord ? '#4ea1d3' : '#2f3d4b';
        ctx.fillRect(Math.round(x0), RULER_HEIGHT, 1, CHORD_LANE_HEIGHT - 1);

        if (w >= 20) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x0 + 2, RULER_HEIGHT, Math.max(0, w - 4), CHORD_LANE_HEIGHT - 1);
          ctx.clip();
          ctx.fillStyle = isActiveChord ? '#ffffff' : '#bde1fa';
          ctx.fillText(ch.symbol, x0 + 6, RULER_HEIGHT + (CHORD_LANE_HEIGHT - 1) / 2);
          ctx.restore();
        }
      }

      ctx.restore();

      // Gutter corner label for chord lane
      ctx.fillStyle = '#181d22';
      ctx.fillRect(0, RULER_HEIGHT, PIANO_GUTTER_WIDTH - 1, CHORD_LANE_HEIGHT - 1);
      ctx.fillStyle = '#6c7684';
      ctx.font = '500 9.5px "JetBrains Mono", monospace';
      ctx.textBaseline = 'middle';
      ctx.fillText('AKK', 10, RULER_HEIGHT + (CHORD_LANE_HEIGHT - 1) / 2);
    }

    // 7. Left Piano-Key Gutter
    ctx.fillStyle = '#1b2025';
    ctx.fillRect(0, plotTop, PIANO_GUTTER_WIDTH, plotHeight);
    ctx.fillStyle = '#2c343d';
    ctx.fillRect(PIANO_GUTTER_WIDTH - 1, 0, 1, size.height);

    ctx.font = '500 10px "JetBrains Mono", monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';

    for (let p = pitchBounds.low; p <= pitchBounds.high; p++) {
      const idxFromTop = pitchBounds.high - p;
      const y = plotTop + idxFromTop * rowH;
      const isActive = playback.activePitches.has(p);
      const isBlack = BLACK_KEYS.has(p % 12);

      if (isActive) {
        ctx.fillStyle = '#72d180';
        ctx.fillRect(0, y, PIANO_GUTTER_WIDTH - 1, Math.max(2, rowH));
      } else if (isBlack) {
        ctx.fillStyle = '#14181c';
        ctx.fillRect(0, y, PIANO_GUTTER_WIDTH - 6, rowH);
      }

      if (p % 12 === 0 || (rowH >= 13 && !isBlack)) {
        ctx.fillStyle = isActive ? '#101417' : p % 12 === 0 ? '#aeb7c2' : '#65707d';
        ctx.fillText(midiPitchToName(p), PIANO_GUTTER_WIDTH - 6, y + rowH / 2);
      }
    }
    ctx.textAlign = 'left';

    // Corner block above piano gutter
    ctx.fillStyle = '#1b2025';
    ctx.fillRect(0, 0, PIANO_GUTTER_WIDTH - 1, RULER_HEIGHT - 1);
    ctx.fillStyle = '#6c7684';
    ctx.font = '500 10px "JetBrains Mono", monospace';
    ctx.textBaseline = 'middle';
    ctx.fillText('TON', 10, RULER_HEIGHT / 2);

    // Bottom left velocity label
    if (showVelocity) {
      ctx.fillStyle = '#161a1f';
      ctx.fillRect(0, plotTop + plotHeight, PIANO_GUTTER_WIDTH - 1, VELOCITY_HEIGHT);
      ctx.fillStyle = '#6c7684';
      ctx.fillText('VEL', 10, plotTop + plotHeight + VELOCITY_HEIGHT / 2);
    }

    // 8. Trim Cut-Zone Shading & Cut Lines (handles are rendered as interactive DOM grips)
    if (trimMode && parsed && parsed.totalTicks > 0) {
      const pxPerTick = virtualWidth / parsed.totalTicks;
      const startPx = PIANO_GUTTER_WIDTH + trimStartTick * pxPerTick - clampedScrollX;
      const effectiveEndTick = trimEndTick ?? parsed.totalTicks;
      const endPx = PIANO_GUTTER_WIDTH + effectiveEndTick * pxPerTick - clampedScrollX;

      ctx.save();
      ctx.beginPath();
      ctx.rect(PIANO_GUTTER_WIDTH, 0, plotWidth, size.height);
      ctx.clip();

      // Dim region before start trim
      if (startPx > PIANO_GUTTER_WIDTH) {
        ctx.fillStyle = 'rgba(10, 13, 17, 0.74)';
        ctx.fillRect(
          PIANO_GUTTER_WIDTH,
          plotTop,
          Math.min(plotWidth, startPx - PIANO_GUTTER_WIDTH),
          plotHeight + VELOCITY_HEIGHT
        );
      }

      // Dim region after end trim
      if (endPx < size.width) {
        ctx.fillStyle = 'rgba(10, 13, 17, 0.74)';
        const x0 = Math.max(PIANO_GUTTER_WIDTH, endPx);
        ctx.fillRect(x0, plotTop, size.width - x0, plotHeight + VELOCITY_HEIGHT);
      }

      // Start Trim vertical line
      if (startPx >= PIANO_GUTTER_WIDTH - 2 && startPx <= size.width + 2) {
        ctx.fillStyle = draggingHandle === 'start' || hoverHandle === 'start' ? '#8dd0f8' : '#5eb1e6';
        ctx.fillRect(Math.round(startPx) - 1, 0, 2, size.height);
      }

      // End Trim vertical line
      if (endPx >= PIANO_GUTTER_WIDTH - 2 && endPx <= size.width + 2) {
        ctx.fillStyle = draggingHandle === 'end' || hoverHandle === 'end' ? '#f5cd79' : '#e6b450';
        ctx.fillRect(Math.round(endPx) - 1, 0, 2, size.height);
      }

      ctx.restore();
    }

    // 9. Playhead Line (exact tick mapping even across tempo changes)
    if (parsed && parsed.totalDurationSec > 0 && (playback.isPlaying || playback.currentSec > 0)) {
      const ratio =
        parsed.totalTicks > 0
          ? Math.max(0, Math.min(1, secondsToTick(parsed, playback.currentSec) / parsed.totalTicks))
          : Math.max(0, Math.min(1, playback.currentSec / parsed.totalDurationSec));
      const px = PIANO_GUTTER_WIDTH + ratio * virtualWidth - clampedScrollX;
      if (px >= PIANO_GUTTER_WIDTH && px <= size.width) {
        ctx.fillStyle = '#e2e8f0';
        ctx.fillRect(Math.round(px), 0, 1.5, size.height);
        ctx.fillStyle = '#4ea1d3';
        ctx.beginPath();
        ctx.moveTo(px - 5, 0);
        ctx.lineTo(px + 5, 0);
        ctx.lineTo(px, 7);
        ctx.closePath();
        ctx.fill();
      }
    }

    ctx.restore();
  }, [
    size,
    parsed,
    barGrid,
    harmony,
    pitchBounds,
    plotTop,
    CHORD_LANE_HEIGHT,
    plotWidth,
    plotHeight,
    virtualWidth,
    clampedScrollX,
    colorByTrack,
    showVelocity,
    showMetadata,
    playback,
    trimMode,
    trimStartTick,
    trimEndTick,
    draggingHandle,
    hoverHandle,
  ]);

  const computeTickFromClientX = (clientX: number, useBarSnap = false): number => {
    if (!parsed || parsed.totalTicks <= 0 || !containerRef.current) return 0;
    const rect = containerRef.current.getBoundingClientRect();
    const mx = clientX - rect.left;
    const pxPerTick = virtualWidth / parsed.totalTicks;
    const rawTick = (mx - PIANO_GUTTER_WIDTH + clampedScrollX) / pxPerTick;
    let clamped = Math.max(0, Math.min(parsed.totalTicks, Math.round(rawTick)));

    if (useBarSnap) {
      clamped = nearestBarSnapTick(parsed, clamped);
    }
    return clamped;
  };

  // Window-level pointer tracking so dragging NEVER drops if cursor leaves canvas
  useEffect(() => {
    if (!draggingHandle || !parsed || parsed.totalTicks <= 0) return;

    const onPointerMove = (e: PointerEvent) => {
      e.preventDefault();
      const useSnap = snapToBars || e.shiftKey;
      const tick = computeTickFromClientX(e.clientX, useSnap);
      const minGap = Math.max(120, Math.round(parsed.ppqn / 2));

      if (draggingHandle === 'start') {
        const maxStart = (trimEndTick ?? parsed.totalTicks) - minGap;
        setTrimStartTick(Math.max(0, Math.min(maxStart, tick)));
      } else {
        const minEnd = trimStartTick + minGap;
        setTrimEndTick(Math.max(minEnd, Math.min(parsed.totalTicks, tick)));
      }
    };

    const onPointerUp = () => {
      setDraggingHandle(null);
      window.setTimeout(() => {
        suppressNextClickRef.current = false;
      }, 0);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  });

  const startDragHandle = (handle: 'start' | 'end', e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    suppressNextClickRef.current = true;
    setHoveredNote(null);
    setDraggingHandle(handle);
  };

  const handleCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!trimMode || !parsed || !canvasRef.current || parsed.totalTicks <= 0) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    if (mx < PIANO_GUTTER_WIDTH - 8) return;

    const pxPerTick = virtualWidth / parsed.totalTicks;
    const startPx = PIANO_GUTTER_WIDTH + trimStartTick * pxPerTick - clampedScrollX;
    const effectiveEndTick = trimEndTick ?? parsed.totalTicks;
    const endPx = PIANO_GUTTER_WIDTH + effectiveEndTick * pxPerTick - clampedScrollX;

    const hitStart =
      Math.abs(mx - startPx) <= 14 ||
      (my <= RULER_HEIGHT && mx >= startPx && mx <= startPx + 54);
    const hitEnd =
      Math.abs(mx - endPx) <= 14 ||
      (my <= RULER_HEIGHT && mx <= endPx && mx >= endPx - 50);

    if (hitStart && hitEnd) {
      startDragHandle(Math.abs(mx - startPx) <= Math.abs(mx - endPx) ? 'start' : 'end', e);
      return;
    }
    if (hitStart) {
      startDragHandle('start', e);
      return;
    }
    if (hitEnd) {
      startDragHandle('end', e);
    }
  };

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!parsed || !canvasRef.current || draggingHandle) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    if (trimMode && parsed.totalTicks > 0) {
      const pxPerTick = virtualWidth / parsed.totalTicks;
      const startPx = PIANO_GUTTER_WIDTH + trimStartTick * pxPerTick - clampedScrollX;
      const effectiveEndTick = trimEndTick ?? parsed.totalTicks;
      const endPx = PIANO_GUTTER_WIDTH + effectiveEndTick * pxPerTick - clampedScrollX;

      if (Math.abs(mx - startPx) <= 14 || (my <= RULER_HEIGHT && mx >= startPx && mx <= startPx + 54)) {
        setHoverHandle('start');
      } else if (Math.abs(mx - endPx) <= 14 || (my <= RULER_HEIGHT && mx <= endPx && mx >= endPx - 50)) {
        setHoverHandle('end');
      } else if (hoverHandle !== null) {
        setHoverHandle(null);
      }
    } else if (hoverHandle !== null) {
      setHoverHandle(null);
    }

    if (
      mx < PIANO_GUTTER_WIDTH ||
      my < plotTop ||
      my > plotTop + plotHeight ||
      parsed.totalTicks <= 0
    ) {
      setHoveredNote(null);
      return;
    }

    const pxPerTick = virtualWidth / parsed.totalTicks;
    const tickAtCursor = (mx - PIANO_GUTTER_WIDTH + clampedScrollX) / pxPerTick;
    const pitchCount = pitchBounds.high - pitchBounds.low + 1;
    const rowH = plotHeight / pitchCount;
    const pitchAtCursor = Math.floor(pitchBounds.high - (my - plotTop) / rowH + 0.5);

    const hit = parsed.notes.find(
      (n) =>
        Math.abs(n.pitch - pitchAtCursor) <= 0 &&
        tickAtCursor >= n.startTick &&
        tickAtCursor <= n.startTick + Math.max(n.durationTick, 6 / pxPerTick)
    );

    if (hit) {
      setHoveredNote({ note: hit, x: mx, y: my });
    } else {
      setHoveredNote(null);
    }
  };

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (draggingHandle || suppressNextClickRef.current) return;
    if (!parsed || !canvasRef.current || parsed.totalDurationSec <= 0) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    if (mx < PIANO_GUTTER_WIDTH) return;
    const ratio = Math.max(
      0,
      Math.min(1, (mx - PIANO_GUTTER_WIDTH + clampedScrollX) / virtualWidth)
    );
    if (parsed.totalTicks > 0) {
      onSeek(tickToSeconds(parsed, ratio * parsed.totalTicks));
    } else {
      onSeek(ratio * parsed.totalDurationSec);
    }
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!parsed) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.25 : 0.8;
      setZoomX((z) => Math.max(1, Math.min(12, Number((z * factor).toFixed(2)))));
    } else if (zoomX > 1) {
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      setScrollX((s) => Math.max(0, Math.min(maxScrollX, s + delta)));
    }
  };

  if (!entry) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-[#151b1f] text-[#7c8591] px-8 text-center">
        <div className="max-w-md space-y-2">
          <p className="text-base font-medium text-[#c5ccd4]">Keine MIDI-Datei ausgewählt</p>
          <p className="text-sm leading-relaxed">
            Wähle links eine MIDI-Datei aus, um sofort alle Noten, Spuren und eventuelle
            Unvollständigkeiten in der Piano-Roll-Vorschau zu prüfen.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-[#151b1f]">
      {/* Top Inspector Header (Clean unboxed metadata with middot separators) */}
      <div className="px-4 py-3 bg-[#1c2026] border-b border-[#2b313a] flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div className="min-w-0 flex-1">
          {isRenaming ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (canWriteToDisk && protectOriginals) {
                  setRenameError(
                    'Originalschutz aktiv: Festplatten-Umbenennung ist gesperrt.'
                  );
                  return;
                }
                const trimmed = renameBase.trim();
                if (!trimmed) {
                  setRenameError('Dateiname darf nicht leer sein.');
                  return;
                }
                if (/[\\/:*?"<>|]/.test(trimmed)) {
                  setRenameError('Ungültige Zeichen (\\ / : * ? " < > |) nicht erlaubt.');
                  return;
                }
                const { ext } = splitExtension(entry.name);
                const finalName = /\.(mid|midi)$/i.test(trimmed) ? trimmed : `${trimmed}${ext}`;
                if (finalName === entry.name) {
                  setIsRenaming(false);
                  return;
                }
                setRenameBusy(true);
                setRenameError(null);
                try {
                  await onRenameMidi(entry, finalName);
                  setIsRenaming(false);
                } catch (err) {
                  setRenameError(
                    err instanceof Error ? err.message : 'Umbenennen fehlgeschlagen.'
                  );
                } finally {
                  setRenameBusy(false);
                }
              }}
              className="space-y-1"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <input
                  ref={renameInputRef}
                  type="text"
                  value={renameBase}
                  disabled={renameBusy || (canWriteToDisk && protectOriginals)}
                  onChange={(e) => {
                    setRenameBase(e.target.value);
                    if (renameError) setRenameError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      setIsRenaming(false);
                      setRenameError(null);
                    }
                  }}
                  className="px-2.5 py-1 text-sm font-medium rounded bg-[#13161a] border border-[#4ea1d3] text-white disabled:opacity-50 focus:outline-none min-w-[200px] max-w-[360px] flex-1"
                  aria-label="Neuer Dateiname"
                />
                <span className="text-xs font-mono text-[#7f8895]">
                  {/\.(mid|midi)$/i.test(renameBase.trim()) ? '' : splitExtension(entry.name).ext}
                </span>
                <button
                  type="submit"
                  disabled={renameBusy || (canWriteToDisk && protectOriginals)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium bg-[#3675a3] hover:bg-[#4187ba] disabled:opacity-40 text-white transition-colors"
                >
                  <Check className="w-3.5 h-3.5" />
                  Speichern
                </button>
                <button
                  type="button"
                  disabled={renameBusy}
                  onClick={() => {
                    setIsRenaming(false);
                    setRenameError(null);
                  }}
                  className="p-1 rounded text-[#9aa3b0] hover:text-white bg-[#22272f] border border-[#313844] transition-colors"
                  title="Abbrechen (Esc)"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
                {canWriteToDisk && protectOriginals && (
                  <span className="inline-flex items-center gap-1.5 text-xs text-emerald-300 ml-1">
                    <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
                    <span>Originalschutz aktiv</span>
                    {onToggleProtectOriginals && (
                      <button
                        type="button"
                        onClick={onToggleProtectOriginals}
                        className="underline text-[#8fc8e8] hover:text-white"
                      >
                        Entsperren
                      </button>
                    )}
                  </span>
                )}
              </div>
              {renameError && <p className="text-xs text-rose-400">{renameError}</p>}
            </form>
          ) : (
            <div className="flex items-center gap-2 min-w-0">
              <h2 className="text-[15px] font-semibold text-[#eef1f5] truncate" title={entry.relativePath}>
                {entry.name}
              </h2>
              <button
                type="button"
                onClick={openRenameMode}
                className={`p-1 rounded transition-colors shrink-0 ${
                  canWriteToDisk && protectOriginals
                    ? 'text-[#6c7684] hover:text-emerald-300 hover:bg-[#242c2a]'
                    : 'text-[#838d9b] hover:text-[#7cc4f0] hover:bg-[#272d36]'
                }`}
                title={
                  canWriteToDisk && protectOriginals
                    ? 'Originalschutz aktiv – Festplatten-Umbenennung gesperrt (F2 für Details)'
                    : 'Datei umbenennen (F2)'
                }
                aria-label="Datei umbenennen"
              >
                {canWriteToDisk && protectOriginals ? (
                  <Lock className="w-3.5 h-3.5" />
                ) : (
                  <Pencil className="w-3.5 h-3.5" />
                )}
              </button>
              {entry.triage === 'keep' && (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-400 shrink-0">
                  <Check className="w-3.5 h-3.5" /> Behalten
                </span>
              )}
              {entry.triage === 'discard' && (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-rose-400 shrink-0">
                  <Trash2 className="w-3.5 h-3.5" /> Aussortiert
                </span>
              )}
            </div>
          )}

          {parsed ? (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-[#919aa6] font-mono tabular-nums">
              {harmony?.key ? (
                <span className="text-[#8fc8e8] font-medium">{harmony.key.label}</span>
              ) : harmony?.isPercussionOnly ? (
                <span className="text-[#8fc8e8]">Drums</span>
              ) : null}
              {(harmony?.key || harmony?.isPercussionOnly) && <span aria-hidden="true">·</span>}

              <span
                className={
                  playback.isTempoOverridden
                    ? 'text-[#7cc4f0]'
                    : !parsed.hasExplicitTempo
                    ? 'text-amber-300/85'
                    : ''
                }
              >
                {parsed.hasExplicitTempo
                  ? `${parsed.primaryBpm} BPM${parsed.hasTempoChanges ? ` (${parsed.tempos.length}×)` : ''}`
                  : '120 BPM Std.'}
              </span>
              <span aria-hidden="true">·</span>
              <span>{parsed.primaryTimeSignature}</span>
              <span aria-hidden="true">·</span>
              <span>{parsed.barCount} Takte</span>
              <span aria-hidden="true">·</span>
              <span>{formatDuration(parsed.totalDurationSec)}</span>
              <span aria-hidden="true">·</span>
              <span className={parsed.notes.length === 0 ? 'text-rose-400 font-medium' : ''}>
                {parsed.notes.length} Noten
              </span>

              {/* Clickable compact status pills that jump right to Inspector Diagnostics tab */}
              {parsed.issues.length > 0 && (
                <button
                  type="button"
                  onClick={() => onOpenInspectorTab?.('diagnostics')}
                  className={`inline-flex items-center gap-1 px-1.5 py-0 rounded text-[10.5px] font-sans font-medium border transition-colors ${
                    parsed.hasErrors
                      ? 'bg-rose-950/50 border-rose-700/60 text-rose-200 hover:bg-rose-900/50'
                      : 'bg-amber-950/45 border-amber-700/50 text-amber-200 hover:bg-amber-900/45'
                  }`}
                  title="Prüfhinweise im Inspektor öffnen"
                >
                  {parsed.hasErrors ? (
                    <XCircle className="w-3 h-3 text-rose-400" />
                  ) : (
                    <AlertTriangle className="w-3 h-3 text-amber-400" />
                  )}
                  {parsed.issues.length} {parsed.issues.length === 1 ? 'Hinweis' : 'Hinweise'}
                </button>
              )}

              {duplicateInfo && (
                <button
                  type="button"
                  onClick={() => onOpenInspectorTab?.('diagnostics')}
                  className="inline-flex items-center gap-1 px-1.5 py-0 rounded text-[10.5px] font-sans font-medium border bg-violet-950/45 border-violet-700/50 text-violet-200 hover:bg-violet-900/45 transition-colors"
                  title="Duplikate / Varianten im Inspektor vergleichen"
                >
                  <Copy className="w-3 h-3" />
                  {duplicateInfo.kind === 'variant'
                    ? `Variante ${duplicateInfo.similarity}%`
                    : `Duplikat #${duplicateInfo.groupId}`}
                </button>
              )}
            </div>
          ) : (
            <div className="mt-1 text-xs text-rose-400">
              {entry.parseError || 'MIDI-Datei konnte nicht gelesen werden.'}
            </div>
          )}
        </div>

        {/* Clean, Minimal View Controls */}
        <div className="flex items-center gap-1.5 shrink-0">
          {parsed && parsed.notes.length > 0 && (
            <button
              type="button"
              onClick={() => {
                if (!trimMode) {
                  setTrimStartTick(parsed.firstNoteTick);
                  setTrimEndTick(parsed.totalTicks);
                  setSmartSuggestion(null);
                  setTrimMode(true);
                } else {
                  setTrimMode(false);
                  setSmartSuggestion(null);
                }
              }}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded border transition-colors whitespace-nowrap ${
                trimMode
                  ? 'bg-[#253b4d] border-[#4ea1d3]/70 text-[#e0f2ff]'
                  : 'bg-[#22272f] border-[#313844] text-[#a7b0bd] hover:text-white'
              }`}
              title="Trim-Modus öffnen (Vorlauf/Stille schneiden, Smart Trim)"
            >
              <Scissors className="w-3.5 h-3.5" />
              Trim
            </button>
          )}

          {/* Grouped Canvas View Toggles */}
          <div className="flex items-center bg-[#181c21] border border-[#2d3440] rounded p-0.5">
            <button
              type="button"
              onClick={() => setColorByTrack((v) => !v)}
              className={`px-2 py-0.5 text-[11px] font-medium rounded transition-colors ${
                colorByTrack ? 'bg-[#2a3644] text-[#dceeff]' : 'text-[#8c96a4] hover:text-white'
              }`}
              title="Spuren farblich unterscheiden"
            >
              Farben
            </button>
            <button
              type="button"
              onClick={() => setFullPitchRange((v) => !v)}
              className={`px-2 py-0.5 text-[11px] font-medium rounded transition-colors ${
                fullPitchRange ? 'bg-[#2a3644] text-[#dceeff]' : 'text-[#8c96a4] hover:text-white'
              }`}
              title="Zwischen Auto-Fokus und vollem 88-Tasten-Bereich wechseln"
            >
              88T
            </button>
            <button
              type="button"
              onClick={() => setShowVelocity((v) => !v)}
              className={`px-2 py-0.5 text-[11px] font-medium rounded transition-colors ${
                showVelocity ? 'bg-[#2a3644] text-[#dceeff]' : 'text-[#8c96a4] hover:text-white'
              }`}
              title="Velocity-Balken ein-/ausblenden"
            >
              Vel
            </button>
            <button
              type="button"
              onClick={() => setShowChords((v) => !v)}
              className={`px-2 py-0.5 text-[11px] font-medium rounded transition-colors ${
                showChords ? 'bg-[#2a3644] text-[#dceeff]' : 'text-[#8c96a4] hover:text-white'
              }`}
              title="Akkord-Spur in der Piano-Roll ein-/ausblenden"
            >
              Akk
            </button>
          </div>

          <div className="flex items-center bg-[#181c21] border border-[#2d3440] rounded">
            <button
              type="button"
              onClick={() => setZoomX((z) => Math.max(1, Number((z / 1.5).toFixed(2))))}
              disabled={zoomX <= 1}
              className="p-1 text-[#9aa3b0] hover:text-white disabled:opacity-35 transition-colors"
              title="Herauszoomen"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <span className="px-1 text-[11px] font-mono tabular-nums text-[#b9c1cc] min-w-[34px] text-center">
              {zoomX.toFixed(1)}×
            </span>
            <button
              type="button"
              onClick={() => setZoomX((z) => Math.min(12, Number((z * 1.5).toFixed(2))))}
              disabled={zoomX >= 12}
              className="p-1 text-[#9aa3b0] hover:text-white disabled:opacity-35 transition-colors"
              title="Hineinzoomen"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
            {zoomX > 1 && (
              <button
                type="button"
                onClick={() => {
                  setZoomX(1);
                  setScrollX(0);
                }}
                className="p-1 text-[#9aa3b0] hover:text-white border-l border-[#2d3440] transition-colors"
                title="Ganze Datei einpassen"
              >
                <Maximize2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Interactive Trim Control Strip (only shown when Trim mode is active) */}
      {trimMode && parsed && (() => {
        const startBar = tickToBarFraction(barGrid, trimStartTick).toFixed(1).replace('.0', '');
        const endTickVal = trimEndTick ?? parsed.totalTicks;
        const endBar = tickToBarFraction(barGrid, endTickVal).toFixed(1).replace('.0', '');

        return (
          <div className="px-4 py-2 bg-[#1a222b] border-b border-[#2e3b49] space-y-1.5 shrink-0">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={trimBusy || smartTrimBlocked}
                  onClick={runSmartTrimSilence}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium bg-[#253b4d] hover:bg-[#2f4b61] border border-[#5eb1e6]/70 text-[#e2f2ff] disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
                  title={
                    smartTrimBlocked
                      ? 'Für vollständige Kompositionen standardmäßig deaktiviert (unten aktivierbar)'
                      : 'MIDI-Buffer erneut analysieren und optimalen Schnittpunkt vorschlagen'
                  }
                >
                  <Wand2 className="w-3.5 h-3.5 text-[#5eb1e6]" />
                  Smart Trim Silence
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSmartSuggestion(null);
                    setTrimStartTick(parsed.firstNoteTick);
                  }}
                  className="px-2.5 py-1 rounded text-xs bg-[#24303d] hover:bg-[#2d3c4d] border border-[#3a4d62] text-[#dce8f5] transition-colors whitespace-nowrap"
                >
                  Start: 1. Note
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSmartSuggestion(null);
                    setTrimStartTick(computeBarStartTick(parsed, parsed.firstNoteTick));
                  }}
                  className="px-2.5 py-1 rounded text-xs bg-[#24303d] hover:bg-[#2d3c4d] border border-[#3a4d62] text-[#dce8f5] transition-colors whitespace-nowrap"
                  title="Rastet auf den Taktanfang direkt vor der 1. Note ein, damit das Taktraster erhalten bleibt"
                >
                  Start: Taktanfang
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSmartSuggestion(null);
                    const barEnd = computeBarEndTick(parsed, parsed.lastNoteEndTick);
                    setTrimEndTick((prev) =>
                      prev && prev < parsed.totalTicks ? parsed.totalTicks : Math.min(parsed.totalTicks, barEnd)
                    );
                  }}
                  className="px-2.5 py-1 rounded text-xs bg-[#24303d] hover:bg-[#2d3c4d] border border-[#3a4d62] text-[#dce8f5] transition-colors whitespace-nowrap"
                >
                  Ende: Nach letzter Note
                </button>

                <label className="inline-flex items-center gap-1.5 text-xs text-[#b5c7da] ml-1 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={snapToBars}
                    onChange={(e) => setSnapToBars(e.target.checked)}
                    className="rounded border-[#434c59] bg-[#16191d] accent-[#5eb1e6]"
                  />
                  Takt-Snap
                </label>

                <span className="text-[11px] font-mono tabular-nums text-[#8ea5bc] ml-1">
                  Takt {startBar} → Takt {endBar}
                </span>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setTrimMode(false);
                    setSmartSuggestion(null);
                  }}
                  className="px-2.5 py-1 rounded text-xs text-[#9aa3b0] hover:text-white bg-[#22272f] border border-[#313844] transition-colors"
                >
                  Abbrechen
                </button>
                <button
                  type="button"
                  disabled={trimBusy}
                  onClick={async () => {
                    setTrimBusy(true);
                    try {
                      const endArg =
                        trimEndTick !== null && trimEndTick < parsed.totalTicks ? trimEndTick : null;
                      await onTrimMidi(entry, trimStartTick, endArg);
                      setTrimMode(false);
                      setSmartSuggestion(null);
                      setTrimNotice('MIDI-Datei erfolgreich gekürzt.');
                    } finally {
                      setTrimBusy(false);
                    }
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium bg-[#3675a3] hover:bg-[#4187ba] disabled:opacity-40 text-white transition-colors whitespace-nowrap"
                >
                  <Scissors className="w-3.5 h-3.5" />
                  Jetzt kürzen
                </button>
              </div>
            </div>

            {parsed.isCompleteComposition && (
              <div className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5 rounded bg-[#141c24] border border-[#2c3b4a] text-xs text-[#b4c6d8]">
                <span>
                  Vollständige Komposition erkannt ({parsed.completeCompositionReason}) — Smart Trimming ist standardmäßig deaktiviert, um Intro, Phrasierung &amp; Ausklang zu schützen.
                </span>
                <label className="inline-flex items-center gap-1.5 text-xs text-[#8fd0f8] cursor-pointer select-none whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={allowSmartTrimComplete}
                    onChange={(e) => toggleAllowSmartTrimComplete(e.target.checked)}
                    className="rounded border-[#434c59] bg-[#16191d] accent-[#5eb1e6]"
                  />
                  Smart Trim auch für vollständige Stücke erlauben
                </label>
              </div>
            )}

            {smartSuggestion && (
              <div className="flex items-center gap-2 text-xs text-[#b9dcf5]">
                <Wand2 className="w-3.5 h-3.5 text-[#5eb1e6] shrink-0" />
                <span>{smartSuggestion.summary}</span>
              </div>
            )}
          </div>
        );
      })()}

      {/* Trimmed State Save / Undo Strip */}
      {(entry.isTrimmed || trimNotice) && (
        <div className="px-4 py-2 bg-[#182620] border-b border-emerald-800/50 flex flex-wrap items-center justify-between gap-2 text-xs shrink-0">
          <div className="flex items-center gap-2 text-emerald-200">
            <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <span>
              {trimNotice || 'Datei wurde gekürzt (Original liegt noch als Backup im Speicher).'}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {entry.isTrimmed && (
              <>
                <button
                  type="button"
                  disabled={trimBusy}
                  onClick={async () => {
                    setTrimBusy(true);
                    try {
                      await onRestoreOriginalMidi(entry);
                      setTrimNotice(null);
                    } finally {
                      setTrimBusy(false);
                    }
                  }}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[#222926] hover:bg-[#2c3531] border border-[#384740] text-xs text-[#d0dcd6] transition-colors whitespace-nowrap"
                >
                  <RotateCcw className="w-3 h-3" />
                  Original wiederherstellen
                </button>

                {canWriteToDisk && (
                  <>
                    <button
                      type="button"
                      disabled={trimBusy}
                      onClick={async () => {
                        setTrimBusy(true);
                        try {
                          const savedName = await onSaveTrimmedCopy(entry);
                          setTrimNotice(`Als „${savedName || '_trimmed'}“ im Ordner gespeichert.`);
                        } finally {
                          setTrimBusy(false);
                        }
                      }}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-[#2a3846] hover:bg-[#344658] border border-[#4ea1d3]/60 text-xs font-medium text-[#dcebf7] transition-colors whitespace-nowrap"
                      title="Speichert eine gekürzte Kopie (_trimmed.mid), ohne das Original anzutasten"
                    >
                      <Save className="w-3 h-3" />
                      Als Kopie speichern
                    </button>

                    {protectOriginals ? (
                      <span
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-[#1d2422] border border-emerald-800/50 text-xs text-emerald-300/90 whitespace-nowrap"
                        title="Originalschutz ist aktiv: Das Original auf der Festplatte bleibt geschützt. Oben deaktivieren, um Überschreiben freizuschalten."
                      >
                        <Lock className="w-3 h-3" />
                        Original geschützt
                      </span>
                    ) : confirmOverwrite ? (
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          disabled={trimBusy}
                          onClick={async () => {
                            setTrimBusy(true);
                            try {
                              await onOverwriteOriginal(entry);
                              setConfirmOverwrite(false);
                              setTrimNotice(
                                'Original auf Festplatte überschrieben (Backup in _Originale_Backup gespeichert).'
                              );
                            } finally {
                              setTrimBusy(false);
                            }
                          }}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-rose-700 hover:bg-rose-600 text-xs font-medium text-white transition-colors whitespace-nowrap"
                        >
                          <Save className="w-3 h-3" />
                          Ja, Original überschreiben (mit Backup)
                        </button>
                        <button
                          type="button"
                          disabled={trimBusy}
                          onClick={() => setConfirmOverwrite(false)}
                          className="px-2 py-1 rounded bg-[#222926] hover:bg-[#2c3531] border border-[#384740] text-xs text-[#d0dcd6]"
                        >
                          Abbrechen
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        disabled={trimBusy}
                        onClick={() => setConfirmOverwrite(true)}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-xs font-medium text-white transition-colors whitespace-nowrap"
                        title="Legt zuvor automatisch eine Kopie in _Originale_Backup an"
                      >
                        <Save className="w-3 h-3" />
                        Original überschreiben
                      </button>
                    )}
                  </>
                )}

                <button
                  type="button"
                  onClick={() => onDownloadTrimmed(entry)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-[#3675a3] hover:bg-[#4187ba] text-xs font-medium text-white transition-colors whitespace-nowrap"
                >
                  <Download className="w-3 h-3" />
                  Herunterladen (.mid)
                </button>
              </>
            )}
            {!entry.isTrimmed && trimNotice && (
              <button
                type="button"
                onClick={() => setTrimNotice(null)}
                className="p-1 text-emerald-300 hover:text-white"
                aria-label="Hinweis schließen"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Main Piano-Roll Canvas Viewport */}
      <div
        ref={containerRef}
        onWheel={handleWheel}
        className="relative flex-1 min-h-0 overflow-hidden select-none"
      >
        <canvas
          ref={canvasRef}
          onPointerDown={handleCanvasPointerDown}
          onMouseMove={handleCanvasMouseMove}
          onMouseLeave={() => {
            setHoveredNote(null);
            setHoverHandle(null);
          }}
          onClick={handleCanvasClick}
          className={`block w-full h-full ${
            draggingHandle || hoverHandle ? 'cursor-ew-resize' : 'cursor-crosshair'
          }`}
        />

        {/* Interactive DOM Grip Overlays for effortless Trim Handle dragging */}
        {trimMode && parsed && parsed.totalTicks > 0 && (() => {
          const pxPerTick = virtualWidth / parsed.totalTicks;
          const startPx = PIANO_GUTTER_WIDTH + trimStartTick * pxPerTick - clampedScrollX;
          const effectiveEndTick = trimEndTick ?? parsed.totalTicks;
          const endPx = PIANO_GUTTER_WIDTH + effectiveEndTick * pxPerTick - clampedScrollX;

          const startVisible = startPx >= PIANO_GUTTER_WIDTH - 12 && startPx <= size.width + 12;
          const endVisible = endPx >= PIANO_GUTTER_WIDTH - 12 && endPx <= size.width + 12;

          return (
            <>
              {startVisible && (
                <>
                  {/* Full-height wide grab strip */}
                  <div
                    onPointerDown={(e) => startDragHandle('start', e)}
                    style={{ left: `${Math.max(PIANO_GUTTER_WIDTH - 8, startPx - 8)}px` }}
                    className="absolute top-0 bottom-0 w-4 z-10 cursor-ew-resize touch-none"
                    title="Start-Schnittpunkt ziehen (Shift für Takt-Snap)"
                  />
                  {/* Top START tab */}
                  <div
                    onPointerDown={(e) => startDragHandle('start', e)}
                    style={{
                      left: `${Math.min(size.width - 54, Math.max(PIANO_GUTTER_WIDTH, startPx))}px`,
                    }}
                    className={`absolute top-0.5 z-20 h-5 px-2 rounded-r flex items-center gap-1 text-[10px] font-mono font-semibold tracking-tight select-none cursor-ew-resize touch-none shadow transition-colors ${
                      draggingHandle === 'start'
                        ? 'bg-[#8dd0f8] text-[#09121a]'
                        : 'bg-[#5eb1e6] hover:bg-[#7cc4f0] text-[#0b151e]'
                    }`}
                    title="Start-Schnittpunkt ziehen"
                  >
                    <span>⋮</span>
                    <span>START</span>
                  </div>
                </>
              )}

              {endVisible && (
                <>
                  {/* Full-height wide grab strip */}
                  <div
                    onPointerDown={(e) => startDragHandle('end', e)}
                    style={{ left: `${Math.min(size.width - 16, Math.max(PIANO_GUTTER_WIDTH, endPx - 8))}px` }}
                    className="absolute top-0 bottom-0 w-4 z-10 cursor-ew-resize touch-none"
                    title="End-Schnittpunkt ziehen (Shift für Takt-Snap)"
                  />
                  {/* Top ENDE tab (anchored inside left of end line so it stays 100% grabbable at 100%) */}
                  <div
                    onPointerDown={(e) => startDragHandle('end', e)}
                    style={{
                      left: `${Math.max(PIANO_GUTTER_WIDTH, Math.min(size.width - 50, endPx - 50))}px`,
                    }}
                    className={`absolute top-0.5 z-20 h-5 px-2 rounded-l flex items-center gap-1 text-[10px] font-mono font-semibold tracking-tight select-none cursor-ew-resize touch-none shadow transition-colors ${
                      draggingHandle === 'end'
                        ? 'bg-[#f5cd79] text-[#171106]'
                        : 'bg-[#e6b450] hover:bg-[#efc367] text-[#171106]'
                    }`}
                    title="End-Schnittpunkt ziehen"
                  >
                    <span>ENDE</span>
                    <span>⋮</span>
                  </div>
                </>
              )}
            </>
          );
        })()}

        {/* Empty MIDI Notice overlay */}
        {parsed && parsed.notes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="px-4 py-2.5 rounded bg-[#1b2126]/95 border border-rose-800/60 text-sm text-rose-200">
              Keine MIDI-Noten in dieser Datei vorhanden (leere Spur).
            </div>
          </div>
        )}

        {/* Note Inspector Hover Tooltip */}
        {hoveredNote && (
          <div
            className="pointer-events-none absolute z-10 px-2.5 py-1.5 rounded bg-[#111519]/95 border border-[#343c47] text-[11px] font-mono tabular-nums text-[#dce2ea] shadow-lg"
            style={{
              left: Math.min(size.width - 170, hoveredNote.x + 12),
              top: Math.max(8, hoveredNote.y - 44),
            }}
          >
            <div className="font-semibold text-[#72d180]">
              {midiPitchToName(hoveredNote.note.pitch)} (MIDI {hoveredNote.note.pitch})
            </div>
            <div className="text-[#99a3b0]">
              Vel {hoveredNote.note.velocity} · {hoveredNote.note.startSec.toFixed(2)}s ·{' '}
              {hoveredNote.note.durationSec.toFixed(2)}s
            </div>
          </div>
        )}
      </div>

      {/* Horizontal Scrollbar when Zoomed In */}
      {zoomX > 1 && maxScrollX > 0 && (
        <div className="px-4 py-1.5 bg-[#181d22] border-t border-[#293039] flex items-center gap-3 shrink-0">
          <span className="text-[11px] font-mono text-[#7c8591]">Position</span>
          <input
            type="range"
            min={0}
            max={maxScrollX}
            value={clampedScrollX}
            onChange={(e) => setScrollX(Number(e.target.value))}
            className="flex-1 accent-[#4ea1d3] h-1.5 cursor-pointer"
          />
        </div>
      )}

      {/* Bottom Transport & Quick Triage Bar */}
      <div className="px-4 py-2.5 bg-[#1c2026] border-t border-[#2b313a] flex flex-wrap items-center justify-between gap-3 shrink-0">
        {/* Audio Preview Controls */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onPlayPause}
            disabled={!parsed || parsed.notes.length === 0}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded bg-[#2a313b] hover:bg-[#343d49] disabled:opacity-40 text-xs font-medium text-[#eef1f5] border border-[#3a424f] transition-colors whitespace-nowrap"
            title="Abspielen / Pause (Leertaste)"
          >
            {playback.isPlaying ? (
              <>
                <Pause className="w-3.5 h-3.5 text-[#72d180]" />
                Pause
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5 text-[#72d180]" />
                Anhören
              </>
            )}
          </button>

          <div className="text-xs font-mono tabular-nums text-[#9ba4b0] min-w-[84px]">
            {formatDuration(
              playback.tempoRate > 0 ? playback.currentSec / playback.tempoRate : playback.currentSec
            )}{' '}
            /{' '}
            {formatDuration(
              playback.tempoRate > 0 ? playback.totalSec / playback.tempoRate : playback.totalSec
            )}
          </div>

          {/* Extracted Header BPM & Manual Playback Tempo Control */}
          {(() => {
            const formatBpm = (val: number) =>
              Number.isInteger(val) ? String(val) : val.toFixed(1);
            const displayBpm = parsed ? playback.playbackBpm : 120;
            const headerBpm = parsed?.primaryBpm ?? playback.baseBpm;
            const canAdjustTempo = Boolean(parsed && parsed.notes.length > 0);

            const commitBpmDraft = () => {
              const normalized = bpmDraft.replace(',', '.').trim();
              const num = Number(normalized);
              setIsEditingBpm(false);
              if (Number.isFinite(num) && num > 0) {
                onTempoChange(num);
              }
            };

            return (
              <div
                className={`flex items-center rounded border transition-colors ${
                  playback.isTempoOverridden
                    ? 'bg-[#1d2b38] border-[#4ea1d3]/65'
                    : 'bg-[#22272f] border-[#313844]'
                }`}
                title={
                  !parsed?.hasExplicitTempo
                    ? 'Kein Tempo-Tag im MIDI-Header (120 BPM Standard) · Klick zum Bearbeiten (±5 BPM, Shift+Klick für ±1 BPM)'
                    : parsed?.hasTempoChanges
                    ? `Tempowechsel aktiv (Start: ${formatBpm(headerBpm)} BPM · aktuell ${formatBpm(playback.currentBpm)} BPM) · Klick zum Skalieren`
                    : `MIDI-Header: ${formatBpm(headerBpm)} BPM · Klick zum Bearbeiten (±5 BPM, Shift+Klick für ±1 BPM)`
                }
              >
                <span className="pl-2 pr-1 text-[#7ea8c9] flex items-center" aria-hidden="true">
                  <Gauge className="w-3.5 h-3.5" />
                </span>
                <button
                  type="button"
                  disabled={!canAdjustTempo || displayBpm <= 20}
                  onClick={(e) =>
                    onTempoChange(Math.max(20, displayBpm - (e.shiftKey ? 1 : 5)))
                  }
                  className="p-1 text-[#9aa3b0] hover:text-white disabled:opacity-35 transition-colors"
                  title="Tempo verringern (−5 BPM, Shift: −1 BPM)"
                  aria-label="Tempo verringern"
                >
                  <Minus className="w-3 h-3" />
                </button>
                <div className="flex items-center px-0.5">
                  <input
                    type="text"
                    inputMode="decimal"
                    disabled={!canAdjustTempo}
                    value={isEditingBpm ? bpmDraft : formatBpm(displayBpm)}
                    onFocus={(e) => {
                      setIsEditingBpm(true);
                      setBpmDraft(formatBpm(displayBpm));
                      e.currentTarget.select();
                    }}
                    onChange={(e) => setBpmDraft(e.target.value)}
                    onBlur={commitBpmDraft}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commitBpmDraft();
                        e.currentTarget.blur();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        setIsEditingBpm(false);
                        e.currentTarget.blur();
                      }
                    }}
                    className={`w-11 bg-transparent text-center text-xs font-mono tabular-nums focus:outline-none disabled:opacity-45 ${
                      playback.isTempoOverridden
                        ? 'text-[#7cc4f0] font-semibold'
                        : 'text-[#e2e7ee]'
                    }`}
                    aria-label="Wiedergabe-Tempo in BPM"
                  />
                  <span className="pr-1.5 text-[10px] font-mono text-[#7f8895] select-none">
                    BPM
                    {!parsed?.hasExplicitTempo && !playback.isTempoOverridden ? ' Std.' : ''}
                    {parsed?.hasTempoChanges ? ' ~' : ''}
                  </span>
                </div>
                <button
                  type="button"
                  disabled={!canAdjustTempo || displayBpm >= 300}
                  onClick={(e) =>
                    onTempoChange(Math.min(300, displayBpm + (e.shiftKey ? 1 : 5)))
                  }
                  className="p-1 text-[#9aa3b0] hover:text-white disabled:opacity-35 transition-colors"
                  title="Tempo erhöhen (+5 BPM, Shift: +1 BPM)"
                  aria-label="Tempo erhöhen"
                >
                  <Plus className="w-3 h-3" />
                </button>
                {playback.isTempoOverridden && (
                  <button
                    type="button"
                    onClick={() => onTempoChange(null)}
                    className="p-1.5 text-[#7cc4f0] hover:text-white border-l border-[#34495e] transition-colors"
                    title={`Auf MIDI-Header-Tempo zurücksetzen (${formatBpm(headerBpm)} BPM)`}
                    aria-label="Tempo zurücksetzen"
                  >
                    <RotateCcw className="w-3 h-3" />
                  </button>
                )}
              </div>
            );
          })()}

          <label className="hidden sm:inline-flex items-center gap-1.5 text-xs text-[#9ba4b0] cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoPlay}
              onChange={onToggleAutoPlay}
              className="rounded border-[#434c59] bg-[#16191d] accent-[#4ea1d3]"
            />
            Auto-Play
          </label>

          {!playback.selectedMidiOutputId && (
            <div className="hidden md:flex items-center gap-1.5 ml-1">
              <Volume2 className="w-3.5 h-3.5 text-[#7d8694]" />
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={volume}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setVolume(v);
                  onVolumeChange(v);
                }}
                className="w-16 accent-[#4ea1d3] h-1 cursor-pointer"
                aria-label="Lautstärke"
              />
            </div>
          )}

          {/* Web MIDI Output Selector (e.g. loopMIDI -> Kontakt 8 Standalone) */}
            <div className="flex items-center gap-1.5">
              {/* Hidden .sf2 file input */}
              <input
                ref={sf2InputRef}
                type="file"
                accept=".sf2,.SF2"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onLoadSoundFont(f);
                  e.target.value = '';
                }}
              />

              <div
                className={`flex items-center rounded border transition-colors ${
                  playback.selectedMidiOutputId
                    ? 'bg-[#1d2b38] border-[#4ea1d3]/65'
                    : 'bg-[#22272f] border-[#313844]'
                }`}
                title={
                  playback.midiError ||
                  'Audio-/MIDI-Ausgang wählen (Interner Sound / SoundFont oder externer MIDI-Port wie loopMIDI -> Kontakt 8)'
                }
              >
                <span
                  className={`pl-2 pr-1 flex items-center ${
                    playback.selectedMidiOutputId ? 'text-[#5eb1e6]' : 'text-[#7d8694]'
                  }`}
                  aria-hidden="true"
                >
                  <Cable className="w-3.5 h-3.5" />
                </span>
                <select
                  value={playback.selectedMidiOutputId ?? ''}
                  onChange={(e) => onSelectMidiOutput(e.target.value || null)}
                  className={`bg-transparent py-1 pr-2 text-xs focus:outline-none max-w-[140px] cursor-pointer ${
                    playback.selectedMidiOutputId
                      ? 'text-[#d8ecfa] font-medium'
                      : 'text-[#cfd5de]'
                  }`}
                  aria-label="Audio- oder MIDI-Ausgang"
                >
                  <option value="" className="bg-[#1c2026] text-[#cfd5de]">
                    {playback.sf2Loaded ? 'SoundFont (.sf2)' : 'Browser-Synth'}
                  </option>
                  {playback.midiOutputs.map((out) => (
                    <option key={out.id} value={out.id} className="bg-[#1c2026] text-[#eef1f5]">
                      {out.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={onRefreshMidiOutputs}
                  className="p-1.5 text-[#8b94a1] hover:text-white border-l border-[#313844] transition-colors"
                  title={
                    playback.midiError
                      ? `MIDI-Geräte neu suchen (${playback.midiError})`
                      : 'MIDI-Ausgänge neu scannen'
                  }
                  aria-label="MIDI-Ausgänge aktualisieren"
                >
                  <RefreshCw className="w-3 h-3" />
                </button>
              </div>

              {/* SoundFont (.sf2) Library Dropdown, Preset Picker & Hall Reverb when internal audio is active */}
              {!playback.selectedMidiOutputId && (
                <>
                  {/* SoundFont Bank Selector (public/soundfonts/ + Browser-Synth + Custom Upload) */}
                  <div
                    className={`flex items-center rounded border transition-colors ${
                      playback.sf2Loaded
                        ? 'bg-[#1c2832] border-[#4ea1d3]/55'
                        : 'bg-[#22272f] border-[#313844]'
                    }`}
                    title="SoundFont aus public/soundfonts/ auswählen oder eigene .sf2-Datei laden"
                  >
                    <span
                      className={`pl-2 pr-1 flex items-center ${
                        playback.sf2Loaded ? 'text-[#6bc0f2]' : 'text-[#8390a0]'
                      }`}
                      aria-hidden="true"
                    >
                      <Music className="w-3.5 h-3.5" />
                    </span>
                    <select
                      disabled={playback.sf2Loading}
                      value={playback.sf2SelectedSourceId}
                      onChange={(e) => onSelectSoundFontSource(e.target.value)}
                      className={`bg-transparent py-1 pr-1.5 text-xs focus:outline-none max-w-[160px] cursor-pointer disabled:opacity-50 ${
                        playback.sf2Loaded ? 'text-[#dceeff] font-medium' : 'text-[#cfd5de]'
                      }`}
                      aria-label="SoundFont auswählen"
                    >
                      <option value="" className="bg-[#1c2026] text-[#cfd5de]">
                        {playback.sf2Loading
                          ? 'Lade SoundFont...'
                          : playback.sf2Library.length > 0
                          ? 'Browser-Synth'
                          : 'Kein .sf2 (Synth)'}
                      </option>
                      {playback.sf2Library.length > 0 && (
                        <optgroup label="Ordner: public/soundfonts" className="bg-[#1c2026] text-[#9fb2c7]">
                          {playback.sf2Library.map((sf) => (
                            <option
                              key={sf.id}
                              value={sf.id}
                              className="bg-[#1c2026] text-[#eef1f5]"
                            >
                              {sf.label}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      {playback.sf2CustomName && (
                        <option value="custom" className="bg-[#1c2026] text-[#a7f3d0]">
                          ★ {playback.sf2CustomName.replace(/\.sf2$/i, '')}
                        </option>
                      )}
                    </select>
                    <button
                      type="button"
                      onClick={onRefreshSoundFontLibrary}
                      className="p-1.5 text-[#8b96a6] hover:text-white border-l border-[#313b47] transition-colors"
                      title="Ordner public/soundfonts/ nach neuen .sf2-Dateien durchsuchen"
                      aria-label="SoundFont-Ordner neu scannen"
                    >
                      <RefreshCw className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => sf2InputRef.current?.click()}
                      className="p-1.5 text-[#8cb8d6] hover:text-white border-l border-[#313b47] transition-colors"
                      title="Einzelne .sf2-Datei von einem anderen Ordner laden"
                      aria-label="Eigene SoundFont-Datei laden"
                    >
                      <Upload className="w-3 h-3" />
                    </button>
                    {playback.sf2SelectedSourceId === 'custom' && (
                      <button
                        type="button"
                        onClick={onUnloadSoundFont}
                        className="p-1.5 text-[#8b96a6] hover:text-rose-300 border-l border-[#313b47] transition-colors"
                        title="Manuell geladenes SoundFont entfernen"
                        aria-label="Manuelles SoundFont entfernen"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    )}
                  </div>

                  {/* Preset Dropdown inside the active SoundFont (shown if >1 preset) */}
                  {playback.sf2Loaded && playback.sf2Presets.length > 1 && (
                    <select
                      value={playback.sf2SelectedPresetId ?? ''}
                      onChange={(e) => onSelectSf2Preset(e.target.value || null)}
                      className="px-2 py-1 rounded text-xs bg-[#1c232c] border border-[#314050] text-[#d6e9fa] focus:outline-none focus:border-[#4ea1d3] max-w-[155px] cursor-pointer"
                      title="Klang-Preset innerhalb des geladenen SoundFonts wählen (Auto erkennt GM & Spurnamen)"
                      aria-label="SoundFont-Preset"
                    >
                      <option value="" className="bg-[#1c2026] text-[#dceeff]">
                        Auto (GM / Spur)
                      </option>
                      {playback.sf2Presets.map((p) => (
                        <option
                          key={p.id}
                          value={p.id}
                          className="bg-[#1c2026] text-[#eef1f5]"
                        >
                          {p.bank === 128 ? 'Drums' : String(p.preset).padStart(3, '0')} · {p.name}
                        </option>
                      ))}
                    </select>
                  )}

                  <button
                    type="button"
                    onClick={onToggleReverb}
                    className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium border transition-colors whitespace-nowrap ${
                      playback.reverbEnabled
                        ? 'bg-[#222f3c] border-[#4ea1d3]/55 text-[#cce7fb]'
                        : 'bg-[#22272f] border-[#313844] text-[#8a94a2] hover:text-white'
                    }`}
                    title="Leichten Raumhall (Reverb) für angenehmeres Vorhören ein-/ausschalten"
                  >
                    <Sparkles className="w-3 h-3" />
                    Hall
                  </button>

                  {playback.sf2Error && (
                    <span
                      className="inline-flex items-center text-amber-400"
                      title={playback.sf2Error}
                    >
                      <AlertTriangle className="w-3.5 h-3.5" />
                    </span>
                  )}
                </>
              )}

            {playback.selectedMidiOutputId && (
              <>
                <button
                  type="button"
                  onClick={() =>
                    onChangeMidiChannelRouting(
                      playback.midiChannelRouting === 'ch1' ? 'original' : 'ch1'
                    )
                  }
                  className="px-2 py-1 rounded text-[11px] font-mono font-medium bg-[#22272f] hover:bg-[#2c333d] border border-[#313844] text-[#b8cde0] transition-colors whitespace-nowrap"
                  title={
                    playback.midiChannelRouting === 'ch1'
                      ? 'Aktuell: Alle Noten auf MIDI-Kanal 1 (ideal für einzelnes Kontakt-Instrument). Klicken für Original-Kanäle 1–16.'
                      : 'Aktuell: Original-MIDI-Kanäle 1–16 (für Kontakt-Multis oder Omni). Klicken für Kanal 1.'
                  }
                >
                  {playback.midiChannelRouting === 'ch1' ? 'Ch 1' : 'Ch 1–16'}
                </button>

                <button
                  type="button"
                  onClick={onMidiPanic}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-[#292226] hover:bg-rose-900/50 border border-[#443139] hover:border-rose-600/60 text-rose-300 transition-colors whitespace-nowrap"
                  title="MIDI Panic: Alle hängenden Noten in Kontakt sofort stoppen (All Notes Off)"
                >
                  <VolumeX className="w-3 h-3" />
                  Panic
                </button>
              </>
            )}

            {playback.midiError && (
              <span
                className="inline-flex items-center text-amber-400"
                title={playback.midiError}
              >
                <AlertTriangle className="w-3.5 h-3.5" />
              </span>
            )}
          </div>
        </div>

        {/* Triage Actions */}
        <div className="flex items-center gap-2">
          {entry.triage !== 'pending' && (
            <button
              type="button"
              onClick={() => onTriage('pending')}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium text-[#9aa3b0] hover:text-white bg-[#22272f] hover:bg-[#2a303a] border border-[#313844] transition-colors whitespace-nowrap"
              title="Markierung zurücksetzen (Taste U)"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Zurücksetzen
            </button>
          )}

          <button
            type="button"
            onClick={() => onTriage('keep')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium border transition-colors whitespace-nowrap ${
              entry.triage === 'keep'
                ? 'bg-emerald-600/25 border-emerald-500/70 text-emerald-300'
                : 'bg-[#22272f] border-[#313844] text-[#cfd5de] hover:border-emerald-500/50 hover:text-emerald-300'
            }`}
            title="Als vollständig behalten & weiter (Taste K)"
          >
            <Check className="w-3.5 h-3.5" />
            Behalten (K)
          </button>

          <button
            type="button"
            onClick={() => onTriage('discard')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium border transition-colors whitespace-nowrap ${
              entry.triage === 'discard'
                ? 'bg-rose-600/25 border-rose-500/70 text-rose-300'
                : 'bg-[#22272f] border-[#313844] text-[#cfd5de] hover:border-rose-500/50 hover:text-rose-300'
            }`}
            title="Zum Aussortieren markieren & weiter (Taste X / Entf)"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Aussortieren (X)
          </button>
        </div>
      </div>
    </div>
  );
};
