"""Content-hash computation for graph cache keys.

Each node's hash is derived from its upstream hashes + its semantic config
(fields that affect output) + CACHE_VERSION.
"""
import hashlib
from pathlib import Path
from typing import Dict

from .schema import NodeSpec, SourceNode, SplitNode, MixNode, PitchSpeedNode, OutputNode, MixInput


CACHE_VERSION = "v3"


def hash_file_bytes(path: Path) -> str:
    with path.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def hash_node(
    node: NodeSpec,
    upstream_hashes: Dict[str, str],
    source_bytes_hash: str,
) -> str:
    """Compute a content hash for the given node.

    `upstream_hashes` maps source-node-id to its already-computed hash.
    `source_bytes_hash` is the sha256 of the Source WAV file.
    """
    h = hashlib.sha256()

    def upd(*parts) -> None:
        h.update("|".join(str(p) for p in parts).encode())
        h.update(b"|")

    upd(CACHE_VERSION)

    if isinstance(node, SourceNode):
        upd("source", source_bytes_hash)

    elif isinstance(node, SplitNode):
        up = upstream_hashes[node.source_node]
        # Semantic params only (exclude device, n_jobs — performance knobs).
        upd(
            "split", f"{up}:{node.source_port}",
            node.model, node.n_shifts,
            node.normalize_before, node.normalize_after,
            node.sample_rate, node.output_mono, node.seed,
        )

    elif isinstance(node, MixNode):
        upd("mix")
        tuples = sorted(
            (upstream_hashes[i.source_node], i.source_port, float(i.gain))
            for i in node.inputs
        )
        for up, port, gain in tuples:
            h.update(f"{up}:{port}:{gain:.6f},".encode())

    elif isinstance(node, PitchSpeedNode):
        upd("pitch_speed")
        # Each input keys its output by slot_id. Sort so the hash is
        # order-independent across equivalent (slot_id -> source) mappings.
        tuples = sorted(
            (inp.slot_id, upstream_hashes[inp.source_node], inp.source_port)
            for inp in node.inputs
        )
        for sid, up, port in tuples:
            h.update(f"{sid}:{up}:{port},".encode())
        upd("", f"{float(node.pitch_semitones):.6f}", f"{float(node.tempo_ratio):.6f}")

    elif isinstance(node, OutputNode):
        # Output is a passthrough alias — its hash is the upstream's.
        up = upstream_hashes[node.source_node]
        upd("output", f"{up}:{node.source_port}")

    return h.hexdigest()[:24]
