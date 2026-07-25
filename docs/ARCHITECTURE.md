# Architecture

The initial implementation is a modular single process using stdio transport.

```text
MCP client
  -> MCP tool adapter
  -> SearchService
  -> DocumentRepository
  -> InMemoryDocumentRepository
```

## Boundaries

- `server.ts` validates MCP input and serializes output.
- `SearchService` owns ranking, snippets, limits, and document retrieval.
- `DocumentRepository` isolates storage from search behavior.
- Domain interfaces contain provider-independent data.

The MCP server is read-only. Crawling, source administration, persistence, and authentication are outside the current runtime boundary.

## Evolution

The in-memory repository is a replaceable adapter. A persistent implementation should preserve the service contract and add runtime validation at its data boundary. PostgreSQL full-text search is the preferred first persistent index; vector search is conditional on measured relevance gains.
