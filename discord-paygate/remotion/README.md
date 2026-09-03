# The Dues hero film, in Remotion

    npm install
    npm run studio     # a scrubber and a live preview — the thing this is for
    npm run render     # writes ../public/hero-tour.mp4

## Why this exists, and what it does and does not fix

Remotion renders React components through **headless Chromium, frame by frame,
then encodes with ffmpeg**. That is the same pipeline `scripts/build-film.mjs`
already runs against `hero/film.html`. Switching authoring surface does not by
itself change a single output pixel, and it would not have caught any of the
four defects that actually got five cuts rejected:

  - a background measuring saturation 0.001 — arithmetically no colour at all
  - near-black gradients that 8-bit h264 cannot hold, banding into 590px plateaus
  - six of nine cursor presses landing outside the element they were pressing
  - an endcard flash caused by one line forcing `opacity = '1'` on a parent

Every one of those was found by measuring rendered frames, and every one of them
is just as easy to write in React as in plain DOM.

What Remotion **does** give, and the reason it is here: `npm run studio` is a
real scrubber. Reviewing a cut by dragging a playhead is far better than
reviewing it through contact sheets, and it lets a change be judged in seconds
rather than after a thirty-minute render.

## The rules live in `src/teardown.ts`

Everything measured off the 600 reference frames is in one module — the plate
construction, the acceptance thresholds, the 25fps authoring grid, the theme
presets, the craft rules, the cursor doctrine. They are constants rather than
comments because five cuts drifted away from them one plausible decision at a
time, and a number in a shared module is harder to drift from than a number in
someone's head.

Read that file before changing anything here.

## Acceptance

A render is not shippable on how it looks on the machine that made it. It has to
measure:

    mean luma        >= 175      (reference 177.2)
    mean saturation  >= 0.19     (reference 0.195)
    frames < luma 100 <= 15%     (reference 12%)
    endcard delta     == 0.0000  for the final 1.2s

`scripts/measure-ground.mjs` in the parent project checks the ground; the same
arithmetic applied to a finished render checks the film.
