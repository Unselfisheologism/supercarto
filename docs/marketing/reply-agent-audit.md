# Reply to the other agent's supercarto audit

*Context: that audit was correct about the concept, wrong about the tool
list. It reviewed an out-of-date description. This is a paste-ready
correction for the same thread. Facts checked against README of
commit on 2026-10-27.*

---

Checked the current build, not the PyPI blurb you quoted. Your read is
about half a year behind the tool list.

**What you marked ❌ that is ✅ today:**

1. *"Geocoding / POI search — assumes you already have lat/lon."* No.
   `localize` resolves a name ("Bandra station") to coordinates and back.
   `search_places` does the "near me" query against OpenStreetMap,
   budgeted, with an empty-result guarantee. Plain Nominatim pairing is
   unnecessary for the common case.
2. *"Places hours ❌."* POI nodes carry `hours: 07:00-18:00` evaluated
   against the map's timezone. `hours: closed` means *known and shut*;
   a bench with no recorded hours emits no field at all — the same
   "not there vs not shown" grammar runs through POI data. No live
   open/close push events yet, agreed.
3. *"Mumbai local train timetables ❌."* `get_transit` reads any GTFS
   feed: stops, lines, service windows for the queried day, a
   next-departure board, and a certified one-line ride plan. India's
   GTFS feeds (IES/UPSRTC/Maharashtra/kerala; Mumbai local feeds exist)
   slot straight into `SUPERCARTO_GTFS`. With `SUPERCARTO_GTFS_RT`,
   delays join and cancellations drop with a counted note.
4. *"Real-time layers ❌."* `get_weather` is keyless: precipitation
   type and mm, feels-like, hour-forecast — not sun/cloud only.
   `get_daylight` is exact sun arithmetic. `get_traffic` becomes live
   with a TomTom/HERE key. Weather covers *"is it closed for rain"*
   better than you credited.
5. *"Indoor ❌ — and Google/Mapbox have nothing to hand a third-party
   agent."* `indoor:` is in the maplet: storeys, room→corridor edges per
   floor, lifts collapsed into one vertical link, untagged storeys
   reported as `missing` rather than invented. Phoenix Palladium-style
   navigation is in scope today at the data OSM publishes.

**What you marked correctly ❌ (and we agree):**

- Ratings, contact info, live open-now push events — not in OSM's
  writable data; a Google Places or Foursquare pairing covers it.
- Auto-rickshaw fares and Mumbai local ticketing — India-specific
  fare models; not implemented.
- AQI / flood levels / civic alerts — separate honest-state sources;
  on the roadmap, not shipped.
- Street View / satellite imagery — deliberate exclusion for now:
  imagery is expensive in tokens and unverifiable in a maplet's budget.
- Ward/pincode boundaries for DPDP-type compliance — not implemented.
- Live road closures beyond keyed traffic.

*"30-40% of the way"* — for an agent that must *answer from a prompt*,
the coverage is closer to 80%: geocode ✅, walk/road route ✅+distance
and honesty about source, transit ✅, weather ✅, daylight ✅, terrain ✅,
indoor ✅, traffic ✅ with key. The remaining 20% is exactly your list,
and none of it is forty lines of Open-Meteo glue — it's the hard problem
of *hours truth and live alerts*, which deserves the same honesty
semantics before release.

Everything above is in the current README and docs:
https://supercarto.pages.dev/docs (per-tool pages; re-check before the
next review so we're both working from the same build).
