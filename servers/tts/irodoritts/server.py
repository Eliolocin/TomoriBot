from __future__ import annotations

import base64
import os
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import torch
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel


DEFAULT_MODEL_ID = "Aratako/Irodori-TTS-v4.1-Small"

MODEL_ID = os.getenv("IRODORI_TTS_MODEL_ID", DEFAULT_MODEL_ID)
LOCAL_CHECKPOINT = os.getenv("IRODORI_TTS_CHECKPOINT")
HOST = os.getenv("TOMORI_TTS_HOST", "127.0.0.1")
PORT = int(os.getenv("TOMORI_TTS_PORT", "8013"))

MODEL_DEVICE = os.getenv("IRODORI_MODEL_DEVICE", "auto")
CODEC_DEVICE = os.getenv("IRODORI_CODEC_DEVICE", "auto")
MODEL_PRECISION = os.getenv(
  "IRODORI_MODEL_PRECISION",
  "bf16" if torch.cuda.is_available() else "fp32",
)
CODEC_PRECISION = os.getenv("IRODORI_CODEC_PRECISION", "fp32")
COMPILE_MODEL = os.getenv("IRODORI_COMPILE_MODEL", "false").lower() in {"1", "true", "yes", "on"}
COMPILE_DYNAMIC = os.getenv("IRODORI_COMPILE_DYNAMIC", "false").lower() in {"1", "true", "yes", "on"}

NUM_STEPS = int(os.getenv("IRODORI_NUM_STEPS", "40"))
T_SCHEDULE_MODE = os.getenv("IRODORI_T_SCHEDULE_MODE", "linear")
SWAY_COEFF = float(os.getenv("IRODORI_SWAY_COEFF", "-1.0"))
CFG_SCALE_TEXT = float(os.getenv("IRODORI_CFG_SCALE_TEXT", "3.0"))
CFG_SCALE_CAPTION = float(os.getenv("IRODORI_CFG_SCALE_CAPTION", "3.0"))
CFG_SCALE_SPEAKER = float(os.getenv("IRODORI_CFG_SCALE_SPEAKER", "5.0"))
MAX_REF_SECONDS_RAW = os.getenv("IRODORI_MAX_REF_SECONDS")
MAX_REF_SECONDS = float(MAX_REF_SECONDS_RAW) if MAX_REF_SECONDS_RAW else None

MAX_TEXT_CHARS = int(os.getenv("TOMORI_TTS_MAX_TEXT_CHARS", "1000"))

runtime = None
resolved_checkpoint: str | None = None
resolved_model_device: str | None = None
resolved_codec_device: str | None = None


class SynthesizeRequest(BaseModel):
  text: str
  ref_audio: Optional[str] = None
  ref_text: Optional[str] = None
  instruct: Optional[str] = None
  language: Optional[str] = None


def decode_ref_audio(raw_base64: str, directory: str) -> str:
  try:
    audio_bytes = base64.b64decode(raw_base64, validate=True)
  except Exception as exc:
    raise HTTPException(status_code=400, detail="ref_audio must be valid base64.") from exc

  if not audio_bytes:
    raise HTTPException(status_code=400, detail="ref_audio must not be empty.")

  ref_path = Path(directory) / "reference.wav"
  ref_path.write_bytes(audio_bytes)
  return str(ref_path)


def resolve_device(value: str) -> str:
  from irodori_tts.inference_runtime import default_runtime_device

  return default_runtime_device() if value.strip().lower() in {"", "auto"} else value


def resolve_checkpoint() -> str:
  from irodori_tts.inference_runtime import download_hf_checkpoint

  if LOCAL_CHECKPOINT and LOCAL_CHECKPOINT.strip():
    path = Path(LOCAL_CHECKPOINT).expanduser()
    if not path.is_file():
      raise FileNotFoundError(f"IRODORI_TTS_CHECKPOINT not found: {path}")
    return str(path)

  return download_hf_checkpoint(MODEL_ID)


def load_model() -> None:
  global runtime, resolved_checkpoint, resolved_model_device, resolved_codec_device

  from irodori_tts.inference_runtime import InferenceRuntime, RuntimeKey

  resolved_checkpoint = resolve_checkpoint()
  resolved_model_device = resolve_device(MODEL_DEVICE)
  resolved_codec_device = resolve_device(CODEC_DEVICE)

  runtime = InferenceRuntime.from_key(
    RuntimeKey(
      checkpoint=resolved_checkpoint,
      model_device=resolved_model_device,
      codec_device=resolved_codec_device,
      model_precision=MODEL_PRECISION,
      codec_precision=CODEC_PRECISION,
      compile_model=COMPILE_MODEL,
      compile_dynamic=COMPILE_DYNAMIC,
    )
  )


@asynccontextmanager
async def lifespan(_app: FastAPI):
  load_model()
  try:
    yield
  finally:
    if runtime is not None:
      runtime.unload()


app = FastAPI(title="TomoriBot Irodori-TTS Server", lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, str | int | float | bool | None]:
  return {
    "status": "ok" if runtime is not None else "loading",
    "model_id": MODEL_ID,
    "checkpoint": resolved_checkpoint,
    "model_device": resolved_model_device,
    "codec_device": resolved_codec_device,
    "model_precision": MODEL_PRECISION,
    "codec_precision": CODEC_PRECISION,
    "num_steps": NUM_STEPS,
    "t_schedule_mode": T_SCHEDULE_MODE,
    "sway_coeff": SWAY_COEFF,
    "compile_model": COMPILE_MODEL,
    "supports_voice_design": True,
  }


@app.post("/synthesize")
def synthesize(payload: SynthesizeRequest) -> Response:
  if runtime is None:
    raise HTTPException(status_code=503, detail="Model is still loading.")

  text = payload.text.strip()
  if not text:
    raise HTTPException(status_code=400, detail="text is required.")
  if len(text) > MAX_TEXT_CHARS:
    raise HTTPException(status_code=400, detail=f"text exceeds {MAX_TEXT_CHARS} characters.")

  ref_audio = payload.ref_audio.strip() if payload.ref_audio else ""
  caption = payload.instruct.strip() if payload.instruct else ""
  if not ref_audio and not caption:
    raise HTTPException(status_code=400, detail="ref_audio or instruct is required.")

  with tempfile.TemporaryDirectory(prefix="tomori-irodori-") as temp_dir:
    ref_path = decode_ref_audio(ref_audio, temp_dir) if ref_audio else None
    output_path = Path(temp_dir) / "output.wav"

    from irodori_tts.inference_runtime import SamplingRequest, save_wav

    try:
      result = runtime.synthesize(
        SamplingRequest(
          text=text,
          caption=caption or None,
          ref_wav=ref_path,
          no_ref=ref_path is None,
          num_candidates=1,
          num_steps=NUM_STEPS,
          t_schedule_mode=T_SCHEDULE_MODE,
          sway_coeff=SWAY_COEFF,
          cfg_scale_text=CFG_SCALE_TEXT,
          cfg_scale_caption=CFG_SCALE_CAPTION,
          cfg_scale_speaker=CFG_SCALE_SPEAKER,
          max_ref_seconds=MAX_REF_SECONDS,
        ),
        log_fn=None,
      )
    except ValueError as exc:
      raise HTTPException(status_code=400, detail=str(exc)) from exc

    save_wav(output_path, result.audio, int(result.sample_rate))
    return Response(content=output_path.read_bytes(), media_type="audio/wav")


if __name__ == "__main__":
  uvicorn.run(app, host=HOST, port=PORT)
