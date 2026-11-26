import type { MidiFileEntry, MidiNote, ParsedMidi } from '../types/midi';
import {
  DEFAULT_ABBREVIATIONS,
  type LibraryAbbreviation,
} from './abbreviationProfile';
import { getGmProgramName, getMidiCcLabel } from './midiConstants';
import { analyzeMidiHarmony } from './musicTheory';

export interface TrainingTxtSection {
  name: string;
  vonTakt: number;
  bisTakt: number;
}

export interface TrainingTxtDraft {
  titel: string;
  status: string;
  hauptstil: string;
  substil: string[];
  grundton: string;
  modus: string;
  sicherheit: string;
  taktart: string;
  tempoBpm: number;
  stimmung: string[];
  meineBewertung: number;
  warumMagIch: string[];
  wichtigeSpuren: {
    hauptmelodie: string[];
    gegenmelodie: string[];
    harmonie: string[];
    bass: string[];
    rhythmischesFundament: string[];
  };
  abschnitte: TrainingTxtSection[];
  besondereMerkmale: string[];
  libraryAbkuerzungen: Array<{ key: string; meaning: string }>;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractRootAndMode(parsed: ParsedMidi): {
  grundton: string;
  modus: string;
  sicherheit: string;
} {
  if (parsed.isPercussionOnly) {
    return { grundton: '-', modus: 'percussion', sicherheit: 'sicher' };
  }

  if (parsed.detectedKey) {
    const rawLabel = parsed.detectedKey.label;
    const rawRoot = rawLabel.replace(/-(Dur|Moll)$/i, '');
    const grundton = rawRoot.charAt(0).toUpperCase() + rawRoot.slice(1);
    const modus = parsed.detectedKey.mode;
    const conf = parsed.detectedKey.confidence;
    const sicherheit = conf >= 76 ? 'sicher' : conf >= 58 ? 'mittel' : 'unsicher';
    return { grundton, modus, sicherheit };
  }

  if (parsed.metadata.embeddedKeySignature) {
    const raw = parsed.metadata.embeddedKeySignature;
    const isMinor = /moll$/i.test(raw);
    const rawRoot = raw.replace(/-(Dur|Moll)$/i, '');
    return {
      grundton: rawRoot.charAt(0).toUpperCase() + rawRoot.slice(1),
      modus: isMinor ? 'minor' : 'major',
      sicherheit: 'sicher',
    };
  }

  return { grundton: 'C', modus: 'major', sicherheit: 'unsicher' };
}

function classifyTracks(
  entry: MidiFileEntry,
  parsed: ParsedMidi
): TrainingTxtDraft['wichtigeSpuren'] {
  const result: TrainingTxtDraft['wichtigeSpuren'] = {
    hauptmelodie: [],
    gegenmelodie: [],
    harmonie: [],
    bass: [],
    rhythmischesFundament: [],
  };

  const baseTitle = entry.name.replace(/\.(mid|midi)$/i, '');
  const notesByTrack = new Map<number, MidiNote[]>();
  for (const n of parsed.notes) {
    const arr = notesByTrack.get(n.trackIndex) || [];
    arr.push(n);
    notesByTrack.set(n.trackIndex, arr);
  }

  const melodicCandidates: Array<{
    name: string;
    avgPitch: number;
    noteCount: number;
    avgSimul: number;
  }> = [];

  for (const tr of parsed.tracks) {
    if (tr.noteCount === 0) continue;
    const trNotes = notesByTrack.get(tr.index) || [];
    const label =
      parsed.tracks.length === 1 && /^Spur \d+$/i.test(tr.name)
        ? baseTitle
        : tr.name;
    const lower = label.toLowerCase();

    const isDrumChannelOnly =
      tr.channels.length > 0 && tr.channels.every((ch) => ch === 9);
    const isPercName =
      /drum|perc|timpani|djun|dhol|taiko|snare|kick|hat|battery|cymbal|tom/i.test(
        lower
      );

    if (isDrumChannelOnly || isPercName) {
      result.rhythmischesFundament.push(label);
      continue;
    }

    let pitchSum = 0;
    for (const n of trNotes) pitchSum += n.pitch;
    const avgPitch = trNotes.length > 0 ? pitchSum / trNotes.length : 60;

    // Estimate average polyphony at note onsets
    let chordGroups = 0;
    let groupedNotes = 0;
    const bucketCounts = new Map<number, number>();
    const quant = Math.max(1, Math.round(parsed.ppqn / 4));
    for (const n of trNotes) {
      const b = Math.round(n.startTick / quant);
      bucketCounts.set(b, (bucketCounts.get(b) || 0) + 1);
    }
    for (const cnt of bucketCounts.values()) {
      chordGroups++;
      groupedNotes += cnt;
    }
    const avgSimul = chordGroups > 0 ? groupedNotes / chordGroups : 1;

    const isBassName = /\bbass\b|sub|contrabass|tuba|808/i.test(lower);
    const isHarmonyName =
      /pad|sus|ens|ensemble|chord|harm|choir|strings/i.test(lower) &&
      !/solo|lead|melod/i.test(lower);
    const isRhythmOstinato =
      /spic|stac|marc|ostinato|arp/i.test(lower) && avgPitch < 62;

    if (isBassName || (avgPitch < 48 && avgSimul < 1.6)) {
      result.bass.push(label);
    } else if (isRhythmOstinato) {
      result.rhythmischesFundament.push(label);
    } else if (isHarmonyName || avgSimul >= 2.15) {
      result.harmonie.push(label);
    } else {
      melodicCandidates.push({
        name: label,
        avgPitch,
        noteCount: tr.noteCount,
        avgSimul,
      });
    }
  }

  melodicCandidates.sort(
    (a, b) => b.avgPitch - a.avgPitch || b.noteCount - a.noteCount
  );

  for (let i = 0; i < melodicCandidates.length; i++) {
    if (i === 0) {
      result.hauptmelodie.push(melodicCandidates[i].name);
    } else if (i === 1) {
      result.gegenmelodie.push(melodicCandidates[i].name);
    } else {
      result.harmonie.push(melodicCandidates[i].name);
    }
  }

  return result;
}

function buildSections(parsed: ParsedMidi): TrainingTxtSection[] {
  const ts = parsed.timeSignatures[0] || { numerator: 4, denominator: 4 };
  const ticksPerBar = Math.max(1, parsed.ppqn * ts.numerator * (4 / ts.denominator));
  const totalBars = Math.max(1, parsed.barCount);

  // Use embedded MIDI markers when available
  if (parsed.metadata.markers.length > 0) {
    const markerBars = parsed.metadata.markers
      .map((m) => ({
        name: m.text,
        bar: Math.max(1, Math.min(totalBars, Math.floor(m.tick / ticksPerBar) + 1)),
      }))
      .sort((a, b) => a.bar - b.bar);

    const sections: TrainingTxtSection[] = [];
    if (markerBars[0].bar > 1) {
      sections.push({
        name: 'Vorlauf / Intro',
        vonTakt: 1,
        bisTakt: markerBars[0].bar - 1,
      });
    }
    for (let i = 0; i < markerBars.length; i++) {
      const cur = markerBars[i];
      const next = markerBars[i + 1];
      const bisTakt = next ? Math.max(cur.bar, next.bar - 1) : totalBars;
      sections.push({
        name: cur.name,
        vonTakt: cur.bar,
        bisTakt,
      });
    }
    return sections;
  }

  // Otherwise segment automatically from bar density curve
  if (totalBars <= 8) {
    return [{ name: 'Hauptteil', vonTakt: 1, bisTakt: totalBars }];
  }

  const barCounts = new Array<number>(totalBars).fill(0);
  for (const n of parsed.notes) {
    const b = Math.min(totalBars - 1, Math.max(0, Math.floor(n.startTick / ticksPerBar)));
    barCounts[b]++;
  }

  const introEnd = Math.max(2, Math.min(12, Math.round(totalBars * 0.14)));
  const buildEnd = Math.max(introEnd + 2, Math.round(totalBars * 0.42));
  const bridgeEnd = Math.max(buildEnd + 2, Math.round(totalBars * 0.72));

  if (totalBars <= 24) {
    const mid = Math.max(2, Math.round(totalBars * 0.25));
    const endStart = Math.max(mid + 2, Math.round(totalBars * 0.75));
    return [
      { name: 'Intro', vonTakt: 1, bisTakt: mid },
      { name: 'Hauptteil', vonTakt: mid + 1, bisTakt: endStart - 1 },
      { name: 'Finale', vonTakt: endStart, bisTakt: totalBars },
    ];
  }

  return [
    { name: 'Intro', vonTakt: 1, bisTakt: introEnd },
    { name: 'Aufbau', vonTakt: introEnd + 1, bisTakt: buildEnd },
    { name: 'Bridge', vonTakt: buildEnd + 1, bisTakt: bridgeEnd },
    { name: 'Finale', vonTakt: bridgeEnd + 1, bisTakt: totalBars },
  ];
}

function inferStyleAndMood(
  entry: MidiFileEntry,
  parsed: ParsedMidi,
  modus: string
): { hauptstil: string; substil: string[]; stimmung: string[] } {
  const combinedText = [
    entry.relativePath,
    parsed.metadata.sequenceName || '',
    ...parsed.tracks.map((t) => t.name),
    ...parsed.metadata.instruments,
    ...parsed.metadata.textEvents.map((t) => t.text),
  ]
    .join(' ')
    .toLowerCase();

  let hauptstil = 'instrumental';
  const substil: string[] = [];

  if (
    /orchestr|string|cello|viol|brass|horn|trump|timpani|choir|ark|cs_|spic|stac|marc|leg|basson/i.test(
      combinedText
    )
  ) {
    hauptstil = 'orchestral';
    substil.push('cinematic');
    if (modus === 'minor') substil.push('dark');
    if (parsed.primaryBpm >= 115 || /spic|marc|epic|trailer|battl/i.test(combinedText)) {
      substil.push('trailer');
    }
  } else if (/piano|klavier|grand|keys/i.test(combinedText)) {
    hauptstil = 'piano';
    substil.push('soloklavier', modus === 'minor' ? 'melancholisch' : 'lyrisch');
  } else if (/drum|groove|beat|bass|synth|arp|edm|electro|techno/i.test(combinedText)) {
    hauptstil = 'electronic';
    if (/arp/i.test(combinedText)) substil.push('arpeggio');
    if (/bass|groove/i.test(combinedText)) substil.push('groove');
  } else {
    substil.push('melodie');
  }

  const stimmung: string[] = [];
  if (modus === 'minor') {
    if (parsed.primaryBpm >= 112) {
      stimmung.push('düster', 'dramatisch', 'treibend');
    } else {
      stimmung.push('traurig', 'ruhig', 'nachdenklich');
    }
  } else if (modus === 'percussion') {
    stimmung.push('rhythmisch', 'energetisch');
  } else {
    if (parsed.primaryBpm >= 112) {
      stimmung.push('energetisch', 'erhebend');
    } else {
      stimmung.push('warm', 'lyrisch');
    }
  }

  return { hauptstil, substil, stimmung };
}

function detectAbbreviations(
  entry: MidiFileEntry,
  parsed: ParsedMidi,
  profile: LibraryAbbreviation[]
): Array<{ key: string; meaning: string }> {
  const combined = [
    entry.name,
    ...parsed.tracks.map((t) => t.name),
    ...parsed.metadata.instruments,
  ].join(' ');
  const normalized = combined.replace(/[_-]+/g, ' ');

  const found: Array<{ key: string; meaning: string }> = [];
  const seen = new Set<string>();

  for (const item of profile) {
    const k = item.key.trim();
    if (!k) continue;
    const regex = new RegExp(`\\b${escapeRegExp(k)}\\b`, 'i');
    if (regex.test(normalized) && !seen.has(k.toLowerCase())) {
      seen.add(k.toLowerCase());
      found.push({ key: k, meaning: item.meaning });
    }
  }

  return found;
}

export function buildTrainingTxtDraft(
  entry: MidiFileEntry,
  customAbbreviations?: LibraryAbbreviation[]
): TrainingTxtDraft {
  const parsed = entry.parsed;
  const titel = entry.name.replace(/\.(mid|midi)$/i, '');

  if (!parsed) {
    return {
      titel,
      status: 'unvollständig',
      hauptstil: 'unbekannt',
      substil: [],
      grundton: 'C',
      modus: 'major',
      sicherheit: 'unsicher',
      taktart: '4/4',
      tempoBpm: 120,
      stimmung: [],
      meineBewertung: 5,
      warumMagIch: [],
      wichtigeSpuren: {
        hauptmelodie: [],
        gegenmelodie: [],
        harmonie: [],
        bass: [],
        rhythmischesFundament: [],
      },
      abschnitte: [{ name: 'Hauptteil', vonTakt: 1, bisTakt: 1 }],
      besondereMerkmale: ['Datei konnte nicht vollständig geparst werden'],
      libraryAbkuerzungen: [],
    };
  }

  const profile =
    customAbbreviations && customAbbreviations.length > 0
      ? customAbbreviations
      : DEFAULT_ABBREVIATIONS;

  const { grundton, modus, sicherheit } = extractRootAndMode(parsed);
  const { hauptstil, substil, stimmung } = inferStyleAndMood(entry, parsed, modus);
  const wichtigeSpuren = classifyTracks(entry, parsed);
  const abschnitte = buildSections(parsed);
  const libraryAbkuerzungen = detectAbbreviations(entry, parsed, profile);

  const status =
    parsed.hasErrors || entry.triage === 'discard'
      ? 'unvollständig'
      : parsed.hasWarnings || parsed.barCount < 8
      ? 'skizze'
      : 'final';

  const harmony = analyzeMidiHarmony(
    parsed.notes,
    parsed.ppqn,
    parsed.timeSignatures,
    parsed.totalTicks
  );

  const besondereMerkmale: string[] = [];
  if (harmony.progressionSummary.length >= 2) {
    const seq = harmony.progressionSummary.slice(0, 8).join(' → ');
    besondereMerkmale.push(`Akkordfolge: ${seq}`);
  }

  // Short rhythmic ostinato check
  if (parsed.notes.length >= 16) {
    const shortNotes = parsed.notes.filter((n) => n.durationSec <= 0.25).length;
    if (shortNotes / parsed.notes.length >= 0.65) {
      besondereMerkmale.push('Kurze rhythmische Noten / Ostinato-Charakter');
    }
  }

  // Late-entering tracks check (e.g. instrumentation buildup)
  const lateThresholdTick = parsed.totalTicks * 0.25;
  const lateTracks: string[] = [];
  for (const tr of parsed.tracks) {
    if (tr.noteCount === 0) continue;
    const firstNote = parsed.notes.find((n) => n.trackIndex === tr.index);
    if (firstNote && firstNote.startTick > lateThresholdTick && parsed.tracks.length > 1) {
      lateTracks.push(tr.name);
    }
  }
  if (lateTracks.length > 0) {
    besondereMerkmale.push(
      `Späterer Einsatz von ${lateTracks.slice(0, 3).join(', ')} im Verlauf`
    );
  }

  // Dynamic velocity range check
  if (parsed.notes.length > 0) {
    let minVel = 127;
    let maxVel = 0;
    for (const n of parsed.notes) {
      if (n.velocity < minVel) minVel = n.velocity;
      if (n.velocity > maxVel) maxVel = n.velocity;
    }
    if (maxVel - minVel >= 45) {
      besondereMerkmale.push(`Große Dynamikspanne (Velocity ${minVel}–${maxVel})`);
    }
  }

  if (parsed.leadingBars >= 1) {
    besondereMerkmale.push(`Vorlauf von ${parsed.leadingBars} Takt(en) vor der ersten Note`);
  }

  if (parsed.metadata.textEvents.length > 0) {
    besondereMerkmale.push(`MIDI-Notiz: ${parsed.metadata.textEvents[0].text}`);
  }

  if (parsed.performance.programChanges.length > 0) {
    const uniqueProgs = Array.from(
      new Set(parsed.performance.programChanges.map((p) => p.program))
    ).slice(0, 4);
    besondereMerkmale.push(
      `GM-Programme: ${uniqueProgs.map((p) => getGmProgramName(p)).join(', ')}`
    );
  }

  const exprParts: string[] = [];
  if (parsed.performance.controlChanges.length > 0) {
    const distinctCcs = Array.from(
      new Set(parsed.performance.controlChanges.map((c) => c.controller))
    ).slice(0, 4);
    exprParts.push(
      `CC (${distinctCcs.map((cc) => `${cc} ${getMidiCcLabel(cc)}`).join(', ')})`
    );
  }
  if (parsed.performance.pitchBends.length > 0) {
    exprParts.push(`Pitch Bend (${parsed.performance.pitchBends.length}×)`);
  }
  if (parsed.performance.aftertouch.length > 0) {
    exprParts.push(`Aftertouch (${parsed.performance.aftertouch.length}×)`);
  }
  if (exprParts.length > 0) {
    besondereMerkmale.push(`Expression / Controller: ${exprParts.join(' · ')}`);
  }

  const warumMagIch: string[] = [];
  if (parsed.trackCount > 1) {
    warumMagIch.push(`Mehrspuriges Arrangement (${parsed.trackCount} Spuren)`);
  } else {
    warumMagIch.push('Klare musikalische Grundidee');
  }
  if (harmony.progressionSummary.length >= 3) {
    warumMagIch.push('Abwechslungsreiche Harmonik');
  }

  return {
    titel,
    status,
    hauptstil,
    substil,
    grundton,
    modus,
    sicherheit,
    taktart: parsed.primaryTimeSignature,
    tempoBpm: Math.round(parsed.primaryBpm),
    stimmung,
    meineBewertung: entry.triage === 'keep' ? 9 : parsed.hasErrors ? 3 : 7,
    warumMagIch,
    wichtigeSpuren,
    abschnitte,
    besondereMerkmale,
    libraryAbkuerzungen,
  };
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

export function serializeTrainingTxt(draft: TrainingTxtDraft): string {
  const lines: string[] = [];

  lines.push(`titel: ${yamlStr(draft.titel)}`);
  lines.push(`status: ${yamlStr(draft.status)}`);
  lines.push('');

  lines.push(`hauptstil: ${yamlStr(draft.hauptstil)}`);
  pushYamlList(lines, 'substil', draft.substil);
  lines.push('');

  lines.push('tonart:');
  lines.push(`  grundton: ${yamlStr(draft.grundton)}`);
  lines.push(`  modus: ${yamlStr(draft.modus)}`);
  lines.push(`  sicherheit: ${yamlStr(draft.sicherheit)}`);
  lines.push('');

  lines.push(`taktart: ${yamlStr(draft.taktart)}`);
  lines.push(`tempo_bpm: ${draft.tempoBpm}`);
  lines.push('');

  pushYamlList(lines, 'stimmung', draft.stimmung);
  lines.push('');

  lines.push(`meine_bewertung: ${draft.meineBewertung}`);
  pushYamlList(lines, 'warum_ich_das_projekt_mag', draft.warumMagIch);
  lines.push('');

  lines.push('wichtige_spuren:');
  pushYamlList(lines, 'hauptmelodie', draft.wichtigeSpuren.hauptmelodie, '  ');
  pushYamlList(lines, 'gegenmelodie', draft.wichtigeSpuren.gegenmelodie, '  ');
  pushYamlList(lines, 'harmonie', draft.wichtigeSpuren.harmonie, '  ');
  pushYamlList(lines, 'bass', draft.wichtigeSpuren.bass, '  ');
  pushYamlList(
    lines,
    'rhythmisches_fundament',
    draft.wichtigeSpuren.rhythmischesFundament,
    '  '
  );
  lines.push('');

  lines.push('abschnitte:');
  for (const sec of draft.abschnitte) {
    lines.push(`  - name: ${yamlStr(sec.name)}`);
    lines.push(`    von_takt: ${sec.vonTakt}`);
    lines.push(`    bis_takt: ${sec.bisTakt}`);
  }
  lines.push('');

  pushYamlList(lines, 'besondere_merkmale', draft.besondereMerkmale);
  lines.push('');

  lines.push('library_abkürzungen:');
  if (draft.libraryAbkuerzungen.length === 0) {
    lines.push('  # keine speziellen Abkürzungen erkannt');
  } else {
    for (const abbr of draft.libraryAbkuerzungen) {
      lines.push(`  ${abbr.key}: ${yamlStr(abbr.meaning)}`);
    }
  }

  return lines.join('\n') + '\n';
}

export function buildDatasetJsonlRecord(
  entry: MidiFileEntry,
  draft: TrainingTxtDraft,
  txtContent: string
): string {
  const parsed = entry.parsed;
  const harmony = parsed
    ? analyzeMidiHarmony(
        parsed.notes,
        parsed.ppqn,
        parsed.timeSignatures,
        parsed.totalTicks
      )
    : null;

  return JSON.stringify({
    titel: draft.titel,
    midi_datei: entry.relativePath,
    sha256: entry.sha256 ?? null,
    status: draft.status,
    hauptstil: draft.hauptstil,
    substil: draft.substil,
    stimmung: draft.stimmung,
    tonart: {
      grundton: draft.grundton,
      modus: draft.modus,
      sicherheit: draft.sicherheit,
    },
    taktart: draft.taktart,
    tempo_bpm: draft.tempoBpm,
    takte: parsed?.barCount ?? 0,
    dauer_sek: parsed ? Number(parsed.totalDurationSec.toFixed(2)) : 0,
    noten_anzahl: parsed?.notes.length ?? 0,
    midi_kanaele: parsed?.performance.channels.map((c) => c.channel + 1) ?? [],
    midi_events: parsed
      ? {
          cc_anzahl: parsed.performance.controlChanges.length,
          pitch_bend_anzahl: parsed.performance.pitchBends.length,
          aftertouch_anzahl: parsed.performance.aftertouch.length,
          program_changes: parsed.performance.programChanges.map((pc) => ({
            kanal: pc.channel + 1,
            program: pc.program,
            name: getGmProgramName(pc.program),
          })),
        }
      : null,
    wichtige_spuren: draft.wichtigeSpuren,
    abschnitte: draft.abschnitte,
    akkordfolge: harmony?.progressionSummary ?? [],
    library_abkuerzungen: draft.libraryAbkuerzungen,
    training_txt: txtContent,
  });
}

