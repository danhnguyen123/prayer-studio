import fs from 'node:fs/promises';
import {createWriteStream, readFileSync} from 'node:fs';
import path from 'node:path';
import {Readable} from 'node:stream';
import {pipeline as streamPipeline} from 'node:stream/promises';
import {PROJECT_ROOT} from './constants.mjs';

const AI33_BASE_URL = (process.env.AI33_BASE_URL || 'https://api.ai33.pro').replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = 2 * 60 * 1000;

export const VOICE_ID_PREFIXES = [
  'elevenlabs_',
  'minimax_',
  'clone_',
  'edge_',
  'kokoro_',
  'vbee_',
  'fishaudio_',
];

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export const validateVoiceId = (value) => {
  const voiceId = String(value || '').trim();
  if (!voiceId) throw new Error('Voice ID không được để trống.');
  if (!VOICE_ID_PREFIXES.some((prefix) => voiceId.startsWith(prefix) && voiceId.length > prefix.length)) {
    throw new Error(`Voice ID phải có prefix: ${VOICE_ID_PREFIXES.join(', ')}`);
  }
  return voiceId;
};

export const validateSpeed = (value) => {
  const speed = Number(value);
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 1.5) {
    throw new Error('Speed phải nằm trong khoảng 0.5 – 1.5.');
  }
  return Math.round(speed * 100) / 100;
};

const readKeyFile = (keyFile) => {
  try {
    return readFileSync(path.resolve(PROJECT_ROOT, keyFile), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('#')) || '';
  } catch {
    return '';
  }
};

const resolveApiKey = () =>
  process.env.AI33_API_KEY?.trim() || readKeyFile(process.env.AI33_API_FILE || 'API_AI33.txt');

export const hasAi33ApiKey = () => Boolean(resolveApiKey());

export const getAi33ApiKey = () => {
  const key = resolveApiKey();
  if (!key) throw new Error('Thiếu AI33_API_KEY hoặc API_AI33.txt trong backend.');
  return key;
};

const ai33Fetch = async (pathname, options = {}) => {
  const response = await fetch(`${AI33_BASE_URL}${pathname}`, {
    ...options,
    headers: {'xi-api-key': getAi33ApiKey(), ...options.headers},
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const raw = await response.text();
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`ai33 HTTP ${response.status}: ${raw.slice(0, 300)}`);
  }
  if (!response.ok || payload.success === false) {
    const detail = payload.error || payload.message || payload.detail || raw.slice(0, 300);
    throw new Error(`ai33 HTTP ${response.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }
  return payload;
};

export const createTts = async ({text, voiceId, speed = 1, withTranscript = false, fileName}) => {
  const form = new FormData();
  form.append('text', text);
  form.append('voice_id', voiceId);
  form.append('speed', String(speed));
  form.append('with_transcript', withTranscript ? 'true' : 'false');
  if (fileName) form.append('file_name', fileName);
  const payload = await ai33Fetch('/v3/text-to-speech', {method: 'POST', body: form});
  if (!payload.task_id) throw new Error('ai33 không trả về task_id.');
  return payload.task_id;
};

export const getTask = (taskId) => ai33Fetch(`/v1/task/${encodeURIComponent(taskId)}`);

export const waitForTask = async (
  taskId,
  {
    intervalMs = Number(process.env.AI33_POLL_MS || 3000),
    timeoutMs = 10 * 60 * 1000,
    onProgress,
  } = {},
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await getTask(taskId);
    if (task.status === 'done') return task;
    if (task.status === 'error') {
      throw new Error(`ai33 task lỗi: ${task.error_message || 'không rõ nguyên nhân'}`);
    }
    onProgress?.(task);
    await delay(intervalMs);
  }
  throw new Error(`ai33 task ${taskId} quá thời gian chờ.`);
};

export const downloadToFile = async (url, destination) => {
  const response = await fetch(url, {signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)});
  if (!response.ok || !response.body) {
    throw new Error(`Không tải được ${url}: HTTP ${response.status}`);
  }
  await fs.mkdir(path.dirname(destination), {recursive: true});
  await streamPipeline(Readable.fromWeb(response.body), createWriteStream(destination));
  return destination;
};

// Tra Voice Library của ai33 để xác nhận voice ID tồn tại và lấy tên hiển thị.
export const lookupVoice = async (value) => {
  const voiceId = validateVoiceId(value);
  const provider = VOICE_ID_PREFIXES.find((prefix) => voiceId.startsWith(prefix)).slice(0, -1);
  const query = new URLSearchParams({provider, search: voiceId, page_size: '100'});
  const payload = await ai33Fetch(`/v3/voices?${query}`);
  const voice = (payload.data || []).find((item) => item.voice_id === voiceId);
  if (!voice) throw new Error(`Không tìm thấy voice ID "${voiceId}" trên ai33.`);
  return {
    voiceId,
    name: String(voice.name || voiceId).trim(),
    language: voice.locale || voice.language || null,
    gender: voice.gender || null,
  };
};

export const getCredits = async () => {
  const payload = await ai33Fetch('/v1/credits');
  return Number(payload.credits);
};
