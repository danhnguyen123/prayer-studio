import fs from 'node:fs/promises';
import path from 'node:path';
import {LANGUAGE_DEFINITIONS, PROJECT_ROOT} from './constants.mjs';
import {extractResponseText} from './kie.mjs';

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const TERMINAL_BATCH_STATUSES = new Set(['completed', 'failed', 'expired', 'cancelled']);

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export const getOpenAIApiKey = async () => {
  if (process.env.OPENAI_API_KEY?.trim()) return process.env.OPENAI_API_KEY.trim();
  const keyFile = process.env.OPENAI_API_FILE || 'API_OPENAI.txt';
  const content = await fs.readFile(path.resolve(PROJECT_ROOT, keyFile), 'utf8').catch(() => '');
  const key = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#'));
  if (!key) {
    throw new Error('Thiếu OPENAI_API_KEY hoặc API_OPENAI.txt trong backend.');
  }
  return key;
};

export const buildTranslationPrompt = (koreanScript, languageCode) => {
  const language = LANGUAGE_DEFINITIONS[languageCode];
  if (!language) throw new Error(`Ngôn ngữ không hỗ trợ: ${languageCode}`);
  return [
    `Translate the complete Korean Catholic prayer script below into ${language.targetName}.`,
    'Preserve every idea, paragraph rhythm, Bible reference, prayer tone, and line break.',
    `Use natural Catholic terminology for ${language.label} speakers.`,
    'Do not rewrite, summarize, omit, expand, explain, or wrap the result in Markdown.',
    'Return only the complete translated prayer script.',
    '',
    'KOREAN SCRIPT:',
    koreanScript,
  ].join('\n');
};

export const buildOpenAITranslationBody = (koreanScript, languageCode) => ({
  model: process.env.OPENAI_MODEL || 'gpt-5.6-terra',
  input: [
    {
      role: 'user',
      content: [{type: 'input_text', text: buildTranslationPrompt(koreanScript, languageCode)}],
    },
  ],
  reasoning: {effort: process.env.OPENAI_REASONING_EFFORT || 'medium'},
  max_output_tokens: 32768,
  store: false,
});

const requestOpenAI = async (pathName, options = {}) => {
  const apiKey = await getOpenAIApiKey();
  const baseUrl = (process.env.OPENAI_BASE_URL || OPENAI_BASE_URL).replace(/\/$/, '');
  const response = await fetch(`${baseUrl}${pathName}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(options.body instanceof FormData ? {} : {'Content-Type': 'application/json'}),
      ...options.headers,
    },
    signal: options.signal || AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI API ${response.status}: ${body.slice(0, 800)}`);
  }
  return response;
};

const sourceResult = (koreanScript, languageCode) => ({
  provider: 'source',
  model: 'korean-source',
  reasoningEffort: null,
  processingMode: 'standard',
  languageCode,
  translation: koreanScript.trim(),
  usage: null,
});

const responseResult = (payload, languageCode, extras = {}) => {
  const text = extractResponseText(payload);
  if (!text) {
    throw new Error(
      `OpenAI không trả về output_text (status: ${payload?.status || 'unknown'}).`,
    );
  }
  return {
    provider: 'openai',
    model: process.env.OPENAI_MODEL || 'gpt-5.6-terra',
    reasoningEffort: process.env.OPENAI_REASONING_EFFORT || 'medium',
    languageCode,
    translation: text.replace(/^```(?:\w+)?\s*/i, '').replace(/\s*```$/i, ''),
    usage: payload?.usage || null,
    ...extras,
  };
};

export const translatePrayerScriptOpenAI = async (koreanScript, languageCode) => {
  if (languageCode === 'korea') return sourceResult(koreanScript, languageCode);
  const response = await requestOpenAI('/responses', {
    method: 'POST',
    body: JSON.stringify(buildOpenAITranslationBody(koreanScript, languageCode)),
  });
  return responseResult(await response.json(), languageCode, {processingMode: 'standard'});
};

const uploadBatchFile = async (lines) => {
  const form = new FormData();
  form.append('purpose', 'batch');
  form.append('file', new Blob([`${lines.join('\n')}\n`], {type: 'application/jsonl'}), 'prayer-translations.jsonl');
  const response = await requestOpenAI('/files', {method: 'POST', body: form});
  return response.json();
};

const createBatch = async (inputFileId) => {
  const response = await requestOpenAI('/batches', {
    method: 'POST',
    body: JSON.stringify({
      input_file_id: inputFileId,
      endpoint: '/v1/responses',
      completion_window: '24h',
      metadata: {workflow: 'prayer-translation'},
    }),
  });
  return response.json();
};

const waitForBatch = async (batchId, onProgress) => {
  const pollMilliseconds = Math.max(1000, Number(process.env.OPENAI_BATCH_POLL_MS || 10000));
  for (;;) {
    const response = await requestOpenAI(`/batches/${encodeURIComponent(batchId)}`, {method: 'GET'});
    const batch = await response.json();
    onProgress?.(batch);
    if (TERMINAL_BATCH_STATUSES.has(batch.status)) return batch;
    await delay(pollMilliseconds);
  }
};

const readBatchOutput = async (fileId) => {
  const response = await requestOpenAI(`/files/${encodeURIComponent(fileId)}/content`, {method: 'GET'});
  const content = await response.text();
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};

export const translatePrayerScriptsOpenAIBatch = async (
  koreanScript,
  languageCodes,
  {onCreated, onProgress} = {},
) => {
  const uniqueCodes = [...new Set(languageCodes)];
  const results = {};
  const apiCodes = uniqueCodes.filter((code) => code !== 'korea');
  if (uniqueCodes.includes('korea')) results.korea = sourceResult(koreanScript, 'korea');
  if (!apiCodes.length) return results;

  const lines = apiCodes.map((code) =>
    JSON.stringify({
      custom_id: `translation:${code}`,
      method: 'POST',
      url: '/v1/responses',
      body: buildOpenAITranslationBody(koreanScript, code),
    }),
  );
  const inputFile = await uploadBatchFile(lines);
  const created = await createBatch(inputFile.id);
  onCreated?.(created);
  const batch = await waitForBatch(created.id, onProgress);
  if (batch.status !== 'completed' || !batch.output_file_id) {
    throw new Error(
      `OpenAI Batch ${batch.id} kết thúc với trạng thái ${batch.status}: ${batch.errors?.data?.[0]?.message || 'không có output file'}`,
    );
  }

  const outputLines = await readBatchOutput(batch.output_file_id);
  for (const item of outputLines) {
    const code = String(item.custom_id || '').replace(/^translation:/, '');
    if (!apiCodes.includes(code)) continue;
    if (item.error || item.response?.status_code >= 400) {
      throw new Error(
        `${LANGUAGE_DEFINITIONS[code].label}: OpenAI Batch lỗi ${JSON.stringify(item.error || item.response?.body?.error || {})}`,
      );
    }
    results[code] = responseResult(item.response?.body, code, {
      processingMode: 'batch',
      batchId: batch.id,
    });
  }
  const missing = apiCodes.filter((code) => !results[code]);
  if (missing.length) throw new Error(`OpenAI Batch thiếu kết quả: ${missing.join(', ')}`);
  return results;
};

