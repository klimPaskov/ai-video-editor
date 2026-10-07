import copy
import json
from pathlib import Path
import unittest

from jsonschema import Draft202012Validator


ROOT = Path(__file__).resolve().parents[2]
STAGES = ["record_import", "auto_edit", "edit", "review", "export"]


def read_json(path):
    return json.loads((ROOT / path).read_text(encoding="utf-8"))


class WorkflowContractsTests(unittest.TestCase):
    def test_codex_drawer_replaces_the_inspector(self):
        validator = Draft202012Validator(read_json("docs/schemas/ui_state.schema.json"))
        state = read_json("docs/examples/ui_state.example.json")
        state["codex"]["drawer_open"] = True
        self.assertFalse(validator.is_valid(state))
        state["open_panel"] = None
        validator.validate(state)

    def test_stage_enums_and_screen_assignment(self):
        ui_schema = read_json("docs/schemas/ui_state.schema.json")
        screen_schema = read_json("docs/schemas/screen_manifest.schema.json")
        enums = [
            read_json("docs/schemas/project.schema.json")["properties"]["workflow_step"]["enum"],
            ui_schema["properties"]["step"]["enum"],
            screen_schema["properties"]["screens"]["items"]["properties"]["step"]["enum"],
        ]
        for values in enums:
            self.assertEqual([value for value in values if value in STAGES], STAGES)
            self.assertNotIn("qa", values)
        self.assertIn("qa", ui_schema["properties"]["screen"]["enum"])
        for path in ["docs/contracts/screens.json", "docs/examples/screen_manifest.example.json"]:
            manifest = read_json(path)
            Draft202012Validator(screen_schema).validate(manifest)
            screens = {screen["screen_id"]: screen for screen in manifest["screens"]}
            self.assertEqual(screens["S08"]["step"], "edit")
            self.assertEqual(screens["S09"]["step"], "review")
            self.assertEqual(screens["S10"]["step"], "review")
        state = read_json("docs/examples/ui_state.example.json")
        self.assertEqual((state["screen"], state["step"]), ("editor", "edit"))
        Draft202012Validator(ui_schema).validate(state)

    def test_authorized_tools_have_no_repeated_confirmation(self):
        schema = read_json("docs/schemas/tool_manifest.schema.json")
        for path in ["docs/contracts/codex-tools.json", "docs/examples/tool_manifest.example.json"]:
            manifest = read_json(path)
            Draft202012Validator(schema).validate(manifest)
            by_name = {tool["name"]: tool for tool in manifest["tools"]}
            for tool in manifest["tools"]:
                if tool["allowed_scope"] in ["active_draft", "export_staging"]:
                    self.assertEqual(tool["user_confirmation"], "none", tool["name"])
                    self.assertIn("approve export", tool["forbidden_effects"])
            if path == "docs/contracts/codex-tools.json":
                self.assertEqual(by_name["export.prepare"]["allowed_scope"], "export_staging")
            else:
                self.assertEqual(
                    list(by_name),
                    [
                        "project.get_summary",
                        "timeline.get_summary",
                        "transcript.get_range",
                        "cut.trim_edge",
                        "cut.split",
                        "cut.delete_range",
                        "cut.delete_ranges",
                        "timeline.undo",
                        "cut.restore_range",
                    ],
                )
                self.assertNotIn("export.prepare", by_name)
            self.assertNotIn("export.start", by_name)
            self.assertNotIn("export.confirm", by_name)

    def test_schema_rejects_regression_to_material_confirmation(self):
        validator = Draft202012Validator(read_json("docs/schemas/tool_manifest.schema.json"))
        source = read_json("docs/contracts/codex-tools.json")
        for name in ["timeline.apply_operations", "analysis.run_magic_wand", "export.prepare"]:
            for confirmation in ["material_change", "always"]:
                manifest = copy.deepcopy(source)
                tool = next(tool for tool in manifest["tools"] if tool["name"] == name)
                tool["user_confirmation"] = confirmation
                self.assertFalse(validator.is_valid(manifest), (name, confirmation))


if __name__ == "__main__":
    unittest.main()
