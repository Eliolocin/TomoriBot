from __future__ import annotations

import base64
import io
import unittest
import wave
from unittest.mock import patch

import ormsgpack
from fastapi import HTTPException
from fastapi.testclient import TestClient
from starlette.requests import Request

import server


class RunningProcess:
    returncode = None

    def poll(self) -> None:
        return None


class UpstreamResponse:
    def __init__(self, content: bytes):
        self.content = content

    def __enter__(self) -> "UpstreamResponse":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self) -> bytes:
        return self.content


def request_with_headers(headers: list[tuple[bytes, bytes]] | None = None) -> Request:
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/health",
            "headers": headers or [],
            "query_string": b"",
            "server": ("127.0.0.1", 8015),
            "client": ("127.0.0.1", 50000),
            "scheme": "http",
        }
    )


def pcm_wav() -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(16_000)
        wav_file.writeframes(b"\x00\x00" * 160)
    return output.getvalue()


class FishServerContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.original_process = server.fish_process
        self.original_api_key = server.API_KEY
        server.fish_process = RunningProcess()
        server.API_KEY = ""

    def tearDown(self) -> None:
        server.fish_process = self.original_process
        server.API_KEY = self.original_api_key

    def test_health_reports_configured_model_metadata(self) -> None:
        result = server.health(request_with_headers())

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["model_family"], "Fish Audio S2 Pro")
        self.assertIn("model_dir", result)

    def test_bearer_auth_is_required_when_configured(self) -> None:
        server.API_KEY = "test-token"

        with self.assertRaises(HTTPException) as context:
            server.health(request_with_headers())
        self.assertEqual(context.exception.status_code, 401)

        result = server.health(request_with_headers([(b"authorization", b"Bearer test-token")]))
        self.assertEqual(result["status"], "ok")

    def test_reference_audio_requires_pcm_wav(self) -> None:
        with self.assertRaises(HTTPException) as context:
            server.decode_reference_audio(base64.b64encode(b"not-a-wav").decode("ascii"))
        self.assertEqual(context.exception.status_code, 400)

    def test_reference_audio_limit_is_checked_before_inference(self) -> None:
        original_limit = server.MAX_REFERENCE_AUDIO_BYTES
        server.MAX_REFERENCE_AUDIO_BYTES = 4
        try:
            with self.assertRaises(HTTPException) as context:
                server.decode_reference_audio(base64.b64encode(b"12345").decode("ascii"))
            self.assertEqual(context.exception.status_code, 413)
        finally:
            server.MAX_REFERENCE_AUDIO_BYTES = original_limit

    def test_synthesize_builds_fish_msgpack_request(self) -> None:
        reference = pcm_wav()
        captured: dict[str, object] = {}

        def fake_urlopen(request: object, timeout: float) -> UpstreamResponse:
            captured["request"] = request
            captured["timeout"] = timeout
            return UpstreamResponse(b"generated-audio")

        payload = server.SynthesizeRequest(
            text="Hello",
            ref_audio=base64.b64encode(reference).decode("ascii"),
            ref_text="Hello there",
        )
        with patch("server.urllib.request.urlopen", side_effect=fake_urlopen):
            response = server.synthesize(payload, request_with_headers())

        self.assertEqual(response.media_type, "audio/wav")
        self.assertEqual(response.body, b"generated-audio")
        upstream_request = captured["request"]
        self.assertIsInstance(upstream_request, server.urllib.request.Request)
        body = ormsgpack.unpackb(upstream_request.data)
        self.assertEqual(body["text"], "Hello")
        self.assertEqual(body["references"][0]["audio"], reference)
        self.assertEqual(body["references"][0]["text"], "Hello there")

    def test_fastapi_routes_expose_health_and_synthesize_contract(self) -> None:
        reference = pcm_wav()
        with patch("server.start_fish_api"), patch("server.stop_fish_api"), patch(
            "server.urllib.request.urlopen", return_value=UpstreamResponse(b"generated-audio")
        ):
            with TestClient(server.app) as client:
                health_response = client.get("/health")
                synthesis_response = client.post(
                    "/synthesize",
                    json={
                        "text": "Hello",
                        "ref_audio": base64.b64encode(reference).decode("ascii"),
                        "ref_text": "Hello there",
                    },
                )

        self.assertEqual(health_response.status_code, 200)
        self.assertEqual(health_response.json()["status"], "ok")
        self.assertEqual(synthesis_response.status_code, 200)
        self.assertEqual(synthesis_response.headers["content-type"], "audio/wav")
        self.assertEqual(synthesis_response.content, b"generated-audio")


if __name__ == "__main__":
    unittest.main()
