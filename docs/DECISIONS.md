# Architecture Decisions

## ADR-001: Independent language repositories

The Node.js and Python implementations live in separate Git repositories. They share product intent, not source, release history, package metadata, or CI.

## ADR-002: AGPL-3.0-or-later

The project uses `AGPL-3.0-or-later` so distributed modifications remain open and modified versions offered over a network must provide corresponding source as required by section 13.

## ADR-003: stdio-first MCP server

The first release uses the official MCP SDK and stdio transport. Remote HTTP transport, authentication, and multi-tenant operation are deferred until deployment requirements are explicit.

## ADR-004: Controlled index before web crawling

The first implementation searches only documents already supplied to a repository. It does not accept arbitrary URLs. This keeps the initial trust and SSRF boundary narrow.

## ADR-005: Lexical search before embeddings

The initial search is deterministic keyword ranking. PostgreSQL full-text search is the planned persistent baseline. Embeddings and hybrid ranking will be added only after an evaluation set demonstrates a measurable improvement.
