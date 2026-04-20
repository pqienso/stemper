"""Disk-backed content-hash cache for graph node outputs.

For Source/Mix nodes we store one file per node: `{hash}.wav`.
For Split nodes we store one file per (hash, stem): `{hash}.{stem}.wav`.
Output nodes are passthroughs; no file is written for them.
"""
from pathlib import Path
from typing import Optional
import shutil
import os


class GraphCache:
    # A single run writes ~17 files × ~270 MB ≈ 4.5 GB of float32 WAV data for
    # a standard 4-minute song. The old 2 GB budget silently evicted upstream
    # files during the final sweep of the same run they were written in,
    # forcing re-runs next time. 10 GB fits a full job with headroom for a
    # few pitch/tempo tweaks on top.
    def __init__(self, cache_dir: Path, max_bytes: int = 10 * 1024 * 1024 * 1024):
        self.cache_dir = cache_dir
        self.max_bytes = max_bytes
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def path_for(self, node_hash: str, port: Optional[str] = None) -> Path:
        if port is None:
            return self.cache_dir / f"{node_hash}.wav"
        # Normalize port name for filesystem safety
        safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in port)
        return self.cache_dir / f"{node_hash}.{safe}.wav"

    def has(self, node_hash: str, port: Optional[str] = None) -> bool:
        return self.path_for(node_hash, port).exists()

    def touch(self, node_hash: str, port: Optional[str] = None) -> None:
        """Bump a cached file's mtime so the LRU sweep treats it as hot.
        Called on cache hits so that files actively used by recent runs don't
        get evicted just because they were written a long time ago."""
        p = self.path_for(node_hash, port)
        if p.exists():
            try:
                os.utime(p, None)
            except OSError:
                pass

    def sweep(self) -> None:
        """Simple mtime-based LRU sweep to keep cache under max_bytes."""
        entries = []
        for p in self.cache_dir.glob("*.wav"):
            try:
                st = p.stat()
            except FileNotFoundError:
                continue
            entries.append((st.st_mtime, st.st_size, p))
        entries.sort(key=lambda e: e[0])
        total = sum(size for _, size, _ in entries)
        for _, size, p in entries:
            if total <= self.max_bytes:
                break
            try:
                p.unlink()
            except FileNotFoundError:
                pass
            total -= size

    def clear(self) -> None:
        if self.cache_dir.exists():
            shutil.rmtree(self.cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
