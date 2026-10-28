# Third-party components

The application source follows the repository's [MIT license](../LICENSE).

- PySide6 / Qt: LGPL-3.0 / GPL-3.0 / commercial licensing, as distributed by The Qt Company. The portable distribution uses separate, replaceable Qt shared libraries. See the bundled license notices and [Qt licensing](https://doc.qt.io/qtforpython-6/licenses.html).
- ONNX Runtime: MIT, [Microsoft](https://github.com/microsoft/onnxruntime).
- tokenizers: Apache-2.0, [Hugging Face](https://github.com/huggingface/tokenizers).
- NumPy: BSD-3-Clause, [NumPy](https://numpy.org/doc/stable/license.html).
- OpenCC Python reimplementation: Apache-2.0, [repository](https://github.com/yichen0831/opencc-python).
- langid.py: BSD-3-Clause, [repository](https://github.com/saffsd/langid.py).
- CTranslate2: MIT, [OpenNMT](https://github.com/OpenNMT/CTranslate2). CPU INT8 translation runtime; no LLM server is required.
- PyYAML: MIT, [repository](https://github.com/yaml/pyyaml).
- C-compiled builds include the Nuitka runtime: AGPLv3 with the Nuitka Runtime Library Exception. The bundled `licenses/nuitka` directory includes the license, runtime exception and notices; [Nuitka](https://github.com/Nuitka/Nuitka).
- Opus-MT: the upstream [English → Chinese model card](https://huggingface.co/Helsinki-NLP/opus-mt-en-zh) lists Apache-2.0; the [Chinese → English model card](https://huggingface.co/Helsinki-NLP/opus-mt-zh-en) lists CC-BY-4.0. The application downloads pinned ONNX exports by [Xenova](https://huggingface.co/Xenova), whose export cards do not declare a separate license. The upstream license labels are recorded by direction, rather than assigning one license to all Opus-MT models. Weights are downloaded separately and are not included in the installer.

Model revisions and download paths are pinned in `vibe_desktop/engine.py`.

NLLB-200 distilled model weights: CC-BY-NC-4.0 (non-commercial use), [Meta model card](https://huggingface.co/facebook/nllb-200-distilled-600M). CTranslate2 INT8 conversions: [600M, JustFrederik](https://huggingface.co/JustFrederik/nllb-200-distilled-600M-ct2-int8) and [1.3B, OpenNMT](https://huggingface.co/OpenNMT/nllb-200-distilled-1.3B-ct2-int8). These weights are optional separate downloads; the application's MIT license does not replace the weights' license. The model card is downloaded alongside the weights.

Language names and script codes follow [Meta FLORES-200](https://github.com/facebookresearch/flores/blob/main/flores200/README.md), filtered to codes present in the model tokenizer. A language/script choice is not a claim that every language pair has equal translation quality.
