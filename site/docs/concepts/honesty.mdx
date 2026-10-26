---
title: Honesty rules
description: The refusal, absence, and degradation semantics that run through every tool — silence is never punctuality.
sidebar:
  label: Honesty
  order: 1
---

Every tool in supercarto is built on one rule, applied everywhere: **a
missing answer must not read like a present-and-fine answer.** An agent's
failure mode is not saying "I don't know"; it is saying something
plausible-sounding that the person then acts on. These are the semantics
that policy enforces:

| Situation | What the deployment does | What it never does |
| --- | --- | --- |
| No traffic credential | tool not advertised; routing labels free-flow | report free-flow as live congestion |
| No GTFS feed | transit tools not advertised | answer "no service" |
| Date with no scheduled service | keeps stops, `routes: []`, says so in the note | read as "the feed is broken" |
| Feed without a calendar | whole network, window declared unknown | present whole-feed data as today's schedule |
| Stop with no realtime prediction | no `live:` entry, note says "unknown" | render as "on time" |
| Weather source unreachable | `degraded` set, tool raises | return zeroes |
| Place with no recorded hours | no `hours:` field at all | render as closed — or open |
| Source used is a fallback | `source:` names the fallback, warnings travel | name the primary source |
| Public demo router | `route` demoted to feasibility | hand over fiction as fact |

## Three states, never two

The pattern underlying most rows: absence is a **third state**. Known-open
and known-closed are facts; never-recorded is unknown. `hours` absent is
not `closed`. A stop without a prediction is not on time. A no-service day
is not no stops. Each distinction changes what a person should do next, so
each is encoded in the output — inside the map where a model reading only
one block still sees it, not on this documentation page.

## A developer's sketch

Before a feature ships, its failure behavior is designed — at length and in
the open. The honest-refusal states are part of the specification: one tool
that could return "on time" for a scheduled-and-silent bus has more to prove
than ten that came up short on tokens.

:::note[Where this gets verified]
121 of the 461 tests run against live sources; 42 cover the transit layer's
service states; 5 cover the realtime join; the parity engine runs on every
push and fails the release if TypeScript and Python ever disagree about a
byte of output.
:::
