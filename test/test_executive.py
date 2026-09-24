import importlib.util
import pathlib
import unittest

path = pathlib.Path(__file__).resolve().parents[1] / "local-voice" / "executive.py"
spec = importlib.util.spec_from_file_location("executive", path)
executive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(executive)


class DistillTest(unittest.TestCase):
    def test_report_separates_thought_and_tools(self):
        report = executive.distill(
            [
                {"role": "assistant", "content": "Check the notes.", "tool_calls": [
                    {"function": {"name": "recall_search"}}
                ]},
                {"role": "tool", "content": "Found the hook note."},
            ]
        )
        self.assertIn("Thought: Check the notes.", report["text"])
        self.assertIn("recall_search", report["did"])
        self.assertIn("Found the hook note.", report["result"])
        self.assertNotIn("role", report["text"])


if __name__ == "__main__":
    unittest.main()
