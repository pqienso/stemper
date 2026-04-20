"""Pydantic models for the Stemper graph.

A graph is a DAG of five node types: Source, Split, Mix, PitchSpeed, Output.

Edges are implicit in node references:
- Split has one (source_node, source_port) input.
- Mix has a list of (source_node, source_port, gain) inputs.
- PitchSpeed has a list of (source_node, source_port) inputs and emits
  matching `out_i` ports (1:1, same transform applied to each channel).
- Output has one (source_node, source_port) input.
- Source has no inputs.
"""
from collections import deque
from typing import List, Literal, Dict, Union, Annotated
from pydantic import BaseModel, Field, field_validator, model_validator


STEM_NAMES_6S = ["vocals", "other", "piano", "guitar", "drums", "bass"]
STEM_NAMES_4S = ["vocals", "drums", "bass", "other"]


def stems_for_model(model: str) -> List[str]:
    if model == "htdemucs_6s":
        return STEM_NAMES_6S
    if model in ("htdemucs", "htdemucs_ft"):
        return STEM_NAMES_4S
    raise ValueError(f"Unknown demucs model: {model}")


# ---- Node specs ---------------------------------------------------------

class NodePosition(BaseModel):
    x: float = 0
    y: float = 0


class SourceNode(BaseModel):
    type: Literal["source"] = "source"
    id: str
    position: NodePosition = NodePosition()


class SplitNode(BaseModel):
    type: Literal["split"] = "split"
    id: str
    position: NodePosition = NodePosition()
    # Input reference
    source_node: str
    source_port: str = "out"
    # Params
    model: str = "htdemucs_6s"
    n_shifts: int = Field(default=2, ge=0, le=20)
    normalize_before: bool = False
    normalize_after: bool = False
    sample_rate: int = 44100
    output_mono: bool = False
    seed: int = 0

    @field_validator("model")
    @classmethod
    def _valid_model(cls, v: str) -> str:
        stems_for_model(v)
        return v


class MixInput(BaseModel):
    source_node: str
    source_port: str
    gain: float = Field(default=1.0, ge=-4.0, le=4.0)


class MixNode(BaseModel):
    type: Literal["mix"] = "mix"
    id: str
    position: NodePosition = NodePosition()
    inputs: List[MixInput] = Field(default_factory=list)


class PitchSpeedInput(BaseModel):
    # Stable slot id — decouples port identity from positional index so that
    # disconnecting one input doesn't renumber the others (which would
    # silently break any downstream edge referencing out_N).
    slot_id: int = Field(ge=0)
    source_node: str
    source_port: str


class PitchSpeedNode(BaseModel):
    type: Literal["pitch_speed"] = "pitch_speed"
    id: str
    position: NodePosition = NodePosition()
    # N inputs → N outputs; inputs[i] feeds `out_{slot_id}`.
    inputs: List[PitchSpeedInput] = Field(default_factory=list)
    # Semitones: positive = pitch up. 0 = no change.
    pitch_semitones: float = Field(default=0.0, ge=-24.0, le=24.0)
    # Tempo ratio: 1.0 = no change, 2.0 = double speed (shorter),
    # 0.5 = half speed (longer).
    tempo_ratio: float = Field(default=1.0, ge=0.25, le=4.0)


class OutputNode(BaseModel):
    type: Literal["output"] = "output"
    id: str
    position: NodePosition = NodePosition()
    label: str = "output"
    source_node: str
    source_port: str


NodeSpec = Annotated[
    Union[SourceNode, SplitNode, MixNode, PitchSpeedNode, OutputNode],
    Field(discriminator="type"),
]


# ---- Graph --------------------------------------------------------------

class GraphSpec(BaseModel):
    nodes: List[NodeSpec] = Field(default_factory=list)

    @model_validator(mode="after")
    def _validate(self):
        ids = [n.id for n in self.nodes]
        if len(ids) != len(set(ids)):
            raise ValueError("duplicate node ids")

        sources = [n for n in self.nodes if isinstance(n, SourceNode)]
        if len(sources) != 1:
            raise ValueError(
                f"graph must have exactly one Source node (got {len(sources)})"
            )

        node_map: Dict[str, NodeSpec] = {n.id: n for n in self.nodes}

        for n in self.nodes:
            for ref_id, ref_port in _incoming_refs(n):
                if ref_id not in node_map:
                    raise ValueError(
                        f"node '{n.id}' references unknown node '{ref_id}'"
                    )
                valid = valid_output_ports(node_map[ref_id])
                if ref_port not in valid:
                    raise ValueError(
                        f"node '{n.id}' references unknown port '{ref_port}' "
                        f"on node '{ref_id}' (valid: {sorted(valid)})"
                    )

        outputs = [n for n in self.nodes if isinstance(n, OutputNode)]
        labels = [o.label for o in outputs]
        if len(labels) != len(set(labels)):
            raise ValueError("output labels must be unique")

        # cycle detection
        toposort(self)
        return self


def valid_output_ports(node: NodeSpec) -> set[str]:
    if isinstance(node, SourceNode):
        return {"out"}
    if isinstance(node, SplitNode):
        return set(stems_for_model(node.model))
    if isinstance(node, MixNode):
        return {"out"}
    if isinstance(node, PitchSpeedNode):
        # One output port per input, keyed by the input's stable slot_id.
        return {f"out_{inp.slot_id}" for inp in node.inputs}
    if isinstance(node, OutputNode):
        return set()
    return set()


def _incoming_refs(node: NodeSpec) -> List[tuple[str, str]]:
    """Return list of (source_node_id, source_port) pairs that this node reads from."""
    if isinstance(node, SourceNode):
        return []
    if isinstance(node, SplitNode):
        return [(node.source_node, node.source_port)]
    if isinstance(node, MixNode):
        return [(i.source_node, i.source_port) for i in node.inputs]
    if isinstance(node, PitchSpeedNode):
        return [(i.source_node, i.source_port) for i in node.inputs]
    if isinstance(node, OutputNode):
        return [(node.source_node, node.source_port)]
    return []


def toposort(graph: GraphSpec) -> List[NodeSpec]:
    """Return nodes in topological order. Raises ValueError on cycle."""
    node_map: Dict[str, NodeSpec] = {n.id: n for n in graph.nodes}

    incoming: Dict[str, List[str]] = {n.id: [] for n in graph.nodes}
    for n in graph.nodes:
        for src_id, _ in _incoming_refs(n):
            incoming[n.id].append(src_id)

    dependents: Dict[str, List[str]] = {n.id: [] for n in graph.nodes}
    for nid, srcs in incoming.items():
        for s in srcs:
            if s in dependents:
                dependents[s].append(nid)

    indegree = {nid: len(srcs) for nid, srcs in incoming.items()}
    queue = deque(nid for nid, d in indegree.items() if d == 0)
    order: List[str] = []

    while queue:
        nid = queue.popleft()
        order.append(nid)
        for dep in dependents[nid]:
            indegree[dep] -= 1
            if indegree[dep] == 0:
                queue.append(dep)

    if len(order) != len(graph.nodes):
        raise ValueError("graph has a cycle")

    return [node_map[nid] for nid in order]
