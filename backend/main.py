import asyncio
import shutil
import threading
import uuid
import json
import sys
import traceback
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Optional

import torch
import torchaudio
from fastapi import FastAPI, HTTPException, BackgroundTasks, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent))
from util.data_ingestion import (
    download_youtube_wav,
    get_video_info,
    is_video_url,
    is_playlist_url,
    extract_video_id,
)
from graph.schema import GraphSpec
from graph.cache import GraphCache
from graph.executor import GraphExecutor, RunCancelled
from graph.hashing import hash_file_bytes
from graph.presets import list_presets, get_preset


DATA_DIR = Path(__file__).parent / "data"
DATA_DIR.mkdir(exist_ok=True)

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
print(f"[stemper] Using device: {DEVICE}")


# ---- Job / run state ----------------------------------------------------

class Job:
    def __init__(self, job_id: str, url: Optional[str] = None):
        self.id = job_id
        self.url = url or ""
        self.video_id: Optional[str] = extract_video_id(url) if url else None
        self.title: str = ""
        # Seed with the canonical YouTube CDN URL so the thumbnail is available
        # immediately on create (before get_video_info completes, and as a
        # fallback if yt-dlp's extractor returns no thumbnail).
        self.thumbnail: Optional[str] = (
            f"https://i.ytimg.com/vi/{self.video_id}/hqdefault.jpg"
            if self.video_id else None
        )
        self.duration: Optional[float] = None
        self.wav_path: Optional[Path] = None
        # SHA-256 of the source WAV bytes. Computed once after the file
        # lands on disk so each Run doesn't re-hash 40+ MB on its hot path.
        self.source_bytes_hash: Optional[str] = None
        # status: "queued" | "downloading" | "ready" | "error"
        self.status: str = "queued"
        self.progress: float = 0
        self.stage: str = ""
        self.error: Optional[str] = None
        self.events: asyncio.Queue = asyncio.Queue()
        # {node_id: {"label", "hash", "path"}} for the most recent run.
        self.outputs: dict = {}
        self.current_task: Optional[asyncio.Task] = None
        # Shared cancel signal for the currently-running graph executor — the
        # Demucs callback checks this and aborts via KeyboardInterrupt, giving
        # us cooperative thread-pool cancellation (asyncio.Task.cancel() alone
        # can't interrupt a running thread).
        self.cancel_event: Optional[threading.Event] = None

    def snapshot(self) -> dict:
        return {
            "id": self.id,
            "url": self.url,
            "video_id": self.video_id,
            "title": self.title,
            "thumbnail": self.thumbnail,
            "duration": self.duration,
            "status": self.status,
            "progress": round(self.progress, 1),
            "stage": self.stage,
            "error": self.error,
        }


jobs: dict[str, Job] = {}


def job_dir(job_id: str) -> Path:
    return DATA_DIR / job_id


async def push_event(job: Job, event: dict) -> None:
    await job.events.put(event)


def push_event_sync(job: Job, event: dict, loop: asyncio.AbstractEventLoop) -> None:
    """Push an event from a worker thread — schedule onto the event loop."""
    asyncio.run_coroutine_threadsafe(job.events.put(event), loop)


# ---- Request / response models -----------------------------------------

class CreateJobRequest(BaseModel):
    url: str


class RunGraphRequest(BaseModel):
    graph: dict  # raw GraphSpec dict (validated below)
    jobs_per_split: int = 4


# ---- Lifespan ----------------------------------------------------------

MAX_JOB_DIRS_ON_DISK = 5


def _prune_old_job_dirs(keep: int = MAX_JOB_DIRS_ON_DISK) -> None:
    """Delete stale per-job data dirs, keeping only the `keep` most recent
    (by mtime). Each dir holds a download WAV + the full graph cache and can
    easily reach a couple GB, so we cap how many accumulate on disk across
    restarts."""
    if not DATA_DIR.exists():
        return
    dirs = [p for p in DATA_DIR.iterdir() if p.is_dir()]
    if len(dirs) <= keep:
        return
    dirs.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    for stale in dirs[keep:]:
        try:
            shutil.rmtree(stale)
            print(f"[stemper] pruned stale job dir: {stale.name}")
        except OSError as e:
            print(f"[stemper] failed to prune {stale.name}: {e}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        torch.multiprocessing.set_start_method("spawn", force=True)
    except RuntimeError:
        pass
    _prune_old_job_dirs()
    yield


app = FastAPI(title="Stemper API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---- Download worker ---------------------------------------------------

async def download_job_worker(job: Job):
    loop = asyncio.get_running_loop()
    try:
        job.status = "downloading"
        await push_event(job, {"type": "job", **job.snapshot()})

        # Ticker: fill the dead time during get_video_info (yt-dlp fires no
        # hooks during metadata extraction) so the UI doesn't stall at 0-20%
        # after the frontend's fake 3s ramp caps. The ticker stops as soon
        # as download_youtube_wav starts emitting real progress (which will
        # bump job.progress above this ticker's pct).
        ticker_active = True

        async def pre_download_ticker():
            pct = 0.0
            while ticker_active and pct < 1.0 and job.progress < 1.0:
                pct += 0.05
                job.progress = max(job.progress, pct)
                await push_event(job, {
                    "type": "job",
                    "status": "downloading",
                    "progress": job.progress,
                    "stage": "fetching metadata",
                })
                await asyncio.sleep(0.4)

        ticker_task = asyncio.create_task(pre_download_ticker())

        try:
            info = await loop.run_in_executor(None, get_video_info, job.url)
            job.title = info.get("title", "Unknown")
            job.thumbnail = info.get("thumbnail") or job.thumbnail
            job.duration = info.get("duration")
            await push_event(job, {"type": "info", **job.snapshot()})
        except Exception as e:
            print(f"[stemper] get_video_info failed: {e}")
            job.title = job.video_id or "Unknown"
        finally:
            ticker_active = False
            ticker_task.cancel()
            try:
                await ticker_task
            except (asyncio.CancelledError, Exception):
                pass

        dl_dir = job_dir(job.id) / "download"

        def dl_progress(pct, stage):
            job.progress = max(job.progress, pct)
            job.stage = stage
            push_event_sync(job, {"type": "job", "status": "downloading", "progress": job.progress, "stage": stage}, loop)

        wav = await loop.run_in_executor(
            None, download_youtube_wav, job.url, dl_dir, dl_progress
        )
        job.wav_path = wav
        job.source_bytes_hash = await loop.run_in_executor(None, hash_file_bytes, wav)
        job.status = "ready"
        job.progress = 100
        job.stage = "ready"
        await push_event(job, {"type": "job", "status": "ready", "progress": 100, **job.snapshot()})
    except Exception as e:
        print(f"[stemper] Download job {job.id} failed: {e}")
        traceback.print_exc()
        job.status = "error"
        job.error = str(e)
        await push_event(job, {"type": "job", "status": "error", "error": str(e)})


# ---- Graph execution worker --------------------------------------------

async def run_graph_worker(job: Job, graph: GraphSpec, jobs_per_split: int):
    loop = asyncio.get_running_loop()
    # Fresh cancel flag per run. Any prior event is replaced, so a stale Set
    # from a previous (already-completed) run doesn't poison this one.
    job.cancel_event = threading.Event()

    def progress(node_id: str, status: str, pct: float, stage: str):
        push_event_sync(job, {
            "type": "node",
            "node_id": node_id,
            "status": status,
            "progress": pct,
            "stage": stage,
        }, loop)

    def work():
        cache = GraphCache(job_dir(job.id) / "graph")
        executor = GraphExecutor(
            graph=graph,
            source_wav=job.wav_path,
            cache=cache,
            device=DEVICE,
            jobs=jobs_per_split,
            progress=progress,
            cancel_event=job.cancel_event,
            source_bytes_hash=job.source_bytes_hash,
        )
        return executor.execute()

    try:
        await push_event(job, {"type": "run", "status": "running"})
        outputs = await loop.run_in_executor(None, work)
        job.outputs = outputs
        await push_event(job, {
            "type": "run",
            "status": "done",
            "outputs": [
                {"node_id": nid, "label": info["label"], "hash": info["hash"]}
                for nid, info in outputs.items()
            ],
        })
    except RunCancelled:
        # Cooperative cancel via the event — Demucs aborted mid-segment.
        await push_event(job, {"type": "run", "status": "cancelled"})
    except asyncio.CancelledError:
        # Fallback: task was cancelled at the asyncio layer (e.g. new run
        # replacing this one). The executor thread may still be finishing
        # a segment; we've emitted the event so the UI is consistent.
        await push_event(job, {"type": "run", "status": "cancelled"})
        raise
    except Exception as e:
        print(f"[stemper] Graph run for job {job.id} failed: {e}")
        traceback.print_exc()
        await push_event(job, {"type": "run", "status": "error", "error": str(e)})


# ---- Endpoints ---------------------------------------------------------

@app.post("/api/jobs")
async def create_job(req: CreateJobRequest, background_tasks: BackgroundTasks):
    if is_playlist_url(req.url):
        raise HTTPException(400, "Playlist URLs are not supported — paste a single video URL")
    if not is_video_url(req.url):
        raise HTTPException(400, "Invalid YouTube URL")
    job_id = str(uuid.uuid4())[:8]
    job = Job(job_id, req.url)
    jobs[job_id] = job
    asyncio.create_task(download_job_worker(job))
    return {"job_id": job_id}


@app.post("/api/jobs/upload")
async def upload_job(file: UploadFile = File(...)):
    job_id = str(uuid.uuid4())[:8]
    job = Job(job_id)
    jobs[job_id] = job

    # Title from filename (sans extension)
    display_name = Path(file.filename or "upload").stem or "upload"
    job.title = display_name

    # Write the upload to disk, then decode -> WAV via torchaudio
    upload_dir = job_dir(job_id) / "upload"
    upload_dir.mkdir(parents=True, exist_ok=True)
    raw_path = upload_dir / (file.filename or "upload.bin")
    with open(raw_path, "wb") as f:
        while chunk := await file.read(1024 * 1024):
            f.write(chunk)

    try:
        audio, sr = torchaudio.load(str(raw_path))
    except Exception as e:
        jobs.pop(job_id, None)
        raise HTTPException(400, f"Could not decode audio: {e}")

    wav_path = upload_dir / "source.wav"
    torchaudio.save(str(wav_path), audio, sr)

    job.wav_path = wav_path
    job.source_bytes_hash = hash_file_bytes(wav_path)
    job.duration = audio.shape[-1] / float(sr)
    job.status = "ready"
    job.progress = 100
    job.stage = "ready"
    await push_event(job, {"type": "job", "status": "ready", "progress": 100, **job.snapshot()})
    return {"job_id": job_id}


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str):
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")
    return jobs[job_id].snapshot()


@app.get("/api/jobs/{job_id}/events")
async def job_events(job_id: str):
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")
    job = jobs[job_id]

    async def stream():
        # Send initial snapshot
        yield f"data: {json.dumps({'type': 'snapshot', **job.snapshot()})}\n\n"
        while True:
            try:
                event = await asyncio.wait_for(job.events.get(), timeout=30.0)
            except asyncio.TimeoutError:
                # Heartbeat to keep the connection alive
                yield ": heartbeat\n\n"
                continue
            yield f"data: {json.dumps(event)}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


@app.post("/api/jobs/{job_id}/graph")
async def run_graph(job_id: str, req: RunGraphRequest):
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")
    job = jobs[job_id]
    if job.status != "ready":
        raise HTTPException(400, f"Job not ready (status: {job.status})")
    if not job.wav_path or not job.wav_path.exists():
        raise HTTPException(400, "Source audio not available")

    try:
        graph = GraphSpec.model_validate(req.graph)
    except Exception as e:
        raise HTTPException(400, f"Invalid graph: {e}")

    # Cancel any previous run — set the event FIRST so Demucs aborts
    # cooperatively, then cancel the task to unblock the await.
    if job.current_task and not job.current_task.done():
        if job.cancel_event is not None:
            job.cancel_event.set()
        job.current_task.cancel()
        try:
            await job.current_task
        except (asyncio.CancelledError, Exception):
            pass

    run_id = str(uuid.uuid4())[:8]
    job.current_task = asyncio.create_task(
        run_graph_worker(job, graph, req.jobs_per_split)
    )
    return {"run_id": run_id, "status": "started"}


@app.post("/api/jobs/{job_id}/graph/cancel")
async def cancel_graph(job_id: str):
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")
    job = jobs[job_id]
    if job.current_task and not job.current_task.done():
        # Signal cooperative cancel — the Demucs callback polls this event
        # and raises KeyboardInterrupt mid-segment, unwinding the thread-pool
        # call promptly. Just calling task.cancel() would deliver a
        # CancelledError to the await but couldn't stop the running thread.
        if job.cancel_event is not None:
            job.cancel_event.set()
        return {"status": "cancelling"}
    return {"status": "not_running"}


@app.get("/api/jobs/{job_id}/graph/outputs/{node_id}")
async def get_output(job_id: str, node_id: str):
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")
    job = jobs[job_id]
    if node_id not in job.outputs:
        raise HTTPException(404, f"Output '{node_id}' not found (run the graph first)")
    path = Path(job.outputs[node_id]["path"])
    if not path.exists():
        raise HTTPException(404, "Output file missing on disk (cache may have been swept)")
    label = job.outputs[node_id].get("label", node_id)
    return FileResponse(
        path, media_type="audio/wav",
        filename=f"{label}.wav",
        headers={"Cache-Control": "no-cache"},
    )


_PRESETS_RESPONSE = {
    "presets": [
        {**meta, "graph": get_preset(meta["id"])}
        for meta in list_presets()
    ],
}


@app.get("/api/presets")
async def get_presets_endpoint():
    return _PRESETS_RESPONSE


@app.get("/api/models")
async def list_models():
    return {
        "models": [
            {"id": "htdemucs_6s", "name": "HTDemucs 6-Stem",
             "stems": ["vocals", "other", "piano", "guitar", "drums", "bass"]},
            {"id": "htdemucs", "name": "HTDemucs 4-Stem",
             "stems": ["vocals", "drums", "bass", "other"]},
            {"id": "htdemucs_ft", "name": "HTDemucs Fine-tuned",
             "stems": ["vocals", "drums", "bass", "other"]},
        ]
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
