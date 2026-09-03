# Monitoring dashboard and alerts

Scrape the server's `/metrics` endpoint every 15 seconds. The production dashboard has four rows:

| Row                  | Panels                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| World health         | readiness probe, `kings_world_tick`, tick duration, tick failures, phase durations                              |
| Durability           | checkpoint tick/age, checkpoint duration/failures, journal lag, command persistence failures, recovery duration |
| Load                 | connected players, entities, active chunks/threats, pending commands, command duration, path queue              |
| Delivery and process | full/delta byte rates, state-build duration, outbound buffered bytes, RSS, heap                                 |

Display counters as rates with `rate(...[5m])` and keep raw totals available for incident correlation.
Annotate deployments, maintenance windows, restores, and configuration changes. The checked-in
[`ops/prometheus-alerts.yml`](../ops/prometheus-alerts.yml) is the minimum alert policy; deployment
automation validates it with `promtool check rules` before loading it.

Route critical alerts to the on-call operator and the incident channel. Route warnings to the
operations channel during staffed hours, escalating after 15 minutes. Every alert links to the
[operations runbook](runbooks/operations.md). A backup scheduler/exporter must publish
`kings_backup_last_success_timestamp_seconds` only after the dump, manifest checksum, and off-host
copy succeed; absence or staleness of that series is a backup failure.
