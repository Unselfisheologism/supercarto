# The robot-brain harness — research brief (D1)

Status: **research bet — do not productize until design partners are spoken to.**
Derived from docs/strategy/market-research.md §7 D1. One page.

## The concept in one sentence

A geospatial context daemon that runs **inside a robot's onboard computer**
and renders the robot's local surroundings as a token-budgeted topological
graph, injected into the robot's own reasoning loop.

## Why robot builders would want it

An embodied agent (delivery robot, AMR/AGV, drone, field scout) makes the
same "should I go there" decisions a chat agent does, with less room to
decide in: onboard compute, latency budgets, and the same hallucination
hazards over raw coordinates. A robot's world model currently has to be
assembled ad hoc from lidar, occupancy maps, and hand-rolled lookups.
supercarto's compiler already solves a general version of that problem:
turn raw geodata + honesty vocabulary into a small traversable graph.

Concretely, the daemon would ship as a single embedded binary (`supercarto
harness run`) that:

- reads **local-only data**: on-device PMTiles extracts, GPS pose, config'd
  sensor feeds — everything offline-capable, no cloud dependency;
- renders the **head-only** slice: the same YAML reasoning format built for
  humans' chat agents, sized to whatever token/latency budget the robot's
  model host allows;
- exposes results over an **IPC surface for whatever robot container it is
  in** (prompt/context injection for LLM-driven planners; structured graph
  for classic planners).

## Why this is a wedge nobody else occupies

- None of the 106 geospatial MCP servers installs *on a robot*; they all
  assume a cloud or workstation host.
- Robotics companies rarely want to ship operator-side cloud dependencies;
  "runs fully offline" is a structural fit with our PMTiles/self-host core.
- Every compiler semantics fix (budgeting, honesty, indoor vertical joins)
  benefits both markets at once — the moat accumulates in one place.

## Risks (stated, not hidden)

- **Unvalidated demand.** No public evidence robot architectures are
  prompt/context-shaped for navigation. Many real deployments use
  classic planners where a YAML graph buys nothing.
- **Certification pressure.** Safety-relevant navigation may forbid
  "reasoning over a compressed map"; regulators and integrators may reject
  anything lossy on the critical path.
- **Sales motion mismatch.** Robots sell through long enterprise cycles;
  our current motion is dev-tools self-serve.

## What a 2-week prototype looks like

1. Package the existing compiler behind a single-file local binary and a
   POSIX/GRPC IPC responder.
2. Feed it one on-device PMTiles extract + live GPS pose.
3. Produce per-tick heads and measure (tokens, latency, correctness of
   feasibility answers near the robot).

## Questions for design partners (ask, don't pitch)

1. Does your autonomy stack have a component that consumes text/graph
   context? What format?
2. What is the actual token or byte budget per tick on your hardware?
3. Where does "what's around me" come from today, and what does it fail at?
4. What would have to be true for a compressed honest map to be allowed
   near the planner?
