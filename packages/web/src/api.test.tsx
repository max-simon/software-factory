import { afterEach, expect, test, vi } from 'vitest';
import { api, ApiError, redirectToLogin } from './api.ts';

const reply = (status: number, body?: unknown) =>
  vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status }));

/** Stubs `fetch` with `response` and `location` at `hash`; returns the stubbed location. */
function stub(response: ReturnType<typeof reply>, hash: string): { hash: string } {
  const location = { hash };
  vi.stubGlobal('fetch', response);
  vi.stubGlobal('location', location);
  return location;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test('a 401 sends the browser to the login, which returns to the page afterwards', async () => {
  const location = stub(reply(401, { error: { code: 'unauthorized', message: 'sign in first' } }), '#/tasks/t1');
  await expect(api.getTask('t1')).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
  expect(location.hash).toBe('#/login?next=%23%2Ftasks%2Ft1');
});

test('on the login page, a 401 does not nest another login', async () => {
  const location = stub(reply(401), '#/login?next=%23%2Faccount');
  await expect(api.me()).rejects.toBeInstanceOf(ApiError);
  expect(location.hash).toBe('#/login?next=%23%2Faccount');
});

test('a failed login stays on the login page for the form to report', async () => {
  const location = stub(reply(401, { error: { code: 'login_failed', message: 'wrong username or password' } }), '#/login');
  await expect(api.login('ada', 'wrong')).rejects.toMatchObject({ status: 401, code: 'login_failed' });
  expect(location.hash).toBe('#/login');
});

test('other errors, a wrong current password included, do not redirect', async () => {
  for (const [status, code] of [
    [400, 'wrong_password'],
    [403, 'session_required'],
    [404, 'not_found'],
    [429, 'too_many_attempts'],
    [500, 'internal'],
  ] as const) {
    const location = stub(reply(status, { error: { code, message: code } }), '#/account');
    await expect(api.changePassword('a', 'b')).rejects.toMatchObject({ status, code });
    expect(location.hash).toBe('#/account');
  }
  const location = stub(
    vi.fn(async () => {
      throw new TypeError('offline');
    }),
    '#/account',
  );
  await expect(api.listTokens()).rejects.toMatchObject({ code: 'unreachable' });
  expect(location.hash).toBe('#/account');
});

test('setting the assignees replaces them with a PUT of the whole list', async () => {
  const response = reply(200, { id: 't1' });
  stub(response, '#/tasks/t1');
  await api.setAssignees('t1', ['u1', 'u2']);
  expect(response).toHaveBeenCalledWith('/tasks/t1/assignees', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ assignees: ['u1', 'u2'] }),
  });
});

test('a disabled user refused as assignee surfaces as its error code', async () => {
  stub(reply(409, { error: { code: 'user_disabled', message: 'user u3 is disabled' } }), '#/tasks/t1');
  await expect(api.setAssignees('t1', ['u3'])).rejects.toMatchObject({ status: 409, code: 'user_disabled', message: 'user u3 is disabled' });
});

test('redirectToLogin from home needs no return address', () => {
  const target = { hash: '' };
  redirectToLogin(target);
  expect(target.hash).toBe('#/login');
});
