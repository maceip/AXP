# Contributing

Use Node 24.15+, Git and `npm ci`. Run `npm run check` and `npm run demo` before
proposing a change. `npm run format` formats owned sources.

Preserve the AHP/ACP boundary. Reuse published upstream types and reducers;
prefer additive capabilities to changing baseline rendering. Public mutations
need a runtime schema, typed result, authority check and durable state
transition. Keep I/O out of reducers and awaits out of database transactions.

Tests should explain an externally meaningful contract or failure mode.
Prioritize real sockets, process lifetime, recovery, spending and authorization
over implementation-shape assertions. Upstream fixtures are conformance
evidence; preserve their bytes and license. Update fixtures and SDK pins
together. AXP reducers maintain 100% branch and line coverage.

Run `npm run schema` after changing command schemas and commit generated files.
CI checks schema drift. Add a changelog entry for public behavior changes.
Additional SDKs and UI surfaces should earn their maintenance cost through
concrete user needs.

Never commit credentials, profiles, databases, original private transcripts or
contributor histories. Report security issues privately; see [SECURITY.md](SECURITY.md).
