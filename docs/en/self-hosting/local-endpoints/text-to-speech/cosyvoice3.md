---
title: "CosyVoice 3"
aiGenerated: false
---

CosyVoice 3 is the current generation of Alibaba/QwenAudio's multilingual CosyVoice TTS project. TomoriBot wraps the official runtime in `servers/tts/cosyvoice3/` and exposes the same `POST /synthesize` interface used by the other local speech endpoints.

TomoriBot defaults to the official **`FunAudioLLM/Fun-CosyVoice3-0.5B-2512`** checkpoint. It is the current CosyVoice 3 release recommended by upstream, uses the normal unquantized model, and is small enough to run comfortably on a 16 GB NVIDIA GPU while keeping CosyVoice's low-latency design intact.

## What it supports

The current CosyVoice 3 release supports:

- Chinese, English, Japanese, Korean, German, Spanish, French, Italian, and Russian
- 18+ Chinese dialects and accents
- zero-shot voice cloning
- multilingual and cross-lingual voice cloning
- natural-language instructions for language, dialect, emotion, speaking speed, and volume
- fine-grained controls such as `[breath]` and `[laughter]`
- text-in and audio-out streaming in the upstream runtime

The official CosyVoice 3 examples currently include one important Japanese caveat: Japanese text is shown after conversion to katakana. Japanese is a supported language, but if normal Japanese orthography gives poor pronunciation, converting the synthesis text to katakana is the upstream-recommended workaround.

## How TomoriBot maps requests

The wrapper accepts the normal clone-sidecar fields:

- `text`
- `ref_audio`
- `ref_text`
- `instruct`
- `language`

It chooses the current CosyVoice 3 API as follows:

| Request | CosyVoice 3 path |
|---|---|
| Reference audio + transcript | `inference_zero_shot` |
| Reference audio without transcript | `inference_cross_lingual` |
| `instruct`, explicit `language`, or supported TomoriBot style tags | `inference_instruct2` |

For the best ordinary cloning quality, provide both the reference audio and its matching transcript. CosyVoice 3's current instruction API conditions on the reference audio but does not also accept the reference transcript, so requests that use `instruct` switch to the official `inference_instruct2` path.

### Style and emotion controls

Register the endpoint with **Bracket Tags** markup. CosyVoice 3 officially supports `[breath]` and `[laughter]`, which the wrapper leaves intact. TomoriBot's common descriptive tags are translated into CosyVoice 3 natural-language instructions instead of being spoken literally. Supported translations include:

`[happy]`, `[sad]`, `[angry]`, `[excited]`, `[tired]`, `[sleepy]`, `[whisper]`, `[whispers]`, `[laugh]`, `[laughs]`, `[fast]`, `[slow]`, `[quiet]`, `[soft]`, and `[loud]`.

The `/synthesize` `instruct` field is also passed into CosyVoice 3's instruction conditioning. Examples include `sound relieved but still tired`, `speak as quickly as possible`, or `speak quietly with restrained excitement`.

## Streaming

CosyVoice 3 supports bidirectional streaming upstream. The project documents both text-in streaming and audio-out streaming, with first-audio latency as low as roughly 150 ms in its optimized setup.

TomoriBot's current custom TTS interface expects one complete audio response for a Discord voice message, so this sidecar still returns a complete WAV. It does **not** disable CosyVoice's streaming inference by default. The sidecar runs upstream generation with `stream=True`, consumes the yielded audio chunks, and joins them only at the existing TomoriBot response boundary.

That separation is intentional. A future live-voice transport can reuse the same upstream generator without replacing the CosyVoice inference implementation.

Set `COSYVOICE3_UPSTREAM_STREAM=0` only when debugging or comparing non-streaming upstream behavior.

## Hardware

Recommended TomoriBot starting point:

- NVIDIA GPU with **16 GB VRAM**
- Python **3.10**
- recent NVIDIA driver compatible with CUDA 12
- `git`
- `ffmpeg` for TomoriBot voice-sample normalization
- `sox` and `libsox-dev` on Linux if upstream audio compatibility issues occur

The model itself is 0.5B parameters and does not need quantization to fit a 16 GB card. The Hugging Face checkpoint download is much larger than the parameter count suggests because it also ships the flow model, speech tokenizers, English text model, and both base and RL LLM weights. Allow roughly 10 GB of disk space for the current model package, plus the Python environment and runtime.

CPU inference is possible through the upstream runtime but is not the recommended path for low-latency Discord voice use.

## Installation

### Linux / WSL2 (recommended)

From the TomoriBot repository root:

```bash
bash servers/tts/cosyvoice3/install-cosyvoice3.sh
servers/tts/cosyvoice3/.venv/bin/python servers/tts/cosyvoice3/server.py
```

Or start the configured sidecar and TomoriBot together:

```bash
bun run launch --cosyvoice3
```

The installer:

1. clones the official `QwenAudio/CosyVoice` repository recursively into `servers/tts/cosyvoice3/CosyVoice/`;
2. creates `servers/tts/cosyvoice3/.venv`;
3. installs the current upstream CosyVoice requirements plus the small wrapper dependency set; and
4. downloads `FunAudioLLM/Fun-CosyVoice3-0.5B-2512` into `CosyVoice/pretrained_models/Fun-CosyVoice3-0.5B/`.

The upstream requirements currently use PyTorch 2.3.1 with the CUDA 12.1 package index, CUDA 12 ONNX Runtime packages on Linux, and TensorRT 10.13 packages on Linux. If you are using hardware that requires a newer PyTorch CUDA build, install a compatible PyTorch build in the sidecar venv after the upstream requirements and test it with your driver.

### Windows PowerShell

Native Windows is provided as a best-effort path:

```powershell
.\servers\tts\cosyvoice3\install-cosyvoice3.ps1
.\servers\tts\cosyvoice3\.venv\Scripts\python.exe servers\tts\cosyvoice3\server.py
```

For NVIDIA GPU use, **WSL2 is recommended**. The current upstream requirements install GPU ONNX Runtime on Linux but CPU ONNX Runtime on Windows, so WSL2 more closely matches the configuration the CosyVoice project optimizes and tests for low latency.

## Register in TomoriBot

Run `/providers`, choose **Add New Custom Endpoint**, and configure the speech endpoint:

- Capability: `Speech`
- API Compatibility: `tts-clone`
- Endpoint URL: `http://127.0.0.1:8016`
- Voice Source Mode: `Clone`
- Script Markup: `Bracket Tags`
- Supports Instruct: `Yes`

After saving the connection, select it and add a Speech model. A clear model code is `Fun-CosyVoice3-0.5B-2512`.

Then open `/config` > Models > Switch Models and activate the CosyVoice 3 speech endpoint.

## Assign a persona voice

For normal zero-shot cloning:

1. Prepare a clean 10 to 20 second sample with one speaker and little or no background noise.
2. Open `/config` under Models > TTS Parameters & Voices and upload the sample.
3. Enter the matching transcript when possible. CosyVoice 3 uses it for the transcript-backed zero-shot path.
4. Open `/config` under Persona > Voice and assign that sample to the persona.

Cross-lingual cloning is supported. The reference speaker can speak a different language from the generated text. If a reference transcript is unavailable, the wrapper uses CosyVoice 3's dedicated cross-lingual path.

## Test with `/generate voice-message`

Use `/generate voice-message` to test the active endpoint without waiting for a normal chat turn to choose the voice tool. You can use the persona's configured sample or upload a one-off sample. When uploading a sample, provide its transcript in the modal when possible.

For expressive delivery, bracket tags in the spoken script are translated or passed through as described above. This is useful for checking emotion and speaking-rate behavior while keeping the endpoint in normal clone mode.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `COSYVOICE3_RUNTIME_DIR` | `servers/tts/cosyvoice3/CosyVoice` | Official CosyVoice checkout |
| `COSYVOICE3_MODEL_DIR` | `CosyVoice/pretrained_models/Fun-CosyVoice3-0.5B` | Local checkpoint directory |
| `COSYVOICE3_MODEL_ID` | `FunAudioLLM/Fun-CosyVoice3-0.5B-2512` | Hugging Face model downloaded by setup |
| `TOMORI_TTS_HOST` | `127.0.0.1` | Wrapper bind address |
| `TOMORI_TTS_PORT` | `8016` | Wrapper port |
| `TOMORI_TTS_MAX_TEXT_CHARS` | `2000` | Maximum synthesis text length |
| `COSYVOICE3_UPSTREAM_STREAM` | `1` | Keep CosyVoice's audio-out streaming generator enabled internally |
| `COSYVOICE3_SPEED` | `1.0` | Global numeric speed multiplier passed to upstream inference |
| `COSYVOICE3_DEFAULT_INSTRUCT` | empty | Optional instruction added when a request does not provide one |
| `COSYVOICE3_FP16` | `0` | Ask the official runtime to use its fp16 mode |
| `COSYVOICE3_LOAD_TRT` | `0` | Enable upstream TensorRT loading when properly prepared |
| `COSYVOICE3_LOAD_VLLM` | `0` | Enable upstream vLLM loading when its separate dependencies are installed |

The default keeps TensorRT, vLLM, and fp16 off. The normal PyTorch runtime already fits the target 16 GB GPU, is simpler to install, and avoids turning the default path into an optimization-specific setup.

## Performance and model variants

### Default: base `Fun-CosyVoice3-0.5B-2512`

This is the recommended default for TomoriBot. It has strong speaker similarity, supports all current CosyVoice 3 cloning and instruction modes, and does not need quantization on a 16 GB GPU.

### RL weight

The current checkpoint package also includes `llm.rl.pt`. Upstream publishes the base and RL results separately. The RL weight improves some content-error metrics, while the base result retains slightly stronger speaker-similarity scores in the published table. Because TomoriBot emphasizes persona voice cloning, the wrapper leaves the normal `llm.pt` as the default.

The current official loader always reads a file named `llm.pt`. To experiment with the RL weight without overwriting the default installation, copy the model directory, replace the copy's `llm.pt` with `llm.rl.pt`, and point `COSYVOICE3_MODEL_DIR` at that copy.

### vLLM and TensorRT

CosyVoice 3 also supports optional vLLM and TensorRT paths. Upstream currently documents vLLM 0.11.x+ using the V1 engine and vLLM 0.9.0 as the legacy path. These runtimes have additional version and hardware constraints, so TomoriBot does not install or enable them by default.

Use them only after the ordinary PyTorch sidecar is working. For a Discord voice-message workload, avoiding extra runtime complexity is usually more useful than optimizing an already-small 0.5B model.

## License

The current CosyVoice code repository is licensed under **Apache License 2.0**, and the `FunAudioLLM/Fun-CosyVoice3-0.5B-2512` Hugging Face repository is also marked **Apache-2.0**.

The upstream model card additionally contains a disclaimer saying the displayed content is for academic demonstration and that some examples may come from the internet. An open upstream discussion asks for explicit clarification about how that disclaimer relates to commercial use of the weights. TomoriBot does not redistribute the model. Self-hosters should review the current upstream license and model-card terms for their own deployment, especially before commercial use.
