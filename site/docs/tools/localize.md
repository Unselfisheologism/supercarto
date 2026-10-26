---
title: localize
description: Move an open map session for the cost of the delta, not a new map.
sidebar:
  label: localize
  order: 1
---

always advertised

`localize(scr, lat, lon, radius, layers, budget)` — you already hold a
maplet and the person moved. A new `get_maplet` call would re-pay for every
unchanged node; `localize` returns only what changed: nodes appeared,
disappeared, or shifted, edges re-wired, and the same honesty records.

When the prompt is already long and the user says "the other corner", this
is the cheap path — a district stays affordable, a street corner cheaper.

:::note[Cheap compared to what]
A maplet's token cost is dominated by nodes and edges the previous
maplet already contained. `localize` exists so a moving session never
pays that cost twice.
:::
