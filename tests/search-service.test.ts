import { describe, expect, it } from "vitest";

import type { SearchDocument } from "../src/domain.js";
import { InMemoryDocumentRepository } from "../src/repository.js";
import { SearchService } from "../src/search-service.js";

const documents: SearchDocument[] = [
  {
    id: "alpha",
    title: "Alpha search guide",
    url: "https://example.com/alpha",
    content: "A concise guide to controlled keyword search.",
    fetchedAt: "2026-07-19T00:00:00.000Z",
  },
  {
    id: "beta",
    title: "Beta reference",
    url: "https://example.com/beta",
    content: "Search appears once in this reference.",
    fetchedAt: "2026-07-19T00:00:00.000Z",
  },
];

const service = new SearchService(new InMemoryDocumentRepository(documents));

describe("SearchService", () => {
  it("ranks title matches ahead of content-only matches", () => {
    const results = service.search("search", 10);

    expect(results.map((result) => result.documentId)).toEqual(["alpha", "beta"]);
  });

  it("returns no results for an unmatched query", () => {
    expect(service.search("missing", 10)).toEqual([]);
  });

  it("truncates documents at the requested character limit", () => {
    const document = service.getDocument("alpha", 12);

    expect(document?.content).toHaveLength(12);
    expect(document?.truncated).toBe(true);
  });

  it("returns undefined for an unknown document", () => {
    expect(service.getDocument("unknown", 100)).toBeUndefined();
  });
});
