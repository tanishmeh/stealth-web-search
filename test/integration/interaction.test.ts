import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.ts';
import { startTestServer, type TestServer } from '../helpers/harness.ts';

/** browser_fill / type / press_key / select_option / check / scroll and the wait tools. */
describe('interaction and wait tools', () => {
  let fx: FixtureServer;
  let srv: TestServer;

  before(async () => {
    fx = await startFixtureServer();
    srv = await startTestServer();
  });
  after(async () => {
    await srv?.stop();
    await fx?.close();
  });

  const open = async (page: string) => {
    const r = await srv.call('browser_navigate', { url: `${fx.baseUrl}/${page}` });
    assert.equal(r.isError, false, r.text);
  };
  const ok = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await srv.call(name, args);
    assert.equal(r.isError, false, `${name} ${JSON.stringify(args)} -> ${r.text}`);
    return r.text;
  };
  const fails = async (name: string, args: Record<string, unknown>, pattern: RegExp) => {
    const r = await srv.call(name, args);
    assert.equal(r.isError, true, `${name} should fail: ${r.text}`);
    assert.match(r.text, pattern);
    return r.text;
  };
  const snapshot = () => ok('browser_snapshot');
  const refOf = (snap: string, label: string) => {
    const m = new RegExp(`ref=(e\\d+)\\s+\\S+\\s+"${label}"`).exec(snap);
    assert.ok(m, `no ref for "${label}" in:\n${snap}`);
    return m[1]!;
  };

  test('fill replaces values with trusted input/change events and never echoes passwords', async () => {
    await open('form.html');
    await ok('browser_fill', { selector: '#email', value: 'first@x.co' });
    const text = await ok('browser_fill', { selector: '#email', value: 'a@b.co' });
    assert.equal(text, 'Filled input[email] "Email address" (selector "#email") with "a@b.co"');

    const snap = await snapshot();
    assert.match(snap, /input\[email\]\s+"Email address" name="email" value="a@b\.co"/);
    assert.match(snap, /email:input:true,email:change/);

    const nick = refOf(snap, 'Nick');
    assert.match(await ok('browser_fill', { ref: nick, value: 'nick' }), new RegExp(`^Filled input "Nick" \\(ref ${nick}\\) with "nick"$`));

    const secret = 'Pa55word-typed-by-fill';
    const pw = await ok('browser_fill', { selector: '#password', value: secret });
    assert.equal(pw, `Filled input[password] "Password" (selector "#password") with (${secret.length} characters)`);

    await ok('browser_fill', { selector: '#bio', value: 'line one\nline two' });
    await ok('browser_fill', { selector: '#editor', value: 'Rich text body' });
    // a <select> is filled by option value or text
    assert.match(await ok('browser_fill', { selector: '#color', value: 'Blue' }), /^Selected "Blue" \(value b\) in select/);

    const after = await snapshot();
    assert.match(after, /name="nickname" value="nick"/);
    assert.match(after, /name="bio" value="line one line two"/);
    assert.match(after, /Rich text body/);
    assert.doesNotMatch(after, new RegExp(secret));

    await fails('browser_fill', { selector: '#readonly', value: 'x' }, /is read-only/);
    await fails('browser_fill', { selector: '#agree', value: 'x' }, /is a checkbox; use browser_check/);
    await fails('browser_fill', { selector: '#submit', value: 'x' }, /not a text field/);
    await fails('browser_fill', { selector: '#does-not-exist', value: 'x' }, /Element not found/);
    await fails('browser_fill', { ref: 'e999', value: 'x' }, /Unknown element ref/);
  });

  test('type appends at the caret end like a user and can press Enter to submit', async () => {
    await open('form.html');
    await ok('browser_fill', { selector: '#nickname', value: 'abc' });
    const typed = await ok('browser_type', { selector: '#nickname', text: 'def' });
    assert.equal(typed, 'Typed "def" into input "Nick" (selector "#nickname"); the field now contains "abcdef"');
    assert.match(await ok('browser_type', { selector: '#nickname', text: 'g' }), /now contains "abcdefg"$/);

    assert.match(await ok('browser_type', { selector: '#bio', text: 'hello' }), /now contains "hello"$/);
    assert.match(await ok('browser_type', { selector: '#bio', text: ' world' }), /now contains "hello world"$/);
    assert.match(await ok('browser_type', { selector: '#editor', text: 'rich' }), /div\[contenteditable\].*now contains "rich"$/);
    assert.match(await ok('browser_type', { selector: '#editor', text: ' text' }), /now contains "rich text"$/);

    const snap = await snapshot();
    assert.match(snap, /nickname:input:true/, 'typing fires trusted input events');

    const pw = await ok('browser_type', { selector: '#password', text: 'typed-secret-1' });
    assert.equal(pw, 'Typed (14 characters) into input[password] "Password" (selector "#password")');

    await fails('browser_type', { selector: '#color', text: 'x' }, /use browser_select_option/);

    const before = fx.requests.length;
    const submitted = await ok('browser_type', { selector: '#q', text: 'kittens', submit: true });
    assert.match(submitted, /then pressed Enter\nThe page navigated to http:\/\/.+\/echo\?q=kittens — "Echo"/);
    assert.ok(fx.requests.slice(before).some((r) => r.method === 'GET' && r.url === '/echo?q=kittens'), 'search form was submitted');
  });

  test('press_key: Enter submits, editing keys, Tab traversal, activation and page scrolling', async () => {
    await open('form.html');
    await ok('browser_fill', { selector: '#q', value: 'cats' });
    const before = fx.requests.length;
    const enter = await ok('browser_press_key', { key: 'Enter', selector: '#q' });
    assert.match(enter, /^Pressed Enter on input "Search" \(selector "#q"\)\nThe page navigated to .*\/echo\?q=cats/);
    assert.ok(fx.requests.slice(before).some((r) => r.url === '/echo?q=cats'));

    await open('keys.html');
    assert.match(await ok('browser_press_key', { key: 'Tab' }), /^Pressed Tab \(no element has focus\); focus moved to input "first" \(ref e\d+\)$/);
    assert.match(await ok('browser_press_key', { key: 'Tab' }), /focus moved to button\[button\] "Plain"/);
    assert.match(await ok('browser_press_key', { key: 'tab' }), /focus moved to input "second"/);
    // skips tabindex=-1 and disabled inputs
    assert.match(await ok('browser_press_key', { key: 'Tab' }), /focus moved to textarea "notes"/);
    assert.match(await ok('browser_press_key', { key: 'Shift+Tab' }), /^Pressed Shift\+Tab on the focused textarea "notes".*focus moved to input "second"/);

    assert.match(await ok('browser_press_key', { key: 'Backspace', selector: '#first' }), /the field now contains "on"$/);
    assert.match(await ok('browser_press_key', { key: 'Home' }), /caret moved to position 0 of 2$/);
    assert.match(await ok('browser_press_key', { key: 'Delete' }), /deleted 1 character; the field now contains "n"$/);
    assert.match(await ok('browser_press_key', { key: 'x' }), /^Pressed "x" on the focused input "first".*the field now contains "xn"$/);
    assert.match(await ok('browser_press_key', { key: 'ArrowRight' }), /caret moved to position 2 of 2$/);

    assert.match(await ok('browser_press_key', { key: 'Space', selector: '#solo' }), /activated \(clicked\) button "Solo"/);
    assert.match(await ok('browser_press_key', { key: ' ', selector: '#agree' }), /activated \(clicked\) input\[checkbox\]/);
    const snap = await snapshot();
    assert.match(snap, /solo clicked/);
    assert.match(snap, /keydown:Escape|keydown:Tab/);
    assert.match(snap, /name="first" value="xn"/);
    assert.match(snap, /input\[checkbox\].*name="agree" checked/);

    await open('keys.html');
    assert.match(await ok('browser_press_key', { key: 'PageDown' }), /^Pressed PageDown \(no element has focus\); the page scrolled to y=630 \(page height \d+, viewport 720\)$/);
    assert.match(await ok('browser_press_key', { key: 'End' }), /Reached the bottom of the page$/);
    assert.match(await ok('browser_press_key', { key: 'PageDown' }), /already at the bottom$/);
    assert.match(await ok('browser_press_key', { key: 'Home' }), /the page scrolled to y=0 /);

    assert.match(await ok('browser_press_key', { key: 'Enter', selector: '#link' }), /The page navigated to .*\/page2\.html/);

    await fails('browser_press_key', { key: 'Control+A' }, /not supported: the browser ignores modifier keys.*browser_fill/);
    await fails('browser_press_key', { key: 'Meta+c' }, /not supported/);
    await fails('browser_press_key', { key: 'F5' }, /Unsupported key "F5"/);
  });

  test('select_option by value, text and case-insensitive text; multi-select; helpful errors', async () => {
    await open('form.html');
    assert.equal(await ok('browser_select_option', { selector: '#color', value: 'g' }), 'Selected "Green" (value g) in select "color" (selector "#color")');
    assert.match(await ok('browser_select_option', { selector: '#color', value: 'Blue' }), /^Selected "Blue" \(value b\)/);
    assert.match(await ok('browser_select_option', { selector: '#color', value: 'red' }), /^Selected "Red" \(value r\)/);
    assert.match(
      await ok('browser_select_option', { selector: '#multi', values: ['Alpha', 'c'] }),
      /^Selected "Alpha" \(value a\), "Gamma" \(value c\) in select "multi"/,
    );
    await fails('browser_select_option', { selector: '#color', value: 'purple' }, /Option "purple" not found .* Available options: "Red" \(value r\), "Green" \(value g\), "Blue" \(value b\)$/);
    await fails('browser_select_option', { selector: '#color', values: ['r', 'g'] }, /allows only one selection/);
    await fails('browser_select_option', { selector: '#email', value: 'x' }, /is not a <select> element/);
    await fails('browser_select_option', { selector: '#color' }, /Provide value/);
    const snap = await snapshot();
    assert.match(snap, /select\s+"color" name="color" value="Red"/);
    assert.match(snap, /color:input:true,color:change/);
  });

  test('check is idempotent, handles radios, and the submitted form carries every value', async () => {
    await open('form.html');
    assert.equal(await ok('browser_check', { selector: '#agree' }), 'Checked input[checkbox] "I agree" (selector "#agree")');
    assert.equal(await ok('browser_check', { selector: '#agree' }), 'input[checkbox] "I agree" (selector "#agree") was already checked');
    assert.match(await ok('browser_check', { selector: '#agree', checked: false }), /^Unchecked input\[checkbox\] "I agree"/);
    assert.match(await ok('browser_check', { selector: '#agree', checked: false }), /was already unchecked/);
    await ok('browser_check', { selector: '#agree', checked: true });
    assert.match(await ok('browser_check', { selector: '#plan-pro' }), /^Checked input\[radio\] "Pro"/);
    await fails('browser_check', { selector: '#plan-pro', checked: false }, /cannot be unchecked directly/);
    await fails('browser_check', { selector: '#email' }, /is not a checkbox or radio button/);

    await ok('browser_fill', { selector: '#email', value: 'user@example.com' });
    await ok('browser_fill', { selector: '#password', value: 'hunter2-submit' });
    await ok('browser_fill', { selector: '#nickname', value: 'nick' });
    await ok('browser_type', { selector: '#nickname', text: 'name' });
    await ok('browser_select_option', { selector: '#color', value: 'Green' });
    await ok('browser_fill', { selector: '#bio', value: 'about me' });

    const before = fx.requests.length;
    const clicked = await ok('browser_click', { selector: '#submit' });
    assert.match(clicked, /navigated to .*\/echo — "Echo"/);
    const post = fx.requests.slice(before).find((r) => r.method === 'POST' && r.url === '/echo');
    assert.ok(post, 'form POSTed');
    const body = new URLSearchParams(post.body);
    assert.equal(body.get('email'), 'user@example.com');
    assert.equal(body.get('password'), 'hunter2-submit');
    assert.equal(body.get('nickname'), 'nickname');
    assert.equal(body.get('agree'), 'yes');
    assert.equal(body.get('plan'), 'pro');
    assert.equal(body.get('color'), 'g');
    assert.equal(body.get('bio'), 'about me');
    assert.equal(body.get('readonly'), 'fixed');
  });

  test('maxlength, ARIA checkboxes, one-time-code fields and selects that navigate', async () => {
    await open('inputs.html');
    assert.equal(
      await ok('browser_type', { selector: '#code', text: 'cdef' }),
      'Typed "cd" into input "Code" (selector "#code") (maxlength 4: only 2 characters fit); the field now contains "abcd"',
    );
    assert.match(await ok('browser_type', { selector: '#code', text: 'x' }), /^Typed nothing into input "Code" .*the field is full.*contains "abcd"$/);
    assert.match(await ok('browser_fill', { selector: '#code', value: 'wxyz12' }), /with "wxyz" \(truncated to maxlength 4\)$/);
    assert.match(await ok('browser_fill', { selector: '#when', value: '2024-01-02' }), /^Filled input\[date\] "Date" .* with "2024-01-02"$/);

    // autocomplete=one-time-code counts as a secret: the value is not echoed
    assert.equal(await ok('browser_fill', { selector: '#otp', value: '987654' }), 'Filled input "One-time code" (selector "#otp") with (6 characters)');
    assert.equal(await ok('browser_type', { selector: '#otp', text: '3' }), 'Typed (1 character) into input "One-time code" (selector "#otp")');

    assert.equal(await ok('browser_check', { selector: '#fancy' }), 'Checked div[role=checkbox] "Fancy toggle" (selector "#fancy")');
    assert.match(await ok('browser_check', { selector: '#fancy' }), /was already checked$/);
    assert.match(await ok('browser_check', { selector: '#fancy', checked: false }), /^Unchecked div\[role=checkbox\]/);
    await fails('browser_check', { selector: '#stuck' }, /did not become checked; the page may be preventing it/);

    const nav = await ok('browser_select_option', { selector: '#lang', value: 'Deutsch' });
    assert.match(nav, /^Selected "Deutsch" \(value de\) in select \(selector "#lang"\)\nThe page navigated to .*\/page2\.html\?lang=de — "Page Two"/);
  });

  test('scroll the page by direction and elements into view', async () => {
    await open('index.html');
    assert.match(await ok('browser_scroll'), /^Scrolled down to y=720 \(page height \d+, viewport 720\)\.$/);
    const bottom = await ok('browser_scroll', { direction: 'bottom' });
    const maxY = Number(/y=(\d+)/.exec(bottom)![1]);
    assert.match(bottom, /^Scrolled to the bottom: y=\d+/);
    assert.match(await ok('browser_scroll', { direction: 'down' }), new RegExp(`to y=${maxY} .*Reached the bottom of the page\\.$`));
    assert.match(await ok('browser_scroll', { direction: 'up', amount: 100 }), new RegExp(`^Scrolled up to y=${maxY - 100} `));
    assert.match(await ok('browser_scroll', { direction: 'top' }), /^Scrolled to the top: y=0 /);
    assert.match(await ok('browser_scroll', { direction: 'up' }), /At the top of the page\.$/);
    const el = await ok('browser_scroll', { selector: '#far' });
    assert.match(el, /^Scrolled button "Far button" \(selector "#far"\) into view; its centre is at x=\d+, y=\d+ in the viewport\. Page scroll y=[1-9]\d*/);

    await open('page2.html');
    assert.match(await ok('browser_scroll'), /fits in the viewport/);
  });

  test('wait_for / wait_for_text poll until content appears and time out with the current state', async () => {
    await open('spa.html');
    const found = await ok('browser_wait_for', { selector: '#late', timeout: 10 });
    assert.match(found, /^Found "#late" \(visible\) after \d+\.\d s$/);
    assert.ok(Number(/after ([\d.]+) s/.exec(found)![1]) < 5);

    let started = Date.now();
    const timedOut = await fails('browser_wait_for', { selector: '#never-there', timeout: 0.5 }, /^Error: Timed out after 0\.\d s waiting for "#never-there" to be visible: no element matches it\. Page: /);
    let elapsed = Date.now() - started;
    assert.ok(elapsed >= 450 && elapsed < 4000, `timeout took ${elapsed} ms: ${timedOut}`);

    await fails('browser_wait_for', { selector: '#late', state: 'hidden', timeout: 0.3 }, /to be hidden: it is still visible/);
    assert.match(await ok('browser_wait_for', { selector: '#late', state: 'attached' }), /^Found "#late" \(attached\)/);
    assert.match(await ok('browser_wait_for', { selector: '#nothing', state: 'detached' }), /is no longer in the page/);

    assert.match(await ok('browser_wait_for_text', { text: 'Arrived after two seconds', timeout: 10 }), /^Found text "Arrived after two seconds" after \d+\.\d s$/);
    assert.match(await ok('browser_wait_for_text', { text: 'Loading', gone: true, timeout: 5 }), /^Text "Loading" is gone after/);
    started = Date.now();
    await fails('browser_wait_for_text', { text: 'never-appears', timeout: 0.4 }, /Timed out after 0\.\d s waiting for text "never-appears" to appear/);
    elapsed = Date.now() - started;
    assert.ok(elapsed >= 350 && elapsed < 4000, `text timeout took ${elapsed} ms`);
    await fails('browser_wait_for_text', { text: 'Late content', gone: true, timeout: 0.2 }, /to disappear \(it is still visible\)/);

    // the text only exists inside the page's inline script until the route button is clicked
    await fails('browser_wait_for_text', { text: 'Routed view', timeout: 0.3 }, /Timed out after 0\.\d s waiting for text "Routed view" to appear/);

    // hidden element becomes visible via a client-side route change
    const clicked = await ok('browser_click', { selector: '#route' });
    // Obscura reports pushState as a main-frame navigation, so either note is acceptable
    assert.match(clicked, /(The URL changed to|The page navigated to) .*\/spa\/route/);
    assert.match(await ok('browser_wait_for_text', { text: 'Routed view', timeout: 5 }), /^Found text "Routed view"/);

    started = Date.now();
    assert.equal(await ok('browser_wait', { seconds: 0.3 }), 'Waited 0.3 s');
    assert.ok(Date.now() - started >= 280);

    const bad = await srv.call('browser_wait_for', { selector: '#late', timeout: 500 }).catch((err: Error) => ({ isError: true, text: err.message }));
    assert.equal(bad.isError, true, 'timeout above the maximum is rejected by the schema');
  });

  const pageLog = async () => ok('browser_evaluate', { expression: "document.getElementById('log').textContent" });

  test('wait_for_text matches rendered text only; hidden state accepts missing elements; invalid selectors fail fast', async () => {
    await open('spa.html');
    // the text is in an inline <script> from the start but is only rendered after 2 s
    const arrived = await ok('browser_wait_for_text', { text: 'Arrived after two seconds', timeout: 10 });
    assert.ok(Number(/after ([\d.]+) s/.exec(arrived)![1]) >= 1.2, arrived);

    await open('edge-inputs.html');
    await fails('browser_wait_for_text', { text: 'Script only phrase', timeout: 0.3 }, /waiting for text "Script only phrase" to appear\. Page: /);
    await fails('browser_wait_for_text', { text: 'Hidden text here', timeout: 0.3 }, /to appear \(it is in the page but hidden\)/);
    assert.match(await ok('browser_wait_for_text', { text: 'Hidden text here', gone: true, timeout: 1 }), /^Text "Hidden text here" is gone after 0\.\d s$/);
    assert.match(await ok('browser_wait_for_text', { text: 'Hidden attribute text', gone: true, timeout: 1 }), /is gone after/);
    // whitespace in the page and in the query is collapsed
    assert.match(await ok('browser_wait_for_text', { text: 'Multi line  text', timeout: 1 }), /^Found text "Multi line  text" after 0\.\d s$/);

    assert.match(await ok('browser_wait_for', { selector: '#no-such-element', state: 'hidden', timeout: 1 }), /^"#no-such-element" is hidden after 0\.\d s$/);
    assert.match(await ok('browser_wait_for', { selector: '#hid', state: 'hidden', timeout: 1 }), /is hidden after/);
    const started = Date.now();
    await fails('browser_wait_for', { selector: 'div[', timeout: 20 }, /Invalid CSS selector "div\["/);
    assert.ok(Date.now() - started < 3000, 'an invalid selector is rejected without waiting for the timeout');
  });

  test('keyboard default actions follow HTML semantics and respect preventDefault', async () => {
    await open('edge-inputs.html');
    const before = fx.requests.length;
    // Enter on a type=button inside a form clicks the button; it does not submit the form
    assert.match(await ok('browser_press_key', { key: 'Enter', selector: '#inform' }), /activated \(clicked\) button\[button\] "In form"/);
    // no default button and two text fields: Enter does not submit, and the result explains why
    assert.match(await ok('browser_press_key', { key: 'Enter', selector: '#mail' }), /; the form was not submitted \(it has no submit button and several text fields\); click its submit control instead$/);
    // the page cancels Enter and "x" in #guarded and Tab in #code
    await ok('browser_fill', { selector: '#guarded', value: 'g' });
    assert.match(await ok('browser_press_key', { key: 'Enter', selector: '#guarded' }), /the page's keydown handler prevented the default action/);
    assert.match(await ok('browser_press_key', { key: 'x', selector: '#guarded' }), /prevented the default action; the field now contains "g"$/);
    assert.match(await ok('browser_press_key', { key: 'Tab', selector: '#code' }), /prevented the default action$/);
    // Enter in a form with a default button clicks it (its click handler runs) and submits
    assert.match(await ok('browser_press_key', { key: 'Enter', selector: '#plain2' }), /; submitted the form via button "Save" \(ref e\d+\)$/);
    const log = await pageLog();
    for (const entry of ['inform clicked', 'guarded prevented Enter', 'guarded prevented x', 'code kept Tab', 'save clicked,jsform submitted']) {
      assert.ok(log.includes(entry), `missing "${entry}" in ${log}`);
    }
    assert.ok(!log.includes('jsform submitted,jsform submitted'), log);
    assert.equal(fx.requests.slice(before).filter((r) => r.url.startsWith('/echo')).length, 0, 'no form was sent to the server');

    // a single text field without a button submits on Enter
    assert.match(await ok('browser_type', { selector: '#single-q', text: 'solo', submit: true }), /The page navigated to .*\/echo\?single=solo/);

    // Shift is reported to the page, focus/blur events fire, radio groups are one tab stop
    await open('edge-inputs.html');
    assert.match(await ok('browser_press_key', { key: 'Shift+Tab', selector: '#num' }), /focus moved to input\[email\] "Mail"/);
    assert.match(await ok('browser_press_key', { key: 'Tab' }), /focus moved to input\[number\] "Num"/);
    assert.match(await ok('browser_press_key', { key: 'Tab', selector: '#nav' }), /focus moved to input\[radio\] "Small"/);
    assert.match(await ok('browser_press_key', { key: 'Tab' }), /focus moved to input "single"/);
    const log2 = await pageLog();
    assert.match(log2, /focus:num,shift:Tab,blur:num,focus:mail,blur:mail,focus:num/);
  });

  test('fill and type report navigation, type does not insert twice, disabled options are refused, scroll events are trusted', async () => {
    await open('edge-inputs.html');
    assert.match(await ok('browser_fill', { selector: '#nav', value: 'B' }), /^Selected "B" \(value b\) in select .*\nThe page navigated to .*\/page2\.html\?nav=b/);

    await open('edge-inputs.html');
    assert.match(await ok('browser_type', { selector: '#chips', text: 'red,' }), /now contains ""$/);
    assert.equal(await ok('browser_evaluate', { expression: "document.querySelectorAll('#chip-list li').length" }), '1');

    await fails('browser_select_option', { selector: '#opts', value: 'Two' }, /Option "Two" \(value 2\) is disabled/);
    assert.match(await ok('browser_select_option', { selector: '#opts', value: 'Three' }), /^Selected "Three"/);

    // clicking a field (or its label) focuses it, so a key pressed without a target goes there
    await ok('browser_click', { selector: '#num' });
    assert.match(await ok('browser_press_key', { key: '5' }), /^Pressed "5" on the focused input\[number\] "Num" \(ref e\d+\); the field now contains "125"$/);
    await ok('browser_click', { selector: 'label[for=mail]' });
    assert.match(await ok('browser_press_key', { key: 'z' }), /^Pressed "z" on the focused input\[email\] "Mail" \(ref e\d+\); the field now contains "abz"$/);
    assert.match(await pageLog(), /focus:num,blur:num,focus:mail/);

    // typing into a contenteditable element keeps its markup
    assert.match(await ok('browser_type', { selector: '#rich', text: ' world' }), /now contains "Hello bold world"$/);
    assert.equal(await ok('browser_evaluate', { expression: "document.getElementById('rich').innerHTML" }), '<p>Hello <b>bold world</b></p>');

    // moving focus between fields fires blur on the previous one
    await ok('browser_fill', { selector: '#mail', value: 'a@b.c' });
    await ok('browser_fill', { selector: '#num', value: '7' });
    assert.match(await pageLog(), /focus:mail,blur:mail,focus:num/);

    await ok('browser_scroll', { direction: 'down', amount: 200 });
    assert.match(await pageLog(), /scroll:true/);
  });

  test('secrets typed into password fields never reach the logs', async () => {
    if (!srv.logDir) return; // external server: logs live in the container
    await open('form.html');
    const snap = await snapshot();
    const pwRef = refOf(snap, 'Password');
    await ok('browser_fill', { ref: pwRef, value: 'RefFilledSecret#1' });
    await ok('browser_type', { ref: pwRef, text: 'RefTypedSecret#2' });
    await ok('browser_press_key', { key: 'Backspace', ref: pwRef });
    // the character is not echoed back either (results are logged and shown on the dashboard)
    assert.equal(await ok('browser_press_key', { key: '§', ref: pwRef }), `Pressed a character (hidden) on input[password] "Password" (ref ${pwRef})`);
    await new Promise((r) => setTimeout(r, 400));
    const logs = srv.logs();
    const cdpLogs = JSON.stringify(logs.filter((l) => l.component === 'cdp'));
    assert.ok(cdpLogs.includes('Input.insertText'), 'CDP traffic is logged');
    assert.ok(!cdpLogs.includes('§'), 'a character typed into a password field with press_key is not in the CDP logs');
    assert.ok(!JSON.stringify(logs).includes('§'), 'nor anywhere else in the logs');
    assert.ok(logs.some((l) => l.component === 'tool' && l.tool === 'browser_fill'), 'tool calls are logged');
    const all = JSON.stringify(logs);
    for (const secret of ['Pa55word-typed-by-fill', 'typed-secret-1', 'hunter2-submit', 'RefFilledSecret#1', 'RefTypedSecret#2']) {
      assert.ok(!all.includes(secret), `secret ${secret} leaked into the logs`);
    }
  });

  test('press_key sets the legacy keyCode so keyCode-based handlers (e.keyCode===13) fire', async () => {
    await open('keycode.html');
    await ok('browser_type', { selector: '#box', text: 'first todo' });
    await ok('browser_press_key', { key: 'Enter', selector: '#box' });
    assert.equal(await ok('browser_evaluate', { expression: "document.querySelectorAll('#list li').length" }), '1');
    assert.match(await ok('browser_evaluate', { expression: "document.querySelector('#list li').textContent" }), /kc=13 which=13/);
    // browser_type submit:true delivers a keyCode-13 keydown too
    await ok('browser_type', { selector: '#box', text: 'second todo', submit: true });
    assert.equal(await ok('browser_evaluate', { expression: "document.querySelectorAll('#list li').length" }), '2');
  });

  test('check keeps a React-controlled checkbox checked and reports success only when it sticks', async () => {
    await open('react-checkbox.html');
    const res = await ok('browser_check', { selector: '#cb' });
    assert.match(res, /^Checked input\[checkbox\]/, res);
    // the controlled component reverts a raw .checked change on its next frame; the state must survive it
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(await ok('browser_evaluate', { expression: "document.getElementById('cb').checked" }), 'true', 'the controlled checkbox stayed checked');
    assert.equal(await ok('browser_evaluate', { expression: "document.getElementById('status').textContent" }), 'state=true');
  });

  test('wait_for_text finds an on-screen inline element even when Obscura gives it a 0x0 box', async () => {
    await open('inline-box.html');
    // browser_snapshot shows the text, so the wait tools must not contradict it by reporting it hidden/gone
    const snap = await snapshot();
    assert.match(snap, /Inline after block phrase/, snap);
    assert.match(await ok('browser_wait_for_text', { text: 'Inline after block phrase', timeout: 3 }), /Found text "Inline after block phrase"/);
    const started = Date.now();
    await fails('browser_wait_for_text', { text: 'Inline after block phrase', gone: true, timeout: 0.5 }, /still visible/);
    assert.ok(Date.now() - started >= 450, 'gone:true succeeded instantly for on-screen text');
  });
});
