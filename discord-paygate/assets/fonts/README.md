# Bundled brand fonts

Static instances cut from the site's variable web fonts so that SVG
rasterization (sharp/librsvg, which resolves families through fontconfig)
renders welcome cards in the real brand faces instead of a fallback.

| File | Family | Cut from |
|---|---|---|
| `SpaceGrotesk-Bold.ttf` | `Dues Grotesk` Bold | Space Grotesk (SIL Open Font License 1.1) |
| `DMSans-Regular.ttf` | `Dues Sans` Regular | DM Sans (SIL Open Font License 1.1) |
| `DMSans-Bold.ttf` | `Dues Sans` Bold | DM Sans (SIL Open Font License 1.1) |

Regenerate with `scripts/build-fonts.mjs`.

The families are renamed on purpose. Both upstream fonts are OFL-licensed, and
the OFL requires that a modified font not be distributed under its original
name — instancing a variable font to a fixed weight is a modification. The
rename keeps us compliant and stops a system-installed copy of the real Space
Grotesk from being picked up instead of ours.

`Dockerfile.presence` copies these into `/usr/share/fonts/dues/` and runs
`fc-cache -f`. Locally, do the same (or point `FONTCONFIG_PATH` at this
directory) or cards render in the fallback face — `renderWelcomeCard()` warns
when the families are missing rather than failing silently.
