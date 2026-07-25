import type { SearchDocument } from "./domain.js";

export interface DocumentRepository {
  findAll(): readonly SearchDocument[];
  findById(documentId: string): SearchDocument | undefined;
}

export class InMemoryDocumentRepository implements DocumentRepository {
  readonly #documents: Map<string, SearchDocument>;

  constructor(documents: readonly SearchDocument[]) {
    this.#documents = new Map(documents.map((document) => [document.id, document]));
  }

  findAll(): readonly SearchDocument[] {
    return [...this.#documents.values()];
  }

  findById(documentId: string): SearchDocument | undefined {
    return this.#documents.get(documentId);
  }
}
