# Can you be somewhere by 9? Transit schedules for AI agents

> The question sounds simple, and for an agent it has been unanswerable
> honestly: a schedule is a table of departures that varies by day, agency
> and timezone, and every plausible-sounding shortcut invents one.
> supercarto 0.5.0 answered it from real data, with rules strict enough to
> print in public.

*October 23, 2026 — release notes, 0.5.0.*

## What shipped

Set one environment variable to any static GTFS feed — a directory of tables
or a single .zip:

```
SUPERCARTO_GTFS=./city-gtfs.zip
```

That is the whole install. `get_transit` appears in the MCP tool list,
`/transit` answers over HTTP, and the CLI grows
`supercarto transit --feed city-gtfs.zip --lat 36.913 --lon -116.77
--radius 3km`. No feed configured? The tool is simply absent — like traffic,
a schedule is only as fresh as an operator's last import, so serving one is
an operator's decision, not a default.

The output is the same shape an agent already reads from a maplet, one
example straight from a live run:

```yaml
transit:
  center: "36.913, -116.77"
  radius: 3.0km
  feed: sample-feed
  note: Stop distances are straight-line. Schedule from GTFS feed for 2007-01-11 in America/Los_Angeles.
nodes:
  STAGECOACH: {type: stop, name: "Stagecoach Hotel & Casino", tags: [bus], routes: ["30", "40"], first: 06:00, last: 06:58}
  NADAV: {type: stop, name: "North Ave / D Ave N", tags: [bus], routes: ["40"], first: 06:14, last: 06:44}
edges:
  NADAV->DADAN: {dist: 601m, dir: south, path: bus 40}
```

Routes and first/last departures come from the schedule for the queried day.
The adjacency edges come from the geometry, so they survive even when the
timetable does not.

## The honesty rules, stated in full

Transit is adversarial to the plausible-sounding shortcut. Three rules in
this release:

**1. Three service states, never two.** A running day shows today's routes
and departures. A date with nothing running keeps the stops, with
`routes: []` and a note saying no service runs — "no transit" is not "no
stops". A feed with no calendar shows the whole network and declares the
service window unknown rather than labelling whole-feed facts as today's
schedule. An agent that can tell these apart will not tell a rider that the
line they are standing at is running.

**2. Times past midnight stay past midnight.** GTFS writes a departure after
the service day's midnight as `25:10`. Re-rendering it as `01:10` fits the
eye and strands the person waiting. supercarto therefore renders `25:10`, in
the feed's own timezone, with the evaluated instant in the `note`.

**3. Every caveat rides in the map.** Straight-line distances are labelled
as straight-line; the feed's timezone and the schedule date travel in the
`note`; nothing is stated for a day the feed does not cover. If the
answering model reads only one line of the output, it still cannot invent a
schedule.

## How it fits the market

Dedicated transit MCP servers exist — for the MTA, Toronto, Transitland
feeds. They are worth having, and they answer a transit question an agent
already knows it has. supercarto ships transit as one tool inside the
maplet, next to the streets, terrain, weather and daylight of the same
place, cut to one token budget with every omission recorded. The agent does
not decide between "explore a place" and "read a timetable"; it walks one
stop list.

On the realism of it all: the implementation adds both an RFC 4180 CSV
parser (quoted fields, CRLF, UTF-8 BOM) and a minimal zip reader (STORE +
DEFLATE) as in-repo code — zero new dependencies, same as every supercarto
release so far. The token budget is hard, re-measured on the delivered
output, with connectivity-preserving pruning and an `omitted:` record of
every drop. 412 tests passing, outputs byte-identical to the Python port,
and the feature was verified against real data in all three service states.

## Next

Both landed since this post: GTFS-Realtime TripUpdates decorate the boards
with live per-trip delays (and mark absence honestly — "no prediction:
unknown, not on time") since 0.5.8, and the certified one-ride-line plan
mixed with walking spans shipped as `get_transit_route` in 0.5.7.
Whole-metro feeds load inside Node's default heap since 0.6.1.

Follow-ons in [the full documentation](https://supercarto.pages.dev/docs):
[transit schedules](https://supercarto.pages.dev/docs/transit) and the
[ride plan](https://supercarto.pages.dev/docs/tools/get-transit-route).

Companion survey: [Maps for AI agents: the 2026
landscape](/blog/maps-for-ai-agents-2026).
