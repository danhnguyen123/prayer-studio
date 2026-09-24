import type {CalculateMetadataFunction} from 'remotion';
import {Composition} from 'remotion';
import {PrayerVideo} from './PrayerVideo';
import {PrayerVideoSchema, type PrayerVideoProps} from './schema';

const calculateMetadata: CalculateMetadataFunction<PrayerVideoProps> = async ({
  props,
}) => ({
  durationInFrames: props.durationInFrames,
  defaultOutName: props.previewSeconds ? 'prayer-preview.mp4' : 'prayer-video.mp4',
});

export const RemotionRoot: React.FC = () => (
  <Composition
    id="PrayerVideo"
    component={PrayerVideo}
    width={1920}
    height={1080}
    fps={30}
    durationInFrames={300}
    schema={PrayerVideoSchema}
    calculateMetadata={calculateMetadata}
    defaultProps={{
      fps: 30,
      durationInFrames: 300,
      audioDurationSeconds: 10,
      renderedDurationSeconds: 10,
      audioSrc: '',
      captions: [],
      clips: [],
      selectedVideos: [],
      selectedImages: [],
      seed: 'prayer-studio',
      previewSeconds: 10,
      introSeconds: 0,
      introText: '',
      musicSrc: null,
      musicVolume: 0,
      musicIntroVolume: 0.2,
    }}
  />
);
