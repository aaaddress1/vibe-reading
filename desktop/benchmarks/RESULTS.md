# Translation timing · 2026-10-28

| Same input, English → Traditional Chinese | Complete result, seconds | Median |
| --- | --- | ---: |
| DeepL website, signed out | 3.124 / 3.137 / 3.006 | 3.124 |
| Local NLLB 1.3B | 19.333 / 19.345 / 17.340 | 19.333 |

[Exact input: 1,500 Unicode characters, 234 words](comparison-en-1500.txt). SHA-256 of UTF-8 text without the final newline: `533a695b6b1cc936847886c1c5746f6797e326ecda10f24eb64dc63bc08ad49f`.

Intel Core Ultra 7 258V, Windows 11, CTranslate2 4.8.4, CPU INT8, 4 intra-op threads, beam size 4, batch size 2. Local model and native kernels were warmed before measurement. Each run performs inference again; no application result cache is used. Times include automatic source detection and Traditional Chinese conversion, excluding model download and loading.

DeepL was measured from submitting the complete passage until all four translated paragraphs and the final sentence were visible and the result could be copied. Browser interaction and polling overhead are included; service-side caching is unknown. All three runs submit the same text. [Raw web measurements](deepl-web-1500.json) · [Result screenshot](deepl-1500.png) · [Local measurements](local-1500-1.3b.json).

These are observed timings, not a quality comparison or a universal speed claim. DeepL was faster on this machine and passage. Its signed-out page truncated a separate 2,210-character input to 1,500 characters; truncation was not counted as a completed comparison.

For the [2,210-character passage](long-text-en.txt), keeping INT8 and beam 4, native batches of two reduced local NLLB 1.3B time from 33.69 s to 25.46 s (one run each). Increasing threads to eight took 38.62 s, so the application retains four threads. Batching does not lower the configured search beam. Outputs can still differ slightly because batching changes numerical execution.
