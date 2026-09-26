import assert from 'node:assert/strict';
import type { FixtureServer } from './fixture-server.ts';
import type { TestServer } from './harness.ts';

export interface FixtureSignIn {
  user: string;
  /** The session cookie's value (server-issued, HttpOnly). */
  token: string;
  /** The value the fixture put into localStorage "profile". */
  profile: string;
}

/**
 * Sign in to the fixture site in the server's main browser through its form (POST /login), the way a
 * user would: the session cookie and the localStorage profile never appear in a URL. The active tab
 * stays on the signed-in page, where the profile is in localStorage (Obscura keeps page storage for
 * one page load only).
 */
export async function signIn(srv: TestServer, fx: FixtureServer, user: string): Promise<FixtureSignIn> {
  const known = new Set(fx.sessions.keys());
  await srv.call('browser_navigate', { url: `${fx.baseUrl}/login` });
  await srv.call('browser_fill', { selector: '#user', value: user });
  await srv.call('browser_fill', { selector: '#password', value: 'fixture-password' });
  const clicked = await srv.call('browser_click', { selector: '#signin' });
  assert.equal(clicked.isError, false, clicked.text);
  const who = await srv.call('browser_get_text', { selector: '#who' });
  assert.match(who.text, new RegExp(`Signed in as ${user}`), who.text);
  const issued = [...fx.sessions.entries()].find(([token, s]) => !known.has(token) && s.user === user);
  assert.ok(issued, `the fixture issued a session for ${user}`);
  return { user, token: issued[0], profile: issued[1].profile };
}

/** The #who and #profile lines of the fixture's /account page, opened in the main browser. */
export async function accountPage(srv: TestServer, fx: FixtureServer): Promise<{ who: string; profile: string }> {
  await srv.call('browser_navigate', { url: `${fx.baseUrl}/account` });
  const who = (await srv.call('browser_get_text', { selector: '#who' })).text.trim();
  const profile = (await srv.call('browser_get_text', { selector: '#profile' })).text.trim();
  return { who, profile };
}
