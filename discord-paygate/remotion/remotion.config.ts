import { Config } from '@remotion/cli/config';

// Match the film's own encoder settings exactly, so a Remotion render and a
// build-film.mjs render of the same composition are the same file.
Config.setVideoImageFormat('png');
Config.setCodec('h264');
Config.setCrf(17);
Config.setChromiumOpenGlRenderer('swiftshader');
