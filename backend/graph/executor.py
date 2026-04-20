"""Graph executor: topological sort + per-node execution with content-hash caching."""
from pathlib import Path
from typing import Dict, Optional, Callable, List
import threading

import torch

from .schema import GraphSpec, toposort, SourceNode, SplitNode, MixNode, PitchSpeedNode, OutputNode
from .hashing import hash_node, hash_file_bytes
from .cache import GraphCache
from .errors import RunCancelled
from . import nodes as node_executors


ProgressFn = Callable[[str, str, float, str], None]


class GraphExecutor:
    """Executes a GraphSpec against a given source WAV, with caching."""

    _separator_lock = threading.Lock()

    def __init__(
        self,
        graph: GraphSpec,
        source_wav: Path,
        cache: GraphCache,
        device: torch.device,
        jobs: int = 4,
        progress: Optional[ProgressFn] = None,
        cancel_event: Optional[threading.Event] = None,
        source_bytes_hash: Optional[str] = None,
    ):
        self.graph = graph
        self.source_wav = source_wav
        self.cache = cache
        self.device = device
        self.jobs = jobs
        self.progress = progress
        self.source_bytes_hash = source_bytes_hash
        # Cooperative cancel: checked between nodes and inside the Demucs
        # callback. asyncio.Task.cancel() doesn't stop thread-pool work, so
        # we need this to unblock CPU-heavy calls mid-execution.
        self.cancel_event = cancel_event

        # Populated during execution
        self.node_hashes: Dict[str, str] = {}
        self.node_files: Dict[str, Path] = {}
        # For Split nodes, map (node_id, port) -> file. For others, just the primary output.
        self.port_files: Dict[tuple[str, str], Path] = {}

    def _check_cancel(self) -> None:
        if self.cancel_event is not None and self.cancel_event.is_set():
            raise RunCancelled()

    def execute(self) -> Dict[str, Dict]:
        """Execute the graph. Returns {output_node_id: {"label", "hash", "path"}}."""
        ordered = toposort(self.graph)
        source_bytes_hash = self.source_bytes_hash or hash_file_bytes(self.source_wav)

        outputs: Dict[str, Dict] = {}

        for node in ordered:
            self._check_cancel()
            if self.progress:
                self.progress(node.id, "queued", 0, "")
            try:
                self._execute_node(node, source_bytes_hash)
            except RunCancelled:
                if self.progress:
                    self.progress(node.id, "idle", 0, "cancelled")
                raise
            except Exception as e:
                if self.progress:
                    self.progress(node.id, "error", 0, str(e))
                raise

            if isinstance(node, OutputNode):
                # Output is a passthrough — its file path is its upstream's port_file
                up_file = self.port_files[(node.source_node, node.source_port)]
                outputs[node.id] = {
                    "label": node.label,
                    "hash": self.node_hashes[node.id],
                    "path": str(up_file),
                }

        self.cache.sweep()
        return outputs

    def _execute_node(self, node, source_bytes_hash: str) -> None:
        node_hash = hash_node(node, self.node_hashes, source_bytes_hash)
        self.node_hashes[node.id] = node_hash

        if isinstance(node, SourceNode):
            path = node_executors.execute_source(
                node, node_hash, self.cache, self.source_wav, self.progress
            )
            self.node_files[node.id] = path
            self.port_files[(node.id, "out")] = path

        elif isinstance(node, SplitNode):
            input_path = self.port_files[(node.source_node, node.source_port)]
            with self._separator_lock:
                stem_paths = node_executors.execute_split(
                    node,
                    node_hash,
                    input_path,
                    self.cache,
                    self.device,
                    self.jobs,
                    self.progress,
                    self.cancel_event,
                )
            for stem, p in stem_paths.items():
                self.port_files[(node.id, stem)] = p
            # Pick any stem as the "primary" node file (for uniformity)
            self.node_files[node.id] = next(iter(stem_paths.values()))

        elif isinstance(node, MixNode):
            input_paths = {
                (inp.source_node, inp.source_port): self.port_files[
                    (inp.source_node, inp.source_port)
                ]
                for inp in node.inputs
            }
            path = node_executors.execute_mix(
                node, node_hash, input_paths, self.cache, self.progress
            )
            self.node_files[node.id] = path
            self.port_files[(node.id, "out")] = path

        elif isinstance(node, PitchSpeedNode):
            input_paths = {
                (inp.source_node, inp.source_port): self.port_files[
                    (inp.source_node, inp.source_port)
                ]
                for inp in node.inputs
            }
            out_paths = node_executors.execute_pitch_speed(
                node,
                node_hash,
                input_paths,
                self.cache,
                self.progress,
                self.cancel_event,
            )
            for port, p in out_paths.items():
                self.port_files[(node.id, port)] = p
            if out_paths:
                self.node_files[node.id] = next(iter(out_paths.values()))

        elif isinstance(node, OutputNode):
            # No file written; it's an alias
            up_file = self.port_files[(node.source_node, node.source_port)]
            self.node_files[node.id] = up_file
