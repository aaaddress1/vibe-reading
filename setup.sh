#!/usr/bin/env bash
set -euo pipefail

echo
echo " === Vibe Reading - Setup (macOS / Linux) ==="
echo " Downloading PDF.js library..."
echo

mkdir -p lib

curl -fL "https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.min.js"        -o lib/pdf.min.js        && echo "  OK: pdf.min.js"
curl -fL "https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js" -o lib/pdf.worker.min.js && echo "  OK: pdf.worker.min.js"

echo
echo " Download complete. Next steps:"
echo
echo " [Load extension in Chrome]"
echo "   1. Open chrome://extensions"
echo "   2. Enable Developer mode (top-right toggle)"
echo "   3. Click \"Load unpacked\""
echo "   4. Select this folder: $(pwd)"
echo
echo " [Enable Chrome built-in AI - first time only]"
echo "   Translator / Language Detector: stable since Chrome 138, no flag needed."
echo "   For Gemini Nano (AI summary / Q&A / translation fallback):"
echo "     A. chrome://flags - enable \"Prompt API for Gemini Nano\""
echo "     B. Restart Chrome"
echo "     C. chrome://components - update \"Optimization Guide On Device Model\""
echo "        (or check chrome://on-device-internals). Requires macOS 13+,"
echo "        ~22GB free disk, >4GB VRAM (or Chrome 140+ CPU fallback: 16GB RAM + 4 cores)."
echo
