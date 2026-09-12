"""Pure CosyVoice request routing helpers used by the sidecar and contract tests."""

from typing import Literal

SynthesisMode = Literal["instruct2", "zero_shot", "cross_lingual"]


def resolve_synthesis_mode(*, ref_text: str, instruct: str, language: str) -> SynthesisMode:
    """Select the upstream path without importing the model runtime."""
    if instruct.strip() or language.strip():
        return "instruct2"
    if ref_text.strip():
        return "zero_shot"
    return "cross_lingual"
