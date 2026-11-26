import type { MidiFileEntry } from '../types/midi';

export type DuplicateKind = 'byte_exact' | 'note_exact' | 'variant';

export interface DuplicatePeer {
  id: string;
  name: string;
  relativePath: string;
  similarity: number; // 0..100
  matchType: DuplicateKind;
  reason: string;
}

export interface DuplicateMatchInfo {
  groupId: number;
  kind: DuplicateKind;
  similarity: number; // 0..100
  peers: DuplicatePeer[];
}

interface FingerprintEntry {
  index: number;
  id: string;
  name: string;
  relativePath: string;
  sha256: string | null;
  tokens: Set<number> | null;
  exactNoteSignature: string | null;
}

function buildTokenFingerprint(entry: MidiFileEntry): Set<number> | null {
  const parsed = entry.parsed;
  if (!parsed || parsed.notes.length < 4) return null;

  const stepTicks = Math.max(1, Math.round(parsed.ppqn / 4)); // 16th-note grid
  const baseTick = parsed.firstNoteTick; // Shift so trimmed vs untrimmed versions match
  const tokens = new Set<number>();

  for (const n of parsed.notes) {
    const relStep = Math.max(0, Math.round((n.startTick - baseTick) / stepTicks));
    tokens.add(relStep * 128 + (n.pitch & 0x7f));
  }

  return tokens.size >= 4 ? tokens : null;
}

/**
 * Canonical normalized signature of all notes (shifted to first note = 0, quantized to 1/32 note).
 * Two files with identical musical notes (e.g. one trimmed, one with different metadata/BPM/header)
 * share the exact same signature, while any added/removed/changed note yields a different signature.
 */
function buildExactNoteSignature(entry: MidiFileEntry): string | null {
  const parsed = entry.parsed;
  if (!parsed || parsed.notes.length === 0) return null;

  const grid = Math.max(1, Math.round(parsed.ppqn / 8)); // 32nd-note resolution
  const baseTick = parsed.firstNoteTick;
  const parts = parsed.notes.map((n) => {
    const relStart = Math.max(0, Math.round((n.startTick - baseTick) / grid));
    const durGrid = Math.max(1, Math.round(n.durationTick / grid));
    return `${relStart}:${n.pitch & 0x7f}:${durGrid}`;
  });
  parts.sort();
  return `${parsed.notes.length}|${parts.join(';')}`;
}

function jaccardSimilarity(a: Set<number>, b: Set<number>): number {
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const tok of smaller) {
    if (larger.has(tok)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Detects duplicate and variant MIDI files across the loaded folder and clearly distinguishes:
 * - byte_exact: identical SHA-256 file hash
 * - note_exact: identical musical notes (ignoring leading silence, metadata, or header differences)
 * - variant: overlapping musical material (75%–99% similarity or altered note arrangement)
 */
export function detectMidiDuplicates(
  entries: MidiFileEntry[],
  threshold = 0.75
): Map<string, DuplicateMatchInfo> {
  const result = new Map<string, DuplicateMatchInfo>();
  const fps: FingerprintEntry[] = [];

  for (let i = 0; i < entries.length; i++) {
    const item = entries[i];
    const sha256 = item.sha256 || null;
    const tokens = buildTokenFingerprint(item);
    const exactNoteSignature = buildExactNoteSignature(item);

    // Include entry if it has either a SHA-256 hash (for byte-exact checks) or enough notes for musical matching
    if (sha256 || tokens || exactNoteSignature) {
      fps.push({
        index: fps.length,
        id: item.id,
        name: item.name,
        relativePath: item.relativePath,
        sha256,
        tokens,
        exactNoteSignature,
      });
    }
  }

  if (fps.length < 2) return result;

  const parent = Array.from({ length: fps.length }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const unite = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  interface EdgeInfo {
    peerIdx: number;
    simPct: number;
    matchType: DuplicateKind;
    reason: string;
  }

  const pairEdges = new Map<number, EdgeInfo[]>();
  const seenPairs = new Set<string>();

  const addPairEdge = (
    idxA: number,
    idxB: number,
    simPct: number,
    matchType: DuplicateKind,
    reason: string
  ) => {
    const lo = Math.min(idxA, idxB);
    const hi = Math.max(idxA, idxB);
    const pairKey = `${lo}:${hi}`;
    if (seenPairs.has(pairKey)) return;
    seenPairs.add(pairKey);

    unite(idxA, idxB);

    const listA = pairEdges.get(idxA) || [];
    listA.push({ peerIdx: idxB, simPct, matchType, reason });
    pairEdges.set(idxA, listA);

    const listB = pairEdges.get(idxB) || [];
    listB.push({ peerIdx: idxA, simPct, matchType, reason });
    pairEdges.set(idxB, listB);
  };

  // Pass 1: Byte-identical files via SHA-256
  const byHash = new Map<string, number[]>();
  for (let i = 0; i < fps.length; i++) {
    const hash = fps[i].sha256;
    if (!hash) continue;
    const list = byHash.get(hash) || [];
    list.push(i);
    byHash.set(hash, list);
  }
  for (const idxs of byHash.values()) {
    if (idxs.length < 2) continue;
    for (let i = 0; i < idxs.length; i++) {
      for (let j = i + 1; j < idxs.length; j++) {
        addPairEdge(idxs[i], idxs[j], 100, 'byte_exact', 'Identischer SHA-256-Dateihash');
      }
    }
  }

  // Pass 2: Note-identical files (same normalized note sequence, different SHA-256 / header / trim)
  const byNoteSig = new Map<string, number[]>();
  for (let i = 0; i < fps.length; i++) {
    const sig = fps[i].exactNoteSignature;
    if (!sig) continue;
    const list = byNoteSig.get(sig) || [];
    list.push(i);
    byNoteSig.set(sig, list);
  }
  for (const idxs of byNoteSig.values()) {
    if (idxs.length < 2) continue;
    for (let i = 0; i < idxs.length; i++) {
      for (let j = i + 1; j < idxs.length; j++) {
        addPairEdge(
          idxs[i],
          idxs[j],
          100,
          'note_exact',
          'Gleiche Notenfolge (anderer Header/Vorlauf)'
        );
      }
    }
  }

  // Pass 3: Musical variants via Jaccard similarity on quantized pitch-step tokens
  const tokenEntries = fps
    .map((fp, origIdx) => ({ fp, origIdx }))
    .filter((x): x is { fp: FingerprintEntry & { tokens: Set<number> }; origIdx: number } =>
      x.fp.tokens !== null
    )
    .sort((a, b) => a.fp.tokens.size - b.fp.tokens.size);

  for (let i = 0; i < tokenEntries.length; i++) {
    const a = tokenEntries[i];
    const maxAllowedSize = Math.floor(a.fp.tokens.size / threshold);

    for (let j = i + 1; j < tokenEntries.length; j++) {
      const b = tokenEntries[j];
      if (b.fp.tokens.size > maxAllowedSize) break;

      const lo = Math.min(a.origIdx, b.origIdx);
      const hi = Math.max(a.origIdx, b.origIdx);
      if (seenPairs.has(`${lo}:${hi}`)) continue;

      const sim = jaccardSimilarity(a.fp.tokens, b.fp.tokens);
      if (sim >= threshold) {
        const simPct = Math.min(99, Math.round(sim * 100));
        addPairEdge(
          a.origIdx,
          b.origIdx,
          simPct,
          'variant',
          `Musikalische Variante (${simPct}% Übereinstimmung)`
        );
      }
    }
  }

  // Group connected components
  const components = new Map<number, number[]>();
  for (let i = 0; i < fps.length; i++) {
    if (!pairEdges.has(i)) continue;
    const root = find(i);
    const arr = components.get(root) || [];
    arr.push(i);
    components.set(root, arr);
  }

  const kindPriority = (k: DuplicateKind): number =>
    k === 'byte_exact' ? 0 : k === 'note_exact' ? 1 : 2;

  const sortedGroups = Array.from(components.values())
    .filter((g) => g.length >= 2)
    .map((memberIndices) => {
      let bestKind: DuplicateKind = 'variant';
      let maxSim = 0;
      for (const idx of memberIndices) {
        for (const edge of pairEdges.get(idx) || []) {
          if (kindPriority(edge.matchType) < kindPriority(bestKind)) {
            bestKind = edge.matchType;
          }
          if (edge.simPct > maxSim) maxSim = edge.simPct;
        }
      }
      return { memberIndices, bestKind, maxSim };
    })
    .sort(
      (a, b) =>
        kindPriority(a.bestKind) - kindPriority(b.bestKind) || b.maxSim - a.maxSim
    );

  sortedGroups.forEach((group, gIdx) => {
    const groupId = gIdx + 1;
    for (const idx of group.memberIndices) {
      const item = fps[idx];
      const peers: DuplicatePeer[] = (pairEdges.get(idx) || [])
        .map((e) => ({
          id: fps[e.peerIdx].id,
          name: fps[e.peerIdx].name,
          relativePath: fps[e.peerIdx].relativePath,
          similarity: e.simPct,
          matchType: e.matchType,
          reason: e.reason,
        }))
        .sort(
          (a, b) =>
            kindPriority(a.matchType) - kindPriority(b.matchType) ||
            b.similarity - a.similarity
        );

      const primaryPeer = peers[0];
      result.set(item.id, {
        groupId,
        kind: primaryPeer?.matchType ?? group.bestKind,
        similarity: primaryPeer?.similarity ?? group.maxSim,
        peers,
      });
    }
  });

  return result;
}
