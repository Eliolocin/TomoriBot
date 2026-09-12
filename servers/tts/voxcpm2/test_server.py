from __future__ import annotations

import asyncio
import base64
import io
import unittest
import wave
from unittest.mock import patch

import numpy as np

import server


def reference_wav() -> str:
  buffer = io.BytesIO()
  with wave.open(buffer, "wb") as output:
    output.setnchannels(1)
    output.setsampwidth(2)
    output.setframerate(16000)
    output.writeframes(b"\x00\x00" * 1600)
  return base64.b64encode(buffer.getvalue()).decode("ascii")


class FakeTtsModel:
  sample_rate = 16000


class FakeModel:
  def __init__(self) -> None:
    self.tts_model = FakeTtsModel()
    self.calls: list[dict[str, object]] = []

  def generate(self, **kwargs: object) -> np.ndarray:
    self.calls.append(kwargs)
    return np.zeros(1600, dtype=np.float32)


class VoxCpmContractTests(unittest.TestCase):
  def setUp(self) -> None:
    self.model = FakeModel()
    server.model = self.model
    server.API_KEY = ""
    server.MAX_REF_AUDIO_BYTES = 10 * 1024 * 1024

  def request(self, **kwargs: object) -> server.SynthesizeRequest:
    return server.SynthesizeRequest(text="Hello there", **kwargs)

  def test_voice_design_uses_instruct_without_reference(self) -> None:
    response = server.synthesize(self.request(instruct="Warm and unhurried"))

    self.assertEqual(response.media_type, "audio/wav")
    self.assertEqual(len(self.model.calls), 1)
    call = self.model.calls[0]
    self.assertTrue(str(call["text"]).startswith("(Warm and unhurried)"))
    self.assertNotIn("reference_wav_path", call)
    self.assertNotIn("prompt_wav_path", call)
    self.assertNotIn("prompt_text", call)

  def test_reference_audio_uses_normal_cloning_without_transcript(self) -> None:
    server.synthesize(self.request(ref_audio=reference_wav()))

    call = self.model.calls[0]
    self.assertIn("reference_wav_path", call)
    self.assertNotIn("prompt_wav_path", call)
    self.assertNotIn("prompt_text", call)

  def test_reference_audio_and_transcript_use_ultimate_cloning(self) -> None:
    server.synthesize(self.request(ref_audio=reference_wav(), ref_text="Reference words"))

    call = self.model.calls[0]
    self.assertIn("reference_wav_path", call)
    self.assertEqual(call["prompt_wav_path"], call["reference_wav_path"])
    self.assertEqual(call["prompt_text"], "Reference words")

  def test_instruction_takes_precedence_over_transcript_for_cloning(self) -> None:
    server.synthesize(
      self.request(ref_audio=reference_wav(), ref_text="Reference words", instruct="Sound excited")
    )

    call = self.model.calls[0]
    self.assertTrue(str(call["text"]).startswith("(Sound excited)"))
    self.assertIn("reference_wav_path", call)
    self.assertNotIn("prompt_wav_path", call)
    self.assertNotIn("prompt_text", call)

  def test_reference_audio_must_be_a_wav_container(self) -> None:
    with self.assertRaises(server.HTTPException) as raised:
      server.synthesize(self.request(ref_audio=base64.b64encode(b"not audio").decode("ascii")))

    self.assertEqual(raised.exception.status_code, 400)

  def test_reference_audio_size_is_checked_before_writing(self) -> None:
    server.MAX_REF_AUDIO_BYTES = 4

    with self.assertRaises(server.HTTPException) as raised:
      server.synthesize(self.request(ref_audio=reference_wav()))

    self.assertEqual(raised.exception.status_code, 413)

  def test_configured_bearer_token_is_required_for_synthesis(self) -> None:
    server.API_KEY = "secret"

    with self.assertRaises(server.HTTPException) as raised:
      server.synthesize(self.request(instruct="Warm"))
    self.assertEqual(raised.exception.status_code, 401)

    server.synthesize(self.request(instruct="Warm"), authorization="Bearer secret")

  def test_remote_bind_requires_auth_or_explicit_opt_in(self) -> None:
    previous_host = server.HOST
    previous_key = server.API_KEY
    previous_opt_in = server.ALLOW_REMOTE_BIND
    try:
      server.HOST = "0.0.0.0"
      server.API_KEY = ""
      server.ALLOW_REMOTE_BIND = False
      with self.assertRaises(RuntimeError):
        server.validate_bind_policy()

      server.ALLOW_REMOTE_BIND = True
      server.validate_bind_policy()
    finally:
      server.HOST = previous_host
      server.API_KEY = previous_key
      server.ALLOW_REMOTE_BIND = previous_opt_in

  def test_remote_bind_policy_runs_before_model_load_in_lifespan(self) -> None:
    previous_host = server.HOST
    previous_key = server.API_KEY
    previous_opt_in = server.ALLOW_REMOTE_BIND
    try:
      server.HOST = "0.0.0.0"
      server.API_KEY = ""
      server.ALLOW_REMOTE_BIND = False

      async def start_application() -> None:
        async with server.lifespan(server.app):
          pass

      with patch.object(server, "load_model") as load_model:
        with self.assertRaises(RuntimeError):
          asyncio.run(start_application())
        load_model.assert_not_called()
    finally:
      server.HOST = previous_host
      server.API_KEY = previous_key
      server.ALLOW_REMOTE_BIND = previous_opt_in


if __name__ == "__main__":
  unittest.main()
