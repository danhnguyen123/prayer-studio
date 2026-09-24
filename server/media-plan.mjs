import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {parseSrt} from '@remotion/captions';
import {
  FPS,
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
} from './constants.mjs';

const hashSeed = (value) => {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

export const createRandom = (seed) => {
  let state = hashSeed(seed || 'prayer-studio');
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

const shuffle = (items, random) => {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
};

const walk = async (directory, extensions) => {
  const entries = await fs.readdir(directory, {withFileTypes: true});
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(fullPath, extensions)));
    if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }
  return files;
};

export const probeDuration = (filePath) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        filePath,
      ],
      {windowsHide: true},
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', (error) => reject(new Error(`Không chạy được ffprobe: ${error.message}`)));
    child.on('close', (code) => {
      const duration = Number.parseFloat(stdout.trim());
      if (code !== 0 || !Number.isFinite(duration)) {
        reject(new Error(`Không đọc được thời lượng ${filePath}: ${stderr.trim()}`));
        return;
      }
      resolve(duration);
    });
  });

const toMediaUrl = (baseUrl, filePath) =>
  `${baseUrl}/api/media-file?path=${encodeURIComponent(filePath)}`;

const clampVideoCount = (value) =>
  Math.max(10, Math.min(15, Math.round(Number(value) || 12)));

export const buildMediaPlan = async ({
  audioPath,
  srtPath,
  videoDir,
  imageDir,
  videoCount = 12,
  seed = 'prayer-studio',
  previewSeconds = null,
  baseUrl,
  introSeconds = 0,
  introText = '',
  musicPath = null,
  musicVolume = 0.15,
  musicIntroVolume = 0.6,
  videosPerCycle = 10,
  imagesPerCycle = 5,
}) => {
  for (const [label, value] of Object.entries({audioPath, srtPath, videoDir, imageDir})) {
    if (!value) throw new Error(`Thiếu ${label}.`);
    await fs.access(value).catch(() => {
      throw new Error(`Không tìm thấy ${label}: ${value}`);
    });
  }

  const [allVideos, allImages, audioDuration, srtText] = await Promise.all([
    walk(videoDir, VIDEO_EXTENSIONS),
    walk(imageDir, IMAGE_EXTENSIONS),
    probeDuration(audioPath),
    fs.readFile(srtPath, 'utf8'),
  ]);
  if (allVideos.length < 1) throw new Error('Thư mục video không có footage hỗ trợ.');
  if (allImages.length < 1) throw new Error('Thư mục ảnh không có ảnh hỗ trợ.');

  const random = createRandom(seed);
  const selectedVideos = shuffle(allVideos, random).slice(
    0,
    Math.min(clampVideoCount(videoCount), allVideos.length),
  );
  const selectedImages = shuffle(allImages, random);
  const videoDurations = await Promise.all(selectedVideos.map(probeDuration));
  const targetSeconds = previewSeconds
    ? Math.min(audioDuration, Math.max(1, Number(previewSeconds)))
    : audioDuration;
  const introFrames = Math.max(0, Math.round(Number(introSeconds || 0) * FPS));
  const bodyFrames = Math.ceil(targetSeconds * FPS);
  const totalFrames = introFrames + bodyFrames;
  // Chu kỳ: mỗi chu kỳ gồm `videosPerCycle` video + `imagesPerCycle` ảnh; thứ tự
  // các phần tử trong chu kỳ được xáo trộn để tránh lặp bố cục giống nhau.
  const perCycleVideos = Math.max(0, Math.round(Number(videosPerCycle)));
  const perCycleImages = Math.max(0, Math.round(Number(imagesPerCycle)));
  const cycleSize =
    perCycleVideos + perCycleImages > 0 ? {v: perCycleVideos, i: perCycleImages} : {v: 3, i: 1};

  const addImageClip = (cursorPos) => {
    const sourcePath = selectedImages[imageCursor % selectedImages.length];
    // Random 12–15s cho mỗi ảnh để tránh lặp thời lượng giống nhau.
    const imageSeconds = 12 + random() * 3;
    const durationInFrames = Math.min(
      Math.max(1, Math.round(imageSeconds * FPS)),
      totalFrames - cursorPos,
    );
    clips.push({
      id: `image-${clips.length + 1}`,
      type: 'image',
      src: toMediaUrl(baseUrl, sourcePath),
      sourcePath,
      from: cursorPos,
      durationInFrames,
      trimBefore: 0,
    });
    imageCursor += 1;
    return durationInFrames;
  };

  const addVideoClip = (cursorPos) => {
    const sourceIndex = videoCursor % selectedVideos.length;
    const sourcePath = selectedVideos[sourceIndex];
    const sourceDuration = videoDurations[sourceIndex];
    const desiredSeconds = 24 + Math.floor(random() * 19);
    const safeSourceSeconds = Math.max(1, sourceDuration - 0.25);
    const clipSeconds = Math.min(desiredSeconds, safeSourceSeconds);
    const durationInFrames = Math.min(
      Math.max(1, Math.floor(clipSeconds * FPS)),
      totalFrames - cursorPos,
    );
    const maxTrimSeconds = Math.max(0, sourceDuration - durationInFrames / FPS - 0.1);
    const trimBefore = Math.floor(random() * maxTrimSeconds * FPS);
    clips.push({
      id: `video-${clips.length + 1}`,
      type: 'video',
      src: toMediaUrl(baseUrl, sourcePath),
      sourcePath,
      from: cursorPos,
      durationInFrames,
      trimBefore,
    });
    videoCursor += 1;
    return durationInFrames;
  };

  const clips = [];
  let cursor = 0;
  let videoCursor = 0;
  let imageCursor = 0;

  while (cursor < totalFrames) {
    const cycleItems = shuffle(
      [
        ...Array(cycleSize.v).fill('video'),
        ...Array(cycleSize.i).fill('image'),
      ],
      random,
    );
    for (const kind of cycleItems) {
      if (cursor >= totalFrames) break;
      cursor += kind === 'image' ? addImageClip(cursor) : addVideoClip(cursor);
    }
  }

  const {captions} = parseSrt({input: srtText});

  let resolvedMusicPath = null;
  let musicSrc = null;
  if (musicPath) {
    const exists = await fs.access(musicPath).then(() => true).catch(() => false);
    if (exists) {
      resolvedMusicPath = path.resolve(musicPath);
      musicSrc = toMediaUrl(baseUrl, resolvedMusicPath);
    }
  }

  return {
    fps: FPS,
    durationInFrames: totalFrames,
    audioDurationSeconds: audioDuration,
    renderedDurationSeconds: targetSeconds + introFrames / FPS,
    audioSrc: toMediaUrl(baseUrl, audioPath),
    captions: captions.filter((caption) => caption.startMs < targetSeconds * 1000),
    clips,
    selectedVideos,
    selectedImages,
    seed,
    previewSeconds: previewSeconds ? Number(previewSeconds) : null,
    introSeconds: introFrames / FPS,
    introText: String(introText || ''),
    musicSrc,
    musicPath: resolvedMusicPath,
    musicVolume: Number(musicVolume),
    musicIntroVolume: Number(musicIntroVolume),
  };
};
