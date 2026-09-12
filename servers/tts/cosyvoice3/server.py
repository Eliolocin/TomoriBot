from __future__ import annotations

import base64
import io
import os
import re
import sys
import tempfile
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import numpy as np
import soundfile as sf
import torch
import uvicorn
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from routing import resolve_synthesis_mode


ROOT = Path(__file__).resolve().parent
RUNTIME_DIR = Path(os.getenv("COSYVOICE3_RUNTIME_DIR", ROOT / "CosyVoice")).resolve()
MODEL_DIR = Path(
    os.getenv(
        "COSYVOICE3_MODEL_DIR",
        RUNTIME_DIR / "pretrained_models" / "Fun-CosyVoice3-0.5B",
    )
).resolve()
MODEL_ID = os.getenv("COSYVOICE3_MODEL_ID", "FunAudioLLM/Fun-CosyVoice3-0.5B-2512")

HOST = os.getenv("TOMORI_TTS_HOST", "127.0.0.1")
PORT = int(os.getenv("COSYVOICE3_PORT", os.getenv("TOMORI_TTS_PORT", "8017")))
MAX_TEXT_CHARS = int(os.getenv("TOMORI_TTS_MAX_TEXT_CHARS", "2000"))
UPSTREAM_STREAM = os.getenv("COSYVOICE3_UPSTREAM_STREAM", "0").lower() in {"1", "true", "yes", "on"}
FP16 = os.getenv("COSYVOICE3_FP16", "0").lower() in {"1", "true", "yes", "on"}
LOAD_TRT = os.getenv("COSYVOICE3_LOAD_TRT", "0").lower() in {"1", "true", "yes", "on"}
LOAD_VLLM = os.getenv("COSYVOICE3_LOAD_VLLM", "0").lower() in {"1", "true", "yes", "on"}
SPEED = float(os.getenv("COSYVOICE3_SPEED", "1.0"))
DEFAULT_INSTRUCT = os.getenv("COSYVOICE3_DEFAULT_INSTRUCT", "").strip()
MAX_REF_AUDIO_BYTES = int(os.getenv("COSYVOICE3_MAX_REF_AUDIO_BYTES", str(25 * 1024 * 1024)))
MAX_REF_AUDIO_SECONDS = float(os.getenv("COSYVOICE3_MAX_REF_AUDIO_SECONDS", "30"))
BEARER_TOKEN = os.getenv("COSYVOICE3_BEARER_TOKEN", "").strip()
ALLOW_REMOTE_BIND = os.getenv("COSYVOICE3_ALLOW_REMOTE_BIND", "0").lower() in {"1", "true", "yes", "on"}

if MAX_REF_AUDIO_BYTES <= 0:
    raise ValueError("COSYVOICE3_MAX_REF_AUDIO_BYTES must be greater than zero.")
if MAX_REF_AUDIO_SECONDS <= 0:
    raise ValueError("COSYVOICE3_MAX_REF_AUDIO_SECONDS must be greater than zero.")

SYSTEM_PROMPT = "You are a helpful assistant."
END_OF_PROMPT = "<|endofprompt|>"

LANGUAGE_NAMES = {
    "zh": "Chinese",
    "zh-cn": "Chinese",
    "en": "English",
    "ja": "Japanese",
    "jp": "Japanese",
    "ko": "Korean",
    "de": "German",
    "es": "Spanish",
    "fr": "French",
    "it": "Italian",
    "ru": "Russian",
}

TAG_REGEX = re.compile(r"\[([^\]\r\n]{1,40})\]")


def is_loopback_host(host: str) -> bool:
    return host in {"127.0.0.1", "localhost", "::1"}


if not is_loopback_host(HOST) and not ALLOW_REMOTE_BIND:
    raise RuntimeError(
        "CosyVoice 3 refuses non-loopback binding by default. "
        "Set COSYVOICE3_ALLOW_REMOTE_BIND=1 only when remote access is intentional."
    )
if not is_loopback_host(HOST) and not BEARER_TOKEN:
    print(
        "[CosyVoice3] Warning: remote binding is enabled without COSYVOICE3_BEARER_TOKEN.",
        file=sys.stderr,
        flush=True,
    )

model = None
model_lock = threading.Lock()


class SynthesizeRequest(BaseModel):
    text: str
    ref_audio: str
    ref_text: Optional[str] = None
    instruct: Optional[str] = None
    language: Optional[str] = None


def log_info(message: str) -> None:
    print(f"[CosyVoice3] {message}", flush=True)


def require_installation() -> None:
    if not (RUNTIME_DIR / "cosyvoice" / "cli" / "cosyvoice.py").is_file():
        raise RuntimeError(
            f"CosyVoice runtime not found at {RUNTIME_DIR}. "
            "Run the CosyVoice 3 setup instructions first."
        )
    if not (MODEL_DIR / "cosyvoice3.yaml").is_file():
        raise RuntimeError(
            f"CosyVoice 3 checkpoint not found at {MODEL_DIR}. "
            f"Download {MODEL_ID} before starting the sidecar."
        )


def prepare_import_path() -> None:
    runtime = str(RUNTIME_DIR)
    matcha = str(RUNTIME_DIR / "third_party" / "Matcha-TTS")
    if runtime not in sys.path:
        sys.path.insert(0, runtime)
    if matcha not in sys.path:
        sys.path.insert(0, matcha)


def load_model() -> None:
    global model
    require_installation()
    prepare_import_path()

    from cosyvoice.cli.cosyvoice import AutoModel

    started_at = time.perf_counter()
    log_info(
        "Loading model "
        f"model_dir={MODEL_DIR} fp16={FP16} load_trt={LOAD_TRT} "
        f"load_vllm={LOAD_VLLM} upstream_stream={UPSTREAM_STREAM}"
    )
    model = AutoModel(
        model_dir=str(MODEL_DIR),
        load_trt=LOAD_TRT,
        load_vllm=LOAD_VLLM,
        fp16=FP16,
    )
    log_info(f"Model loaded in {time.perf_counter() - started_at:.2f}s")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    load_model()
    yield


app = FastAPI(title="TomoriBot CosyVoice 3 TTS Server", lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, object]:
    return {
        "status": "ok" if model is not None else "loading",
        "model": "Fun-CosyVoice3-0.5B-2512",
        "model_id": MODEL_ID,
        "model_dir": str(MODEL_DIR),
        "sample_rate": int(model.sample_rate) if model is not None else 24000,
        "upstream_streaming": UPSTREAM_STREAM,
        "port": PORT,
        "max_ref_audio_bytes": MAX_REF_AUDIO_BYTES,
        "max_ref_audio_seconds": MAX_REF_AUDIO_SECONDS,
        "supports_zero_shot": True,
        "supports_cross_lingual": True,
        "supports_instruct": True,
    }


def decode_reference_audio(raw_base64: str, directory: str) -> str:
    max_encoded_chars = ((MAX_REF_AUDIO_BYTES + 2) // 3) * 4
    if len(raw_base64) > max_encoded_chars:
        raise HTTPException(status_code=413, detail="ref_audio exceeds the configured size limit.")
    try:
        audio = base64.b64decode(raw_base64, validate=True)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="ref_audio must be valid base64.") from exc
    if not audio:
        raise HTTPException(status_code=400, detail="ref_audio must not be empty.")
    if len(audio) > MAX_REF_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="ref_audio exceeds the configured size limit.")

    ref_path = Path(directory) / "reference.wav"
    ref_path.write_bytes(audio)
    try:
        info = sf.info(ref_path)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="ref_audio must be a readable audio container.") from exc
    if info.format not in {"WAV", "FLAC", "OGG", "AIFF"}:
        raise HTTPException(status_code=400, detail="ref_audio must use WAV, FLAC, OGG, or AIFF audio.")
    if info.frames <= 0 or info.samplerate <= 0:
        raise HTTPException(status_code=400, detail="ref_audio must contain audio frames.")
    if info.samplerate < 16000:
        raise HTTPException(status_code=400, detail="ref_audio sample rate must be at least 16000 Hz.")
    if info.duration > MAX_REF_AUDIO_SECONDS:
        raise HTTPException(
            status_code=413,
            detail=f"ref_audio exceeds the configured {MAX_REF_AUDIO_SECONDS:g}-second duration limit.",
        )
    return str(ref_path)


def normalize_language(language: Optional[str]) -> str:
    if not language or not language.strip():
        return ""
    normalized = language.strip().lower().replace("_", "-")
    if normalized in {"auto", "automatic"}:
        return ""
    return LANGUAGE_NAMES.get(normalized, language.strip())


def prepare_script(text: str) -> str:
    # CosyVoice instructions apply to the whole request. Removing tags here avoids turning
    # positional [happy] and [sad] markers into contradictory utterance-wide directions.
    cleaned = TAG_REGEX.sub("", text)
    cleaned = re.sub(r"[ \t]+\n", "\n", cleaned)
    cleaned = re.sub(r"[^\S\n]+", " ", cleaned).strip()
    return cleaned


def build_instruct(payload: SynthesizeRequest) -> str:
    parts: list[str] = []
    language = normalize_language(payload.language)
    if language:
        parts.append(f"Speak in {language}.")

    explicit = (payload.instruct or DEFAULT_INSTRUCT).strip()
    if explicit:
        # The delimiter belongs to CosyVoice's prompt format, not the user text.
        explicit = explicit.replace(END_OF_PROMPT, " ").strip()
        parts.append(explicit)

    if not parts:
        return ""

    return f"{SYSTEM_PROMPT} {' '.join(parts)}{END_OF_PROMPT}"


def collect_audio(outputs) -> np.ndarray:
    chunks: list[np.ndarray] = []
    for output in outputs:
        speech = output.get("tts_speech")
        if speech is None:
            continue
        tensor = speech.detach().to(dtype=torch.float32, device="cpu")
        array = tensor.numpy()
        if array.ndim == 2 and array.shape[0] == 1:
            array = array[0]
        chunks.append(np.asarray(array, dtype=np.float32).reshape(-1))

    if not chunks:
        raise RuntimeError("CosyVoice returned no audio chunks.")
    return np.concatenate(chunks)


def encode_wav(audio: np.ndarray, sample_rate: int) -> bytes:
    buffer = io.BytesIO()
    sf.write(buffer, audio, sample_rate, format="WAV", subtype="PCM_16")
    return buffer.getvalue()


def iter_inference(
    *,
    text: str,
    ref_path: str,
    ref_text: str,
    instruct: str,
):
    mode = resolve_synthesis_mode(ref_text=ref_text, instruct=instruct, language="")
    if mode == "instruct2":
        return "instruct2", model.inference_instruct2(
            text,
            instruct,
            ref_path,
            stream=UPSTREAM_STREAM,
            speed=SPEED,
        )

    if mode == "zero_shot":
        prompt_text = f"{SYSTEM_PROMPT}{END_OF_PROMPT}{ref_text}"
        return "zero_shot", model.inference_zero_shot(
            text,
            prompt_text,
            ref_path,
            stream=UPSTREAM_STREAM,
            speed=SPEED,
        )

    # The current CosyVoice 3 cross-lingual path conditions on the reference
    # audio without a transcript. Keep the system prefix used by the official
    # CosyVoice 3 examples.
    cross_lingual_text = f"{SYSTEM_PROMPT}{END_OF_PROMPT}{text}"
    return "cross_lingual", model.inference_cross_lingual(
        cross_lingual_text,
        ref_path,
        stream=UPSTREAM_STREAM,
        speed=SPEED,
    )


@app.post("/synthesize")
def synthesize(payload: SynthesizeRequest, authorization: Optional[str] = Header(default=None)) -> Response:
    if BEARER_TOKEN and authorization != f"Bearer {BEARER_TOKEN}":
        raise HTTPException(status_code=401, detail="A valid bearer token is required.")
    if model is None:
        raise HTTPException(status_code=503, detail="CosyVoice 3 is still loading.")

    text = payload.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required.")
    if len(text) > MAX_TEXT_CHARS:
        raise HTTPException(status_code=400, detail=f"text exceeds {MAX_TEXT_CHARS} characters.")
    if not payload.ref_audio or not payload.ref_audio.strip():
        raise HTTPException(status_code=400, detail="ref_audio is required for CosyVoice 3 voice cloning.")

    processed_text = prepare_script(text)
    if not processed_text:
        raise HTTPException(status_code=400, detail="text was empty after removing bracket tags.")

    ref_text = payload.ref_text.strip() if payload.ref_text else ""
    instruct = build_instruct(payload)

    with tempfile.TemporaryDirectory(prefix="tomori-cosyvoice3-") as temp_dir:
        ref_path = decode_reference_audio(payload.ref_audio, temp_dir)
        started_at = time.perf_counter()

        try:
            with model_lock, torch.inference_mode():
                mode, outputs = iter_inference(
                    text=processed_text,
                    ref_path=ref_path,
                    ref_text=ref_text,
                    instruct=instruct,
                )
                audio = collect_audio(outputs)
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"CosyVoice 3 synthesis failed: {exc}") from exc

    sample_rate = int(model.sample_rate)
    wav = encode_wav(audio, sample_rate)
    log_info(
        f"/synthesize mode={mode} text_chars={len(processed_text)} ref_text_chars={len(ref_text)} "
        f"instruct_chars={len(instruct)} sample_rate={sample_rate} elapsed_ms={int((time.perf_counter() - started_at) * 1000)}"
    )
    return Response(content=wav, media_type="audio/wav")


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT)
