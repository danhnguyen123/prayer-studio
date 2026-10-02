import {createReadStream, createWriteStream} from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import {pathToFileURL} from 'node:url';
import {GetObjectCommand, PutObjectCommand, S3Client} from '@aws-sdk/client-s3';
import {Upload} from '@aws-sdk/lib-storage';

const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-southeast-1';
const bucketName = process.env.PLAN_BUCKET;
const planKey = process.env.PLAN_KEY;

const s3 = new S3Client({region});
let workDir;
let plan;
let lastStatusAt = 0;

const putStatus = async (value) => {
  if (!plan?.statusKey) return;
  await s3.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: plan.statusKey,
    Body: JSON.stringify({...value, updatedAt: new Date().toISOString()}),
    ContentType: 'application/json',
  }));
};

const download = async (objectKey, destination) => {
  const result = await s3.send(new GetObjectCommand({Bucket: bucketName, Key: objectKey}));
  await pipeline(result.Body, createWriteStream(destination));
};

const loadPlan = async () => {
  const result = await s3.send(new GetObjectCommand({Bucket: bucketName, Key: planKey}));
  return JSON.parse(await result.Body.transformToString('utf8'));
};

const assTime = (milliseconds) => {
  const totalCentiseconds = Math.max(0, Math.round(milliseconds / 10));
  const hours = Math.floor(totalCentiseconds / 360000);
  const minutes = Math.floor((totalCentiseconds % 360000) / 6000);
  const seconds = Math.floor((totalCentiseconds % 6000) / 100);
  const centiseconds = totalCentiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
};

const assText = (value) => String(value || '')
  .replaceAll('\\', '\\\\')
  .replaceAll('{', '\\{')
  .replaceAll('}', '\\}')
  .replace(/\r?\n/g, '\\N');

export const buildAss = (value) => {
  const events = [];
  const introMs = Math.round(Number(value.introSeconds || 0) * 1000);
  if (introMs > 0 && String(value.introText || '').trim()) {
    events.push(
      `Dialogue: 0,${assTime(0)},${assTime(introMs)},Verse,,0,0,0,,{\\fad(3000,1000)}${assText(value.introText.trim())}`,
    );
  }
  for (const caption of value.captions || []) {
    const start = introMs + Number(caption.startMs || 0);
    const end = introMs + Number(caption.endMs || 0);
    if (end <= start) continue;
    events.push(
      `Dialogue: 0,${assTime(start)},${assTime(end)},Caption,,0,0,0,,${assText(caption.text).trim()}`,
    );
  }
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${value.width}
PlayResY: ${value.height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Noto Sans,112,&H00F6FDFF,&H000000FF,&H00000000,&H70000000,-1,0,0,0,100,100,-0.4,0,1,3.5,0.7,5,120,120,80,1
Style: Verse,Noto Serif,54,&H00F6FDFF,&H000000FF,&H00000000,&H70000000,-1,-1,0,0,100,100,-0.4,0,1,3,1,5,120,120,80,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join('\n')}
`;
};

const runFfmpeg = async ({filesByKey, outputPath, assPath}) => {
  const args = ['-hide_banner', '-y'];
  const inputIndexes = [];
  for (const clip of plan.clips) {
    const duration = clip.durationInFrames / plan.fps;
    if (clip.type === 'video') {
      args.push('-ss', String((clip.trimBefore || 0) / plan.fps), '-t', String(duration), '-i', filesByKey[clip.objectKey]);
    } else {
      // Một frame ảnh duy nhất; zoompan tự sinh đúng durationInFrames frame.
      args.push('-i', filesByKey[clip.objectKey]);
    }
    inputIndexes.push(args.filter((item) => item === '-i').length - 1);
  }
  const audioIndex = inputIndexes.length;
  args.push('-i', filesByKey[plan.audioKey]);
  const musicIndex = plan.musicKey ? audioIndex + 1 : null;
  if (plan.musicKey) args.push('-stream_loop', '-1', '-i', filesByKey[plan.musicKey]);

  const filters = [];
  const labels = [];
  plan.clips.forEach((clip, index) => {
    const duration = clip.durationInFrames / plan.fps;
    const label = `v${index}`;
    labels.push(`[${label}]`);
    const normalize = `scale=${plan.width}:${plan.height}:force_original_aspect_ratio=increase,crop=${plan.width}:${plan.height},setsar=1,fps=${plan.fps},format=yuv420p`;
    if (clip.type === 'image') {
      const frames = Math.max(1, clip.durationInFrames);
      // Tạo chuyển động thật sự trên canvas 2x, khóa tọa độ về pixel chẵn,
      // sau đó downscale một lần về 1080p. Chỉ upscale nguồn nhưng để
      // zoompan xuất thẳng 1080p vẫn làm pha lấy mẫu nhảy qua lại giữa
      // các pixel; supersampling giữ pha chuyển động ổn định trước khi thu nhỏ.
      const zoomSourceWidth = plan.width * 2;
      const zoomSourceHeight = plan.height * 2;
      filters.push(
        `[${index}:v]scale=${zoomSourceWidth}:${zoomSourceHeight}:force_original_aspect_ratio=increase:flags=lanczos,crop=${zoomSourceWidth}:${zoomSourceHeight},setsar=1,format=yuv444p,zoompan=z='1.01+0.085*on/${Math.max(1, frames - 1)}':x='trunc((iw-iw/zoom)/4)*2':y='trunc((ih-ih/zoom)/4)*2':d=${frames}:s=${zoomSourceWidth}x${zoomSourceHeight}:fps=${plan.fps},scale=${plan.width}:${plan.height}:flags=lanczos+accurate_rnd,format=yuv420p,trim=duration=${duration},setpts=PTS-STARTPTS[${label}]`,
      );
    } else {
      filters.push(`[${index}:v]${normalize},trim=duration=${duration},setpts=PTS-STARTPTS[${label}]`);
    }
  });
  filters.push(`${labels.join('')}concat=n=${labels.length}:v=1:a=0[joined]`);
  // Không phủ lớp đen nửa dưới; chỉ giữ vignette rất nhẹ và burn ASS.
  filters.push(`[joined]vignette=PI/7,ass=${assPath}[vout]`);

  const intro = Math.max(0, Number(plan.introSeconds || 0));
  const fadeStart = Math.max(0, intro - 0.7);
  if (musicIndex !== null && intro > 0) {
    filters.push(`[${musicIndex}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${Number(plan.musicIntroVolume || 0.2)},apad,atrim=duration=${intro},afade=t=out:st=${fadeStart}:d=${Math.min(0.7, intro)}[introa]`);
  } else {
    filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${intro}[introa]`);
  }
  filters.push(`[${audioIndex}:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[voice]`);
  filters.push(`[introa][voice]concat=n=2:v=0:a=1,apad,atrim=duration=${plan.renderedDurationSeconds}[aout]`);

  const filterPath = path.join(workDir, 'filters.txt');
  await fs.writeFile(filterPath, filters.join(';\n'), 'utf8');
  args.push(
    '-filter_complex_script', filterPath,
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', String(plan.preset || 'veryfast'),
    '-crf', String(plan.crf ?? 20), '-threads', '0', '-pix_fmt', 'yuv420p', '-r', String(plan.fps),
    '-c:a', 'aac', '-b:a', '192k',
    '-map_metadata', '-1', '-metadata', `creation_time=${new Date().toISOString().slice(0, 19)}`,
    '-movflags', '+faststart', '-t', String(plan.renderedDurationSeconds),
    '-progress', 'pipe:1', '-nostats', outputPath,
  );

  await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, {stdio: ['ignore', 'pipe', 'pipe']});
    let stderr = '';
    let progressBuffer = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
    });
    child.stdout.on('data', (chunk) => {
      progressBuffer += chunk.toString();
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop() || '';
      for (const line of lines) {
        const [key, rawValue] = line.split('=');
        if (key !== 'out_time_us' && key !== 'out_time_ms') continue;
        const seconds = Number(rawValue) / 1_000_000;
        const progress = Math.max(0, Math.min(0.999, seconds / plan.renderedDurationSeconds));
        if (Date.now() - lastStatusAt > 5000) {
          lastStatusAt = Date.now();
          putStatus({state: 'rendering', progress, message: `FFmpeg đang render ${Math.round(progress * 100)}%`}).catch(() => undefined);
        }
      }
    });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`FFmpeg exit ${code}: ${stderr.slice(-4000)}`)));
  });
};

const main = async () => {
  if (!bucketName || !planKey) throw new Error('PLAN_BUCKET và PLAN_KEY là bắt buộc.');
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prayer-ffmpeg-'));
  try {
    plan = await loadPlan();
  await putStatus({state: 'downloading', progress: 0, message: 'Worker đang tải media từ S3'});
  const keys = [...new Set([
    plan.audioKey,
    plan.musicKey,
    ...plan.clips.map((clip) => clip.objectKey),
  ].filter(Boolean))];
  const filesByKey = {};
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const extension = path.extname(key.split('/').pop()) || '.bin';
    const localPath = path.join(workDir, `media-${index}${extension}`);
    await download(key, localPath);
    filesByKey[key] = localPath;
    await putStatus({
      state: 'downloading',
      progress: 0,
      message: `Worker đang tải media ${index + 1}/${keys.length}`,
    });
  }

  const assPath = path.join(workDir, 'captions.ass');
  const outputPath = path.join(workDir, 'output.mp4');
  await fs.writeFile(assPath, buildAss(plan), 'utf8');
  await putStatus({state: 'rendering', progress: 0, message: 'FFmpeg bắt đầu render'});
  await runFfmpeg({filesByKey, outputPath, assPath});

  await putStatus({state: 'uploading', progress: 0.999, message: 'Đang upload video hoàn tất lên S3'});
  await new Upload({
    client: s3,
    params: {
      Bucket: bucketName,
      Key: plan.outputKey,
      Body: createReadStream(outputPath),
      ContentType: 'video/mp4',
    },
    queueSize: 4,
    leavePartsOnError: false,
  }).done();
  await putStatus({state: 'completed', progress: 1, message: 'FFmpeg render hoàn tất'});
  } catch (error) {
    await putStatus({state: 'failed', progress: 1, message: error.message}).catch(() => undefined);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  } finally {
    await fs.rm(workDir, {recursive: true, force: true}).catch(() => undefined);
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
