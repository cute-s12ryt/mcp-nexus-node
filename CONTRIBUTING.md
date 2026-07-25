# Contributing

Thank you for improving Focused Search MCP.

## Development workflow

1. Open an issue for significant behavior or architecture changes.
2. Create a focused branch from the default branch.
3. Run `npm ci` and `npm run check`.
4. Add or update tests with every behavior change.
5. Submit a pull request using the repository template.

Keep transport handling, search logic, and storage adapters separated. Do not add unrestricted URL fetching, new network providers, telemetry, or credential handling without a documented security review.

## Licensing

By contributing, you agree that your contribution is licensed under `AGPL-3.0-or-later`, the same license as this project. Only submit work you have the right to license.
