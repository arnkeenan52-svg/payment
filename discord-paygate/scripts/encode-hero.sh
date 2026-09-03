#!/usr/bin/env bash
# Cut and encode the hero tour from the 30s edit master.
#
# ── WHY IT IS SHORT ──────────────────────────────────────────────────────────
# The hero is <video autoplay preload=auto>, so every visitor downloads the
# whole file before anything plays smoothly. That makes runtime and quality
# directly competing costs, and the first two attempts both got the trade wrong:
#
#   v1  30.1s @ 1.18 Mbps  4.3MB   text smeared on every motion scene
#   v2  30.1s @ 2.49 Mbps  9.4MB   stills better, but 2x the bytes to buffer
#                                  — reported as "laggy" on real connections
#
# Spending the budget on 30 seconds was the mistake. A hero loop does not need
# to show every feature; the page below it already does. So this cuts to the
# three strongest beats and spends the same bytes on a third of the runtime:
#
#   v3  11.6s @ 3.87 Mbps  5.4MB   3.3x v1's bitrate, 43% smaller than v2
#
# ── THE CUT ──────────────────────────────────────────────────────────────────
# Chosen off a contact sheet of the whole master, and aligned to the edit's own
# hard cuts (detected at 6.30 / 16.57 / 23.57 / 25.67) so no join lands inside
# one of its crossfades.
#
#   0.00-6.20   brand card into Overview: revenue analytics, compare period
#   19.40-23.40 Appearance: themes recolouring the live checkout preview —
#               the most visually dynamic four seconds in the tour
#   27.30-29.20 the payoff: a sale landing in Discord
#
# Dropped: Products, Members, Transactions, Discounts. All list views — flat,
# text-heavy, the worst thing to compress and the thing the page already
# covers in its own sections.
#
# ── WHY CRF 16 AND NOT LOWER ─────────────────────────────────────────────────
# Measured against a lossless cut of the same segments:
#
#   crf18  4.5MB  3.26 Mbps  worst second 0.99695
#   crf16  5.4MB  3.87 Mbps  worst second 0.99754   <- shipped
#
# 3.87 Mbps is already above the master's own ~3.3 Mbps through these regions.
# Below crf16 the encoder starts spending bits faithfully reproducing the
# master's compression artifacts, which buys nothing. This is the ceiling until
# the tour is re-shot from a higher-resolution source.
#
# NOT `-tune animation`. It is built for flat-shaded cartoons: it sets
# psy_rd=0.40 (vs 1.00) and deblock=1:1:1, which smear exactly the UI text this
# video exists to show. That was the whole of the v1 quality failure.
#
#   aq-mode=3     variance AQ biased to dark scenes — this UI is near-black
#   deblock=-1:-1 preserve text edges rather than smoothing them
#   g=60          a keyframe every 2s
#
# Usage: scripts/encode-hero.sh <master-dark.mp4> <master-light.mp4>
set -euo pipefail
cd "$(dirname "$0")/.."

A_IN=0.00;  A_LEN=6.20
B_IN=19.40; B_LEN=4.00
C_IN=27.30; C_LEN=1.90
XF=0.25 # crossfade at each join, matching the master's own transition length

encode() {
  local src="$1" out="$2" theme="$3"
  echo "==> $out"
  # xfade offsets are cumulative: each is (running length so far - fade), and
  # every fade shortens the total by its own duration.
  local off1 off2
  off1=$(echo "$A_LEN - $XF" | bc)
  off2=$(echo "$A_LEN + $B_LEN - 2 * $XF" | bc)
  ffmpeg -v error -stats \
    -ss $A_IN -t $A_LEN -i "$src" \
    -ss $B_IN -t $B_LEN -i "$src" \
    -ss $C_IN -t $C_LEN -i "$src" \
    -filter_complex "\
[0:v]setpts=PTS-STARTPTS,fps=30[a];\
[1:v]setpts=PTS-STARTPTS,fps=30[b];\
[2:v]setpts=PTS-STARTPTS,fps=30[c];\
[a][b]xfade=transition=fade:duration=$XF:offset=$off1[ab];\
[ab][c]xfade=transition=fade:duration=$XF:offset=$off2[v]" \
    -map "[v]" -c:v libx264 -preset slow -crf 16 \
    -x264-params "aq-mode=3:deblock=-1:-1:psy-rd=1.00:0.15:ref=5:bframes=4" \
    -g 60 -pix_fmt yuv420p -an -movflags +faststart -y "$out"
  # The poster is frame one, so the page paints exactly what the video starts
  # on. It carries LCP now that the video no longer loads until after paint.
  ffmpeg -v error -i "$out" -frames:v 1 -c:v libwebp -quality 82 -y "public/hero-poster-$theme.webp"
}

encode "$1" public/hero-tour-dark.mp4 dark
encode "$2" public/hero-tour-light.mp4 light
ls -la public/hero-tour-*.mp4 public/hero-poster-*.webp
