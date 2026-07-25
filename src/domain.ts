export interface SearchDocument {
  id: string;
  title: string;
  url: string;
  content: string;
  fetchedAt: string;
}

export interface SearchResult {
  documentId: string;
  title: string;
  url: string;
  snippet: string;
  fetchedAt: string;
  score: number;
}

export interface DocumentView {
  documentId: string;
  title: string;
  url: string;
  content: string;
  fetchedAt: string;
  truncated: boolean;
}
