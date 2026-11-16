import { z } from 'zod';

// The few routes of the opencode V2 server API (2.2.7, marked experimental) the
// adapter needs. Responses are validated here, so a changed contract fails loud.

export interface ModelRef {
  providerID: string;
  id: string;
}

export interface NewSession {
  id: string;
  agent: string;
  model: ModelRef;
  directory: string;
}

const idleMessage = z.object({
  type: z.literal('idle'),
  time: z.object({ created: z.number() }),
  outcome: z.enum(['succeeded', 'failed', 'interrupted']),
  error: z.object({ type: z.string(), message: z.string() }).optional(),
});
// Excludes `idle`, so an idle message missing its outcome fails loud instead of passing as another kind.
const otherMessage = z.object({ type: z.string().refine((type) => type !== 'idle'), time: z.object({ created: z.number() }) });
const message = z.union([idleMessage, otherMessage]);

/** The end of an execution, as the session records it. */
export type IdleMessage = z.infer<typeof idleMessage>;
export type Message = z.infer<typeof message>;

export const isIdle = (m: Message | undefined): m is IdleMessage => m?.type === 'idle';

const admitted = z.object({ data: z.object({ time: z.object({ created: z.number() }) }) });
const messages = z.object({ data: z.array(message) });
const session = z.object({ data: z.object({ cost: z.number() }) });

export interface OpencodeApi {
  createSession(session: NewSession): Promise<void>;
  /** Queues the prompt and starts execution; resolves with when the server admitted it, on its clock. */
  prompt(sessionID: string, text: string): Promise<{ admittedAt: number }>;
  /** Resolves once the session is idle, or after a timeout: callers check the session again. */
  waitIdle(sessionID: string): Promise<void>;
  latestMessage(sessionID: string): Promise<Message | undefined>;
  /** The session's running cost total in USD. */
  cost(sessionID: string): Promise<number>;
  /** Live server events; no replay, so the stream misses what happens while disconnected. */
  events(signal: AbortSignal): AsyncIterable<unknown>;
}

export class OpencodeApiError extends Error {
  override name = 'OpencodeApiError';
}

// A turn runs for minutes to hours, longer than fetch waits for response
// headers (300 s), so each wait is cut short and repeated by the caller.
const waitTimeoutMs = 240_000;

export function createOpencodeApi(baseUrl: string, password: string, fetchFn: typeof fetch = fetch): OpencodeApi {
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  const request = async (method: string, path: string, body?: object, signal?: AbortSignal): Promise<Response> => {
    const response = await fetchFn(`${baseUrl}${path}`, {
      method,
      headers: { authorization, ...(body && { 'content-type': 'application/json' }) },
      ...(body && { body: JSON.stringify(body) }),
      ...(signal && { signal }),
    });
    if (!response.ok) {
      throw new OpencodeApiError(`${method} ${path} returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }
    return response;
  };
  const parse = async <T>(schema: z.ZodType<T>, response: Promise<Response>): Promise<T> => {
    const result = schema.safeParse(await (await response).json());
    if (!result.success) throw new OpencodeApiError(`unexpected opencode response: ${z.prettifyError(result.error)}`);
    return result.data;
  };
  const sessionPath = (id: string) => `/api/session/${encodeURIComponent(id)}`;

  return {
    createSession: async ({ directory, ...rest }) => {
      await request('POST', '/api/session', { ...rest, location: { directory } });
    },
    prompt: async (sessionID, text) => {
      const { data } = await parse(admitted, request('POST', `${sessionPath(sessionID)}/prompt`, { text }));
      return { admittedAt: data.time.created };
    },
    waitIdle: async (sessionID) => {
      try {
        await request('POST', `/api/experimental/session/${encodeURIComponent(sessionID)}/wait`, undefined, AbortSignal.timeout(waitTimeoutMs));
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'TimeoutError')) throw error;
      }
    },
    latestMessage: async (sessionID) =>
      (await parse(messages, request('GET', `${sessionPath(sessionID)}/message?limit=1&order=desc`))).data[0],
    cost: async (sessionID) => (await parse(session, request('GET', sessionPath(sessionID)))).data.cost,
    events: (signal) => serverSentEvents(request('GET', '/api/event', undefined, signal)),
  };
}

async function* serverSentEvents(response: Promise<Response>): AsyncIterable<unknown> {
  const body = (await response).body;
  if (!body) return;
  let partial = '';
  for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
    const lines = (partial + chunk).split('\n');
    partial = lines.pop()!;
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      try {
        yield JSON.parse(line.slice('data:'.length));
      } catch {
        // An event we cannot read only costs an activity line.
      }
    }
  }
}
