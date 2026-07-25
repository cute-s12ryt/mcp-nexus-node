import type { DocumentView, SearchDocument, SearchResult } from "./domain.js";
import type { DocumentRepository } from "./repository.js";

const DEFAULT_SNIPPET_LENGTH = 240;

export class SearchService {
  constructor(private readonly repository: DocumentRepository) {}

  search(query: string, limit: number): SearchResult[] {
    const terms = normalizeTerms(query);

    return this.repository
      .findAll()
      .map((document) => rankDocument(document, terms))
      .filter((result): result is SearchResult => result !== undefined)
      .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
      .slice(0, limit);
  }

  getDocument(documentId: string, maxCharacters: number): DocumentView | undefined {
    const document = this.repository.findById(documentId);
    if (!document) {
      return undefined;
    }

    const truncated = document.content.length > maxCharacters;
    return {
      documentId: document.id,
      title: document.title,
      url: document.url,
      content: truncated ? document.content.slice(0, maxCharacters) : document.content,
      fetchedAt: document.fetchedAt,
      truncated,
    };
  }
}

function normalizeTerms(query: string): string[] {
  return [...new Set(query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean))];
}

function rankDocument(document: SearchDocument, terms: readonly string[]): SearchResult | undefined {
  const title = document.title.toLocaleLowerCase();
  const content = document.content.toLocaleLowerCase();
  let score = 0;
  let firstMatch = -1;

  for (const term of terms) {
    const titleMatches = countOccurrences(title, term);
    const contentMatches = countOccurrences(content, term);
    score += titleMatches * 4 + contentMatches;

    const position = content.indexOf(term);
    if (position >= 0 && (firstMatch < 0 || position < firstMatch)) {
      firstMatch = position;
    }
  }

  if (score === 0) {
    return undefined;
  }

  return {
    documentId: document.id,
    title: document.title,
    url: document.url,
    snippet: createSnippet(document.content, firstMatch),
    fetchedAt: document.fetchedAt,
    score,
  };
}

function countOccurrences(value: string, term: string): number {
  let count = 0;
  let position = 0;

  while ((position = value.indexOf(term, position)) >= 0) {
    count += 1;
    position += term.length;
  }

  return count;
}

function createSnippet(content: string, matchPosition: number): string {
  const start = Math.max(0, matchPosition - Math.floor(DEFAULT_SNIPPET_LENGTH / 3));
  const snippet = content.slice(start, start + DEFAULT_SNIPPET_LENGTH).trim();
  return `${start > 0 ? "..." : ""}${snippet}${start + DEFAULT_SNIPPET_LENGTH < content.length ? "..." : ""}`;
}
