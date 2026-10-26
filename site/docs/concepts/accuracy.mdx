---
title: Accuracy
description: Distances verified against haversine ground truth at mid and high latitude — the Mercator scale correction done per axis.
sidebar:
  label: Accuracy
  order: 2
---

Distances are verified against haversine ground truth at mid and high
latitude:

- **0.11%** error at San Francisco (37.77°N)
- **0.11%** error at Oslo (59.91°N)

## Why this required work

Web Mercator distances exceed ground distance by `1/cos(latitude)` on both
axes. Two failure modes live in that sentence:

1. **Getting the sign wrong** produces a 26% distance error at mid latitude
   that compounds toward the poles.
2. **A mean isotropic scale is wrong for a non-square bbox.** The scale is
   applied per axis, so a wide bbox at 60°N does not inherit a scale chosen
   for its height.

:::note[The benchmark spans 64°N to 33°S deliberately]
A benchmark run only at 37°N measures one case and hides every sign error
toward the poles. Crossing hemispheres (11°S, 41°S, 33°S) in the task set is
what makes "the Mercator correction is right" a checked claim rather than a
symptom of luck.
:::
