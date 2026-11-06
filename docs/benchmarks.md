# Benchmarks and reproducibility

No Windows latency, GPU-fit, real local-model success rate or fallback-performance result has been measured in the cloud build. Values below distinguish selected settings from observed evidence.

| Item                    | Selected configuration                                       | Verification                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target                  | Windows 11; RTX 3050 4 GB; 24 GB RAM                         | Laptop run pending                                                                                                                                            |
| Node                    | >=22.14; cloud run 24.22.1                                   | Cloud observed                                                                                                                                                |
| TrueForge runtime / SDK | 0.184.2 / 0.184.1, npm lockfile                              | Actual local runtime and settings API registration observed                                                                                                   |
| Primary candidate       | Qwen3-1.7B Q4_K_M; Apache-2.0                                | No GGUF downloaded or live inference run                                                                                                                      |
| Inference binary        | Compatible llama.cpp CUDA release                            | Exact binary release/hash selection pending                                                                                                                   |
| Fallback candidate      | Separate tool-capable Qwen3 model, CPU, port 8081            | Artifact and live fallback test pending                                                                                                                       |
| Context / output        | 4,096 total; at most 1,024 output                            | Endpoint flags/provider metadata configured; tokenizer-fit unverified                                                                                         |
| Sampling / slots        | Temperature 0.2; one slot; nonthinking Qwen Jinja            | Launch-argument tests passed                                                                                                                                  |
| Compaction              | TrueForge input-token estimate threshold 2,048               | Actual agent registration passed; summary/state preservation unverified                                                                                       |
| Schema discovery        | Preload reads/search/retrieval/staging; defer apply/commands | Actual scripted-provider protocol: selective7,687/eager8,578 schema JSON bytes;891 bytes/10.4% lower;two discovery calls;not tokenizer/model-quality evidence |
| Fixture                 | Flask 3.1.3, `22d924701a6ae2e4cd01e9a15bbaf3946094af65`      | Actual fixture A: baseline CLI tests 58 passed; clean including untracked files; safe repeat passed                                                           |
| Python fixture tooling  | Python 3.12 x64; uv 0.9.28; checked-in uv.lock               | Cloud Python 3.12.14; runtime-local pinned uv; external editable fixture import verified                                                                      |

The retrieval budget uses a conservative byte-based estimate and reserves output plus instructions/schema allowance. It is not an exact Qwen tokenizer. TrueForge history, discovery schemas and tool responses consume the same context window; endpoint context limits and compaction remain necessary. Measure full prompts with the selected model before claiming the 4,096-token workflow fits dependably. Compaction costs a model call and can lose details; approval receipts and base versions stay in the extension's private state rather than depending on a summary.

Record the final inference distribution release tag/commit, publisher digest, extracted executable SHA-256, GGUF source/revision/hash and license before the Windows run. These are deliberately not fabricated in example files. Runtime JSON, bearer tokens, model weights and fixture changes are excluded from the submission source.

| Fresh cycle | A result / time | B result / time | C result / fallback time | Tool errors | Peak RAM / VRAM |
| ----------- | --------------- | --------------- | ------------------------ | ----------- | --------------- |
| 1           | Unrun           | Unrun           | Unrun                    | Unmeasured  | Unmeasured      |
| 2           | Unrun           | Unrun           | Unrun                    | Unmeasured  | Unmeasured      |
| 3           | Unrun           | Unrun           | Unrun                    | Unmeasured  | Unmeasured      |

Also record first-token time, cancellation acknowledgement time, process-tree termination time, schema bytes/tokens and the TrueForge session IDs for successful and failed runs. Save `nvidia-smi` observations and Windows process memory measurements outside the fixture. Calculate task success as successful fresh runs divided by all attempted fresh runs; report the failure cause for every unsuccessful attempt.

Provider portability needs two kinds of evidence: deterministic configuration/SDK tests, and the same task with a second genuinely tool-capable model. The latter is pending. An external provider check requires authorised credentials and remains unrun; no hosted-model cost has been incurred by this setup. Local inference has no per-token service fee, with hardware/electricity costs unmeasured.
