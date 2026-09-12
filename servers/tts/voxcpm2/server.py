from __future__ import annotations

import base64
import hmac
import io
import os
import tempfile
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Optional

import soundfile as sf
import uvicorn
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel


MODEL_ID = os.getenv("VOXCPM2_MODEL_ID", "openbmb/VoxCPM2")
DEVICE = os.getenv("VOXCPM2_DEVICE", "auto")
OPTIMIZE = os.getenv("VOXCPM2_OPTIMIZE", "1").lower() in {"1", "true", "yes", "on"}
LOAD_DENOISER = os.getenv("VOXCPM2_LOAD_DENOISER", "0").lower() in {"1", "true", "yes", "on"}
HOST = os.getenv("TOMORI_TTS_HOST", "127.0.0.1")
PORT = int(os.getenv("VOXCPM2_PORT", os.getenv("TOMORI_TTS_PORT", "8016")))
MAX_TEXT_CHARS = int(os.getenv("TOMORI_TTS_MAX_TEXT_CHARS", "2000"))
MAX_REF_AUDIO_BYTES = int(os.getenv("VOXCPM2_MAX_REF_AUDIO_BYTES", str(10 * 1024 * 1024)))
API_KEY = (os.getenv("VOXCPM2_API_KEY") or os.getenv("TOMORI_TTS_API_KEY", "")).strip()
ALLOW_REMOTE_BIND = os.getenv("TOMORI_TTS_ALLOW_REMOTE_BIND", "0").lower() in {"1", "true", "yes", "on"}
CFG_VALUE = float(os.getenv("VOXCPM2_CFG_VALUE", "2.0"))
INFERENCE_TIMESTEPS = int(os.getenv("VOXCPM2_INFERENCE_TIMESTEPS", "10"))
MAX_LEN = int(os.getenv("VOXCPM2_MAX_LEN", "4096"))
NORMALIZE = os.getenv("VOXCPM2_NORMALIZE", "0").lower() in {"1", "true", "yes", "on"}
RETRY_BADCASE = os.getenv("VOXCPM2_RETRY_BADCASE", "1").lower() in {"1", "true", "yes", "on"}
RETRY_BADCASE_MAX_TIMES = int(os.getenv("VOXCPM2_RETRY_BADCASE_MAX_TIMES", "3"))
RETRY_BADCASE_RATIO_THRESHOLD = float(os.getenv("VOXCPM2_RETRY_BADCASE_RATIO_THRESHOLD", "6.0"))

model = None
model_lock = threading.Lock()


class SynthesizeRequest(BaseModel):
    text: str
    ref_audio: Optional[str] = None
    ref_text: Optional[str] = None
    instruct: Optional[str] = None
    language: Optional[str] = None


def log_info(message: str) -> None:
    print(f"[VoxCPM2] {message}", flush=True)


def resolve_device() -> Optional[str]:
    normalized = DEVICE.strip().lower()
    if normalized in {"", "auto"}:
        return None
    return DEVICE.strip()


def controlled_text(text: str, instruct: Optional[str]) -> str:
    control = (instruct or "").strip()
    if not control:
        return text
    if control.startswith("(") and control.endswith(")"):
        return f"{control}{text}"
    return f"({control}){text}"


def is_loopback_host(host: str) -> bool:
    return host.strip().lower() in {"127.0.0.1", "localhost", "::1"}


def validate_bind_policy() -> None:
    if not is_loopback_host(HOST) and not API_KEY and not ALLOW_REMOTE_BIND:
        raise RuntimeError(
            "Refusing non-loopback bind without VOXCPM2_API_KEY or "
            "TOMORI_TTS_ALLOW_REMOTE_BIND=1."
        )


def require_bearer_token(authorization: Optional[str]) -> None:
    if not API_KEY:
        return
    expected = f"Bearer {API_KEY}"
    if not authorization or not hmac.compare_digest(authorization.strip(), expected):
        raise HTTPException(status_code=401, detail="A valid bearer token is required.")


def decode_ref_audio(raw_base64: str, directory: str) -> str:
    max_encoded_chars = ((MAX_REF_AUDIO_BYTES + 2) // 3) * 4
    if len(raw_base64) > max_encoded_chars:
        raise HTTPException(status_code=413, detail=f"ref_audio exceeds {MAX_REF_AUDIO_BYTES} decoded bytes.")

    try:
        audio_bytes = base64.b64decode(raw_base64, validate=True)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="ref_audio must be valid base64.") from exc
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="ref_audio must not be empty.")
    if len(audio_bytes) > MAX_REF_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail=f"ref_audio exceeds {MAX_REF_AUDIO_BYTES} decoded bytes.")

    try:
        info = sf.info(io.BytesIO(audio_bytes))
    except Exception as exc:
        raise HTTPException(status_code=400, detail="ref_audio must be a readable audio container.") from exc
    if info.format.upper() != "WAV":
        raise HTTPException(status_code=400, detail="ref_audio must be a WAV container.")
    if info.frames <= 0 or info.samplerate <= 0 or info.channels <= 0:
        raise HTTPException(status_code=400, detail="ref_audio must contain a non-empty audio stream.")

    ref_path = Path(directory) / "reference.wav"
    ref_path.write_bytes(audio_bytes)
    return str(ref_path)


def load_model() -> None:
    global model
    from voxcpm import VoxCPM

    started_at = time.perf_counter()
    log_info(
        f"Loading model_id={MODEL_ID} device={DEVICE} optimize={OPTIMIZE} denoiser={LOAD_DENOISER}"
    )
    model = VoxCPM.from_pretrained(
        MODEL_ID,
        load_denoiser=LOAD_DENOISER,
        optimize=OPTIMIZE,
        device=resolve_device(),
    )
    log_info(f"Model loaded elapsed_ms={int((time.perf_counter() - started_at) * 1000)}")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    validate_bind_policy()
    load_model()
    yield


app = FastAPI(title="TomoriBot VoxCPM2 TTS Server", lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, str | bool | int | float | None]:
    sample_rate = None
    if model is not None:
        sample_rate = int(model.tts_model.sample_rate)
    return {
        "status": "ok" if model is not None else "loading",
        "model": "voxcpm2",
        "model_id": MODEL_ID,
        "device": DEVICE,
        "sample_rate": sample_rate,
        "voice_cloning": True,
        "voice_design": True,
        "controllable_cloning": True,
        "ultimate_cloning": True,
        "upstream_streaming": True,
        "tomoribot_streaming": False,
    }


@app.post("/synthesize")
def synthesize(
    payload: SynthesizeRequest,
    authorization: Annotated[Optional[str], Header()] = None,
) -> Response:
    require_bearer_token(authorization)
    if model is None:
        raise HTTPException(status_code=503, detail="VoxCPM2 is still loading.")

    text = payload.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required.")
    if len(text) > MAX_TEXT_CHARS:
        raise HTTPException(status_code=400, detail=f"text exceeds {MAX_TEXT_CHARS} characters.")

    synthesis_text = controlled_text(text, payload.instruct)
    ref_text = payload.ref_text.strip() if payload.ref_text else ""
    has_ref_audio = bool(payload.ref_audio and payload.ref_audio.strip())
    has_instruct = bool(payload.instruct and payload.instruct.strip())

    if not has_ref_audio and not has_instruct:
        raise HTTPException(status_code=400, detail="Send ref_audio for cloning or instruct for Voice Design.")
    if ref_text and not has_ref_audio:
        raise HTTPException(status_code=400, detail="ref_text requires ref_audio.")

    with tempfile.TemporaryDirectory(prefix="tomori-voxcpm2-") as temp_dir:
        reference_path = decode_ref_audio(payload.ref_audio, temp_dir) if has_ref_audio else None

        kwargs = {
            "text": synthesis_text,
            "cfg_value": CFG_VALUE,
            "inference_timesteps": INFERENCE_TIMESTEPS,
            "max_len": MAX_LEN,
            "normalize": NORMALIZE,
            "denoise": LOAD_DENOISER,
            "retry_badcase": RETRY_BADCASE,
            "retry_badcase_max_times": RETRY_BADCASE_MAX_TIMES,
            "retry_badcase_ratio_threshold": RETRY_BADCASE_RATIO_THRESHOLD,
        }

        mode = "voice-design" if has_instruct and not has_ref_audio else "clone"
        if reference_path:
            kwargs["reference_wav_path"] = reference_path
            mode = "controllable-clone" if has_instruct else "clone"
            if ref_text and not has_instruct:
                kwargs["prompt_wav_path"] = reference_path
                kwargs["prompt_text"] = ref_text
                mode = "ultimate-clone"

        started_at = time.perf_counter()
        with model_lock:
            try:
                wav = model.generate(**kwargs)
            except Exception as exc:
                log_info(f"Synthesis failed mode={mode}: {exc}")
                raise HTTPException(status_code=500, detail=f"VoxCPM2 synthesis failed: {exc}") from exc

        buffer = io.BytesIO()
        sf.write(buffer, wav, int(model.tts_model.sample_rate), format="WAV")
        audio = buffer.getvalue()
        log_info(
            f"/synthesize completed mode={mode} text_chars={len(text)} language={payload.language or 'auto'} "
            f"elapsed_ms={int((time.perf_counter() - started_at) * 1000)}"
        )
        return Response(content=audio, media_type="audio/wav")


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT)
