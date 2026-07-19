# ADR 0001: one authoritative global world

## Status

Accepted

## Decision

Run exactly one world host. Browsers submit typed commands and receive snapshots or deltas; they never author game state. The in-memory simulation is the runtime authority. Durable restoration is a later PostgreSQL adapter outside the simulation package.

## Consequences

The server must validate commands and support reconnect/resynchronization. The simulation remains platform-independent and deterministic, which makes replay and future persistence possible.

