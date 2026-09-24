import fs from 'node:fs/promises';
import path from 'node:path';
import {bundle} from '@remotion/bundler';
import {renderMedia, selectComposition} from '@remotion/renderer';
import {PROJECT_ROOT} from './constants.mjs';
import {appendJobLog, updateJob} from './job-store.mjs';
import {buildMediaPlan} from './media-plan.mjs';

let bundlePromise = null;

const getBundle = () => {
  if (!bundlePromise) {
    bundlePromise = bundle({
      entryPoint: path.join(PROJECT_ROOT, 'remotion', 'index.ts'),
      onProgress: () => undefined,
    }).catch((error) => {
      bundlePromise = null;
      throw error;
    });
  }
  return bundlePromise;
};

const safeTimestamp = () => new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');

export const runRenderJob = async (jobId, options, baseUrl, registerMediaRoots) => {
  updateJob(jobId, {
    status: 'running',
    progress: 0.01,
    message: 'Đang phân tích voiceover và tạo timeline',
  });

  try {
    registerMediaRoots([
      options.videoDir,
      options.imageDir,
      path.dirname(options.audioPath),
      path.dirname(options.srtPath),
      options.musicPath && path.dirname(options.musicPath),
    ]);
    const inputProps = await buildMediaPlan({...options, baseUrl});
    appendJobLog(
      jobId,
      `Timeline: ${inputProps.clips.length} clip, ${inputProps.renderedDurationSeconds.toFixed(1)} giây`,
    );
    updateJob(jobId, {
      progress: 0.05,
      message: 'Đang bundle Remotion',
      planSummary: {
        clips: inputProps.clips.length,
        selectedVideos: inputProps.selectedVideos.length,
        durationSeconds: inputProps.renderedDurationSeconds,
      },
    });

    const serveUrl = await getBundle();
    const composition = await selectComposition({
      serveUrl,
      id: 'PrayerVideo',
      inputProps,
    });
    const outputDirectory = path.join(PROJECT_ROOT, 'renders');
    await fs.mkdir(outputDirectory, {recursive: true});
    const suffix = options.previewSeconds ? 'preview' : 'full';
    const outputLocation = path.join(
      outputDirectory,
      `prayer-${suffix}-${safeTimestamp()}.mp4`,
    );

    updateJob(jobId, {message: 'Đang render video'});
    await renderMedia({
      composition,
      serveUrl,
      codec: 'h264',
      crf: options.previewSeconds ? 28 : 20,
      outputLocation,
      inputProps,
      concurrency: options.previewSeconds ? 2 : undefined,
      scale: options.previewSeconds ? 0.5 : 1,
      onProgress: ({progress}) => {
        updateJob(jobId, {
          progress: 0.05 + progress * 0.95,
          message: `Đang render ${Math.round(progress * 100)}%`,
        });
      },
    });

    const stat = await fs.stat(outputLocation);
    updateJob(jobId, {
      status: 'completed',
      progress: 1,
      message: 'Render hoàn tất',
      result: {
        outputLocation,
        fileName: path.basename(outputLocation),
        sizeBytes: stat.size,
        durationSeconds: inputProps.renderedDurationSeconds,
      },
    });
  } catch (error) {
    appendJobLog(jobId, error.stack || error.message);
    updateJob(jobId, {
      status: 'failed',
      message: error.message,
      error: error.message,
    });
  }
};
