import fs from 'node:fs/promises';
import path from 'node:path';
import {LANGUAGE_DEFINITIONS, PROJECT_ROOT} from './constants.mjs';

const getApiKey = async () => {
  if (process.env.KIE_API_KEY?.trim()) return process.env.KIE_API_KEY.trim();
  const keyFile = process.env.KIE_API_FILE || 'API_KIE.txt';
  const content = await fs.readFile(path.resolve(PROJECT_ROOT, keyFile), 'utf8').catch(() => '');
  const key = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#'));
  if (!key) {
    throw new Error(
      'Thiếu KIE_API_KEY hoặc API_KIE.txt. Thêm Kie API token vào backend trước khi dịch.',
    );
  }
  return key;
};

export const extractResponseText = (payload) =>
  (payload?.output || [])
    .filter((item) => item?.type === 'message' && item?.role === 'assistant')
    .flatMap((item) => item.content || [])
    .filter((item) => item?.type === 'output_text')
    .map((item) => item.text || '')
    .join('')
    .trim();

export const parseKieResponseBody = (body) => {
  try {
    return JSON.parse(body);
  } catch {
    // Kie can return OpenAI Responses events even when `stream` is omitted.
  }

  const responsePayloads = [];
  const deltas = [];
  const completedTexts = [];

  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;

    let event;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }

    const candidate = event?.response || event;
    if (Array.isArray(candidate?.output)) responsePayloads.push(candidate);
    if (event?.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      deltas.push(event.delta);
    }
    if (event?.type === 'response.output_text.done' && typeof event.text === 'string') {
      completedTexts.push(event.text);
    }
  }

  const completedPayload = responsePayloads.findLast((payload) => extractResponseText(payload));
  if (completedPayload) return completedPayload;

  const text = completedTexts.at(-1) || deltas.join('');
  if (text) {
    return {
      status: 'completed',
      output: [
        {type: 'message', role: 'assistant', content: [{type: 'output_text', text}]},
      ],
    };
  }

  if (responsePayloads.length) return responsePayloads.at(-1);

  throw new Error('Kie trả về dữ liệu không phải JSON hoặc Responses SSE hợp lệ.');
};

export const translatePrayerScript = async (koreanScript, languageCode) => {
  const language = LANGUAGE_DEFINITIONS[languageCode];
  if (!language) throw new Error(`Ngôn ngữ không hỗ trợ: ${languageCode}`);

  if (languageCode === 'korea') {
    return {
      provider: 'source',
      model: 'korean-source',
      reasoningEffort: null,
      languageCode,
      translation: koreanScript.trim(),
      usage: null,
    };
  }

  const apiKey = await getApiKey();
  const model = process.env.KIE_MODEL || 'gpt-5-6-terra';
  const endpoint = process.env.KIE_API_URL || 'https://api.kie.ai/codex/v1/responses';
  const prompt = [
    `Translate the complete Korean Catholic prayer script below into ${language.targetName}.`,
    'Preserve every idea, paragraph rhythm, Bible reference, prayer tone, and line break.',
    `Use natural Catholic terminology for ${language.label} speakers.`,
    'Do not rewrite, summarize, omit, expand, explain, or wrap the result in Markdown.',
    'Return only the complete translated prayer script.',
    '',
    'KOREAN SCRIPT:',
    koreanScript,
  ].join('\n');

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: 'user',
          content: [{type: 'input_text', text: prompt}],
        },
      ],
      reasoning: {effort: 'medium'},
      max_output_tokens: 32768,
    }),
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Kie Responses API ${response.status}: ${body.slice(0, 800)}`);
  }

  const payload = parseKieResponseBody(await response.text());
  const text = extractResponseText(payload);
  if (!text) {
    throw new Error(
      `Kie không trả về output_text (status: ${payload?.status || 'unknown'}).`,
    );
  }

  return {
    provider: 'kie',
    model,
    reasoningEffort: 'medium',
    languageCode,
    translation: text.replace(/^```(?:\w+)?\s*/i, '').replace(/\s*```$/i, ''),
    usage: payload?.usage || null,
  };
};
