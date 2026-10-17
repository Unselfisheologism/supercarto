"""Indoor floor graphs — minimal bridge while the indoor compiler is unported.

The indoor emitter guard and the empty-graph shape are ported so outdoor
compiles (the entire milestone-1 surface) behave identically to TypeScript:
``compile_indoor`` on a document with no ``indoor=``/``level=`` features
returns the empty graph and the emitter emits nothing. Milestone 2 ports the
full per-floor topology builder (``src/compile/indoor.ts``).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .types import ScrDocument


@dataclass
class IndoorGraph:
    """Per-floor indoor topology. Milestone 1 only ever produces this empty."""

    levels: list[Any] = field(default_factory=list)
    vertical: list[Any] = field(default_factory=list)
    multiStorey: bool = False
    missingLevels: list[Any] = field(default_factory=list)
    omitted: list[Any] = field(default_factory=list)


def empty_indoor() -> IndoorGraph:
    return IndoorGraph()


def is_meaningful_indoor(graph: IndoorGraph | Any) -> bool:
    """Whether the graph deserves an ``indoor:`` block.

    Deliberately stricter than "is non-empty": a genuinely multi-level
    building needs a vertical link to belong in the graph, and the full
    builder checks that. Milestone 1 produces only the empty graph, for which
    the answer is always no.
    """
    if not isinstance(graph, IndoorGraph):
        return False
    return bool(graph.levels) and bool(graph.vertical)


def compile_indoor(doc: ScrDocument, opts: dict) -> IndoorGraph:
    """Collect indoor-tagged features and build the per-floor graph.

    Milestone 1: returns the empty graph without attaching per-floor
    topology. A pure ``indoor=*`` document therefore compiles to an outdoor
    map on the Python path; the Node path is still authoritative until
    ``src/compile/indoor.ts`` is ported.
    """
    return empty_indoor()
