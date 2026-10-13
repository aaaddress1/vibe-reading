# PP-DocLayout-S

`pp-doclayout-s.onnx` is the PP-DocLayout-S document layout detection model by
PaddlePaddle ([paper](https://arxiv.org/abs/2503.17213),
[model card](https://huggingface.co/PaddlePaddle/PP-DocLayout-S)), in the ONNX
export published by [GreatV/oar-ocr](https://github.com/GreatV/oar-ocr/releases/tag/v0.3.0).

- License: Apache License 2.0 (see `LICENSE` in this folder)
- Input: 1×3×480×480 RGB, ImageNet mean/std normalisation; plus `scale_factor`
- Output: N×6 `[class_id, score, x1, y1, x2, y2]`, 23 layout classes
- SHA-256: `c2336493a0a13cd9b9b457ca68aea370b327c362a4a7da4917c2bba96029bceb`
