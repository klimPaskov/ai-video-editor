# P5 local transcription runtime

Reviewed 2026-09-27 from the official Hugging Face model API/model card and the installed package declarations. This record supersedes the P0 note that selected a Whisper runtime and model later; the P0 text remains an accurate record of what was known on 2026-09-05.

## Runtime and model

- `@huggingface/transformers@4.3.0`, Apache-2.0, runs the ASR pipeline in a Node worker.
- `onnxruntime-node@1.30.0` supplies the local CPU backend. `sharp` and installed runtime dependencies are packaged with third-party notices. Native files under `node_modules` are unpacked from ASAR.
- Model: [`Xenova/whisper-base`](https://huggingface.co/Xenova/whisper-base/tree/64da57285918e20ea79ea5c88eed7197933abaa8), Apache-2.0, revision `64da57285918e20ea79ea5c88eed7197933abaa8`, q8 weights, CPU. Transformers.js documents word timestamps through `return_timestamps: "word"` and chunked long-audio inference in its [ASR pipeline reference](https://huggingface.co/docs/transformers.js/api/pipelines#module_pipelines.AutomaticSpeechRecognitionPipeline).
- The UI discloses a one-time download of about 76 MiB of model weights. The user must start transcription before any model download. The app pins the HTTPS host, repository, revision, filenames, byte sizes, and hashes, then verifies both weight files before model inference. Model metadata may be fetched from the same fixed Hugging Face repository/revision when first needed. Model weights are never committed or bundled.

Pinned weight files:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `onnx/encoder_model_quantized.onnx` | 23,200,850 | `3e345e977b55620a37c0c2b2af0644e019afdfad562dcf71eb929bb7274285f9` |
| `onnx/decoder_model_merged_quantized.onnx` | 53,707,539 | `a6beb6baabb66f00b6a686d828c95ffca6146d51900cbad0266cad38f64cf861` |

## Data and timing boundary

After explicit start, main verifies the active project's immutable managed sources, selects the first audio stream, and decodes a private mono 16 kHz `f32le` analysis proxy. The worker receives only the proxy path plus bounded project/source/job identity and runs without provider credentials in its environment. The only network payload in this path is fixed public model material; source media, transcript output, and user prompts are not uploaded. Temporary speech proxies are removed when a job ends. Original/imported media and the project draft are unchanged.

Whisper word boundaries are estimates and currently have null confidence. Transformers.js returns no language property for this pinned run, so the product stores `und` and shows that language was not identified. FFmpeg silence ranges use a separate fixed threshold of -40 dB for at least 250 ms. Silence is evidence only and never authorizes a cut. Neither transcript text edits nor silence analysis modify recorded speech.

Results and source-hash/model-revision identity are stored under the app's per-user data root, outside project baselines and drafts. Active repeated starts return the same job ID; poll requests carry that ID. Completed results are reused after project reopen. The protected cache, transcript content, model files and native test results remain private and are not included in source publication.

## Fixture provenance

The packaged native smoke uses the public `jfk.wav` sample from the [Transformers.js documentation dataset](https://huggingface.co/datasets/Xenova/transformers.js-docs/tree/fbe92bd97d48f3ec17779d8d8f2964e1c6bc7634). Its guest-only test copy is pinned to revision `fbe92bd97d48f3ec17779d8d8f2964e1c6bc7634`, 1,940,478 bytes, SHA-256 `aa81c2552465568567e670f3823117e633900d16bd6202346a72f3c8464c74c8`. The sample is a fixture, not a bundled product asset.

The smoke checks word timing bounds, separate silence evidence, source immutability, model hashes, repeated-start job reuse, same-ID polling, and transcript persistence after reopening the packaged project. A P5-02 correction path additionally records one text-only word override in the shared draft journal and covers Undo/Redo and project reopen while leaving the original ASR result unchanged. Neither smoke proves transcription quality across languages, microphone/camera hardware, transcript-linked cuts, semantic edits, A/V listening, Magic Wand, or master export.
