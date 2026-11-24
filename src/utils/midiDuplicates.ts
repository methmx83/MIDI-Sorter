import type { MidiFileEntry } from '../types/midi';

export interface DuplicateMatchInfo {
  groupId: number;
  kind: 'exact' | 'variant';
  similarity: number; // 0..100
  peers: Array<{ id: string; name: string; similarity: number }>;
}

interface FingerprintEntry {
  index: number;
  id: string;
  name: string;
  tokens: Set<number>;
}

function buildTokenFingerprint(entry: MidiFileEntry): Set<number> | null {
  const parsed = entry.parsed;
  if (!parsed || parsed.notes.length < 4) return null;

  const stepTicks = Math.max(1, Math.round(parsed.ppqn / 4)); // 16th-note grid
  const baseTick = parsed.firstNoteTick; // Shift so trimmed vs untrimmed versions still match!
  const tokens = new Set<number>();

  for (const n of parsed.notes) {
    const relStep = Math.max(0, Math.round((n.startTick - baseTick) / stepTicks));
    tokens.add(relStep * 128 + (n.pitch & 0x7f));
  }

  return tokens.size >= 4 ? tokens : null;
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
 * Detects duplicate or near-identical variant MIDI files across the loaded folder.
 * Ignores leading silence offset so trimmed and untrimmed versions of the same song match.
 */
export function detectMidiDuplicates(
  entries: MidiFileEntry[],
  threshold = 0.75
): Map<string, DuplicateMatchInfo> {
  const result = new Map<string, DuplicateMatchInfo>();
  const fps: FingerprintEntry[] = [];

  for (let i = 0; i < entries.length; i++) {
    const tokens = buildTokenFingerprint(entries[i]);
    if (tokens) {
      fps.push({
        index: fps.length,
        id: entries[i].id,
        name: entries[i].name,
        tokens,
      });
    }
  }

  if (fps.length < 2) return result;

  // Sort by token count so we can prune impossible pairs quickly
  fps.sort((a, b) => a.tokens.size - b.tokens.size);

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

  const pairEdges = new Map<number, Array<{ peerIdx: number; simPct: number }>>();

  for (let i = 0; i < fps.length; i++) {
    const a = fps[i];
    const maxAllowedSize = Math.floor(a.tokens.size / threshold);

    for (let j = i + 1; j < fps.length; j++) {
      const b = fps[j];
      if (b.tokens.size > maxAllowedSize) break;

      const sim = jaccardSimilarity(a.tokens, b.tokens);
      if (sim >= threshold) {
        const simPct = Math.min(100, Math.round(sim * 100));
        unite(i, j);

        const listA = pairEdges.get(i) || [];
        listA.push({ peerIdx: j, simPct });
        pairEdges.set(i, listA);

        const listB = pairEdges.get(j) || [];
        listB.push({ peerIdx: i, simPct });
        pairEdges.set(j, listB);
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

  // Sort groups by highest internal similarity descending, then filename
  const sortedGroups = Array.from(components.values())
    .filter((g) => g.length >= 2)
    .map((memberIndices) => {
      let maxSim = 0;
      for (const idx of memberIndices) {
        for (const edge of pairEdges.get(idx) || []) {
          if (edge.simPct > maxSim) maxSim = edge.simPct;
        }
      }
      return { memberIndices, maxSim };
    })
    .sort((a, b) => b.maxSim - a.maxSim);

  sortedGroups.forEach((group, gIdx) => {
    const groupId = gIdx + 1;
    for (const idx of group.memberIndices) {
      const item = fps[idx];
      const edges = (pairEdges.get(idx) || [])
        .map((e) => ({
          id: fps[e.peerIdx].id,
          name: fps[e.peerIdx].name,
          similarity: e.simPct,
        }))
        .sort((a, b) => b.similarity - a.similarity);

      const bestSim = edges[0]?.similarity ?? group.maxSim;
      result.set(item.id, {
        groupId,
        kind: bestSim >= 96 ? 'exact' : 'variant',
        similarity: bestSim,
        peers: edges,
      });
    }
  });

  return result;
}
