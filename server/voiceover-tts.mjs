import fs from 'node:fs/promises';
import path from 'node:path';
import {LANGUAGE_DEFINITIONS} from './constants.mjs';
import {createTts, downloadToFile, waitForTask} from './ai33.mjs';
import {mapWithConcurrency} from './concurrency.mjs';
import {appendJobLog, getJob, listJobs, mutateJob} from './job-store.mjs';
import {probeDuration} from './media-plan.mjs';
import {prepVoiceover} from './voiceover-prep.mjs';
import {buildConcatArgs, mergeSrtParts, runFfmpeg} from './voiceover-merge.mjs';

const PART_ATTEMPTS = 3;

const setVoiceover = (jobId, code, patch) => {
  mutateJob(jobId, (job) => {
    const lane = job.languages[code];
    lane.voiceover = {...lane.voiceover, ...patch};
  });
};

export const synthesizeToFile = async ({text, voiceId, speed, audioPath, srtPath}) => {
  const taskId = await createTts({text, voiceId, speed, withTranscript: Boolean(srtPath)});
  const task = await waitForTask(taskId);
  const audioUrl = task.metadata?.audio_url;
  if (!audioUrl) throw new Error('ai33 không trả về audio_url.');
  await downloadToFile(audioUrl, audioPath);
  if (srtPath) {
    const srtUrl = task.metadata?.srt_url;
    if (!srtUrl) throw new Error('ai33 không trả về srt_url (with_transcript).');
    await downloadToFile(srtUrl, srtPath);
  }
  return task;
};

const synthesizePart = async ({jobId, label, index, text, voice, directory}) => {
  const name = `part-${String(index + 1).padStart(3, '0')}`;
  const audioPath = path.join(directory, `${name}.mp3`);
  const srtPath = path.join(directory, `${name}.srt`);
  for (let attempt = 1; ; attempt += 1) {
    try {
      await synthesizeToFile({text, voiceId: voice.voiceId, speed: voice.speed, audioPath, srtPath});
      return {audioPath, srtPath};
    } catch (error) {
      appendJobLog(jobId, `[${label}] Phần ${index + 1} lần ${attempt}: ${error.message}`);
      if (attempt >= PART_ATTEMPTS) throw new Error(`Phần ${index + 1}: ${error.message}`);
    }
  }
};

export const isVoiceoverRunning = (jobId, code) =>
  getJob(jobId)?.languages?.[code]?.voiceover?.status === 'running';

export const runVoiceoverGeneration = async ({jobId, code, voice, gapSeconds, maxChars, outputRoot}) => {
  const label = LANGUAGE_DEFINITIONS[code]?.label || code;
  const startedAt = new Date().toISOString();
  setVoiceover(jobId, code, {
    status: 'running',
    progress: 0,
    completedParts: 0,
    totalParts: 0,
    message: 'Đang chia phần kịch bản',
    voice: {key: voice.key, name: voice.name, voiceId: voice.voiceId, speed: voice.speed},
    gapSeconds,
    maxChars,
    startedAt,
    finishedAt: null,
    error: null,
  });
  try {
    const lane = getJob(jobId)?.languages?.[code];
    if (!lane?.outputPath) throw new Error('Kịch bản chưa sẵn sàng.');
    const parts = prepVoiceover(await fs.readFile(lane.outputPath, 'utf8'), maxChars);
    if (!parts.length) throw new Error('Kịch bản rỗng.');

    const directory = path.join(outputRoot, 'ai33', jobId, code, startedAt.replace(/[:.]/g, '-'));
    await fs.mkdir(directory, {recursive: true});
    let completedParts = 0;
    setVoiceover(jobId, code, {totalParts: parts.length, message: `ai33 đang tạo giọng 0/${parts.length} phần`});

    const concurrency = Math.max(1, Number(process.env.AI33_CONCURRENCY || 3));
    const results = await mapWithConcurrency(parts, concurrency, async (text, index) => {
      const result = await synthesizePart({jobId, label, index, text, voice, directory});
      completedParts += 1;
      setVoiceover(jobId, code, {
        completedParts,
        progress: (completedParts / parts.length) * 0.9,
        message: `ai33 đang tạo giọng ${completedParts}/${parts.length} phần`,
      });
      return result;
    });

    setVoiceover(jobId, code, {message: 'Đang ghép MP3 và SRT'});
    const durations = await Promise.all(results.map((result) => probeDuration(result.audioPath)));
    const srtTexts = await Promise.all(results.map((result) => fs.readFile(result.srtPath, 'utf8')));
    const srtPath = path.join(directory, 'voiceover.srt');
    const audioPath = path.join(directory, 'voiceover.mp3');
    await fs.writeFile(
      srtPath,
      mergeSrtParts(
        srtTexts.map((srtText, index) => ({srtText, durationSec: durations[index]})),
        gapSeconds,
      ),
    );
    await runFfmpeg(
      buildConcatArgs(
        results.map((result, index) => ({path: result.audioPath, durationSec: durations[index]})),
        gapSeconds,
        audioPath,
      ),
    );
    const durationSeconds = await probeDuration(audioPath);

    setVoiceover(jobId, code, {
      status: 'done',
      progress: 1,
      message: `Voiceover sẵn sàng · ${parts.length} phần`,
      audioPath,
      srtPath,
      audioName: `${code}-voiceover.mp3`,
      srtName: `${code}-voiceover.srt`,
      durationSeconds,
      finishedAt: new Date().toISOString(),
    });
  } catch (error) {
    appendJobLog(jobId, `[${label}] Voiceover lỗi: ${error.stack || error.message}`);
    setVoiceover(jobId, code, {
      status: 'failed',
      message: error.message,
      error: error.message,
      finishedAt: new Date().toISOString(),
    });
  }
};

// Job đang chạy dở khi server tắt sẽ không bao giờ hoàn tất → đánh dấu lỗi.
export const failInterruptedVoiceovers = () => {
  for (const job of listJobs({type: 'prayer-workflow'})) {
    for (const [code, lane] of Object.entries(job.languages || {})) {
      if (lane?.voiceover?.status === 'running') {
        setVoiceover(job.id, code, {
          status: 'failed',
          message: 'Server khởi động lại khi đang tạo voiceover, hãy tạo lại.',
          error: 'interrupted',
        });
      }
    }
  }
};
