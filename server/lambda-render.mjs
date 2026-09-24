import {createReadStream, createWriteStream} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import {HeadObjectCommand, GetObjectCommand, S3Client} from '@aws-sdk/client-s3';
import {Upload} from '@aws-sdk/lib-storage';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
import {bundle} from '@remotion/bundler';
import {
  deploySiteFromBundle,
  getOrCreateBucket,
} from '@remotion/lambda';
import {
  getRenderProgress,
  presignUrl,
  renderMediaOnLambda,
} from '@remotion/lambda/client';
import {PROJECT_ROOT} from './constants.mjs';
import {buildMediaPlan} from './media-plan.mjs';
import {appendJobLog, getJob, mutateJob, updateJob} from './job-store.mjs';

let bucketPromise = null;
let serveUrlPromise = null;
const uploadedUrlPromises = new Map();

// Remotion's AWS clients use the standard AWS credential chain. Allow a
// backend-only REMOTION_ prefix without exposing or duplicating credentials.
if (!process.env.AWS_ACCESS_KEY_ID && process.env.REMOTION_AWS_ACCESS_KEY_ID) {
  process.env.AWS_ACCESS_KEY_ID = process.env.REMOTION_AWS_ACCESS_KEY_ID;
}
if (!process.env.AWS_SECRET_ACCESS_KEY && process.env.REMOTION_AWS_SECRET_ACCESS_KEY) {
  process.env.AWS_SECRET_ACCESS_KEY = process.env.REMOTION_AWS_SECRET_ACCESS_KEY;
}
if (!process.env.AWS_SESSION_TOKEN && process.env.REMOTION_AWS_SESSION_TOKEN) {
  process.env.AWS_SESSION_TOKEN = process.env.REMOTION_AWS_SESSION_TOKEN;
}
if (!process.env.AWS_REGION && process.env.REMOTION_AWS_REGION) {
  process.env.AWS_REGION = process.env.REMOTION_AWS_REGION;
}

const createLimiter = (maximum) => {
  let active = 0;
  const queue = [];
  const drain = () => {
    if (active >= maximum || queue.length === 0) return;
    const {task, resolve, reject} = queue.shift();
    active += 1;
    task()
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        drain();
      });
  };
  return (task) =>
    new Promise((resolve, reject) => {
      queue.push({task, resolve, reject});
      drain();
    });
};

const limitUpload = createLimiter(3);

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const lambdaConfig = () => {
  const region = process.env.REMOTION_AWS_REGION || 'ap-southeast-1';
  const functionName = process.env.REMOTION_FUNCTION_NAME;
  const rendererFunctionName =
    process.env.REMOTION_RENDERER_FUNCTION_NAME?.trim() || undefined;
  if (!functionName) {
    throw new Error(
      'Thiếu REMOTION_FUNCTION_NAME. Hãy deploy Lambda function và cập nhật .env.',
    );
  }
  return {
    region,
    functionName,
    rendererFunctionName,
    siteName: process.env.REMOTION_SITE_NAME || 'youtube-pray-generation',
  };
};

const awsCredentials = () => {
  const accessKeyId =
    process.env.REMOTION_AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey =
    process.env.REMOTION_AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return undefined;
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken:
      process.env.REMOTION_AWS_SESSION_TOKEN || process.env.AWS_SESSION_TOKEN,
  };
};

const getBucket = async (region) => {
  if (!bucketPromise) {
    bucketPromise = getOrCreateBucket({region, enableFolderExpiry: true}).catch(
      (error) => {
        bucketPromise = null;
        throw error;
      },
    );
  }
  return bucketPromise;
};

const getServeUrl = async ({region, siteName}, bucketName, onProgress) => {
  if (process.env.REMOTION_SERVE_URL) return process.env.REMOTION_SERVE_URL;
  if (!serveUrlPromise) {
    serveUrlPromise = (async () => {
      onProgress?.('Đang bundle và deploy Remotion site');
      const bundleDir = await bundle({
        entryPoint: path.join(PROJECT_ROOT, 'remotion', 'index.ts'),
        onProgress: () => undefined,
      });
      const deployed = await deploySiteFromBundle({
        bucketName,
        region,
        bundleDir,
        siteName,
        privacy: 'public',
      });
      return deployed.serveUrl;
    })().catch((error) => {
      serveUrlPromise = null;
      throw error;
    });
  }
  return serveUrlPromise;
};

const contentTypeFor = (filePath) => {
  const extension = path.extname(filePath).toLowerCase();
  return {
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.m4v': 'video/x-m4v',
    '.webm': 'video/webm',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
  }[extension] || 'application/octet-stream';
};

const safeName = (filePath) =>
  path.basename(filePath).replace(/[^a-zA-Z0-9._-]+/g, '-');

const uploadAndPresign = async ({filePath, bucketName, region}) => {
  const stat = await fs.stat(filePath);
  const objectKey = `prayer-media/${stat.size}-${Math.round(stat.mtimeMs)}/${safeName(filePath)}`;
  const cacheKey = `${bucketName}:${objectKey}`;
  if (!uploadedUrlPromises.has(cacheKey)) {
    uploadedUrlPromises.set(
      cacheKey,
      (async () => {
        const client = new S3Client({region, credentials: awsCredentials()});
        let exists = true;
        try {
          await client.send(new HeadObjectCommand({Bucket: bucketName, Key: objectKey}));
        } catch (error) {
          if (error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404) {
            exists = false;
          } else {
            throw error;
          }
        }
        if (!exists) {
          const upload = new Upload({
            client,
            params: {
              Bucket: bucketName,
              Key: objectKey,
              Body: createReadStream(filePath),
              ContentType: contentTypeFor(filePath),
            },
            queueSize: 3,
            leavePartsOnError: false,
          });
          await upload.done();
        }
        return getSignedUrl(
          client,
          new GetObjectCommand({Bucket: bucketName, Key: objectKey}),
          {expiresIn: 60 * 60 * 12},
        );
      })().catch((error) => {
        uploadedUrlPromises.delete(cacheKey);
        throw error;
      }),
    );
  }
  return uploadedUrlPromises.get(cacheKey);
};

const RENDERS_DIR = path.join(PROJECT_ROOT, 'renders');

const downloadS3Object = async ({bucketName, objectKey, region, destPath}) => {
  const client = new S3Client({region, credentials: awsCredentials()});
  const result = await client.send(
    new GetObjectCommand({Bucket: bucketName, Key: objectKey}),
  );
  await pipeline(result.Body, createWriteStream(destPath));
};

// Xoá toàn bộ metadata (bỏ tag "Made with Remotion"), gắn creation_time, +faststart.
// Remux copy stream nên KHÔNG re-encode, không giảm chất lượng. Giống clean_metadata.py.
const cleanMetadata = (inputPath, outputPath) =>
  new Promise((resolve, reject) => {
    const when = new Date().toISOString().slice(0, 19);
    const child = spawn(
      'ffmpeg',
      [
        '-y', '-i', inputPath,
        '-map_metadata', '-1',
        '-metadata', `creation_time=${when}`,
        '-c', 'copy', '-movflags', '+faststart',
        outputPath,
      ],
      {windowsHide: true},
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', (error) => reject(new Error(`Không chạy được ffmpeg: ${error.message}`)));
    child.on('close', (exitCode) =>
      exitCode === 0
        ? resolve()
        : reject(new Error(`ffmpeg lỗi ${exitCode}: ${stderr.slice(-500)}`)),
    );
  });

const setLambdaLanguage = (jobId, code, patch) => {
  mutateJob(jobId, (job) => {
    job.languages[code] = {...job.languages[code], ...patch};
    const values = Object.values(job.languages);
    job.progress =
      values.reduce((sum, item) => sum + (item.progress || 0), 0) / values.length;
  });
};

const renderLanguageOnLambda = async ({
  jobId,
  workflowId,
  code,
  options,
  baseUrl,
}) => {
  try {
    const workflow = getJob(workflowId);
    const language = workflow?.languages?.[code];
    if (!workflow || !language) throw new Error(`Không tìm thấy workflow ${workflowId}.`);
    if (!language.assets?.audioPath || !language.assets?.srtPath) {
      throw new Error('Hãy upload cả MP3 và SRT trước khi render.');
    }

    setLambdaLanguage(jobId, code, {
      stage: 'planning',
      progress: 0.03,
      message: 'Đang tạo timeline Remotion',
    });
    const plan = await buildMediaPlan({
      ...options,
      audioPath: language.assets.audioPath,
      srtPath: language.assets.srtPath,
      seed: `${options.seed || 'prayer-studio'}-${code}`,
      previewSeconds: null,
      introText: options.introTexts?.[code] ?? options.introText ?? '',
      baseUrl,
    });

    const config = lambdaConfig();
    const {bucketName} = await getBucket(config.region);
    const serveUrl = await getServeUrl(config, bucketName, (message) =>
      setLambdaLanguage(jobId, code, {message}),
    );

    setLambdaLanguage(jobId, code, {
      stage: 'uploading-media',
      progress: 0.08,
      message: `Đang đồng bộ ${plan.selectedVideos.length} video và ảnh lên S3`,
    });
    const mediaPaths = [
      language.assets.audioPath,
      ...plan.selectedVideos,
      ...plan.selectedImages,
      ...(plan.musicPath ? [plan.musicPath] : []),
    ];
    const uniquePaths = [...new Set(mediaPaths)];
    const pairs = await Promise.all(
      uniquePaths.map(async (filePath) => [
        filePath,
        await limitUpload(() =>
          uploadAndPresign({filePath, bucketName, region: config.region}),
        ),
      ]),
    );
    const urlByPath = Object.fromEntries(pairs);
    const {musicPath: _localMusicPath, ...planForRender} = plan;
    const inputProps = {
      ...planForRender,
      audioSrc: urlByPath[language.assets.audioPath],
      musicSrc: plan.musicPath ? urlByPath[plan.musicPath] : null,
      clips: plan.clips.map((clip) => ({
        ...clip,
        src: urlByPath[clip.sourcePath],
      })),
      selectedVideos: plan.selectedVideos.map((item) => path.basename(item)),
      selectedImages: plan.selectedImages.map((item) => path.basename(item)),
    };

    setLambdaLanguage(jobId, code, {
      stage: 'starting-lambda',
      progress: 0.18,
      message: 'Đang khởi chạy Remotion Lambda',
    });
    const outName = `renders/${workflowId}/${code}-${Date.now()}.mp4`;
    const concurrency = Number(process.env.REMOTION_CONCURRENCY || 200);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 200) {
      throw new Error('REMOTION_CONCURRENCY phải là số nguyên từ 1 đến 200.');
    }
    const started = await renderMediaOnLambda({
      region: config.region,
      functionName: config.functionName,
      ...(config.rendererFunctionName
        ? {rendererFunctionName: config.rendererFunctionName}
        : {}),
      serveUrl,
      composition: 'PrayerVideo',
      codec: 'h264',
      audioCodec: 'aac',
      inputProps,
      privacy: 'private',
      outName,
      crf: 20,
      x264Preset: 'veryfast',
      maxRetries: 2,
      concurrency,
      metadata: {workflowId, language: code},
    });

    setLambdaLanguage(jobId, code, {
      stage: 'rendering',
      progress: 0.2,
      message: 'Lambda đang render',
      renderId: started.renderId,
      bucketName: started.bucketName,
    });

    while (true) {
      const progress = await getRenderProgress({
        region: config.region,
        functionName: config.functionName,
        renderId: started.renderId,
        bucketName: started.bucketName,
      });
      if (progress.fatalErrorEncountered || progress.errors.length > 0) {
        const firstError = progress.errors[0];
        throw new Error(firstError?.message || 'Remotion Lambda render thất bại.');
      }
      setLambdaLanguage(jobId, code, {
        stage: 'rendering',
        progress: 0.2 + progress.overallProgress * 0.8,
        message: `Lambda đang render ${Math.round(progress.overallProgress * 100)}%`,
      });
      if (progress.done) {
        if (!progress.outKey) throw new Error('Lambda hoàn tất nhưng không trả về output key.');
        const outputBucket = progress.outBucket || started.bucketName;
        setLambdaLanguage(jobId, code, {
          stage: 'rendering',
          progress: 0.98,
          message: 'Đang tải video về và xoá metadata',
        });

        await fs.mkdir(RENDERS_DIR, {recursive: true});
        const cleanName = `${code}-${workflowId}-${Date.now()}.mp4`;
        const rawPath = path.join(RENDERS_DIR, `raw-${cleanName}`);
        const cleanPath = path.join(RENDERS_DIR, cleanName);
        let downloadUrl;
        let outputSizeInBytes = progress.outputSizeInBytes;
        try {
          await downloadS3Object({
            bucketName: outputBucket,
            objectKey: progress.outKey,
            region: config.region,
            destPath: rawPath,
          });
          await cleanMetadata(rawPath, cleanPath);
          await fs.unlink(rawPath).catch(() => undefined);
          outputSizeInBytes = (await fs.stat(cleanPath)).size;
          downloadUrl = `${baseUrl}/api/renders/${encodeURIComponent(cleanName)}`;
        } catch (cleanError) {
          appendJobLog(
            jobId,
            `[${code}] Xoá metadata thất bại (${cleanError.message}); dùng link S3 gốc.`,
          );
          await fs.unlink(rawPath).catch(() => undefined);
          downloadUrl = await presignUrl({
            region: config.region,
            bucketName: outputBucket,
            objectKey: progress.outKey,
            expiresInSeconds: 60 * 60 * 24 * 7,
          });
        }

        setLambdaLanguage(jobId, code, {
          stage: 'completed',
          progress: 1,
          message: 'Video đã sẵn sàng (đã xoá metadata)',
          downloadUrl,
          outputSizeInBytes,
          outputFile: progress.outputFile,
        });
        return;
      }
      await sleep(2500);
    }
  } catch (error) {
    appendJobLog(jobId, `[${code}] ${error.stack || error.message}`);
    setLambdaLanguage(jobId, code, {
      stage: 'failed',
      progress: 1,
      message: error.message,
      error: error.message,
    });
  }
};

export const runParallelLambdaRenderJob = async ({
  jobId,
  workflowId,
  languages,
  options,
  baseUrl,
}) => {
  updateJob(jobId, {
    status: 'running',
    message: `Đang render song song ${languages.length} ngôn ngữ`,
  });
  await Promise.all(
    languages.map((code) =>
      renderLanguageOnLambda({jobId, workflowId, code, options, baseUrl}),
    ),
  );
  const job = getJob(jobId);
  const completed = Object.values(job.languages).filter(
    (item) => item.stage === 'completed',
  ).length;
  updateJob(jobId, {
    status: 'completed',
    progress: 1,
    message: `Hoàn tất ${completed}/${languages.length} video`,
  });
};
