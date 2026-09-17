import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.ts';
import { startTestServer, type TestServer } from '../helpers/harness.ts';

interface Field {
  ref: string;
  tag: string;
  type: string;
  name: string;
  label: string;
  value: string;
  checked?: boolean;
  required?: boolean;
  disabled?: boolean;
  options?: Array<{ value: string; text: string }>;
}
interface Form {
  index: number;
  id: string;
  name: string;
  action: string;
  method: string;
  fields: Field[];
}

/** browser_detect_forms and browser_fill_form against test/fixtures/site/form.html. */
describe('form tools', () => {
  let fx: FixtureServer;
  let srv: TestServer;
  const SECRET = 'Form-Secret-Passw0rd!';

  before(async () => {
    fx = await startFixtureServer();
    srv = await startTestServer();
  });
  after(async () => {
    await srv?.stop();
    await fx?.close();
  });

  const call = async (name: string, args: Record<string, unknown> = {}) => srv.call(name, args);
  const ok = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await call(name, args);
    assert.equal(r.isError, false, `${name} ${JSON.stringify(args)} -> ${r.text}`);
    return r.text;
  };
  const open = (page: string) => ok('browser_navigate', { url: `${fx.baseUrl}/${page}` });
  const detect = async (): Promise<Form[]> => {
    const text = await ok('browser_detect_forms');
    assert.match(text, /^Found \d+ forms?\. Pass field refs to browser_fill_form/);
    return JSON.parse(text.slice(text.indexOf('\n') + 1)) as Form[];
  };
  const field = (form: Form, name: string, value?: string) => {
    const f = form.fields.find((x) => x.name === name && (value === undefined || x.value === value));
    assert.ok(f, `field ${name} not found in ${JSON.stringify(form.fields)}`);
    return f;
  };

  test('detect_forms lists forms and fields with refs, masks passwords, and refs work', async () => {
    await open('form.html');
    await ok('browser_fill', { selector: '#password', value: 'mask-me-please' });
    const forms = await detect();
    assert.equal(forms.length, 2);
    const [signup, search] = forms as [Form, Form];
    assert.equal(signup.id, 'signup');
    assert.equal(signup.method, 'post');
    assert.match(signup.action, /\/echo$/);
    assert.equal(search.method, 'get');

    const email = field(signup, 'email');
    assert.match(email.ref, /^e\d+$/);
    assert.equal(email.label, 'Email address');
    assert.equal(email.type, 'email');
    assert.equal(email.required, true, 'required comes from the attribute');
    assert.equal(field(signup, 'password').value, '••••');
    assert.equal(field(signup, 'agree').checked, false);
    assert.equal(field(signup, 'plan', 'free').checked, true);
    assert.deepEqual(field(signup, 'color').options, [
      { value: 'r', text: 'Red' },
      { value: 'g', text: 'Green' },
      { value: 'b', text: 'Blue' },
    ]);
    assert.ok(!signup.fields.some((f) => f.name === 'csrf'), 'hidden inputs are skipped');
    assert.ok(!JSON.stringify(forms).includes('mask-me-please'));
    assert.equal(new Set(signup.fields.map((f) => f.ref)).size, signup.fields.length, 'refs are unique');

    // refs from detect_forms are accepted by the other tools and stay stable
    assert.match(await ok('browser_fill', { ref: email.ref, value: 'ref@x.co' }), new RegExp(`\\(ref ${email.ref}\\) with "ref@x\\.co"`));
    assert.match(await ok('browser_check', { ref: field(signup, 'agree').ref }), /^Checked input\[checkbox\] "I agree"/);
    const again = await detect();
    assert.equal(field(again[0]!, 'email').ref, email.ref);
    assert.equal(field(again[0]!, 'email').value, 'ref@x.co');
    assert.equal(field(again[0]!, 'agree').checked, true);

    await open('page2.html');
    assert.match(await ok('browser_detect_forms'), /^No forms found on this page\./);
  });

  test('fill_form fills every field type, clicks submit and returns the fully loaded result page', async () => {
    await open('form.html');
    const [signup] = await detect();
    const before = fx.requests.length;
    const text = await ok('browser_fill_form', {
      fields: [
        { ref: field(signup!, 'email').ref, value: 'form@x.co' },
        { ref: field(signup!, 'password').ref, value: SECRET },
        { selector: '#nickname', value: 'nick' },
        { ref: field(signup!, 'agree').ref, value: 'true' },
        { selector: '#plan-pro', type: 'check' },
        { ref: field(signup!, 'color').ref, value: 'Blue' },
        { selector: '#bio', type: 'text', value: 'multi\nline' },
      ],
      submit_ref: signup!.fields.find((f) => f.tag === 'button')!.ref,
    });
    assert.match(text, /^Filled 7 of 7 fields\.\nClicked button\[submit\] "Send" \(ref e\d+\) to submit\.\nThe page navigated to http:\/\/.+\/echo — "Echo"\. Element refs were reset/);
    assert.ok(!text.includes(SECRET));

    const posts = fx.requests.slice(before).filter((r) => r.method === 'POST' && r.url === '/echo');
    assert.equal(posts.length, 1, 'submitted exactly once');
    const body = new URLSearchParams(posts[0]!.body);
    assert.equal(body.get('email'), 'form@x.co');
    assert.equal(body.get('password'), SECRET);
    assert.equal(body.get('nickname'), 'nick');
    assert.equal(body.get('csrf'), 'tok');
    assert.equal(body.get('agree'), 'yes');
    assert.equal(body.get('plan'), 'pro');
    assert.equal(body.get('color'), 'b');
    assert.match(body.get('bio') ?? '', /^multi\r?\nline$/);

    // the navigation finished before fill_form returned: the next call sees the result page
    const page = await ok('browser_snapshot', { include_elements: false });
    assert.match(page, /^Title: Echo$/m);
    assert.match(page, /email=form%40x\.co/);
  });

  test('fill_form reports per-field errors, does not submit a partially filled form, and uncheck works', async () => {
    await open('form.html');
    await ok('browser_check', { selector: '#agree' });
    const before = fx.requests.length;
    const partial = await call('browser_fill_form', {
      fields: [
        { selector: '#nope', value: 'x' },
        { selector: '#readonly', value: 'y' },
        { selector: '#nickname', value: 'kept' },
        { selector: '#agree', value: 'maybe' },
        { selector: '#color', value: 'Purple' },
        { selector: '#agree', type: 'uncheck' },
      ],
      submit_selector: '#submit',
    });
    assert.equal(partial.isError, false, partial.text);
    assert.match(partial.text, /^Filled 2 of 6 fields\.\nErrors:\n/);
    assert.match(partial.text, /- Element not found: selector "#nope"/);
    assert.match(partial.text, /- input "readonly" \(selector "#readonly"\) is read-only/);
    assert.match(partial.text, /- selector "#agree": value "maybe" is not valid for a checkbox\/radio/);
    assert.match(partial.text, /- Option "Purple" not found in select "color" \(selector "#color"\)\. Available options: "Red" \(value r\)/);
    assert.match(partial.text, /The form was not submitted because some fields failed/);
    assert.equal(fx.requests.length, before, 'nothing was submitted');

    const snap = await ok('browser_snapshot');
    assert.match(snap, /name="nickname" value="kept"/);
    assert.match(snap, /name="agree" unchecked/);

    const allFailed = await call('browser_fill_form', { fields: [{ selector: '#nope', value: 'x' }, { value: 'no target' }] });
    assert.equal(allFailed.isError, true);
    assert.match(allFailed.text, /^Error: Filled 0 of 2 fields\./);
    assert.match(allFailed.text, /field 2: provide 'ref' or 'selector'/);

    const badSubmit = await call('browser_fill_form', { fields: [{ selector: '#nickname', value: 'z' }], submit_selector: '#missing-button' });
    assert.equal(badSubmit.isError, false);
    assert.match(badSubmit.text, /^Filled 1 of 1 field\.\nCould not submit: Element not found: selector "#missing-button"$/);

    // GET form via submit_selector
    const search = await ok('browser_fill_form', { fields: [{ selector: '#q', value: 'forms rock' }], submit_selector: '#go' });
    assert.match(search, /navigated to .*\/echo\?q=forms\+rock/);
    assert.ok(fx.requests.some((r) => r.method === 'GET' && r.url === '/echo?q=forms+rock'));

    // a slow response: fill_form only returns once the result page has loaded
    await open('slow-form.html');
    const started = Date.now();
    const slow = await ok('browser_fill_form', { fields: [{ selector: '#ms', value: '700' }], submit_selector: '#go' });
    assert.ok(Date.now() - started >= 650, 'waited for the slow response');
    assert.match(slow, /The page navigated to .*\/slow\?ms=700 — "Slow"/);
    assert.match(await ok('browser_snapshot', { include_elements: false }), /waited 700 ms/);
  });

  test('detect_forms labels wrapped controls, flags multi-selects, caps long lists and masks one-time codes', async () => {
    await open('form.html');
    const [signup] = await detect();
    assert.equal(field(signup!, 'agree').label, 'I agree');
    assert.equal(field(signup!, 'plan', 'pro').label, 'Pro');
    assert.equal((field(signup!, 'multi') as Field & { multiple?: boolean }).multiple, true);
    assert.equal(signup!.fields.find((f) => f.tag === 'button')!.label, 'Send');

    await open('edge-inputs.html');
    const forms = await detect();
    const jsform = forms.find((f) => f.id === 'jsform')!;
    const many = field(jsform, 'many') as Field & { more_options?: number };
    assert.equal(many.options!.length, 25);
    assert.equal(many.more_options, 55);
    assert.equal(field(jsform, 'verification').value, '••••');
  });

  test('fill_form checks radios by value or label and stops when a field navigates the page', async () => {
    await open('form.html');
    assert.match(await ok('browser_fill_form', { fields: [{ selector: '#plan-free', value: 'pro' }] }), /^Filled 1 of 1 field\.$/);
    assert.match(await ok('browser_snapshot'), /input\[radio\]\s+"Pro" name="plan" checked/);
    await ok('browser_fill_form', { fields: [{ selector: 'input[name=plan]', value: 'Free' }] });
    assert.match(await ok('browser_snapshot'), /input\[radio\]\s+"Free" name="plan" checked/);
    const bad = await call('browser_fill_form', { fields: [{ selector: 'input[name=plan]', value: 'enterprise' }] });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /no radio button in group "plan" has the value or label "enterprise"; options: "Free" \(value free\), "Pro" \(value pro\)/);

    await open('edge-inputs.html');
    const before = fx.requests.length;
    const nav = await call('browser_fill_form', {
      fields: [
        { selector: '#nav', value: 'b' },
        { selector: '#mail', value: 'late@x.co' },
      ],
      submit_selector: '#inform',
    });
    assert.equal(nav.isError, false, nav.text);
    assert.match(nav.text, /^Filled 1 of 2 fields\.\nThe page navigated while filling field 1 \(selector "#nav"\); the remaining 1 field was not filled and the form was not submitted\.\nThe page navigated to .*\/page2\.html\?nav=b/);
    assert.equal(fx.requests.slice(before).filter((r) => r.url.startsWith('/echo')).length, 0);

    // a same-document URL change (history.replaceState) keeps refs valid and does not stop filling
    await open('edge-inputs.html');
    const jsform = (await detect()).find((f) => f.id === 'jsform')!;
    const synced = await ok('browser_fill_form', {
      fields: [
        { selector: '#sort', value: 'Descending' },
        { ref: field(jsform, 'plain2').ref, value: 'after sort' },
      ],
      submit_ref: jsform.fields.find((f) => f.tag === 'button')!.ref,
    });
    assert.match(
      synced,
      /^Filled 2 of 2 fields\.\nThe URL changed to .*\/edge-inputs\.html\?sort=desc while filling \(same page, no reload; element refs are still valid\)\.\nClicked button "Save" \(ref e\d+\) to submit\./,
    );
    assert.equal(await ok('browser_evaluate', { expression: "document.getElementById('plain2').value" }), 'after sort');
    assert.match(await ok('browser_evaluate', { expression: "document.getElementById('log').textContent" }), /save clicked,jsform submitted/);
  });

  test('password values from fill_form never appear in the server logs', async () => {
    if (!srv.logDir) return; // external server: logs live in the container
    await open('form.html');
    const [signup] = await detect();
    await ok('browser_fill_form', {
      fields: [
        { ref: field(signup!, 'password').ref, value: 'Second-Secret-Value' },
        { selector: '#password', value: 'Third-Secret-Value' },
      ],
    });
    await new Promise((r) => setTimeout(r, 400));
    const logs = srv.logs();
    assert.ok(logs.some((l) => l.component === 'tool' && l.tool === 'browser_fill_form'), 'fill_form calls are logged');
    assert.ok(logs.some((l) => l.component === 'cdp'), 'CDP traffic is logged');
    const all = JSON.stringify(logs);
    for (const secret of [SECRET, 'mask-me-please', 'Second-Secret-Value', 'Third-Secret-Value']) {
      assert.ok(!all.includes(secret), `secret ${secret} leaked into the logs`);
    }
  });
});
