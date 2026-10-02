import path from 'node:path';
import {BatchClient, DescribeJobsCommand, SubmitJobCommand} from '@aws-sdk/client-batch';
import {buildMediaPlan} from './media-plan.mjs';
import {appendJobLog, getJob, mutateJob, updateJob} from './job-store.mjs';
import {
  awsCredentials,
  getJson,
  headObject,
  presignObject,
  putJson,
  uploadFileCached,
} from './aws-storage.mjs';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const mapWithConcurrency = async (items, concurrency, mapper) => {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({length: Math.min(concurrency, items.length)}, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
};

export const batchConfig = () => {
  const region = process.env.AWS_BATCH_REGION || process.env.REMOTION_AWS_REGION || 'ap-southeast-1';
  return {
    region,
    bucketName: process.env.AWS_BATCH_BUCKET?.trim(),
    jobQueue: process.env.AWS_BATCH_JOB_QUEUE?.trim(),
    jobDefinition: process.env.AWS_BATCH_JOB_DEFINITION?.trim(),
    pollMs: Math.max(3000, Number(process.env.AWS_BATCH_POLL_MS || 10000)),
    crf: Number(process.env.FFMPEG_CRF || 20),
    preset: process.env.FFMPEG_PRESET || 'veryfast',
  };
};

export const isBatchConfigured = () => {
  const config = batchConfig();
  return Boolean(config.bucketName && config.jobQueue && config.jobDefinition);
};

const setLanguage = (jobId, code, patch) => {
  mutateJob(jobId, (job) => {
    job.languages[code] = {...job.languages[code], ...patch};
    const values = Object.values(job.languages);
    job.progress = values.reduce((sum, item) => sum + (item.progress || 0), 0) / values.length;
  });
};

const uploadPlanMedia = async ({plan, audioPath, config, onProgress}) => {
  const paths = [
    audioPath,
    ...plan.clips.map((clip) => clip.sourcePath),
    ...(plan.musicPath ? [plan.musicPath] : []),
  ];
  const uniquePaths = [...new Set(paths)];
  const keyByPath = {};
  let completed = 0;
  const pairs = await mapWithConcurrency(uniquePaths, 3, async (filePath) => {
    const objectKey = await uploadFileCached({
      filePath,
      bucketName: config.bucketName,
      region: config.region,
    });
    completed += 1;
    onProgress?.(completed / uniquePaths.length);
    return [filePath, objectKey];
  });
  Object.assign(keyByPath, Object.fromEntries(pairs));
  return keyByPath;
};

const buildWorkerPlan = ({plan, keyByPath, audioPath, outputKey, statusKey, config}) => ({
  version: 1,
  fps: plan.fps,
  width: 1920,
  height: 1080,
  durationInFrames: plan.durationInFrames,
  renderedDurationSeconds: plan.renderedDurationSeconds,
  introSeconds: plan.introSeconds,
  introText: plan.introText,
  musicIntroVolume: plan.musicIntroVolume,
  captions: plan.captions,
  audioKey: keyByPath[audioPath],
  musicKey: plan.musicPath ? keyByPath[plan.musicPath] : null,
  clips: plan.clips.map((clip) => ({
    id: clip.id,
    type: clip.type,
    objectKey: keyByPath[clip.sourcePath],
    durationInFrames: clip.durationInFrames,
    trimBefore: clip.trimBefore,
  })),
  outputKey,
  statusKey,
  crf: config.crf,
  preset: config.preset,
});

const readWorkerProgress = async ({config, statusKey}) => {
  try {
    return await getJson({
      bucketName: config.bucketName,
      objectKey: statusKey,
      region: config.region,
    });
  } catch (error) {
    if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
};

const renderLanguage = async ({jobId, workflowId, code, options, baseUrl}) => {
  const workflow = getJob(workflowId);
  const language = workflow?.languages?.[code];
  if (!workflow || !language) throw new Error(`Không tìm thấy workflow ${workflowId}.`);
  if (!language.assets?.audioPath || !language.assets?.srtPath) {
    throw new Error(`${code}: hãy upload cả MP3 và SRT trước khi render.`);
  }

  const config = batchConfig();
  if (!isBatchConfigured()) {
    throw new Error('Thiếu AWS_BATCH_BUCKET, AWS_BATCH_JOB_QUEUE hoặc AWS_BATCH_JOB_DEFINITION.');
  }
  const client = new BatchClient({region: config.region, credentials: awsCredentials()});

  setLanguage(jobId, code, {stage: 'planning', progress: 0.02, message: 'Đang tạo timeline FFmpeg'});
  const plan = await buildMediaPlan({
    ...options,
    audioPath: language.assets.audioPath,
    srtPath: language.assets.srtPath,
    seed: `${options.seed || 'prayer-studio'}-${code}`,
    previewSeconds: null,
    introText: options.introTexts?.[code] ?? options.introText ?? '',
    baseUrl,
  });

  setLanguage(jobId, code, {
    stage: 'uploading-media',
    progress: 0.05,
    message: `Đang đồng bộ ${new Set(plan.clips.map((clip) => clip.sourcePath)).size} media lên S3`,
  });
  const keyByPath = await uploadPlanMedia({
    plan,
    audioPath: language.assets.audioPath,
    config,
    onProgress: (value) => setLanguage(jobId, code, {
      progress: 0.05 + value * 0.15,
      message: `Đang đồng bộ media ${Math.round(value * 100)}%`,
    }),
  });

  const stamp = Date.now();
  const prefix = `batch-jobs/${workflowId}/${code}/${stamp}`;
  const planKey = `${prefix}/plan.json`;
  const statusKey = `${prefix}/status.json`;
  const outputKey = `batch-renders/${workflowId}/${code}-${stamp}.mp4`;
  await putJson({
    bucketName: config.bucketName,
    objectKey: planKey,
    region: config.region,
    value: buildWorkerPlan({
      plan,
      keyByPath,
      audioPath: language.assets.audioPath,
      outputKey,
      statusKey,
      config,
    }),
  });

  setLanguage(jobId, code, {stage: 'starting-batch', progress: 0.21, message: 'Đang khởi chạy AWS Batch Spot worker'});
  const submitted = await client.send(new SubmitJobCommand({
    jobName: `prayer-${code}-${stamp}`.slice(0, 128),
    jobQueue: config.jobQueue,
    jobDefinition: config.jobDefinition,
    containerOverrides: {
      environment: [
        {name: 'AWS_REGION', value: config.region},
        {name: 'PLAN_BUCKET', value: config.bucketName},
        {name: 'PLAN_KEY', value: planKey},
      ],
    },
    timeout: {attemptDurationSeconds: Number(process.env.AWS_BATCH_TIMEOUT_SECONDS || 7200)},
    retryStrategy: {attempts: Number(process.env.AWS_BATCH_RETRY_ATTEMPTS || 2)},
    tags: {application: 'prayer-studio', workflowId, language: code},
  }));
  if (!submitted.jobId) throw new Error('AWS Batch không trả về jobId.');
  appendJobLog(jobId, `[${code}] AWS Batch job ${submitted.jobId}`);
  setLanguage(jobId, code, {
    stage: 'batch-queued',
    progress: 0.23,
    message: 'AWS Batch đang cấp EC2 Spot',
    batchJobId: submitted.jobId,
  });

  while (true) {
    const described = await client.send(new DescribeJobsCommand({jobs: [submitted.jobId]}));
    const remote = described.jobs?.[0];
    if (!remote) throw new Error(`Không đọc được AWS Batch job ${submitted.jobId}.`);
    if (remote.status === 'FAILED') {
      throw new Error(remote.statusReason || remote.container?.reason || 'AWS Batch render thất bại.');
    }

    const workerStatus = await readWorkerProgress({config, statusKey});
    if (remote.status === 'RUNNING') {
      const workerProgress = Math.max(0, Math.min(1, Number(workerStatus?.progress || 0)));
      const renderStartedAt = getJob(jobId)?.languages?.[code]?.renderStartedAt || new Date().toISOString();
      setLanguage(jobId, code, {
        stage: 'rendering',
        progress: 0.25 + workerProgress * 0.72,
        message: workerStatus?.message || `FFmpeg đang render ${Math.round(workerProgress * 100)}%`,
        renderStartedAt,
      });
    } else if (remote.status !== 'SUCCEEDED') {
      setLanguage(jobId, code, {
        stage: 'batch-queued',
        progress: 0.23,
        message: `AWS Batch: ${remote.status}`,
      });
    }

    if (remote.status === 'SUCCEEDED') {
      const object = await headObject({
        bucketName: config.bucketName,
        objectKey: outputKey,
        region: config.region,
      });
      const downloadUrl = await presignObject({
        bucketName: config.bucketName,
        objectKey: outputKey,
        region: config.region,
      });
      setLanguage(jobId, code, {
        stage: 'completed',
        progress: 1,
        message: 'Video FFmpeg đã sẵn sàng (metadata đã làm sạch)',
        renderFinishedAt: new Date().toISOString(),
        downloadUrl,
        outputSizeInBytes: object.ContentLength,
        outputKey,
      });
      return;
    }
    await sleep(config.pollMs);
  }
};

export const runParallelBatchRenderJob = async ({jobId, workflowId, languages, options, baseUrl}) => {
  const maxParallelWorkers = 5;
  updateJob(jobId, {status: 'running', message: `AWS Batch tối đa ${maxParallelWorkers} worker: 0/${languages.length} video`});
  let completed = 0;
  await mapWithConcurrency(languages, maxParallelWorkers, async (code) => {
    try {
      await renderLanguage({jobId, workflowId, code, options, baseUrl});
      completed += 1;
      updateJob(jobId, {message: `AWS Batch tối đa ${maxParallelWorkers} worker: ${completed}/${languages.length} video`});
    } catch (error) {
      appendJobLog(jobId, `[${code}] ${error.stack || error.message}`);
      const current = getJob(jobId)?.languages?.[code];
      setLanguage(jobId, code, {
        stage: 'failed',
        progress: 1,
        message: error.message,
        error: error.message,
        ...(current?.renderStartedAt ? {renderFinishedAt: new Date().toISOString()} : {}),
      });
    }
  });
  updateJob(jobId, {
    status: completed === languages.length ? 'completed' : completed ? 'completed' : 'failed',
    progress: 1,
    message: `Hoàn tất ${completed}/${languages.length} video bằng tối đa ${maxParallelWorkers} AWS Batch worker`,
    ...(completed ? {} : {error: 'Tất cả AWS Batch render đều thất bại.'}),
  });
};
