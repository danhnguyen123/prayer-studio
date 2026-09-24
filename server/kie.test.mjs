import test from 'node:test';
import assert from 'node:assert/strict';
import {extractResponseText, parseKieResponseBody, translatePrayerScript} from './kie.mjs';

test('extracts output_text from a Responses-style payload', () => {
  assert.equal(
    extractResponseText({
      output: [
        {type: 'reasoning', summary: []},
        {type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'Amen.'}]},
      ],
    }),
    'Amen.',
  );
});

test('parses a streamed Responses SSE payload from Kie', () => {
  const body = [
    'event: response.created',
    'data: {"type":"response.created","response":{"status":"in_progress","output":[]}}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"Prière "}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"traduite"}',
    '',
    'data: [DONE]',
  ].join('\n');

  assert.equal(extractResponseText(parseKieResponseBody(body)), 'Prière traduite');
});

test('one translation call targets one language with Terra medium', async () => {
  const previousKey = process.env.KIE_API_KEY;
  const previousFetch = globalThis.fetch;
  const requests = [];
  process.env.KIE_API_KEY = 'test-key';
  globalThis.fetch = async (url, options) => {
    requests.push({url, body: JSON.parse(options.body)});
    return new Response(JSON.stringify({
      status: 'completed',
      output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'Prière traduite'}]}],
    }), {status: 200, headers: {'Content-Type': 'application/json'}});
  };
  try {
    const result = await translatePrayerScript('기도문 원문입니다.', 'france');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.model, 'gpt-5-6-terra');
    assert.deepEqual(requests[0].body.reasoning, {effort: 'medium'});
    assert.match(requests[0].body.input[0].content[0].text, /into French/);
    assert.doesNotMatch(requests[0].body.input[0].content[0].text, /Polish|German|Italian/);
    assert.equal(result.translation, 'Prière traduite');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.KIE_API_KEY;
    else process.env.KIE_API_KEY = previousKey;
  }
});

test('Korea uses the Korean source without an API request', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('fetch should not be called');
  };
  try {
    const result = await translatePrayerScript('  한국어 기도문  ', 'korea');
    assert.equal(result.model, 'korean-source');
    assert.equal(result.translation, '한국어 기도문');
  } finally {
    globalThis.fetch = previousFetch;
  }
});
