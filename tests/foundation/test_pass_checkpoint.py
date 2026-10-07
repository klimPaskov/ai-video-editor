"""Pass-checkpoint schema evidence requirements."""
from copy import deepcopy
import json
from pathlib import Path
import unittest

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[2]


class PassCheckpointSchemaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.schema = json.loads(
            (ROOT / 'docs/schemas/pass_checkpoint.schema.json').read_text(encoding='utf-8')
        )
        Draft202012Validator.check_schema(cls.schema)
        cls.validator = Draft202012Validator(cls.schema)
        cls.example = json.loads(
            (ROOT / 'docs/examples/pass_checkpoint.example.json').read_text(encoding='utf-8')
        )

    def test_published_example_has_concrete_check_evidence(self):
        self.validator.validate(self.example)

    def test_passed_check_without_evidence_is_rejected(self):
        checkpoint = deepcopy(self.example)
        checkpoint['checks'][0]['evidence_ids'] = []
        self.assertFalse(self.validator.is_valid(checkpoint))


if __name__ == '__main__':
    unittest.main()
