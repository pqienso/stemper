import torch
import torchaudio
import pyloudnorm


def convert_mono(audio: torch.Tensor):
    return audio.mean(dim=0, keepdim=True)


# Cache Resample transforms — each instantiation builds a filter kernel, which
# is wasted work when the same (sr, sr, device) tuple gets reused across stems.
_RESAMPLE_CACHE: dict[tuple[int, int, str], torchaudio.transforms.Resample] = {}


def resample(
    audio: torch.Tensor,
    old_sr: int,
    final_sr: int,
    device=torch.device("cpu"),
):
    key = (old_sr, final_sr, str(device))
    resampler = _RESAMPLE_CACHE.get(key)
    if resampler is None:
        resampler = torchaudio.transforms.Resample(
            orig_freq=old_sr, new_freq=final_sr
        ).to(device)
        _RESAMPLE_CACHE[key] = resampler
    return resampler(audio)


def normalize_lufs(
    waveform: torch.Tensor, sr: int, target_lufs: float = -14.0
) -> torch.Tensor:
    """Normalizes a torchaudio waveform to a target LUFS level."""
    assert waveform.dim() == 2
    waveform_np = waveform.transpose(0, 1).numpy()

    meter = pyloudnorm.Meter(sr)
    loudness = meter.integrated_loudness(waveform_np)

    if loudness == float("-inf"):
        return waveform

    normalized_waveform_np = pyloudnorm.normalize.loudness(
        waveform_np, loudness, target_lufs
    )
    normalized_waveform = torch.from_numpy(normalized_waveform_np).transpose(0, 1)

    return normalized_waveform
