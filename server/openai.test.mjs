import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOpenAITranslationBody,
  translatePrayerScriptOpenAI,
  translatePrayerScriptsOpenAIBatch,
} from './openai.mjs';

const responsePayload = (text) => ({
  status: 'completed',
  output: [
    {type: 'message', role: 'assistant', content: [{type: 'output_text', text}]},
  ],
});

test('official OpenAI translation uses GPT-5.6 Terra medium', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  let request;
  globalThis.fetch = async (url, options) => {
    request = {url, body: JSON.parse(options.body)};
    return new Response(JSON.stringify(responsePayload('Prière officielle')), {status: 200});
  };
  try {
    const result = await translatePrayerScriptOpenAI('기도문 원문입니다.', 'france');
    assert.match(request.url, /api\.openai\.com\/v1\/responses$/);
    assert.equal(request.body.model, 'gpt-5.6-terra');
    assert.deepEqual(request.body.reasoning, {effort: 'medium'});
    assert.equal(request.body.store, false);
    assert.equal(result.provider, 'openai');
    assert.equal(result.translation, 'Prière officielle');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test('OpenAI Batch maps output by custom_id instead of output order', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({url, method: options.method});
    if (url.endsWith('/files') && options.method === 'POST') {
      return new Response(JSON.stringify({id: 'file-input'}), {status: 200});
    }
    if (url.endsWith('/batches') && options.method === 'POST') {
      return new Response(JSON.stringify({id: 'batch-prayer', status: 'validating'}), {status: 200});
    }
    if (url.endsWith('/batches/batch-prayer')) {
      return new Response(JSON.stringify({
        id: 'batch-prayer', status: 'completed', output_file_id: 'file-output',
        request_counts: {total: 2, completed: 2, failed: 0},
      }), {status: 200});
    }
    if (url.endsWith('/files/file-output/content')) {
      const lines = [
        {custom_id: 'translation:germany', response: {status_code: 200, body: responsePayload('Deutsches Gebet')}},
        {custom_id: 'translation:france', response: {status_code: 200, body: responsePayload('Prière française')}},
      ];
      return new Response(lines.map((line) => JSON.stringify(line)).join('\n'), {status: 200});
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const results = await translatePrayerScriptsOpenAIBatch(
      '기도문 원문입니다.',
      ['france', 'germany'],
    );
    assert.equal(results.france.translation, 'Prière française');
    assert.equal(results.germany.translation, 'Deutsches Gebet');
    assert.equal(results.france.processingMode, 'batch');
    assert.equal(results.france.batchId, 'batch-prayer');
    assert.equal(calls.length, 4);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test('Korea bypasses OpenAI in batch mode', async () => {
  const result = await translatePrayerScriptsOpenAIBatch('  한국어 기도문  ', ['korea']);
  assert.equal(result.korea.provider, 'source');
  assert.equal(result.korea.translation, '한국어 기도문');
});

test('translation request builder preserves a single target language', () => {
  const body = buildOpenAITranslationBody('기도문', 'italia');
  const prompt = body.input[0].content[0].text;
  assert.match(prompt, /into Italian/);
  assert.doesNotMatch(prompt, /French|Polish|German/);
});

