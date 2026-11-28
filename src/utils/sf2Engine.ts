/**
 * Pure TypeScript SoundFont 2 (.sf2) parser & Web Audio synthesizer engine.
 * - Zero external dependencies, 100% local/offline
 * - Supports full RIFF/sfbk parsing (INFO, sdta/smpl, pdta: phdr/pbag/pgen/inst/ibag/igen/shdr)
 * - Lazy per-sample AudioBuffer caching (instant loading even for 100+ MB SoundFonts)
 * - Supports key/velocity zones, sample loops, ADSR envelopes, lowpass filter, pan, exclusiveClass (hi-hats)
 * - Smart GM program + track-name auto-mapping for multi-track songs without explicit Program Changes
 */

export interface Sf2PresetInfo {
  id: string; // `${bank}:${preset}`
  bank: number;
  preset: number;
  name: string;
}

interface Sf2SampleHeader {
  name: string;
  start: number;
  end: number;
  startLoop: number;
  endLoop: number;
  sampleRate: number;
  originalPitch: number;
  pitchCorrection: number;
  sampleLink: number;
  sampleType: number;
}

interface Sf2ZoneGenerators {
  keyLo: number;
  keyHi: number;
  velLo: number;
  velHi: number;
  startAddrsOffset: number;
  endAddrsOffset: number;
  startloopAddrsOffset: number;
  endloopAddrsOffset: number;
  initialFilterFc: number; // absolute cents (default 13500)
  initialFilterQ: number; // centibels
  pan: number; // -500..+500
  delayVolEnv: number; // timecents
  attackVolEnv: number; // timecents
  holdVolEnv: number; // timecents
  decayVolEnv: number; // timecents
  sustainVolEnv: number; // centibels attenuation (0..1000)
  releaseVolEnv: number; // timecents
  initialAttenuation: number; // centibels
  coarseTune: number; // semitones
  fineTune: number; // cents
  scaleTuning: number; // cents per key (default 100)
  sampleModes: number; // 0 = no loop, 1 = loop, 3 = loop+release
  exclusiveClass: number;
  overridingRootKey: number; // -1 if unset
  keynum: number; // -1 if unset
  sampleId: number;
}

interface Sf2CompiledPreset {
  info: Sf2PresetInfo;
  zones: Sf2ZoneGenerators[];
}

interface ParsedSf2Bank {
  bankName: string;
  sampleData: Int16Array;
  samples: Sf2SampleHeader[];
  presets: Sf2CompiledPreset[];
  presetByKey: Map<string, Sf2CompiledPreset>;
}

interface ActiveVoice {
  source: AudioBufferSourceNode;
  env: GainNode;
  filter: BiquadFilterNode;
  panner: StereoPannerNode;
  exclusiveClass: number;
  channel: number;
  stopTime: number;
}

const GEN_START_ADDRS_OFFSET = 0;
const GEN_END_ADDRS_OFFSET = 1;
const GEN_STARTLOOP_ADDRS_OFFSET = 2;
const GEN_ENDLOOP_ADDRS_OFFSET = 3;
const GEN_START_ADDRS_COARSE = 4;
const GEN_INITIAL_FILTER_FC = 8;
const GEN_INITIAL_FILTER_Q = 9;
const GEN_END_ADDRS_COARSE = 12;
const GEN_PAN = 17;
const GEN_DELAY_VOL_ENV = 33;
const GEN_ATTACK_VOL_ENV = 34;
const GEN_HOLD_VOL_ENV = 35;
const GEN_DECAY_VOL_ENV = 36;
const GEN_SUSTAIN_VOL_ENV = 37;
const GEN_RELEASE_VOL_ENV = 38;
const GEN_INSTRUMENT = 41;
const GEN_KEY_RANGE = 43;
const GEN_VEL_RANGE = 44;
const GEN_STARTLOOP_ADDRS_COARSE = 45;
const GEN_KEYNUM = 46;
const GEN_INITIAL_ATTENUATION = 48;
const GEN_ENDLOOP_ADDRS_COARSE = 50;
const GEN_COARSE_TUNE = 51;
const GEN_FINE_TUNE = 52;
const GEN_SAMPLE_ID = 53;
const GEN_SAMPLE_MODES = 54;
const GEN_SCALE_TUNING = 56;
const GEN_EXCLUSIVE_CLASS = 57;
const GEN_OVERRIDING_ROOT_KEY = 58;

function readFourCC(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  );
}

function readFixedString(bytes: Uint8Array, offset: number, maxLen: number): string {
  let end = offset;
  const limit = Math.min(bytes.length, offset + maxLen);
  while (end < limit && bytes[end] !== 0) end++;
  const slice = bytes.subarray(offset, end);
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(slice).trim();
  } catch {
    let out = '';
    for (let i = 0; i < slice.length; i++) out += String.fromCharCode(slice[i]);
    return out.trim();
  }
}

function timecentsToSec(tc: number): number {
  if (tc <= -12000) return 0.001;
  return Math.max(0.001, Math.min(20, Math.pow(2, tc / 1200)));
}

function centsToHz(cents: number): number {
  return Math.max(20, Math.min(20000, 8.1757989156 * Math.pow(2, cents / 1200)));
}

function createDefaultInstGen(): Sf2ZoneGenerators {
  return {
    keyLo: 0,
    keyHi: 127,
    velLo: 0,
    velHi: 127,
    startAddrsOffset: 0,
    endAddrsOffset: 0,
    startloopAddrsOffset: 0,
    endloopAddrsOffset: 0,
    initialFilterFc: 13500,
    initialFilterQ: 0,
    pan: 0,
    delayVolEnv: -12000,
    attackVolEnv: -12000,
    holdVolEnv: -12000,
    decayVolEnv: -12000,
    sustainVolEnv: 0,
    releaseVolEnv: -12000,
    initialAttenuation: 0,
    coarseTune: 0,
    fineTune: 0,
    scaleTuning: 100,
    sampleModes: 0,
    exclusiveClass: 0,
    overridingRootKey: -1,
    keynum: -1,
    sampleId: -1,
  };
}

interface RawGen {
  oper: number;
  u16: number;
  i16: number;
  lo: number;
  hi: number;
}

function applyRawGenToInst(target: Sf2ZoneGenerators, g: RawGen): void {
  switch (g.oper) {
    case GEN_START_ADDRS_OFFSET:
      target.startAddrsOffset += g.i16;
      break;
    case GEN_END_ADDRS_OFFSET:
      target.endAddrsOffset += g.i16;
      break;
    case GEN_STARTLOOP_ADDRS_OFFSET:
      target.startloopAddrsOffset += g.i16;
      break;
    case GEN_ENDLOOP_ADDRS_OFFSET:
      target.endloopAddrsOffset += g.i16;
      break;
    case GEN_START_ADDRS_COARSE:
      target.startAddrsOffset += g.i16 * 32768;
      break;
    case GEN_END_ADDRS_COARSE:
      target.endAddrsOffset += g.i16 * 32768;
      break;
    case GEN_STARTLOOP_ADDRS_COARSE:
      target.startloopAddrsOffset += g.i16 * 32768;
      break;
    case GEN_ENDLOOP_ADDRS_COARSE:
      target.endloopAddrsOffset += g.i16 * 32768;
      break;
    case GEN_INITIAL_FILTER_FC:
      target.initialFilterFc = g.i16;
      break;
    case GEN_INITIAL_FILTER_Q:
      target.initialFilterQ = g.i16;
      break;
    case GEN_PAN:
      target.pan = g.i16;
      break;
    case GEN_DELAY_VOL_ENV:
      target.delayVolEnv = g.i16;
      break;
    case GEN_ATTACK_VOL_ENV:
      target.attackVolEnv = g.i16;
      break;
    case GEN_HOLD_VOL_ENV:
      target.holdVolEnv = g.i16;
      break;
    case GEN_DECAY_VOL_ENV:
      target.decayVolEnv = g.i16;
      break;
    case GEN_SUSTAIN_VOL_ENV:
      target.sustainVolEnv = g.i16;
      break;
    case GEN_RELEASE_VOL_ENV:
      target.releaseVolEnv = g.i16;
      break;
    case GEN_KEY_RANGE:
      target.keyLo = g.lo;
      target.keyHi = g.hi;
      break;
    case GEN_VEL_RANGE:
      target.velLo = g.lo;
      target.velHi = g.hi;
      break;
    case GEN_KEYNUM:
      target.keynum = g.i16;
      break;
    case GEN_INITIAL_ATTENUATION:
      target.initialAttenuation = g.i16;
      break;
    case GEN_COARSE_TUNE:
      target.coarseTune = g.i16;
      break;
    case GEN_FINE_TUNE:
      target.fineTune = g.i16;
      break;
    case GEN_SAMPLE_ID:
      target.sampleId = g.u16;
      break;
    case GEN_SAMPLE_MODES:
      target.sampleModes = g.u16;
      break;
    case GEN_SCALE_TUNING:
      target.scaleTuning = g.i16;
      break;
    case GEN_EXCLUSIVE_CLASS:
      target.exclusiveClass = g.u16;
      break;
    case GEN_OVERRIDING_ROOT_KEY:
      target.overridingRootKey = g.i16;
      break;
  }
}

interface PresetDelta {
  keyLo: number;
  keyHi: number;
  velLo: number;
  velHi: number;
  initialFilterFc: number;
  initialFilterQ: number;
  pan: number;
  delayVolEnv: number;
  attackVolEnv: number;
  holdVolEnv: number;
  decayVolEnv: number;
  sustainVolEnv: number;
  releaseVolEnv: number;
  initialAttenuation: number;
  coarseTune: number;
  fineTune: number;
  scaleTuning: number;
  instrumentId: number;
}

function createEmptyPresetDelta(): PresetDelta {
  return {
    keyLo: 0,
    keyHi: 127,
    velLo: 0,
    velHi: 127,
    initialFilterFc: 0,
    initialFilterQ: 0,
    pan: 0,
    delayVolEnv: 0,
    attackVolEnv: 0,
    holdVolEnv: 0,
    decayVolEnv: 0,
    sustainVolEnv: 0,
    releaseVolEnv: 0,
    initialAttenuation: 0,
    coarseTune: 0,
    fineTune: 0,
    scaleTuning: 0,
    instrumentId: -1,
  };
}

function applyRawGenToPresetDelta(target: PresetDelta, g: RawGen): void {
  switch (g.oper) {
    case GEN_INITIAL_FILTER_FC:
      target.initialFilterFc += g.i16;
      break;
    case GEN_INITIAL_FILTER_Q:
      target.initialFilterQ += g.i16;
      break;
    case GEN_PAN:
      target.pan += g.i16;
      break;
    case GEN_DELAY_VOL_ENV:
      target.delayVolEnv += g.i16;
      break;
    case GEN_ATTACK_VOL_ENV:
      target.attackVolEnv += g.i16;
      break;
    case GEN_HOLD_VOL_ENV:
      target.holdVolEnv += g.i16;
      break;
    case GEN_DECAY_VOL_ENV:
      target.decayVolEnv += g.i16;
      break;
    case GEN_SUSTAIN_VOL_ENV:
      target.sustainVolEnv += g.i16;
      break;
    case GEN_RELEASE_VOL_ENV:
      target.releaseVolEnv += g.i16;
      break;
    case GEN_INITIAL_ATTENUATION:
      target.initialAttenuation += g.i16;
      break;
    case GEN_COARSE_TUNE:
      target.coarseTune += g.i16;
      break;
    case GEN_FINE_TUNE:
      target.fineTune += g.i16;
      break;
    case GEN_SCALE_TUNING:
      target.scaleTuning += g.i16;
      break;
    case GEN_KEY_RANGE:
      target.keyLo = g.lo;
      target.keyHi = g.hi;
      break;
    case GEN_VEL_RANGE:
      target.velLo = g.lo;
      target.velHi = g.hi;
      break;
    case GEN_INSTRUMENT:
      target.instrumentId = g.u16;
      break;
  }
}

export function parseSf2Buffer(buffer: ArrayBuffer, fallbackName = 'SoundFont'): ParsedSf2Bank {
  if (buffer.byteLength < 64) {
    throw new Error('Datei ist zu klein für ein gültiges SoundFont (.sf2).');
  }

  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  if (readFourCC(view, 0) !== 'RIFF' || readFourCC(view, 8) !== 'sfbk') {
    throw new Error('Ungültiges Format: Keine gültige SoundFont 2 (.sf2) Datei.');
  }

  let bankName = fallbackName.replace(/\.sf2$/i, '');
  let smplOffset = -1;
  let smplSize = 0;

  const pdtaChunks = new Map<string, { offset: number; size: number }>();

  let pos = 12;
  const riffEnd = Math.min(buffer.byteLength, 8 + view.getUint32(4, true));

  while (pos + 8 <= riffEnd) {
    const chunkId = readFourCC(view, pos);
    const chunkSize = view.getUint32(pos + 4, true);
    const dataStart = pos + 8;
    const dataEnd = Math.min(riffEnd, dataStart + chunkSize);

    if (chunkId === 'LIST' && dataStart + 4 <= dataEnd) {
      const listType = readFourCC(view, dataStart);
      let subPos = dataStart + 4;

      while (subPos + 8 <= dataEnd) {
        const subId = readFourCC(view, subPos);
        const subSize = view.getUint32(subPos + 4, true);
        const subStart = subPos + 8;
        const subEnd = Math.min(dataEnd, subStart + subSize);

        if (listType === 'INFO' && subId === 'INAM' && subSize > 0) {
          const parsedName = readFixedString(bytes, subStart, subSize);
          if (parsedName) bankName = parsedName;
        } else if (listType === 'sdta' && subId === 'smpl') {
          smplOffset = subStart;
          smplSize = subEnd - subStart;
        } else if (listType === 'pdta') {
          pdtaChunks.set(subId, { offset: subStart, size: subEnd - subStart });
        }

        subPos = subStart + subSize + (subSize & 1);
      }
    }

    pos = dataStart + chunkSize + (chunkSize & 1);
  }

  if (smplOffset < 0 || smplSize < 2) {
    throw new Error('SoundFont enthält keine Sample-Daten (sdta/smpl).');
  }

  const phdrChunk = pdtaChunks.get('phdr');
  const pbagChunk = pdtaChunks.get('pbag');
  const pgenChunk = pdtaChunks.get('pgen');
  const instChunk = pdtaChunks.get('inst');
  const ibagChunk = pdtaChunks.get('ibag');
  const igenChunk = pdtaChunks.get('igen');
  const shdrChunk = pdtaChunks.get('shdr');

  if (!phdrChunk || !pbagChunk || !pgenChunk || !instChunk || !ibagChunk || !igenChunk || !shdrChunk) {
    throw new Error('SoundFont ist unvollständig (fehlende pdta-Tabellen).');
  }

  // Extract 16-bit signed PCM sample buffer safely
  const sampleCount = Math.floor(smplSize / 2);
  let sampleData: Int16Array;
  if (smplOffset % 2 === 0) {
    sampleData = new Int16Array(buffer, smplOffset, sampleCount);
  } else {
    sampleData = new Int16Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      sampleData[i] = view.getInt16(smplOffset + i * 2, true);
    }
  }

  // Parse shdr (46 bytes each)
  const shdrCount = Math.floor(shdrChunk.size / 46);
  const samples: Sf2SampleHeader[] = [];
  for (let i = 0; i < shdrCount; i++) {
    const o = shdrChunk.offset + i * 46;
    const name = readFixedString(bytes, o, 20);
    samples.push({
      name,
      start: view.getUint32(o + 20, true),
      end: view.getUint32(o + 24, true),
      startLoop: view.getUint32(o + 28, true),
      endLoop: view.getUint32(o + 32, true),
      sampleRate: view.getUint32(o + 36, true) || 44100,
      originalPitch: view.getUint8(o + 40),
      pitchCorrection: view.getInt8(o + 41),
      sampleLink: view.getUint16(o + 42, true),
      sampleType: view.getUint16(o + 44, true),
    });
  }

  const readBags = (chunk: { offset: number; size: number }): number[] => {
    const count = Math.floor(chunk.size / 4);
    const out: number[] = [];
    for (let i = 0; i < count; i++) {
      out.push(view.getUint16(chunk.offset + i * 4, true));
    }
    return out;
  };

  const readGens = (chunk: { offset: number; size: number }): RawGen[] => {
    const count = Math.floor(chunk.size / 4);
    const out: RawGen[] = [];
    for (let i = 0; i < count; i++) {
      const o = chunk.offset + i * 4;
      out.push({
        oper: view.getUint16(o, true),
        u16: view.getUint16(o + 2, true),
        i16: view.getInt16(o + 2, true),
        lo: view.getUint8(o + 2),
        hi: view.getUint8(o + 3),
      });
    }
    return out;
  };

  const pbagGenIndices = readBags(pbagChunk);
  const pgens = readGens(pgenChunk);
  const ibagGenIndices = readBags(ibagChunk);
  const igens = readGens(igenChunk);

  // Parse instruments (22 bytes each; last is EOI)
  const instCount = Math.max(0, Math.floor(instChunk.size / 22) - 1);
  const instZonesByIndex: Sf2ZoneGenerators[][] = [];

  for (let i = 0; i < instCount; i++) {
    const o = instChunk.offset + i * 22;
    const nextO = instChunk.offset + (i + 1) * 22;
    const bagStart = view.getUint16(o + 20, true);
    const bagEnd = view.getUint16(nextO + 20, true);

    const zones: Sf2ZoneGenerators[] = [];
    let globalInstGen: Sf2ZoneGenerators | null = null;

    for (let b = bagStart; b < bagEnd && b + 1 < ibagGenIndices.length; b++) {
      const gStart = ibagGenIndices[b];
      const gEnd = ibagGenIndices[b + 1];
      const base: Sf2ZoneGenerators = globalInstGen
        ? { ...globalInstGen }
        : createDefaultInstGen();
      let hasSample = false;

      for (let g = gStart; g < gEnd && g < igens.length; g++) {
        applyRawGenToInst(base, igens[g]);
        if (igens[g].oper === GEN_SAMPLE_ID) hasSample = true;
      }

      if (!hasSample && b === bagStart) {
        globalInstGen = base;
      } else if (hasSample && base.sampleId >= 0 && base.sampleId < samples.length) {
        zones.push(base);
      }
    }

    instZonesByIndex.push(zones);
  }

  // Parse presets (38 bytes each; last is EOP)
  const phdrCount = Math.max(0, Math.floor(phdrChunk.size / 38) - 1);
  const presets: Sf2CompiledPreset[] = [];
  const presetByKey = new Map<string, Sf2CompiledPreset>();

  for (let i = 0; i < phdrCount; i++) {
    const o = phdrChunk.offset + i * 38;
    const nextO = phdrChunk.offset + (i + 1) * 38;
    const name = readFixedString(bytes, o, 20) || `Preset ${i}`;
    const presetNum = view.getUint16(o + 20, true);
    const bankNum = view.getUint16(o + 22, true);
    const bagStart = view.getUint16(o + 24, true);
    const bagEnd = view.getUint16(nextO + 24, true);

    const compiledZones: Sf2ZoneGenerators[] = [];
    let globalPresetDelta: PresetDelta | null = null;

    for (let b = bagStart; b < bagEnd && b + 1 < pbagGenIndices.length; b++) {
      const gStart = pbagGenIndices[b];
      const gEnd = pbagGenIndices[b + 1];
      const delta: PresetDelta = globalPresetDelta
        ? { ...globalPresetDelta }
        : createEmptyPresetDelta();
      let hasInst = false;

      for (let g = gStart; g < gEnd && g < pgens.length; g++) {
        applyRawGenToPresetDelta(delta, pgens[g]);
        if (pgens[g].oper === GEN_INSTRUMENT) hasInst = true;
      }

      if (!hasInst && b === bagStart) {
        globalPresetDelta = delta;
      } else if (hasInst && delta.instrumentId >= 0 && delta.instrumentId < instZonesByIndex.length) {
        const izones = instZonesByIndex[delta.instrumentId];
        for (const iz of izones) {
          const keyLo = Math.max(iz.keyLo, delta.keyLo);
          const keyHi = Math.min(iz.keyHi, delta.keyHi);
          const velLo = Math.max(iz.velLo, delta.velLo);
          const velHi = Math.min(iz.velHi, delta.velHi);
          if (keyLo > keyHi || velLo > velHi) continue;

          compiledZones.push({
            ...iz,
            keyLo,
            keyHi,
            velLo,
            velHi,
            initialFilterFc: iz.initialFilterFc + delta.initialFilterFc,
            initialFilterQ: iz.initialFilterQ + delta.initialFilterQ,
            pan: Math.max(-500, Math.min(500, iz.pan + delta.pan)),
            delayVolEnv: iz.delayVolEnv + delta.delayVolEnv,
            attackVolEnv: iz.attackVolEnv + delta.attackVolEnv,
            holdVolEnv: iz.holdVolEnv + delta.holdVolEnv,
            decayVolEnv: iz.decayVolEnv + delta.decayVolEnv,
            sustainVolEnv: Math.max(0, Math.min(1000, iz.sustainVolEnv + delta.sustainVolEnv)),
            releaseVolEnv: iz.releaseVolEnv + delta.releaseVolEnv,
            initialAttenuation: iz.initialAttenuation + delta.initialAttenuation,
            coarseTune: iz.coarseTune + delta.coarseTune,
            fineTune: iz.fineTune + delta.fineTune,
            scaleTuning: iz.scaleTuning + delta.scaleTuning,
          });
        }
      }
    }

    if (compiledZones.length > 0) {
      const id = `${bankNum}:${presetNum}`;
      const compiled: Sf2CompiledPreset = {
        info: { id, bank: bankNum, preset: presetNum, name },
        zones: compiledZones,
      };
      presets.push(compiled);
      if (!presetByKey.has(id)) {
        presetByKey.set(id, compiled);
      }
    }
  }

  presets.sort((a, b) => a.info.bank - b.info.bank || a.info.preset - b.info.preset);

  if (presets.length === 0) {
    throw new Error('SoundFont enthält keine spielbaren Presets.');
  }

  return { bankName, sampleData, samples, presets, presetByKey };
}

/**
 * Infers a best-fit GM program number (0..127) from a track name when the MIDI file
 * doesn't contain explicit Program Change events (common in DAW exports like Cubase/Kontakt).
 */
export function inferGmProgramFromTrackName(trackName: string): {
  program: number;
  isDrum: boolean;
} {
  const lower = trackName.toLowerCase();
  if (/drum|perc|taiko|djun|dhol|dohl|snare|kick|hihat|hi-hat|hat|cymbal|tom\b|kit\b/.test(lower)) {
    return { program: 0, isDrum: true };
  }
  if (/timpani|pauke/.test(lower)) return { program: 47, isDrum: false };
  if (/piano|klavier|grand|vintage\s*d/.test(lower)) return { program: 0, isDrum: false };
  if (/epiano|rhodes|wurlitzer|keys/.test(lower)) return { program: 4, isDrum: false };
  if (/harpsichord/.test(lower)) return { program: 6, isDrum: false };
  if (/celesta|glocke|bell/.test(lower)) return { program: 8, isDrum: false };
  if (/marimba|xylophone|vibraphone/.test(lower)) return { program: 12, isDrum: false };
  if (/organ|orgel/.test(lower)) return { program: 19, isDrum: false };
  if (/guitar|gitar/.test(lower)) return { program: 24, isDrum: false };
  if (/808|sub\s*bass|synth\s*bass/.test(lower)) return { program: 38, isDrum: false };
  if (/contrabass|double\s*bass|upright/.test(lower)) return { program: 43, isDrum: false };
  if (/bass/.test(lower)) return { program: 33, isDrum: false };
  if (/violin|vio\b|geige/.test(lower)) return { program: 40, isDrum: false };
  if (/viola/.test(lower)) return { program: 41, isDrum: false };
  if (/cello|celli/.test(lower)) return { program: 42, isDrum: false };
  if (/pizz/.test(lower)) return { program: 45, isDrum: false };
  if (/harp|harfe/.test(lower)) return { program: 46, isDrum: false };
  if (/tremolo/.test(lower)) return { program: 44, isDrum: false };
  if (/string|streicher|spic|stac|marc|orchestr/.test(lower)) return { program: 48, isDrum: false };
  if (/choir|chor|vocal|voice/.test(lower)) return { program: 52, isDrum: false };
  if (/trump/.test(lower)) return { program: 56, isDrum: false };
  if (/trombone|posaune/.test(lower)) return { program: 57, isDrum: false };
  if (/tuba/.test(lower)) return { program: 58, isDrum: false };
  if (/horn/.test(lower)) return { program: 60, isDrum: false };
  if (/brass|blech/.test(lower)) return { program: 61, isDrum: false };
  if (/oboe/.test(lower)) return { program: 68, isDrum: false };
  if (/bassoon|fagott/.test(lower)) return { program: 70, isDrum: false };
  if (/clarinet/.test(lower)) return { program: 71, isDrum: false };
  if (/flute|flöte|woodwind/.test(lower)) return { program: 73, isDrum: false };
  if (/pad/.test(lower)) return { program: 89, isDrum: false };
  if (/lead|synth|arp/.test(lower)) return { program: 81, isDrum: false };
  return { program: 0, isDrum: false };
}

export class Sf2WebAudioSynth {
  private bank: ParsedSf2Bank | null = null;
  private fileName: string | null = null;
  private sampleBufferCache: Map<number, AudioBuffer> = new Map();
  private cachedCtx: AudioContext | null = null;
  private activeVoices: Set<ActiveVoice> = new Set();
  private readonly MAX_VOICES = 72;

  loadBuffer(buffer: ArrayBuffer, fileName: string): {
    bankName: string;
    fileName: string;
    presets: Sf2PresetInfo[];
  } {
    const parsed = parseSf2Buffer(buffer, fileName);
    this.stopAll();
    this.bank = parsed;
    this.fileName = fileName;
    this.sampleBufferCache.clear();
    return {
      bankName: parsed.bankName,
      fileName,
      presets: parsed.presets.map((p) => p.info),
    };
  }

  unload(): void {
    this.stopAll();
    this.bank = null;
    this.fileName = null;
    this.sampleBufferCache.clear();
  }

  isLoaded(): boolean {
    return this.bank !== null;
  }

  getInfo(): { bankName: string; fileName: string; presets: Sf2PresetInfo[] } | null {
    if (!this.bank || !this.fileName) return null;
    return {
      bankName: this.bank.bankName,
      fileName: this.fileName,
      presets: this.bank.presets.map((p) => p.info),
    };
  }

  private resolvePreset(
    presetOverrideId: string | null,
    program: number,
    isDrum: boolean
  ): Sf2CompiledPreset | null {
    if (!this.bank) return null;

    if (presetOverrideId) {
      const exact = this.bank.presetByKey.get(presetOverrideId);
      if (exact) return exact;
    }

    if (isDrum) {
      // Standard GM percussion bank 128
      const drumExact =
        this.bank.presetByKey.get(`128:${program}`) ||
        this.bank.presetByKey.get('128:0') ||
        this.bank.presets.find((p) => p.info.bank === 128);
      if (drumExact) return drumExact;
    }

    // Standard melodic bank 0
    const melodic =
      this.bank.presetByKey.get(`0:${program}`) ||
      this.bank.presets.find((p) => p.info.preset === program && p.info.bank !== 128) ||
      this.bank.presetByKey.get('0:0') ||
      this.bank.presets[0];

    return melodic ?? null;
  }

  private getSampleAudioBuffer(
    ctx: AudioContext,
    sampleId: number,
    zone: Sf2ZoneGenerators
  ): { buffer: AudioBuffer; sample: Sf2SampleHeader; loopStartSec: number; loopEndSec: number; canLoop: boolean } | null {
    if (!this.bank) return null;
    const sample = this.bank.samples[sampleId];
    if (!sample) return null;

    if (this.cachedCtx !== ctx) {
      this.sampleBufferCache.clear();
      this.cachedCtx = ctx;
    }

    const start = Math.max(0, sample.start + zone.startAddrsOffset);
    const end = Math.min(this.bank.sampleData.length, sample.end + zone.endAddrsOffset);
    const length = end - start;
    if (length < 8) return null;

    // Cache key includes sampleId + offset when non-zero
    const cacheKey =
      zone.startAddrsOffset === 0 && zone.endAddrsOffset === 0
        ? sampleId
        : sampleId * 1000003 + ((zone.startAddrsOffset * 31) ^ zone.endAddrsOffset);

    let audioBuf = this.sampleBufferCache.get(cacheKey);
    if (!audioBuf) {
      const sr = Math.max(8000, Math.min(192000, sample.sampleRate || 44100));
      audioBuf = ctx.createBuffer(1, length, sr);
      const chData = audioBuf.getChannelData(0);
      const pcm = this.bank.sampleData;
      for (let i = 0; i < length; i++) {
        chData[i] = pcm[start + i] / 32768;
      }
      this.sampleBufferCache.set(cacheKey, audioBuf);
    }

    const loopStartSample = sample.startLoop + zone.startloopAddrsOffset - start;
    const loopEndSample = sample.endLoop + zone.endloopAddrsOffset - start;
    const sr = audioBuf.sampleRate;
    const canLoop =
      (zone.sampleModes === 1 || zone.sampleModes === 3) &&
      loopStartSample >= 0 &&
      loopEndSample > loopStartSample + 16 &&
      loopEndSample <= length;

    return {
      buffer: audioBuf,
      sample,
      loopStartSec: canLoop ? loopStartSample / sr : 0,
      loopEndSec: canLoop ? loopEndSample / sr : 0,
      canLoop,
    };
  }

  triggerNote(
    ctx: AudioContext,
    destination: AudioNode,
    pitch: number,
    velocity: number,
    when: number,
    durationSec: number,
    channel: number,
    program: number,
    isDrum: boolean,
    presetOverrideId: string | null
  ): void {
    const preset = this.resolvePreset(presetOverrideId, program, isDrum);
    if (!preset) return;

    const matchingZones = preset.zones.filter(
      (z) => pitch >= z.keyLo && pitch <= z.keyHi && velocity >= z.velLo && velocity <= z.velHi
    );
    if (matchingZones.length === 0) return;

    // Cap simultaneous zones per note to avoid stereo+layer explosion on huge chords
    const zonesToPlay = matchingZones.slice(0, 4);
    const layerGainScale = zonesToPlay.length > 1 ? 1 / Math.sqrt(zonesToPlay.length) : 1;

    for (const zone of zonesToPlay) {
      // Handle exclusive class (e.g., closed hi-hat stops open hi-hat)
      if (zone.exclusiveClass > 0) {
        this.cutExclusiveClass(zone.exclusiveClass, channel, when);
      }

      // Voice stealing if polyphony limit reached
      if (this.activeVoices.size >= this.MAX_VOICES) {
        this.stealOldestVoice(when);
      }

      const loaded = this.getSampleAudioBuffer(ctx, zone.sampleId, zone);
      if (!loaded) continue;

      const { buffer, sample, loopStartSec, loopEndSec, canLoop } = loaded;

      const source = ctx.createBufferSource();
      source.buffer = buffer;

      // Pitch calculation
      const effectiveKey = zone.keynum >= 0 && zone.keynum <= 127 ? zone.keynum : pitch;
      const rootKey =
        zone.overridingRootKey >= 0 && zone.overridingRootKey <= 127
          ? zone.overridingRootKey
          : sample.originalPitch <= 127
          ? sample.originalPitch
          : 60;
      const keyDeltaCents = (effectiveKey - rootKey) * zone.scaleTuning;
      const totalCents =
        keyDeltaCents + zone.coarseTune * 100 + zone.fineTune + sample.pitchCorrection;
      source.playbackRate.setValueAtTime(
        Math.max(0.0625, Math.min(16, Math.pow(2, totalCents / 1200))),
        when
      );

      if (canLoop) {
        source.loop = true;
        source.loopStart = loopStartSec;
        source.loopEnd = loopEndSec;
      }

      // Lowpass filter
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      const baseCutoff = centsToHz(zone.initialFilterFc);
      // Slight velocity-sensitive brightness
      const velBrightness = 0.55 + (velocity / 127) * 0.45;
      filter.frequency.setValueAtTime(Math.min(19500, baseCutoff * velBrightness), when);
      if (zone.initialFilterQ > 0) {
        filter.Q.setValueAtTime(Math.min(18, zone.initialFilterQ / 10), when);
      }

      // Stereo panning (also handle SF2 left=4 / right=2 linked samples if pan not explicitly set)
      const panner = ctx.createStereoPanner();
      let panVal = Math.max(-1, Math.min(1, zone.pan / 500));
      if (panVal === 0) {
        if ((sample.sampleType & 4) !== 0) panVal = -0.7;
        else if ((sample.sampleType & 2) !== 0) panVal = 0.7;
      }
      panner.pan.setValueAtTime(panVal, when);

      // Volume ADSR envelope
      const env = ctx.createGain();
      const attenFactor = Math.pow(10, -(Math.max(0, zone.initialAttenuation) * 0.4) / 200);
      const velCurve = Math.pow(Math.max(1, velocity) / 127, 1.55);
      const peakGain = Math.min(1.0, Math.max(0.01, velCurve * attenFactor * 0.62 * layerGainScale));

      const delay = zone.delayVolEnv > -12000 ? timecentsToSec(zone.delayVolEnv) : 0;
      const attack = Math.min(2.5, Math.max(0.002, timecentsToSec(zone.attackVolEnv)));
      const hold = zone.holdVolEnv > -12000 ? Math.min(2.0, timecentsToSec(zone.holdVolEnv)) : 0;
      const decay =
        zone.decayVolEnv > -12000 ? Math.min(8.0, timecentsToSec(zone.decayVolEnv)) : 0.01;
      const sustainRatio = Math.max(0.0005, Math.pow(10, -zone.sustainVolEnv / 200));
      const sustainGain = Math.max(0.0002, peakGain * sustainRatio);
      const rawRelease =
        zone.releaseVolEnv > -12000 ? timecentsToSec(zone.releaseVolEnv) : 0.14;
      const release = Math.max(0.035, Math.min(3.0, rawRelease));

      const noteStart = when + delay;
      const noteDur = Math.max(0.04, Math.min(12.0, durationSec));
      const noteOff = noteStart + noteDur;

      env.gain.setValueAtTime(0.0001, when);
      if (delay > 0.001) {
        env.gain.setValueAtTime(0.0001, noteStart);
      }
      env.gain.linearRampToValueAtTime(peakGain, noteStart + attack);

      const decayStart = noteStart + attack + hold;
      if (hold > 0.002) {
        env.gain.setValueAtTime(peakGain, decayStart);
      }
      if (decayStart < noteOff && sustainRatio < 0.99) {
        env.gain.exponentialRampToValueAtTime(sustainGain, decayStart + decay);
      }

      // Release at noteOff (for one-shot drums, let sample finish naturally if shorter)
      const naturalSampleDur = buffer.duration / source.playbackRate.value;
      const stopAt =
        !canLoop && isDrum
          ? noteStart + Math.min(4.0, naturalSampleDur + 0.05)
          : noteOff + release + 0.03;

      if (!isDrum || canLoop) {
        env.gain.setValueAtTime(
          Math.max(0.0002, sustainRatio < 0.99 && noteOff > decayStart + decay ? sustainGain : peakGain * 0.85),
          noteOff
        );
        env.gain.exponentialRampToValueAtTime(0.0001, noteOff + release);
      } else {
        const fadeStart = Math.max(noteStart + 0.02, stopAt - 0.04);
        env.gain.setValueAtTime(peakGain, fadeStart);
        env.gain.exponentialRampToValueAtTime(0.0001, stopAt);
      }

      source.connect(filter);
      filter.connect(panner);
      panner.connect(env);
      env.connect(destination);

      source.start(noteStart);
      source.stop(stopAt + 0.01);

      const voice: ActiveVoice = {
        source,
        env,
        filter,
        panner,
        exclusiveClass: zone.exclusiveClass,
        channel,
        stopTime: stopAt,
      };
      this.activeVoices.add(voice);

      source.onended = () => {
        this.activeVoices.delete(voice);
        try {
          source.disconnect();
          filter.disconnect();
          panner.disconnect();
          env.disconnect();
        } catch {
          // ignore
        }
      };
    }
  }

  private cutExclusiveClass(exclusiveClass: number, channel: number, when: number): void {
    for (const v of this.activeVoices) {
      if (v.exclusiveClass === exclusiveClass && v.channel === channel) {
        try {
          v.env.gain.cancelScheduledValues(when);
          v.env.gain.setValueAtTime(0.0001, when + 0.015);
          v.source.stop(when + 0.02);
        } catch {
          // ignore
        }
      }
    }
  }

  private stealOldestVoice(when: number): void {
    const oldest = this.activeVoices.values().next().value as ActiveVoice | undefined;
    if (!oldest) return;
    this.activeVoices.delete(oldest);
    try {
      oldest.env.gain.cancelScheduledValues(when);
      oldest.env.gain.setValueAtTime(0.0001, when + 0.01);
      oldest.source.stop(when + 0.015);
    } catch {
      // ignore
    }
  }

  stopAll(): void {
    for (const v of this.activeVoices) {
      try {
        v.source.stop();
        v.source.disconnect();
        v.filter.disconnect();
        v.panner.disconnect();
        v.env.disconnect();
      } catch {
        // already stopped
      }
    }
    this.activeVoices.clear();
  }
}
