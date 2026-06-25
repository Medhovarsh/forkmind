const { reconstructOpenAI, reconstructAnthropic } = require('../src/proxy/reconstruct');
const { drainSSE } = require('../src/proxy/server');

describe('reconstructOpenAI', () => {
  test('joins streamed content deltas into a full message', () => {
    const chunks = [
      { id: 'c1', model: 'llama3', choices: [{ delta: { role: 'assistant', content: 'Hel' } }] },
      { id: 'c1', model: 'llama3', choices: [{ delta: { content: 'lo ' } }] },
      { id: 'c1', model: 'llama3', choices: [{ delta: { content: 'world' }, finish_reason: 'stop' }] },
    ];
    const out = reconstructOpenAI(chunks);
    expect(out.choices[0].message.content).toBe('Hello world');
    expect(out.choices[0].finish_reason).toBe('stop');
    expect(out._forkmind.reconstructedFromStream).toBe(true);
  });

  test('accumulates fragmented tool-call arguments by index', () => {
    const chunks = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'get_weather', arguments: '{"ci' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"NYC"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ];
    const out = reconstructOpenAI(chunks);
    const tc = out.choices[0].message.tool_calls[0];
    expect(tc.id).toBe('t1');
    expect(tc.function.name).toBe('get_weather');
    expect(tc.function.arguments).toBe('{"city":"NYC"}');
    expect(out.choices[0].message.content).toBeNull();
  });
});

describe('reconstructAnthropic', () => {
  test('joins content_block_delta text events', () => {
    const events = [
      { type: 'message_start', message: { id: 'm1', model: 'claude', role: 'assistant', usage: { input_tokens: 5 } } },
      { type: 'content_block_delta', delta: { text: 'Hi ' } },
      { type: 'content_block_delta', delta: { text: 'there' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    ];
    const out = reconstructAnthropic(events);
    expect(out.content[0].text).toBe('Hi there');
    expect(out.stop_reason).toBe('end_turn');
  });
});

describe('drainSSE', () => {
  test('parses complete events and preserves a partial trailing event', () => {
    const buf =
      'data: {"a":1}\n\n' +
      'data: [DONE]\n\n' +
      'data: {"b":2'; // incomplete — no terminating \n\n
    const { parsed, rest } = drainSSE(buf);
    expect(parsed).toEqual([{ a: 1 }]); // [DONE] skipped, partial held back
    expect(rest).toBe('data: {"b":2');
  });
});
