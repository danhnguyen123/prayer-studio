import {Audio as MediaAudio, Video} from '@remotion/media';
import {
  AbsoluteFill,
  Audio,
  Easing,
  Img,
  interpolate,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {Captions, VerseCard} from './Captions';
import type {MediaClip, PrayerVideoProps} from './schema';

const ImageScene: React.FC<{clip: MediaClip}> = ({clip}) => {
  const frame = useCurrentFrame();
  const durationInFrames = clip.durationInFrames;
  return (
    <AbsoluteFill style={{backgroundColor: '#080c0d', overflow: 'hidden'}}>
      <Img
        name="Prayer still"
        src={clip.src}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          // Zoom chậm Ken Burns; KHÔNG fade → cắt thẳng, không nhấp nháy.
          scale: interpolate(frame, [0, durationInFrames], [1.01, 1.095], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
            easing: Easing.bezier(0.25, 0.1, 0.25, 1),
            output: 'perceptual-scale',
          }),
        }}
      />
    </AbsoluteFill>
  );
};

const VideoScene: React.FC<{clip: MediaClip}> = ({clip}) => {
  return (
    <AbsoluteFill style={{backgroundColor: '#080c0d'}}>
      <Video
        name="Prayer footage"
        src={clip.src}
        muted
        objectFit="cover"
        trimBefore={clip.trimBefore}
        style={{width: '100%', height: '100%'}}
      />
    </AbsoluteFill>
  );
};

export const PrayerVideo: React.FC<PrayerVideoProps> = ({
  audioSrc,
  captions,
  clips,
  introSeconds = 0,
  introText = '',
  musicSrc = null,
  musicIntroVolume = 0.2,
}) => {
  const {fps} = useVideoConfig();
  const introFrames = Math.max(0, Math.round((introSeconds || 0) * fps));
  const verseFadeInFrames = Math.round(3 * fps); // fade in 3s
  const verseFadeOutFrames = Math.round(1 * fps); // fade out 1s (kết thúc đúng lúc voiceover vào)

  // Nhạc nền CHỈ phát trong intro rồi tắt hẳn (bọc trong Sequence), fade nhẹ ở
  // cuối intro để không bị "cụp". Không còn phát khi voiceover chạy.
  const musicFadeOut = Math.round(0.7 * fps);
  const musicVolumeAt = (frame: number) =>
    interpolate(
      frame,
      [0, Math.max(1, introFrames - musicFadeOut), introFrames],
      [musicIntroVolume, musicIntroVolume, 0],
      {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'},
    );

  return (
    <AbsoluteFill style={{backgroundColor: '#080c0d'}}>
      {clips.map((clip) => (
        <Sequence
          key={clip.id}
          name={clip.id}
          from={clip.from}
          durationInFrames={clip.durationInFrames}
          premountFor={fps}
        >
          {clip.type === 'video' ? (
            <VideoScene clip={clip} />
          ) : (
            <ImageScene clip={clip} />
          )}
        </Sequence>
      ))}

      <AbsoluteFill
        style={{
          background:
            'linear-gradient(180deg, rgba(3, 8, 9, 0.10) 0%, rgba(3, 8, 9, 0.02) 48%, rgba(3, 8, 9, 0.52) 100%)',
          boxShadow: 'inset 0 0 180px rgba(0, 0, 0, 0.28)',
        }}
      />

      {musicSrc && introFrames > 0 ? (
        <Sequence from={0} durationInFrames={introFrames} name="Background music">
          <Audio src={musicSrc} loop volume={musicVolumeAt} />
        </Sequence>
      ) : null}

      {audioSrc ? (
        <Sequence from={introFrames} name="Voiceover">
          <MediaAudio src={audioSrc} />
        </Sequence>
      ) : null}

      {introFrames > 0 && introText.trim() ? (
        <Sequence from={0} durationInFrames={introFrames} name="Intro verse">
          <VerseCard
            text={introText}
            fadeInFrames={verseFadeInFrames}
            fadeOutStart={Math.max(verseFadeInFrames, introFrames - verseFadeOutFrames)}
            fadeOutFrames={verseFadeOutFrames}
          />
        </Sequence>
      ) : null}

      <Captions captions={captions} offsetFrames={introFrames} />
    </AbsoluteFill>
  );
};
