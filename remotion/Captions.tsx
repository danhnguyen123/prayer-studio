import type {Caption} from '@remotion/captions';
import {
  AbsoluteFill,
  Easing,
  interpolate,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

const FONT = 'Arial, "Segoe UI", Helvetica, sans-serif';

const baseTextStyle = (isVerse: boolean): React.CSSProperties => ({
  maxWidth: 1520,
  color: '#fffdf6',
  fontFamily: FONT,
  fontSize: isVerse ? 54 : 62,
  fontStyle: isVerse ? 'italic' : 'normal',
  fontWeight: 700,
  lineHeight: isVerse ? 1.34 : 1.22,
  letterSpacing: -0.4,
  textAlign: 'center',
  whiteSpace: 'pre-wrap',
  // Viền đen mỏng quanh chữ (stroke vẽ dưới, fill đè lên → viền mảnh, chữ sắc nét).
  WebkitTextStroke: '3px rgba(0, 0, 0, 0.92)',
  paintOrder: 'stroke fill',
  textShadow: '0 2px 5px rgba(0, 0, 0, 0.55)',
});

const Center: React.FC<{children: React.ReactNode}> = ({children}) => (
  <AbsoluteFill
    style={{justifyContent: 'center', alignItems: 'center', padding: '80px 120px'}}
  >
    {children}
  </AbsoluteFill>
);

// Phụ đề voiceover: tĩnh, không fade in/out, có viền đen mỏng.
const SubtitleCard: React.FC<{text: string}> = ({text}) => (
  <Center>
    <div style={baseTextStyle(false)}>{text.trim()}</div>
  </Center>
);

// Câu Kinh Thánh intro: fade in (fadeInFrames) + trượt nhẹ lên,
// fade out bắt đầu tại fadeOutStart, kéo dài fadeOutFrames.
export const VerseCard: React.FC<{
  text: string;
  fadeInFrames: number;
  fadeOutStart: number;
  fadeOutFrames: number;
}> = ({text, fadeInFrames, fadeOutStart, fadeOutFrames}) => {
  const frame = useCurrentFrame();
  const safeOutStart = Math.max(fadeInFrames, fadeOutStart);
  // Chỉ fade in/out, KHÔNG trượt (translateY subpixel + viền chữ dày gây rung chữ).
  const opacity = interpolate(
    frame,
    [0, fadeInFrames, safeOutStart, safeOutStart + fadeOutFrames],
    [0, 1, 1, 0],
    {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
      easing: Easing.bezier(0.16, 1, 0.3, 1),
    },
  );
  return (
    <Center>
      <div style={{...baseTextStyle(true), opacity, willChange: 'opacity'}}>
        {text.trim()}
      </div>
    </Center>
  );
};

export const Captions: React.FC<{
  captions: Caption[];
  offsetFrames?: number;
}> = ({captions, offsetFrames = 0}) => {
  const {fps} = useVideoConfig();

  return (
    <AbsoluteFill>
      {captions.map((caption, index) => {
        const from =
          offsetFrames + Math.max(0, Math.floor((caption.startMs / 1000) * fps));
        const durationInFrames = Math.max(
          1,
          Math.ceil(((caption.endMs - caption.startMs) / 1000) * fps),
        );
        return (
          <Sequence
            key={`${caption.startMs}-${index}`}
            name={`Caption ${index + 1}`}
            from={from}
            durationInFrames={durationInFrames}
            premountFor={fps}
          >
            <SubtitleCard text={caption.text} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
