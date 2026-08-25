#!/usr/bin/env bash
# Encode the hero tour videos from the edit master.
#
# WHY THESE SETTINGS. The first shipped cut used `-tune animation`, which is
# built for flat-shaded cartoons and is actively wrong for a UI screen
# recording. It set psy_rd=0.40 (vs 1.00 default) and deblock=1:1:1, which
# together smear exactly the thing this video is selling: crisp dashboard text.
# At crf=23 on top of that, the encode kept only 27-35% of the master's bitrate
# through the motion-heavy seconds and the text visibly mushed.
#
# Measured against the master with SSIM, per second (the mean hides this —
# it is dominated by the static frames):
#
#   shipped: crf23 + tune=animation   4.26MB   worst second 0.99585
#   crf23, tune removed               7.09MB   worst second 0.99648
#   crf21, tune removed               8.96MB   worst second 0.99731  <- shipped
#
# AV1 was tested and rejected, not skipped: SVT-AV1 preset 6 scored 0.9977-0.9980
# at 5.4-6.8MB, i.e. worse than plain x264 at a comparable size. High-fidelity
# screen content with fine text is a case x264 with psy-rd still wins.
#
#   aq-mode=3    variance AQ biased to dark scenes — this UI is near-black
#   deblock=-1:-1 preserve text edges instead of smoothing them
#   psy-rd       back to the default strength that retains fine detail
#   g=60         a keyframe every 2s (the shipped file had keyint=250)
#
# Usage: scripts/encode-hero.sh <master-dark.mp4> <master-light.mp4>
set -euo pipefail
cd "$(dirname "$0")/.."

encode() {
  local src="$1" out="$2"
  echo "==> $out"
  ffmpeg -v error -stats -i "$src" \
    -c:v libx264 -preset slow -crf 21 \
    -x264-params "aq-mode=3:deblock=-1:-1:psy-rd=1.00:0.15:ref=5:bframes=4" \
    -g 60 -pix_fmt yuv420p -an -movflags +faststart -y "$out"
  # The poster is the first frame, so it matches what the video shows before it
  # starts. It is what the page paints for LCP, so it stays small.
  ffmpeg -v error -i "$out" -frames:v 1 -q:v 82 -y "public/hero-poster-$(basename "${out%.mp4}" | sed "s/hero-tour-//").webp"
}

encode "$1" public/hero-tour-dark.mp4
encode "$2" public/hero-tour-light.mp4
ls -la public/hero-tour-*.mp4
