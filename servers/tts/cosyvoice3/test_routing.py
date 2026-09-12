import unittest

from routing import resolve_synthesis_mode


class CosyVoiceRoutingTests(unittest.TestCase):
    def test_instruction_takes_precedence_over_transcript(self) -> None:
        self.assertEqual(
            resolve_synthesis_mode(ref_text="reference", instruct="speak softly", language=""),
            "instruct2",
        )

    def test_language_uses_instruction_path(self) -> None:
        self.assertEqual(resolve_synthesis_mode(ref_text="", instruct="", language="Japanese"), "instruct2")

    def test_transcript_uses_zero_shot(self) -> None:
        self.assertEqual(resolve_synthesis_mode(ref_text="reference", instruct="", language=""), "zero_shot")

    def test_missing_transcript_uses_cross_lingual(self) -> None:
        self.assertEqual(resolve_synthesis_mode(ref_text="", instruct="", language=""), "cross_lingual")


if __name__ == "__main__":
    unittest.main()
