# Workspace validation

Status: implementation specifications and references. The application has not been built by this packaging task.

## Checks run

- Root package validator: goal length, schema/example validation, task identifiers, phase prompts, tool contracts, skills, subagent routing, and live manifests
- Reference checks: all 20 original PNG files exist, decode, retain their recorded hashes, and meet full-size requirements
- Separate current and previous sets, with no contact sheets or image collages included
- Gallery paths and reference membership
- Ten negative export-contract cases, including false lossless codec labels, missing compressed-export consent, proxy misuse, and failed sample equality
- Required open-source and fidelity guidance included in the actual `ai-video-editor` root
- Full SHA-256 manifest and ZIP CRC checks before delivery

## Not claimed

No application code, native executable, installer, camera capture, real Codex sign-in, user-example edit, or remote GitHub publication was tested or completed here. Those are implementation tasks and remain unchecked. The numerical hashes in schema examples are sample values, not media evidence.

## Reference coverage

There are ten current and ten previous native-app screen images. They are original individual ImageGen outputs, not slices of collages. Some full screen states, including dedicated onboarding and settings, have specifications but no dedicated image. See `docs/references/SCREEN_COVERAGE.md` for direct and partial mappings. The latest interface and quality rules override errors or obsolete wording embedded in the images.

## Reproduce

```bash
python -m pip install -r requirements-validation.txt
python scripts/validate_package.py
python scripts/validate_delivery.py
python scripts/build_integrity_manifest.py
python scripts/validate_delivery.py --check-integrity
```

Regenerate MANIFEST.sha256 after intentional workspace edits. The ZIP itself is a delivery artifact, not a runtime dependency.
