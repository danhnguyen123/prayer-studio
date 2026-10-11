import {spawn} from 'node:child_process';
import {parseSrtCaptions} from './media-plan.mjs';

const pad = (value, length = 2) => String(value).padStart(length, '0');

export const formatSrtTime = (milliseconds) => {
  const total = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(total % 1000, 3)}`;
};

export const formatSrt = (captions) =>
  captions
    .map(
      (caption, index) =>
        `${index + 1}\n${formatSrtTime(caption.startMs)} --> ${formatSrtTime(caption.endMs)}\n${caption.text}`,
    )
    .join('\n\n') + '\n';

// Phần i bắt đầu sau tổng (thời lượng + khoảng nghỉ) của các phần trước nó.
export const partOffsetsMs = (durationsSec, gapSeconds) => {
  const offsets = [];
  let cursor = 0;
  for (const duration of durationsSec) {
    offsets.push(Math.round(cursor * 1000));
    cursor += duration + gapSeconds;
  }
  return offsets;
};

export const mergeSrtParts = (parts, gapSeconds) => {
  const offsets = partOffsetsMs(parts.map((part) => part.durationSec), gapSeconds);
  const captions = parts.flatMap((part, index) =>
    parseSrtCaptions(part.srtText).map((caption) => ({
      text: caption.text,
      startMs: caption.startMs + offsets[index],
      endMs: caption.endMs + offsets[index],
    })),
  );
  return formatSrt(captions);
};

// Mỗi phần bị ép đúng `durationSec + gap` (atrim + apad whole_dur) để timeline audio
// khớp tuyệt đối với offset SRT, kể cả khi độ dài giải mã MP3 lệch vài chục ms so với ffprobe.
export const buildConcatArgs = (parts, gapSeconds, outputPath) => {
  const filters = parts.map((part, index) => {
    const gap = index < parts.length - 1 ? gapSeconds : 0;
    const length = (part.durationSec + gap).toFixed(3);
    return `[${index}:a]aformat=sample_rates=44100:channel_layouts=stereo,atrim=end=${part.durationSec.toFixed(3)},apad=whole_dur=${length}[a${index}]`;
  });
  const concatInputs = parts.map((_part, index) => `[a${index}]`).join('');
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    ...parts.flatMap((part) => ['-i', part.path]),
    '-filter_complex',
    `${filters.join(';')};${concatInputs}concat=n=${parts.length}:v=0:a=1[out]`,
    '-map',
    '[out]',
    '-c:a',
    'libmp3lame',
    '-b:a',
    '192k',
    outputPath,
  ];
};

export const runFfmpeg = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, {windowsHide: true});
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.on('error', (error) => reject(new Error(`Không chạy được ffmpeg: ${error.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg lỗi (exit ${code}): ${stderr.trim()}`));
    });
  });
