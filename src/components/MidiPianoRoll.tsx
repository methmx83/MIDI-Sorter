import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bookmark,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Copyright,
  Download,
  FileText,
  Maximize2,
  Music2,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Save,
  Scissors,
  Trash2,
  Volume2,
  Wand2,
  X,
  XCircle,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { MidiFileEntry, MidiNote, TriageStatus } from '../types/midi';
import type { DuplicateMatchInfo } from '../utils/midiDuplicates';
import { formatBytes, formatDuration, midiPitchToName } from '../utils/midiParser';
import type { MidiPlaybackState } from '../utils/midiPlayer';
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
  onTriage: (status: TriageStatus) => void;
  canWriteToDisk: boolean;
  onImmediateMoveToSorted?: (entry: MidiFileEntry) => void;
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
  onOpenTrainingTxt: (entry: MidiFileEntry) => void;
  duplicateInfo?: DuplicateMatchInfo | null;
  onSelectEntry?: (id: string) => void;
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
  onTriage,
  canWriteToDisk,
  onImmediateMoveToSorted,
  onTrimMidi,
  onRestoreOriginalMidi,
  onSaveTrimmedCopy,
  onOverwriteOriginal,
  onDownloadTrimmed,
  renameTrigger,
  onRenameMidi,
  onAnalyzeSmartTrim,
  onOpenTrainingTxt,
  duplicateInfo,
  onSelectEntry,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const [size, setSize] = useState({ width: 800, height: 500 });
  const [zoomX, setZoomX] = useState<number>(1);
  const [scrollX, setScrollX] = useState<number>(0);
  const [fullPitchRange, setFullPitchRange] = useState<boolean>(false);
  const [colorByTrack, setColorByTrack] = useState<boolean>(false);
  const [showVelocity, setShowVelocity] = useState<boolean>(true);
  const [showChords, setShowChords] = useState<boolean>(true);
  const [showMetadata, setShowMetadata] = useState<boolean>(true);
  const [metaExpanded, setMetaExpanded] = useState<boolean>(false);
  const [volume, setVolume] = useState<number>(0.75);
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
  const suppressNextClickRef = useRef<boolean>(false);

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
    setMetaExpanded(false);
  }, [entry?.id]);

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

    // 2. Vertical Bar / Beat Grid
    if (parsed && parsed.totalTicks > 0) {
      const ts = parsed.timeSignatures[0] || { numerator: 4, denominator: 4 };
      const ticksPerBeat = parsed.ppqn * (4 / ts.denominator);
      const ticksPerBar = ticksPerBeat * ts.numerator;
      const totalBars = Math.max(1, Math.ceil(parsed.totalTicks / Math.max(1, ticksPerBar)));

      const pxPerTick = virtualWidth / parsed.totalTicks;
      const barPx = ticksPerBar * pxPerTick;
      const barStep = barPx < 22 ? Math.ceil(22 / Math.max(1, barPx)) : 1;

      for (let b = 0; b <= totalBars; b++) {
        const tick = b * ticksPerBar;
        const x = PIANO_GUTTER_WIDTH + tick * pxPerTick - clampedScrollX;
        if (x < PIANO_GUTTER_WIDTH - 2 || x > size.width + 2) continue;

        const isMajor = b % barStep === 0;
        if (isMajor) {
          ctx.fillStyle = b % 4 === 0 ? '#2b363f' : '#202930';
          ctx.fillRect(Math.round(x), plotTop, 1, plotHeight + VELOCITY_HEIGHT);
        }

        // Beat lines when zoomed in enough
        if (barPx > 56 && b < totalBars) {
          ctx.fillStyle = '#192127';
          for (let beatIdx = 1; beatIdx < ts.numerator; beatIdx++) {
            const bx = x + beatIdx * ticksPerBeat * pxPerTick;
            if (bx >= PIANO_GUTTER_WIDTH && bx <= size.width) {
              ctx.fillRect(Math.round(bx), plotTop, 1, plotHeight);
            }
          }
        }
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

    if (parsed && parsed.totalTicks > 0) {
      const ts = parsed.timeSignatures[0] || { numerator: 4, denominator: 4 };
      const ticksPerBar = parsed.ppqn * ts.numerator * (4 / ts.denominator);
      const totalBars = Math.max(1, Math.ceil(parsed.totalTicks / Math.max(1, ticksPerBar)));
      const pxPerTick = virtualWidth / parsed.totalTicks;
      const barPx = ticksPerBar * pxPerTick;
      const labelStep = barPx < 36 ? Math.ceil(36 / Math.max(1, barPx)) : 1;

      ctx.font = '500 10px "JetBrains Mono", monospace';
      ctx.textBaseline = 'middle';

      for (let b = 0; b < totalBars; b++) {
        if (b % labelStep !== 0) continue;
        const x = PIANO_GUTTER_WIDTH + b * ticksPerBar * pxPerTick - clampedScrollX;
        if (x < PIANO_GUTTER_WIDTH - 24 || x > size.width) continue;

        ctx.fillStyle = '#38434e';
        ctx.fillRect(Math.round(x), RULER_HEIGHT - 6, 1, 5);
        ctx.fillStyle = '#8b95a2';
        ctx.fillText(`${b + 1}`, Math.round(x) + 4, RULER_HEIGHT / 2);
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
          ? (playback.currentSec / parsed.totalDurationSec) * parsed.totalTicks
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

    // 9. Playhead Line
    if (parsed && parsed.totalDurationSec > 0 && (playback.isPlaying || playback.currentSec > 0)) {
      const ratio = Math.max(0, Math.min(1, playback.currentSec / parsed.totalDurationSec));
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
      const ts = parsed.timeSignatures[0] || { numerator: 4, denominator: 4 };
      const ticksPerBar = parsed.ppqn * ts.numerator * (4 / ts.denominator);
      if (ticksPerBar > 0) {
        clamped = Math.min(
          parsed.totalTicks,
          Math.max(0, Math.round(clamped / ticksPerBar) * ticksPerBar)
        );
      }
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
    onSeek(ratio * parsed.totalDurationSec);
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
              <div className="flex items-center gap-1.5">
                <input
                  ref={renameInputRef}
                  type="text"
                  value={renameBase}
                  disabled={renameBusy}
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
                  className="px-2.5 py-1 text-sm font-medium rounded bg-[#13161a] border border-[#4ea1d3] text-white focus:outline-none min-w-[200px] max-w-[360px] flex-1"
                  aria-label="Neuer Dateiname"
                />
                <span className="text-xs font-mono text-[#7f8895]">
                  {/\.(mid|midi)$/i.test(renameBase.trim()) ? '' : splitExtension(entry.name).ext}
                </span>
                <button
                  type="submit"
                  disabled={renameBusy}
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
                className="p-1 rounded text-[#838d9b] hover:text-[#7cc4f0] hover:bg-[#272d36] transition-colors shrink-0"
                title="Datei umbenennen (F2)"
                aria-label="Datei umbenennen"
              >
                <Pencil className="w-3.5 h-3.5" />
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
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[#919aa6] font-mono tabular-nums">
              {entry.folderPath && (
                <>
                  <span className="text-[#78828f] truncate max-w-[180px]">{entry.folderPath}</span>
                  <span aria-hidden="true">·</span>
                </>
              )}
              <span className={parsed.notes.length === 0 ? 'text-rose-400 font-medium' : 'text-[#c9d2dc]'}>
                {parsed.notes.length} Noten
              </span>
              <span aria-hidden="true">·</span>
              <span>{parsed.barCount} Takte</span>
              <span aria-hidden="true">·</span>
              <span>{formatDuration(parsed.totalDurationSec)}</span>
              <span aria-hidden="true">·</span>
              <span>{parsed.primaryBpm} BPM</span>
              <span aria-hidden="true">·</span>
              <span>{parsed.primaryTimeSignature}</span>
              <span aria-hidden="true">·</span>
              <span>
                {parsed.trackCount} {parsed.trackCount === 1 ? 'Spur' : 'Spuren'}
              </span>
              {parsed.notes.length > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    {midiPitchToName(parsed.minPitch)}–{midiPitchToName(parsed.maxPitch)}
                  </span>
                </>
              )}
              {harmony?.isPercussionOnly && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-[#8fc8e8]">Drums / Percussion</span>
                </>
              )}
              {harmony?.key && (
                <>
                  <span aria-hidden="true">·</span>
                  <span
                    className="text-[#8fc8e8] font-medium"
                    title={`Parallele Tonart: ${harmony.key.relativeLabel}${
                      harmony.secondaryKey ? ` · Ebenfalls nah: ${harmony.secondaryKey}` : ''
                    }`}
                  >
                    Tonart: {harmony.key.label} ({harmony.key.confidence}%)
                  </span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <span>{formatBytes(entry.sizeBytes)}</span>
            </div>
          ) : (
            <div className="mt-1 text-xs text-rose-400">
              {entry.parseError || 'MIDI-Datei konnte nicht gelesen werden.'}
            </div>
          )}
        </div>

        {/* View Controls (Trim / Zoom / Pitch Fit / Track Colors / Velocity) */}
        <div className="flex flex-wrap items-center gap-1.5 shrink-0">
          {parsed && parsed.notes.length > 0 && parsed.firstNoteTick > 0 && (
            <button
              type="button"
              disabled={trimBusy}
              onClick={async () => {
                setTrimBusy(true);
                try {
                  await onTrimMidi(entry, parsed.firstNoteTick, null);
                  setTrimMode(false);
                  setTrimNotice(
                    `Vorlauf bis zur 1. Note entfernt (−${parsed.firstNoteSec.toFixed(1)} s).`
                  );
                } finally {
                  setTrimBusy(false);
                }
              }}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border bg-[#233340] border-[#4ea1d3]/70 text-[#d8ecfa] hover:bg-[#2b4050] transition-colors whitespace-nowrap"
              title={`Schneidet die Stille vor der 1. Note ab (${parsed.firstNoteSec.toFixed(1)} s / ${parsed.leadingBars} Takte)`}
            >
              <Scissors className="w-3.5 h-3.5 text-[#5eb1e6]" />
              Auf 1. Note kürzen
            </button>
          )}

          {parsed && parsed.notes.length > 0 && (
            <button
              type="button"
              disabled={trimBusy}
              onClick={runSmartTrimSilence}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border bg-[#233340] border-[#4ea1d3]/70 text-[#d8ecfa] hover:bg-[#2b4050] disabled:opacity-40 transition-colors whitespace-nowrap"
              title="Analysiert die MIDI-Datei automatisch auf führende Stille und schlägt den optimalen Schnittpunkt vor"
            >
              <Wand2 className="w-3.5 h-3.5 text-[#5eb1e6]" />
              Smart Trim Silence
            </button>
          )}

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
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border transition-colors whitespace-nowrap ${
                trimMode
                  ? 'bg-[#2a333f] border-[#4ea1d3]/70 text-[#d8e9f5]'
                  : 'bg-[#22272f] border-[#313844] text-[#9aa3b0] hover:text-white'
              }`}
              title="Start- und End-Schnittpunkte frei in der Piano-Roll setzen"
            >
              <Scissors className="w-3.5 h-3.5" />
              Trimmen
            </button>
          )}

          {parsed && parsed.notes.length > 0 && (
            <button
              type="button"
              onClick={() => onOpenTrainingTxt(entry)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border bg-[#222c28] border-emerald-600/60 text-emerald-200 hover:bg-[#293832] transition-colors whitespace-nowrap"
              title="Erstellt eine strukturierte .txt-Beschreibungsdatei (Tonart, Stil, Spuren, Abschnitte) für dein MIDI-Training"
            >
              <FileText className="w-3.5 h-3.5 text-emerald-400" />
              Training-TXT
            </button>
          )}

          <button
            type="button"
            onClick={() => setColorByTrack((v) => !v)}
            className={`px-2.5 py-1.5 text-xs font-medium rounded border transition-colors whitespace-nowrap ${
              colorByTrack
                ? 'bg-[#2a333f] border-[#4ea1d3]/60 text-[#d8e9f5]'
                : 'bg-[#22272f] border-[#313844] text-[#9aa3b0] hover:text-white'
            }`}
            title="Spuren unterschiedlich einfärben"
          >
            Spurfarben
          </button>
          <button
            type="button"
            onClick={() => setFullPitchRange((v) => !v)}
            className={`px-2.5 py-1.5 text-xs font-medium rounded border transition-colors whitespace-nowrap ${
              fullPitchRange
                ? 'bg-[#2a333f] border-[#4ea1d3]/60 text-[#d8e9f5]'
                : 'bg-[#22272f] border-[#313844] text-[#9aa3b0] hover:text-white'
            }`}
            title="Zwischen Auto-Fokus und vollem 88-Tasten-Bereich wechseln"
          >
            {fullPitchRange ? '88 Tasten' : 'Auto-Fokus'}
          </button>
          <button
            type="button"
            onClick={() => setShowVelocity((v) => !v)}
            className={`px-2.5 py-1.5 text-xs font-medium rounded border transition-colors whitespace-nowrap ${
              showVelocity
                ? 'bg-[#2a333f] border-[#4ea1d3]/60 text-[#d8e9f5]'
                : 'bg-[#22272f] border-[#313844] text-[#9aa3b0] hover:text-white'
            }`}
          >
            Velocity
          </button>
          <button
            type="button"
            onClick={() => setShowChords((v) => !v)}
            className={`px-2.5 py-1.5 text-xs font-medium rounded border transition-colors whitespace-nowrap ${
              showChords
                ? 'bg-[#2a333f] border-[#4ea1d3]/60 text-[#d8e9f5]'
                : 'bg-[#22272f] border-[#313844] text-[#9aa3b0] hover:text-white'
            }`}
            title="Tonart und erkannte Akkordfolge ein- oder ausblenden"
          >
            Akkorde
          </button>
          {parsed && parsed.metadata.totalCount > 0 && (
            <button
              type="button"
              onClick={() => setShowMetadata((v) => !v)}
              className={`px-2.5 py-1.5 text-xs font-medium rounded border transition-colors whitespace-nowrap ${
                showMetadata
                  ? 'bg-[#2a333f] border-[#4ea1d3]/60 text-[#d8e9f5]'
                  : 'bg-[#22272f] border-[#313844] text-[#9aa3b0] hover:text-white'
              }`}
              title="Eingebettete MIDI-Metadaten (Copyright, Marker, Text-Events) ein- oder ausblenden"
            >
              Metadaten ({parsed.metadata.totalCount})
            </button>
          )}

          <div className="flex items-center bg-[#22272f] border border-[#313844] rounded ml-1">
            <button
              type="button"
              onClick={() => setZoomX((z) => Math.max(1, Number((z / 1.5).toFixed(2))))}
              disabled={zoomX <= 1}
              className="p-1.5 text-[#9aa3b0] hover:text-white disabled:opacity-35 transition-colors"
              title="Herauszoomen"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <span className="px-1.5 text-[11px] font-mono tabular-nums text-[#b9c1cc] min-w-[38px] text-center">
              {zoomX.toFixed(1)}×
            </span>
            <button
              type="button"
              onClick={() => setZoomX((z) => Math.min(12, Number((z * 1.5).toFixed(2))))}
              disabled={zoomX >= 12}
              className="p-1.5 text-[#9aa3b0] hover:text-white disabled:opacity-35 transition-colors"
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
                className="p-1.5 text-[#9aa3b0] hover:text-white border-l border-[#313844] transition-colors"
                title="Ganze Datei einpassen"
              >
                <Maximize2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Interactive Harmony / Chord Progression Strip */}
      {showChords && parsed && harmony && (harmony.key || harmony.chords.length > 0) && (
        <div className="px-4 py-1.5 bg-[#181d23] border-b border-[#27303a] flex items-center gap-2.5 overflow-x-auto shrink-0">
          <div className="flex items-center gap-1.5 text-xs text-[#9fb2c7] shrink-0">
            <Music2 className="w-3.5 h-3.5 text-[#5eb1e6]" />
            {harmony.key && (
              <span className="font-medium text-[#dce8f5] whitespace-nowrap">
                {harmony.key.label}
              </span>
            )}
            {harmony.key && (
              <span
                className="text-[11px] font-mono text-[#7c8c9e] whitespace-nowrap"
                title="Relative Paralleltonart"
              >
                ({harmony.key.relativeLabel})
              </span>
            )}
          </div>

          {harmony.chords.length > 0 && (() => {
            const playTick =
              parsed.totalDurationSec > 0 && (playback.isPlaying || playback.currentSec > 0)
                ? (playback.currentSec / parsed.totalDurationSec) * parsed.totalTicks
                : -1;

            return (
              <>
                <span className="text-[#36414d] select-none shrink-0">|</span>
                <div className="flex items-center gap-1 min-w-0">
                  {harmony.chords.slice(0, 32).map((ch, idx) => {
                    const isActive = playTick >= ch.startTick && playTick < ch.endTick;
                    return (
                      <React.Fragment key={`${ch.startTick}-${ch.symbol}-${idx}`}>
                        {idx > 0 && (
                          <span className="text-[#4a5665] text-[10px] select-none">→</span>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            if (parsed.totalTicks > 0 && parsed.totalDurationSec > 0) {
                              onSeek((ch.startTick / parsed.totalTicks) * parsed.totalDurationSec);
                            }
                          }}
                          className={`px-1.5 py-0.5 rounded border text-[11px] font-mono font-semibold transition-colors whitespace-nowrap shrink-0 ${
                            isActive
                              ? 'bg-[#2c4a63] border-[#5eb1e6] text-white'
                              : 'bg-[#212933] hover:bg-[#2b3746] border-[#313d4a] text-[#cde7fb]'
                          }`}
                          title={`Takt ${ch.startBar} · Zum Akkord springen`}
                        >
                          {ch.symbol}
                        </button>
                      </React.Fragment>
                    );
                  })}
                  {harmony.chords.length > 32 && (
                    <span className="text-[11px] font-mono text-[#7c8c9e] ml-1 whitespace-nowrap">
                      +{harmony.chords.length - 32} weitere
                    </span>
                  )}
                </div>
              </>
            );
          })()}

          {harmony.chords.length === 0 && !harmony.isPercussionOnly && (
            <span className="text-[11px] text-[#7c8c9e] whitespace-nowrap">
              Einzelmelodie / zu wenig gleichzeitige Harmonien für Akkorderkennung
            </span>
          )}
        </div>
      )}

      {/* MIDI Metadata Summary Bar & Expandable Inspector */}
      {showMetadata && parsed && parsed.metadata.totalCount > 0 && (() => {
        const md = parsed.metadata;
        const ts = parsed.timeSignatures[0] || { numerator: 4, denominator: 4 };
        const ticksPerBar = Math.max(1, parsed.ppqn * ts.numerator * (4 / ts.denominator));
        const formatTickBar = (tick: number) => Math.floor(tick / ticksPerBar) + 1;

        return (
          <div className="bg-[#171c22] border-b border-[#27303a] shrink-0">
            {/* Compact 1-line summary bar */}
            <div className="px-4 py-1.5 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0 overflow-x-auto text-xs">
                {md.copyright.length > 0 && (
                  <span
                    className="inline-flex items-center gap-1.5 text-[#c9d4e0] whitespace-nowrap shrink-0"
                    title={md.copyright.join(' · ')}
                  >
                    <Copyright className="w-3.5 h-3.5 text-[#7ea8c9] shrink-0" />
                    <span className="truncate max-w-[240px]">{md.copyright[0]}</span>
                  </span>
                )}

                {md.instruments.length > 0 && (
                  <span
                    className="inline-flex items-center gap-1.5 text-[#9eb0c4] whitespace-nowrap shrink-0"
                    title={`Instrumente: ${md.instruments.join(', ')}`}
                  >
                    <FileText className="w-3.5 h-3.5 text-[#6d94b5] shrink-0" />
                    <span className="truncate max-w-[200px]">{md.instruments.join(', ')}</span>
                  </span>
                )}

                {md.markers.length > 0 && (
                  <div className="flex items-center gap-1 shrink-0">
                    <Bookmark className="w-3.5 h-3.5 text-[#e6b450] mr-0.5 shrink-0" />
                    {md.markers.slice(0, 8).map((mk, idx) => (
                      <button
                        key={`${mk.tick}-${mk.text}-${idx}`}
                        type="button"
                        onClick={() => onSeek(mk.sec)}
                        className="px-1.5 py-0.5 rounded bg-[#25221a] hover:bg-[#332e21] border border-[#4c4025] text-[11px] font-mono text-[#f3cf7a] transition-colors whitespace-nowrap"
                        title={`Takt ${formatTickBar(mk.tick)} (${formatDuration(mk.sec)}) · Zu Marker springen`}
                      >
                        {mk.text}
                      </button>
                    ))}
                    {md.markers.length > 8 && (
                      <span className="text-[11px] font-mono text-[#8b95a3] whitespace-nowrap">
                        +{md.markers.length - 8}
                      </span>
                    )}
                  </div>
                )}

                {md.textEvents.length > 0 && md.copyright.length === 0 && md.markers.length === 0 && (
                  <span
                    className="inline-flex items-center gap-1.5 text-[#b5c2d1] truncate"
                    title={md.textEvents[0].text}
                  >
                    <FileText className="w-3.5 h-3.5 text-[#7ea8c9] shrink-0" />
                    <span className="truncate max-w-[360px]">{md.textEvents[0].text}</span>
                  </span>
                )}

                {md.embeddedKeySignature && (
                  <span className="text-[11px] font-mono text-[#8495a8] whitespace-nowrap shrink-0">
                    MIDI-Tonart: {md.embeddedKeySignature}
                  </span>
                )}
              </div>

              <button
                type="button"
                onClick={() => setMetaExpanded((v) => !v)}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium text-[#9fb2c7] hover:text-white bg-[#20262f] hover:bg-[#2a323d] border border-[#2f3845] transition-colors whitespace-nowrap shrink-0"
              >
                <span>{metaExpanded ? 'Weniger' : `Alle Metadaten (${md.totalCount})`}</span>
                {metaExpanded ? (
                  <ChevronUp className="w-3 h-3" />
                ) : (
                  <ChevronDown className="w-3 h-3" />
                )}
              </button>
            </div>

            {/* Expanded Metadata Inspector Panel */}
            {metaExpanded && (
              <div className="px-4 py-2.5 bg-[#13171c] border-t border-[#232b35] max-h-48 overflow-y-auto grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2.5 text-xs">
                {(md.copyright.length > 0 ||
                  md.sequenceName ||
                  md.instruments.length > 0 ||
                  md.embeddedKeySignature) && (
                  <div className="space-y-1.5">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-[#728296]">
                      Datei- &amp; Werkangaben
                    </div>
                    {md.sequenceName && (
                      <div className="flex gap-2">
                        <span className="text-[#798696] w-24 shrink-0">Titel / Sequenz:</span>
                        <span className="text-[#dce4ee] break-words">{md.sequenceName}</span>
                      </div>
                    )}
                    {md.copyright.map((c, idx) => (
                      <div key={idx} className="flex gap-2">
                        <span className="text-[#798696] w-24 shrink-0">Copyright:</span>
                        <span className="text-[#dce4ee] break-words">{c}</span>
                      </div>
                    ))}
                    {md.instruments.length > 0 && (
                      <div className="flex gap-2">
                        <span className="text-[#798696] w-24 shrink-0">Instrumente:</span>
                        <span className="text-[#c5d1de] break-words">{md.instruments.join(', ')}</span>
                      </div>
                    )}
                    {md.embeddedKeySignature && (
                      <div className="flex gap-2">
                        <span className="text-[#798696] w-24 shrink-0">MIDI Key-Tag:</span>
                        <span className="text-[#8fc8e8] font-mono">{md.embeddedKeySignature}</span>
                      </div>
                    )}
                  </div>
                )}

                {(md.markers.length > 0 ||
                  md.cues.length > 0 ||
                  md.textEvents.length > 0 ||
                  md.lyrics.length > 0) && (
                  <div className="space-y-1.5">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-[#728296]">
                      Zeitbezogene Events (Marker, Text, Cue, Lyrics)
                    </div>
                    <div className="space-y-1">
                      {[...md.markers, ...md.cues, ...md.textEvents, ...md.lyrics]
                        .sort((a, b) => a.tick - b.tick)
                        .map((ev, idx) => {
                          const typeLabel =
                            ev.type === 'marker'
                              ? 'Marker'
                              : ev.type === 'cue'
                              ? 'Cue'
                              : ev.type === 'lyric'
                              ? 'Lyric'
                              : 'Text';
                          const typeColor =
                            ev.type === 'marker'
                              ? 'text-[#f3cf7a]'
                              : ev.type === 'cue'
                              ? 'text-[#5fd4c2]'
                              : 'text-[#8fc8e8]';

                          return (
                            <button
                              key={`${ev.type}-${ev.tick}-${idx}`}
                              type="button"
                              onClick={() => onSeek(ev.sec)}
                              className="w-full text-left flex items-baseline gap-2 px-1.5 py-0.5 rounded hover:bg-[#1e252e] transition-colors"
                              title="Klicken, um zu dieser Stelle zu springen"
                            >
                              <span className="font-mono tabular-nums text-[11px] text-[#7c8a9b] shrink-0">
                                T{formatTickBar(ev.tick)} · {formatDuration(ev.sec)}
                              </span>
                              <span className={`font-mono text-[11px] shrink-0 w-12 ${typeColor}`}>
                                {typeLabel}
                              </span>
                              <span className="text-[#d6dfe9] break-words">{ev.text}</span>
                            </button>
                          );
                        })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* Duplicate / Variant Comparison Strip */}
      {duplicateInfo && duplicateInfo.peers.length > 0 && (
        <div className="px-4 py-1.5 bg-[#1b1f27] border-b border-[#2b313a] flex flex-wrap items-center gap-2 text-xs shrink-0">
          <span
            className={`inline-flex items-center gap-1.5 font-medium shrink-0 ${
              duplicateInfo.kind === 'exact' ? 'text-amber-300' : 'text-violet-300'
            }`}
          >
            <Copy className="w-3.5 h-3.5" />
            Gruppe #{duplicateInfo.groupId} ·{' '}
            {duplicateInfo.kind === 'exact' ? 'Exaktes Duplikat' : 'Ähnliche Variante'} (
            {duplicateInfo.similarity}%)
          </span>
          <span className="text-[#6f7885]">·</span>
          <span className="text-[11px] text-[#8d96a4]">Vergleichen mit:</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {duplicateInfo.peers.map((peer) => (
              <button
                key={peer.id}
                type="button"
                onClick={() => onSelectEntry?.(peer.id)}
                className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-[#232933] hover:bg-[#2d3542] border border-[#343d4b] text-[11px] text-[#d6dfeb] transition-colors whitespace-nowrap"
                title={`Zu ${peer.name} springen (${peer.similarity}% Ähnlichkeit)`}
              >
                <span className="truncate max-w-[180px]">
                  {peer.name.replace(/\.(mid|midi)$/i, '')}
                </span>
                <span className="font-mono text-[10px] text-[#7ea8c9]">{peer.similarity}%</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Interactive Trim Control Strip */}
      {trimMode && parsed && (() => {
        const ts = parsed.timeSignatures[0] || { numerator: 4, denominator: 4 };
        const ticksPerBar = Math.max(1, parsed.ppqn * ts.numerator * (4 / ts.denominator));
        const startBar = (trimStartTick / ticksPerBar + 1).toFixed(1).replace('.0', '');
        const endTickVal = trimEndTick ?? parsed.totalTicks;
        const endBar = (endTickVal / ticksPerBar + 1).toFixed(1).replace('.0', '');

        return (
          <div className="px-4 py-2 bg-[#1a222b] border-b border-[#2e3b49] space-y-1.5 shrink-0">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={trimBusy}
                  onClick={runSmartTrimSilence}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium bg-[#253b4d] hover:bg-[#2f4b61] border border-[#5eb1e6]/70 text-[#e2f2ff] disabled:opacity-40 transition-colors whitespace-nowrap"
                  title="MIDI-Buffer erneut analysieren und optimalen Schnittpunkt vorschlagen"
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
                    >
                      <Save className="w-3 h-3" />
                      Als Kopie speichern
                    </button>
                    <button
                      type="button"
                      disabled={trimBusy}
                      onClick={async () => {
                        setTrimBusy(true);
                        try {
                          await onOverwriteOriginal(entry);
                          setTrimNotice('Originaldatei auf der Festplatte überschrieben.');
                        } finally {
                          setTrimBusy(false);
                        }
                      }}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-xs font-medium text-white transition-colors whitespace-nowrap"
                    >
                      <Save className="w-3 h-3" />
                      Original überschreiben
                    </button>
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

      {/* Diagnostic Issues Strip (only shown if parser found completeness problems) */}
      {parsed && parsed.issues.length > 0 && (
        <div
          className={`px-4 py-2 border-b flex flex-wrap items-center gap-x-4 gap-y-1 text-xs shrink-0 ${
            parsed.hasErrors
              ? 'bg-rose-950/35 border-rose-900/50 text-rose-200'
              : 'bg-amber-950/30 border-amber-900/40 text-amber-200'
          }`}
        >
          {parsed.issues.map((issue) => (
            <div key={issue.code} className="flex items-center gap-1.5" title={issue.detail}>
              {issue.severity === 'error' ? (
                <XCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
              ) : (
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              )}
              <span className="font-medium">{issue.label}:</span>
              <span className="opacity-85">{issue.detail}</span>
            </div>
          ))}
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
            {formatDuration(playback.currentSec)} / {formatDuration(playback.totalSec)}
          </div>

          <label className="hidden sm:inline-flex items-center gap-1.5 text-xs text-[#9ba4b0] cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoPlay}
              onChange={onToggleAutoPlay}
              className="rounded border-[#434c59] bg-[#16191d] accent-[#4ea1d3]"
            />
            Auto-Play
          </label>

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

          {canWriteToDisk && onImmediateMoveToSorted && (
            <button
              type="button"
              onClick={() => onImmediateMoveToSorted(entry)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-rose-700/80 hover:bg-rose-600 text-white transition-colors whitespace-nowrap"
              title="Datei sofort in den Unterordner _Aussortiert verschieben"
            >
              Sofort verschieben
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
