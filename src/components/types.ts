export interface Memory {
  id: string;
  text: string;
  content: string;
  type: string;
  domain: string;
  entities: string[];
  timestamp: number;
  usageCount: number;
  timeRef?: string | null;
  timeConfidence?: number;
}

export interface AskResult {
  question: string;
  response: string;
  relevantIds: string[];
}

export interface SearchResult {
  clusters: Array<{
    topic: string;
    emoji: string;
    items: string[];
  }>;
  response: string;
  expanded_query?: string;
}

// ─── Vault view ──────────────────────────────────────────────────────────────

export interface TreeItem {
  id: string;
  content: string;
  type: string;
  domain: string | null;
  timeRef: string | null;
  createdAt: string;
}

export interface TreeDomain {
  domain: string | null;
  items: TreeItem[];
}

export interface TreeEntity {
  name: string;
  type: string;
  items: Array<{ id: string; content: string }>;
}

export interface TreeResponse {
  domains: TreeDomain[];
  entities: TreeEntity[];
}

// ─── Note detail (GET /api/items/[id]) ─────────────────────────────────────

export interface ItemDetail {
  id: string;
  content: string;
  rawText: string;
  type: string;
  domain: string | null;
  domainLocked: boolean;
  intent: string | null;
  importance: number | null;
  timeRef: string | null;
  timeConfidence: number | null;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ItemEdge {
  id: string;
  edgeType: string;
  weight: number;
  direction: "out" | "in";
  partner: {
    id: string;
    content: string;
    type: string;
    domain: string | null;
  };
}

export interface ItemDetailResponse {
  item: ItemDetail;
  entities: Array<{ name: string; type: string }>;
  edges: ItemEdge[];
}
