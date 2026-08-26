import { loadFont } from "@remotion/fonts";
import { staticFile } from "remotion";

// loadFont() holds the render open with delayRender() until the face is ready,
// so importing this module once (from Root) is enough for every composition.
loadFont({
  family: "Dues Grotesk",
  url: staticFile("fonts/SpaceGrotesk-Bold.ttf"),
  weight: "700",
});
loadFont({
  family: "Dues Sans",
  url: staticFile("fonts/DMSans-Regular.ttf"),
  weight: "400",
});
loadFont({
  family: "Dues Sans",
  url: staticFile("fonts/DMSans-Bold.ttf"),
  weight: "700",
});
