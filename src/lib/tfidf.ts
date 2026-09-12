import { cosineSimilarity } from "./vector";

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

function buildVocabulary(texts: string[]): Map<string, number> {
  const vocab = new Map<string, number>();
  for (const text of texts) {
    for (const t of new Set(tokenize(text))) {
      if (!vocab.has(t)) vocab.set(t, vocab.size);
    }
  }
  return vocab;
}

function computeVector(text: string, vocab: Map<string, number>): number[] {
  const tokens = tokenize(text);
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  const vec = new Array(vocab.size).fill(0);
  for (const [term, count] of tf) {
    const idx = vocab.get(term);
    if (idx !== undefined) vec[idx] = count / tokens.length;
  }
  return vec;
}

export interface DuplicateCluster {
  ids: string[];
  representative: string;
}

export function detectDuplicates(
  memories: Array<{ id: string; text: string }>,
  threshold = 0.85
): DuplicateCluster[] {
  if (memories.length < 2) return [];
  const vocab = buildVocabulary(memories.map((m) => m.text));
  const vecs = memories.map((m) => computeVector(m.text, vocab));

  const parent = memories.map((_, i) => i);
  function find(x: number): number {
    if (parent[x] !== x) parent[x] = find(parent[x]);
    return parent[x];
  }
  function union(x: number, y: number) {
    parent[find(x)] = find(y);
  }

  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      if (cosineSimilarity(vecs[i], vecs[j]) >= threshold) union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < memories.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }

  const clusters: DuplicateCluster[] = [];
  for (const indices of groups.values()) {
    if (indices.length >= 2) {
      clusters.push({
        ids: indices.map((i) => memories[i].id),
        representative: memories[indices[0]].id,
      });
    }
  }
  return clusters;
}
