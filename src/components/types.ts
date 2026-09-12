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
