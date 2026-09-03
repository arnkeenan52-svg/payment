import React from 'react';
import { Composition } from 'remotion';
import { HeroFilm } from './HeroFilm';
import { CONTAINER_FPS, DURATION_S } from './teardown';

export const RemotionRoot: React.FC = () => (
  <Composition
    id="HeroFilm"
    component={HeroFilm}
    durationInFrames={DURATION_S * CONTAINER_FPS}
    fps={CONTAINER_FPS}
    width={1920}
    height={1080}
  />
);
