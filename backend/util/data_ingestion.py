from typing import Optional, Callable
import os
import sys
import threading
import time
import yt_dlp
import re
from pathlib import Path


# Toggled via STEMPER_YTDLP_VERBOSE=1 (set by run.sh). When on, yt-dlp logs
# format selection, signature decode, and extractor internals to stderr.
YTDLP_VERBOSE = os.environ.get("STEMPER_YTDLP_VERBOSE") == "1"


_VIDEO_ID_RE = re.compile(r"(?:v=|youtu\.be/|embed/|shorts/)([A-Za-z0-9_-]{11})")


def extract_video_id(youtube_url: str) -> Optional[str]:
    match = _VIDEO_ID_RE.search(youtube_url)
    return match.group(1) if match else None


def is_playlist_url(youtube_url: str) -> bool:
    playlist_pattern = r"https?://(?:www\.)?youtube\.com/playlist\?list=[A-Za-z0-9_-]+"
    return bool(re.match(playlist_pattern, youtube_url))


def is_video_url(youtube_url: str) -> bool:
    return bool(re.match(
        r"https?://(?:www\.)?(?:youtube\.com/(?:watch|shorts|embed)|youtu\.be/)",
        youtube_url,
    ))


def get_video_info(url: str) -> dict:
    opts = {"extract_flat": True}
    if YTDLP_VERBOSE:
        opts.update({"quiet": False, "verbose": True, "no_warnings": False})
        print(f"[yt-dlp] get_video_info: {url}", file=sys.stderr, flush=True)
    else:
        opts["quiet"] = True
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
        return {
            "title": info.get("title", "Unknown"),
            "duration": info.get("duration"),
            "thumbnail": info.get("thumbnail"),
            "id": info.get("id"),
        }


def download_youtube_wav(
    video_url: str,
    download_folder: Path,
    progress_callback: Optional[Callable[[float, str], None]] = None,
) -> Path:
    """Mirrors saxgpt's download_youtube_wav."""
    video_id = extract_video_id(video_url)
    assert video_id is not None, "URL must be a valid YouTube video"

    wav_file_path = download_folder / f"{video_id}.wav"
    download_folder.mkdir(parents=True, exist_ok=True)

    if wav_file_path.exists():
        print(f"File '{wav_file_path}' already exists. Skipping download.")
        if progress_callback:
            progress_callback(100, "cached")
        return wav_file_path

    # Progress plan (pct sent to progress_callback; frontend then re-scales
    # into its own 20–100 band):
    #   0-10%  : probing ramp while yt-dlp resolves metadata + signatures.
    #            yt-dlp fires no hooks during this phase, so we tick our own
    #            synthetic progress on a thread so the UI keeps moving.
    #   10-90% : actual byte-download progress from progress_hooks.
    #   90-99% : ffmpeg post-processing (FFmpegExtractAudio) from
    #            postprocessor_hooks.
    #   100%   : file written + validated.
    #
    # `state.lock` guards `state.pct` so the probe thread and yt-dlp's own
    # hook threads (yt-dlp may fire from worker threads for fragmented DASH
    # streams) don't race when monotonically bumping the pct upward.
    class State:
        pct: float = 0.0
        real_started: bool = False
        stop_probe: bool = False
        lock = threading.Lock()

    state = State()

    def emit(pct: float, stage: str) -> None:
        """Monotonically bump pct and forward via the callback."""
        with state.lock:
            if pct <= state.pct:
                pct = state.pct
            else:
                state.pct = pct
        if progress_callback:
            progress_callback(pct, stage)
        if YTDLP_VERBOSE:
            print(f"[yt-dlp] stage={stage} pct={pct:.1f}", file=sys.stderr, flush=True)

    def mark_real(pct: float, stage: str) -> None:
        """Flag real-progress arrival so the probe loop exits."""
        with state.lock:
            state.real_started = True
        emit(pct, stage)

    def progress_hook(d):
        status = d.get("status")
        if status == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            downloaded = d.get("downloaded_bytes", 0)
            raw_pct = (downloaded / total * 100) if total > 0 else 0
            # Map download 0-100 into the 10-90 band.
            mark_real(10 + raw_pct * 0.8, "downloading")
        elif status == "finished":
            mark_real(90, "download complete")

    def postprocessor_hook(d):
        status = d.get("status")
        pp = d.get("postprocessor", "")
        if status == "started":
            mark_real(92, f"converting: {pp}")
        elif status == "finished":
            mark_real(99, f"converted: {pp}")

    def probe():
        """Tick synthetic progress from 0 → 10 while waiting for the first
        real hook. Small increments (0.5/sec) so we never overshoot before
        real progress overtakes us."""
        while not state.stop_probe and not state.real_started:
            with state.lock:
                if state.pct < 9.5:
                    state.pct += 0.5
                    cur = state.pct
                else:
                    cur = state.pct
            if progress_callback:
                progress_callback(cur, "resolving")
            time.sleep(0.5)

    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": str(download_folder / "%(id)s.%(ext)s"),
        "postprocessors": [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "wav",
            }
        ],
        "progress_hooks": [progress_hook],
        "postprocessor_hooks": [postprocessor_hook],
        # Reject playlist semantics — if the URL has &list=..., download only
        # the single video it points to.
        "noplaylist": True,
        # yt-dlp 2026+ needs a JS runtime + a remote challenge solver to
        # decode modern YouTube stream signatures. `node` is installed via
        # mise; `ejs:github` pulls the solver script from yt-dlp's repo.
        "js_runtimes": {"node": {}},
        "remote_components": ["ejs:github"],
    }
    if YTDLP_VERBOSE:
        # Verbose dumps format ladder, signature decoding, and extractor
        # internals — plus our own header so it's easy to grep per-download.
        ydl_opts.update({"quiet": False, "verbose": True, "no_warnings": False})
        print(
            f"[yt-dlp] download_youtube_wav: url={video_url} -> {wav_file_path}",
            file=sys.stderr,
            flush=True,
        )
    else:
        ydl_opts.update({"quiet": True, "no_warnings": True})

    probe_thread = threading.Thread(target=probe, daemon=True)
    probe_thread.start()
    try:
        emit(1, "resolving")  # immediate tick so the bar leaves 0 right away
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.extract_info(video_url, download=True)
    except yt_dlp.DownloadError as e:
        raise RuntimeError(f"Download of {video_url} failed: {e}")
    finally:
        state.stop_probe = True
        probe_thread.join(timeout=1.0)

    if not wav_file_path.exists():
        raise RuntimeError(f"Download finished but {wav_file_path} not found")

    emit(100, "ready")
    return wav_file_path
