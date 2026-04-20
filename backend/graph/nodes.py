"""Node executors for the graph.

Each executor produces one or more WAV files in the cache directory
(or reuses cached outputs). Executors operate on tensors for Mix; Split
writes one file per stem; Source copies/hardlinks the downloaded WAV.
"""
from pathlib import Path
from typing import Dict, Optional, Callable
import shutil
import threading

import torch
import torchaudio
import torchaudio.functional as AF
import torchaudio.transforms as AT
import demucs.api

from .cache import GraphCache
from .errors import RunCancelled
from .schema import SourceNode, SplitNode, MixNode, PitchSpeedNode, stems_for_model
from util.audio_util import normalize_lufs, resample, convert_mono


ProgressFn = Callable[[str, str, float, str], None]


def execute_source(
    node: SourceNode,
    node_hash: str,
    cache: GraphCache,
    source_wav: Path,
    progress: Optional[ProgressFn] = None,
) -> Path:
    """Source's output is just the downloaded WAV. We copy it into the cache
    under its content hash so it participates in the same cache protocol."""
    if progress:
        progress(node.id, "running", 0, "loading source")
    target = cache.path_for(node_hash)
    if not target.exists():
        # Use a hardlink if possible to avoid disk duplication; fallback to copy.
        try:
            target.hardlink_to(source_wav)
        except (OSError, AttributeError):
            shutil.copy2(source_wav, target)
    else:
        cache.touch(node_hash)
    if progress:
        progress(node.id, "done", 100, "source ready")
    return target


# Separator cache: one Separator instance per (model, shifts, jobs, device)
_separator_cache: Dict[tuple, demucs.api.Separator] = {}


def get_separator(
    model: str,
    shifts: int,
    jobs: int,
    device: torch.device,
) -> demucs.api.Separator:
    key = (model, shifts, jobs, str(device))
    if key not in _separator_cache:
        print(f"[graph] Loading separator {key}")
        _separator_cache[key] = demucs.api.Separator(
            model=model,
            shifts=shifts,
            jobs=jobs,
            device=device,
            # We pipe per-segment progress via our own demucs_cb callback
            # to the frontend, so suppress Demucs's built-in tqdm bar —
            # otherwise it spams run.sh's terminal with rewriting lines.
            progress=False,
        )
    return _separator_cache[key]


def execute_split(
    node: SplitNode,
    node_hash: str,
    input_path: Path,
    cache: GraphCache,
    device: torch.device,
    jobs: int,
    progress: Optional[ProgressFn] = None,
    cancel_event: Optional[threading.Event] = None,
) -> Dict[str, Path]:
    """Run Demucs on the input WAV and write one file per stem into the cache."""
    stem_names = stems_for_model(node.model)
    output_paths = {
        stem: cache.path_for(node_hash, port=stem) for stem in stem_names
    }
    if all(p.exists() for p in output_paths.values()):
        for stem in stem_names:
            cache.touch(node_hash, port=stem)
        if progress:
            progress(node.id, "cached", 100, "all stems cached")
        return output_paths

    def check_cancel():
        if cancel_event is not None and cancel_event.is_set():
            raise RunCancelled()

    check_cancel()
    if progress:
        progress(node.id, "running", 5, "loading audio")

    audio, sr = torchaudio.load(input_path)
    if node.normalize_before:
        audio = normalize_lufs(audio, sr)

    check_cancel()
    if progress:
        progress(node.id, "running", 10, "running demucs")

    separator = get_separator(node.model, node.n_shifts, jobs, device)

    # Map demucs's per-chunk callback to overall pct in [10, 85].
    # Fires from worker threads — `progress` forwards via run_coroutine_threadsafe.
    # Also checks `cancel_event`: if set, raise KeyboardInterrupt (demucs's
    # documented way to abort separation mid-run). We catch it outside and
    # re-raise as RunCancelled.
    last_pct = [10.0]
    def demucs_cb(d: dict):
        # Abort path — must raise BEFORE touching progress, so we don't
        # emit a final misleading "running" event.
        if cancel_event is not None and cancel_event.is_set():
            raise KeyboardInterrupt
        if progress is None:
            return
        # Only count segment completions; halves the event volume and avoids
        # reporting 0% for every "start".
        if d.get("state") != "end":
            return
        models = d.get("models") or 1
        shifts_count = max(1, node.n_shifts)
        model_idx = d.get("model_idx_in_bag", 0)
        shift_idx = d.get("shift_idx", 0)
        seg_offset = d.get("segment_offset", 0)
        audio_len = d.get("audio_length") or 1
        total_passes = max(1, models * shifts_count)
        pass_idx = model_idx * shifts_count + shift_idx
        within_pass = min(1.0, seg_offset / audio_len)
        demucs_pct = (pass_idx + within_pass) / total_passes
        overall = 10 + demucs_pct * 75
        # Throttle: only forward monotonically-increasing whole-percent steps.
        if overall >= last_pct[0] + 1:
            last_pct[0] = overall
            progress(node.id, "running", overall, "separating")

    separator.update_parameter(callback=demucs_cb)

    # Seed for reproducibility
    torch.manual_seed(node.seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(node.seed)

    try:
        _, separated = separator.separate_tensor(audio, sr=sr)
    except KeyboardInterrupt:
        # Either our callback raised (cancel_event set) or demucs itself
        # aborted. Surface as RunCancelled so the executor can distinguish
        # from a real error.
        raise RunCancelled()
    finally:
        # Detach our callback so a later run with no `progress` doesn't fire it.
        separator.update_parameter(callback=None)

    if progress:
        progress(node.id, "running", 85, "post-processing")

    for idx, stem in enumerate(stem_names):
        s = separated[stem]
        if node.output_mono:
            s = convert_mono(s)
        if separator.samplerate != node.sample_rate:
            s = resample(s, separator.samplerate, node.sample_rate)
        if node.normalize_after:
            s = normalize_lufs(s, node.sample_rate)
        torchaudio.save(output_paths[stem], s, node.sample_rate)
        if progress:
            progress(
                node.id,
                "running",
                85 + (idx + 1) / len(stem_names) * 15,
                f"saved {stem}",
            )

    if progress:
        progress(node.id, "done", 100, "split complete")

    return output_paths


def execute_mix(
    node: MixNode,
    node_hash: str,
    input_paths: Dict[tuple, Path],  # (source_node_id, source_port) -> file path
    cache: GraphCache,
    progress: Optional[ProgressFn] = None,
) -> Path:
    """Sum the input WAVs with signed gains, then clip(-1, 1)."""
    target = cache.path_for(node_hash)
    if target.exists():
        cache.touch(node_hash)
        if progress:
            progress(node.id, "cached", 100, "mix cached")
        return target

    if progress:
        progress(node.id, "running", 10, "loading inputs")

    mixed: Optional[torch.Tensor] = None
    sr: Optional[int] = None

    for inp in node.inputs:
        path = input_paths[(inp.source_node, inp.source_port)]
        audio, input_sr = torchaudio.load(path)
        if sr is None:
            sr = input_sr
        elif input_sr != sr:
            audio = resample(audio, input_sr, sr)

        audio = audio * inp.gain

        if mixed is None:
            mixed = audio
        else:
            # Align shapes (channel count + length)
            if mixed.shape[0] != audio.shape[0]:
                if mixed.shape[0] == 1 and audio.shape[0] > 1:
                    mixed = mixed.expand(audio.shape[0], -1)
                elif audio.shape[0] == 1 and mixed.shape[0] > 1:
                    audio = audio.expand(mixed.shape[0], -1)
            min_len = min(mixed.shape[-1], audio.shape[-1])
            mixed = mixed[..., :min_len] + audio[..., :min_len]

    if mixed is None or sr is None:
        raise ValueError(f"Mix node '{node.id}' has no inputs")

    mixed = torch.clip(mixed, -1.0, 1.0)
    target.parent.mkdir(parents=True, exist_ok=True)
    # torchaudio.save expects contiguous tensors in some backends
    torchaudio.save(target, mixed.contiguous(), sr)

    if progress:
        progress(node.id, "done", 100, "mix complete")

    return target


def execute_pitch_speed(
    node: PitchSpeedNode,
    node_hash: str,
    input_paths: Dict[tuple, Path],
    cache: GraphCache,
    progress: Optional[ProgressFn] = None,
    cancel_event: Optional[threading.Event] = None,
) -> Dict[str, Path]:
    """Apply pitch shift + time stretch to each input, producing one output
    per input with the same transform applied.

    Inspired by saxgpt's AudioAugmenter: pitch via
    torchaudio.functional.pitch_shift (STFT-based, preserves duration),
    tempo via Spectrogram → TimeStretch → InverseSpectrogram (preserves
    pitch, changes duration).

    Returns {port_name: Path} keyed by `out_0`, `out_1`, ....
    """
    n = len(node.inputs)

    def check_cancel():
        if cancel_event is not None and cancel_event.is_set():
            raise RunCancelled()

    if n == 0:
        if progress:
            progress(node.id, "done", 100, "no inputs")
        return {}

    # Identity guard: pitch==0 AND tempo==1 → pure passthrough. Return the
    # upstream paths directly without loading audio, running STFT, or writing
    # any cache files. Epsilon avoids slider fp imprecision tripping the check.
    identity = (
        abs(node.pitch_semitones) < 1e-9
        and abs(node.tempo_ratio - 1.0) < 1e-9
    )

    if identity:
        if progress:
            progress(node.id, "done", 100, "passthrough")
        return {
            f"out_{inp.slot_id}": input_paths[(inp.source_node, inp.source_port)]
            for inp in node.inputs
        }

    # Port names are keyed by the input's stable slot_id, not its list index.
    # That way if a downstream edge references out_5, it stays valid even if
    # the upstream input at slot 3 is disconnected later.
    output_paths = {
        f"out_{inp.slot_id}": cache.path_for(node_hash, port=f"out_{inp.slot_id}")
        for inp in node.inputs
    }

    if all(p.exists() for p in output_paths.values()):
        for inp in node.inputs:
            cache.touch(node_hash, port=f"out_{inp.slot_id}")
        if progress:
            progress(node.id, "cached", 100, "all outputs cached")
        return output_paths

    # Build STFT transforms once per sample rate (inputs may have different SRs).
    # Keyed by sr to avoid rebuilding for every input. n_fft/hop_length mirror
    # saxgpt's AudioAugmenter defaults.
    n_fft = 4096
    hop_length = 512
    specgram_cache: Dict[int, tuple] = {}

    def get_stft_transforms(sr: int):
        if sr not in specgram_cache:
            spec = AT.Spectrogram(power=None, n_fft=n_fft, hop_length=hop_length)
            stretch = AT.TimeStretch(n_freq=n_fft // 2 + 1, hop_length=hop_length)
            inv = AT.InverseSpectrogram(n_fft=n_fft, hop_length=hop_length)
            specgram_cache[sr] = (spec, stretch, inv)
        return specgram_cache[sr]

    if progress:
        progress(node.id, "running", 5, "loading inputs")

    for i, inp in enumerate(node.inputs):
        check_cancel()
        src_path = input_paths[(inp.source_node, inp.source_port)]
        audio, sr = torchaudio.load(src_path)
        port = f"out_{inp.slot_id}"

        # Pitch first (duration-preserving), then tempo (pitch-preserving).
        if abs(node.pitch_semitones) >= 1e-9:
            audio = AF.pitch_shift(audio, sr, n_steps=float(node.pitch_semitones))
        if abs(node.tempo_ratio - 1.0) >= 1e-9:
            spec_t, stretch_t, inv_t = get_stft_transforms(sr)
            complex_spec = spec_t(audio)
            stretched = stretch_t(complex_spec, float(node.tempo_ratio))
            audio = inv_t(stretched)
        torchaudio.save(
            str(output_paths[port]),
            audio.contiguous(),
            sr,
        )

        if progress:
            pct = 5 + (i + 1) / n * 90
            progress(node.id, "running", pct, f"processed {i + 1}/{n}")

    if progress:
        progress(node.id, "done", 100, "pitch/speed complete")

    return output_paths
