import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "local-voice"))

import turn_timing  # noqa: E402


class SilenceTests(unittest.TestCase):
    def test_short_utterance_uses_tighter_silence(self):
        self.assertEqual(turn_timing.silence_needed_ms(800), turn_timing.SHORT_SILENCE_MS)

    def test_long_thought_keeps_patient_silence(self):
        self.assertEqual(turn_timing.silence_needed_ms(4000), turn_timing.SILENCE_MS)

    def test_boundary_uses_patient_silence(self):
        self.assertEqual(
            turn_timing.silence_needed_ms(turn_timing.LONG_SPEECH_MS),
            turn_timing.SILENCE_MS,
        )

    def test_speculative_starts_before_short_silence(self):
        self.assertLess(turn_timing.SPECULATIVE_MS, turn_timing.SHORT_SILENCE_MS)


class RewriteSkipTests(unittest.TestCase):
    def test_skips_short_casual_chat(self):
        self.assertTrue(
            turn_timing.skip_talk_rewrites(
                mode="chat",
                lane="talk",
                reply="Yeah, I'm good. You?",
                user_text="how's it going",
                tools_used=False,
            )
        )

    def test_keeps_rewrites_for_factual_asks(self):
        self.assertFalse(
            turn_timing.skip_talk_rewrites(
                mode="chat",
                lane="talk",
                reply="Three agents are running.",
                user_text="what's running",
                tools_used=False,
            )
        )

    def test_keeps_rewrites_on_work_lane(self):
        self.assertFalse(
            turn_timing.skip_talk_rewrites(
                mode="act",
                lane="work",
                reply="Nothing here.",
                user_text="search my notes for shoes",
                tools_used=True,
            )
        )

    def test_keeps_rewrites_on_long_chat(self):
        long = "x" * (turn_timing.SHORT_TALK_CHARS + 1)
        self.assertFalse(
            turn_timing.skip_talk_rewrites(
                mode="chat",
                lane="talk",
                reply=long,
                user_text="tell me a story",
                tools_used=False,
            )
        )


class StreamDecisionTests(unittest.TestCase):
    def test_streams_casual_chat(self):
        self.assertTrue(
            turn_timing.stream_before_rewrite(
                mode="chat",
                lane="talk",
                user_text="hey you good",
                tools_used=False,
            )
        )

    def test_waits_when_honesty_rewrite_must_run(self):
        self.assertFalse(
            turn_timing.stream_before_rewrite(
                mode="chat",
                lane="talk",
                user_text="what agents are running",
                tools_used=False,
            )
        )

    def test_streams_after_tools_already_ran(self):
        self.assertTrue(
            turn_timing.stream_before_rewrite(
                mode="act",
                lane="work",
                user_text="what agents are running",
                tools_used=True,
            )
        )


if __name__ == "__main__":
    unittest.main()
