# Dependency policy

The lockfile is part of every reviewed change. CI installs it with `--frozen-lockfile` and rejects
high or critical production advisories with `pnpm audit --prod --audit-level high`. Dependabot opens
grouped minor/patch updates each Monday, limited to five open dependency pull requests.

Dependency updates must pass formatting, lint, build, and the complete test suite. Review lockfile
changes for unexpected packages, install scripts, registry sources, and major transitive graph growth.
Do not merge an update solely because automation opened it. Major upgrades are separate intentional
changes with release notes and migration risks reviewed by a maintainer.

For an exploitable high/critical advisory, open a focused update immediately rather than waiting for
the weekly cadence. If no fixed version exists, document reachability and temporary mitigation in the
threat model; do not silently waive the CI gate. Production deploys use the reviewed frozen lockfile.
