import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpencodeApi, OpencodeApiError } from './opencode-api.ts';
import { opencodeConfig } from './opencode-server.ts';

interface Request {
  url: string;
  method: string;
  authorization: string;
  body?: unknown;
}

function fakeFetch(respond: (request: Request) => Response) {
  const requests: Request[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const request = {
      url,
      method: init.method!,
      authorization: headers.authorization!,
      ...(init.body !== undefined && { body: JSON.parse(init.body as string) }),
    };
    requests.push(request);
    return respond(request);
  }) as typeof fetch;
  return { requests, fetchFn };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test('creates sessions at a location and authenticates as the opencode user', async () => {
  const { requests, fetchFn } = fakeFetch(() => json({ data: { id: 'ses_1' } }));
  const api = createOpencodeApi('http://oc', 'pw', fetchFn);
  await api.createSession({ id: 'ses_1', agent: 'factory', model: { providerID: 'anthropic', id: 'm' }, directory: '/work' });
  assert.deepEqual(requests, [
    {
      url: 'http://oc/api/session',
      method: 'POST',
      authorization: `Basic ${Buffer.from('opencode:pw').toString('base64')}`,
      body: { id: 'ses_1', agent: 'factory', model: { providerID: 'anthropic', id: 'm' }, location: { directory: '/work' } },
    },
  ]);
});

test('reads the admission time, the newest message and the cost', async () => {
  const { requests, fetchFn } = fakeFetch(({ url }) => {
    if (url.endsWith('/prompt')) return json({ data: { id: 'msg_1', time: { created: 42 }, type: 'user' } });
    if (url.includes('/message')) return json({ data: [{ id: 'msg_2', type: 'idle', time: { created: 50 }, outcome: 'succeeded' }] });
    return json({ data: { id: 'ses_1', cost: 0.75, tokens: {} } });
  });
  const api = createOpencodeApi('http://oc', 'pw', fetchFn);
  assert.deepEqual(await api.prompt('ses_1', 'hi'), { admittedAt: 42 });
  assert.deepEqual(await api.latestMessage('ses_1'), { type: 'idle', time: { created: 50 }, outcome: 'succeeded' });
  assert.equal(await api.cost('ses_1'), 0.75);
  assert.deepEqual(
    requests.map((r) => `${r.method} ${r.url}`),
    ['POST http://oc/api/session/ses_1/prompt', 'GET http://oc/api/session/ses_1/message?limit=1&order=desc', 'GET http://oc/api/session/ses_1'],
  );
});

test('error statuses and unexpected bodies fail loud', async () => {
  const failing = createOpencodeApi('http://oc', 'pw', fakeFetch(() => new Response('gone', { status: 404 })).fetchFn);
  await assert.rejects(failing.cost('ses_1'), (e) => e instanceof OpencodeApiError && /GET \/api\/session\/ses_1 returned 404: gone/.test(e.message));
  const changed = createOpencodeApi('http://oc', 'pw', fakeFetch(() => json({ data: { price: 1 } })).fetchFn);
  await assert.rejects(changed.cost('ses_1'), (e) => e instanceof OpencodeApiError && /unexpected opencode response/.test(e.message));
  const idleWithoutOutcome = createOpencodeApi('http://oc', 'pw', fakeFetch(() => json({ data: [{ type: 'idle', time: { created: 1 } }] })).fetchFn);
  await assert.rejects(idleWithoutOutcome.latestMessage('ses_1'), OpencodeApiError);
});

test('the event stream yields each data line, across chunk boundaries', async () => {
  const chunks = ['data: {"type":"a"}\n\nda', 'ta: {"type":"b"}\n', 'data: not json\n', 'event: x\ndata: {"type":"c"}\n'];
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  const api = createOpencodeApi('http://oc', 'pw', fakeFetch(() => new Response(body)).fetchFn);
  const events: unknown[] = [];
  for await (const event of api.events(new AbortController().signal)) events.push(event);
  assert.deepEqual(events, [{ type: 'a' }, { type: 'b' }, { type: 'c' }]);
});

test('the server config defines the agent without permission prompts and the bridge without Code Mode', () => {
  const config = opencodeConfig({
    agent: 'factory',
    systemPrompt: 'rules',
    bridgePath: '/app/bridge.ts',
    bridge: { controlPlaneUrl: 'http://cp', taskToken: 'tok' },
  });
  assert.deepEqual(config, {
    update: 'disable',
    agents: { factory: { mode: 'primary', system: 'rules', permissions: [{ action: '*', resource: '*', effect: 'allow' }] } },
    mcp: {
      servers: {
        factory: {
          type: 'local',
          command: [process.execPath, '/app/bridge.ts'],
          environment: { FACTORY_CONTROL_PLANE_URL: 'http://cp', FACTORY_TASK_TOKEN: 'tok' },
          codemode: false,
        },
      },
    },
  });
});
