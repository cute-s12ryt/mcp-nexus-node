# Roadmap

## 0.1: Functional scaffold

- [x] stdio MCP server
- [x] `search_index` and `get_document`
- [x] in-memory repository and deterministic ranking
- [x] unit tests, lint, type checking, build, and CI

## 0.2: Controlled persistence

- [ ] define source registration and document lifecycle contracts
- [ ] add PostgreSQL full-text repository
- [ ] add migrations, integration tests, and index freshness metadata
- [ ] establish a fixed relevance evaluation set

## Later, after requirements are confirmed

- [ ] allowlisted sitemap or feed ingestion
- [ ] authenticated administration boundary
- [ ] optional embeddings and hybrid ranking after measured improvement
- [ ] optional Streamable HTTP transport with origin, authorization, and rate-limit controls
