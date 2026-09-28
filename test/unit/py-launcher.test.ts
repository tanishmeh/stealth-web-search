import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LAUNCHER = path.join(ROOT, 'scripts', 'py.mjs');
// a plain .mjs module: imported untyped
const py: any = await import(pathToFileURL(LAUNCHER).href);
const temp = mkdtempSync(path.join(tmpdir(), 'sbm-py-launcher-'));
let counter = 0;

function launch(args: string[], env: Record<string, string | undefined> = {}) {
  const res = spawnSync(process.execPath, [LAUNCHER, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: res.status, signal: res.signal, stdout: res.stdout, stderr: res.stderr };
}

/** An empty file marked executable, standing in for a program. */
function fakeProgram(file: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '', { mode: 0o755 });
  return file;
}

/** A checkout with only python/pyproject.toml, and a PATH folder with nothing on it. */
function fakeRoot() {
  const root = path.join(temp, `root-${++counter}`);
  mkdirSync(path.join(root, 'python'), { recursive: true });
  copyFileSync(path.join(ROOT, 'python', 'pyproject.toml'), path.join(root, 'python', 'pyproject.toml'));
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  return { root, bin, env: { PATH: bin } };
}

const systemPython = py.findInterpreter([3, 9]);

describe('scripts/py.mjs', () => {
  after(() => rmSync(temp, { recursive: true, force: true }));

  test('tries py -3 first on Windows and python3 first elsewhere', () => {
    assert.deepEqual(py.interpreterCandidates('win32'), [['py', '-3'], ['python'], ['python3']]);
    const posix = py.interpreterCandidates('linux');
    assert.deepEqual(posix.slice(0, 2), [['python3'], ['python']]);
    assert.ok(posix.some((c: string[]) => c[0] === 'python3.10'));
    // the standard-library scripts support 3.9: where python3 is older (Enterprise Linux 8), python3.9 may be the one
    assert.deepEqual(posix.at(-1), ['python3.9']);
  });

  test('finds a Python that is on PATH only under a versioned name', { skip: (process.platform === 'win32' || !systemPython) && 'POSIX with Python only' }, () => {
    const { root, bin, env } = fakeRoot();
    const real = spawnSync(systemPython.cmd[0], [...systemPython.cmd.slice(1), '-c', 'import os, sys; print(os.path.realpath(sys.executable))'], { encoding: 'utf8' });
    symlinkSync(real.stdout.trim(), path.join(bin, 'python3.9'));
    const plan = py.planScript('s.py', ['a'], { root, env });
    assert.deepEqual(plan, { route: 'system', file: 'python3.9', args: ['s.py', 'a'] });
  });

  test('reads the package commands from pyproject.toml, and each points at a module that exists', () => {
    const entries: Map<string, string> = py.readEntryPoints();
    assert.deepEqual([...entries.keys()].sort(), ['sws-agents-e2e', 'sws-lmstudio-agent', 'sws-lmstudio-e2e', 'sws-site', 'sws-tools']);
    for (const target of entries.values()) {
      const [module, fn] = target.split(':');
      assert.equal(fn, 'main');
      assert.ok(existsSync(path.join(ROOT, 'python', 'src', ...module.split('.')) + '.py'), target);
    }
  });

  test('finds executables on PATH, only .exe/.com on Windows', () => {
    const { bin } = fakeRoot();
    fakeProgram(path.join(bin, 'uv'));
    assert.equal(py.which('uv', { PATH: bin }, 'linux'), path.join(bin, 'uv'));
    assert.equal(py.which('uv', { PATH: bin }, 'win32'), null);
    fakeProgram(path.join(bin, 'tool.cmd'));
    assert.equal(py.which('tool', { PATH: bin }, 'win32'), null);
    fakeProgram(path.join(bin, 'tool.exe'));
    assert.equal(py.which('tool', { PATH: bin }, 'win32'), path.join(bin, 'tool.exe'));
  });

  test('package commands: uv first, then python/.venv, then nothing', { skip: process.platform === 'win32' }, () => {
    const { root, bin, env } = fakeRoot();
    assert.equal(py.planPackageCommand('sws-tools', [], { root, env }), null);

    const venvTool = fakeProgram(path.join(root, 'python', '.venv', 'bin', 'sws-tools'));
    const venvPlan = py.planPackageCommand('sws-tools', ['a b', '--', '-x'], { root, env });
    assert.deepEqual({ ...venvPlan, env: undefined }, { route: 'venv', file: venvTool, args: ['a b', '--', '-x'], env: undefined });
    // the checkout's source comes first on the path, whatever the venv's editable install does
    assert.equal(venvPlan.env.PYTHONPATH, path.join(root, 'python', 'src'));
    assert.equal(py.planPackageCommand('sws-tools', [], { root, env: { ...env, PYTHONPATH: '/x' } }).env.PYTHONPATH, `${path.join(root, 'python', 'src')}:/x`);

    const uv = fakeProgram(path.join(bin, 'uv'));
    const uvPlan = py.planPackageCommand('sws-tools', ['a b'], { root, env });
    assert.deepEqual([uvPlan.route, uvPlan.file, uvPlan.args], ['uv', uv, ['run', '--project', path.join(root, 'python'), 'sws-tools', 'a b']]);
    assert.equal(uvPlan.env.PYTHONPATH, path.join(root, 'python', 'src'));
    // SWS_PY_RUNNER forces a route
    assert.equal(py.planPackageCommand('sws-tools', [], { root, env: { ...env, SWS_PY_RUNNER: 'venv' } }).route, 'venv');
    // commands that pyproject.toml does not declare are never run
    assert.equal(py.planPackageCommand('not-declared', [], { root, env }), null);
  });

  test('dev tools run from python/ with the dev extra', { skip: process.platform === 'win32' }, () => {
    const { root, bin, env } = fakeRoot();
    const uv = fakeProgram(path.join(bin, 'uv'));
    const cwd = path.join(root, 'python');
    const plan = py.planDevTool('pytest', ['-k', 'x'], { root, env });
    assert.deepEqual([plan.route, plan.cwd, plan.file, plan.args], ['uv', cwd, uv, ['run', '--project', cwd, '--extra', 'dev', 'pytest', '-k', 'x']]);
    assert.equal(plan.env.PYTHONPATH, path.join(cwd, 'src'));
  });

  test('standard-library scripts fall back to python/.venv, then to uv', { skip: process.platform === 'win32' }, () => {
    const { root, bin, env } = fakeRoot();
    assert.equal(py.planScript('s.py', [], { root, env }), null);
    const uv = fakeProgram(path.join(bin, 'uv'));
    assert.deepEqual(py.planScript('s.py', ['a'], { root, env }), { route: 'uv', file: uv, args: ['run', '--no-project', '--python', '>=3.9', 's.py', 'a'] });
    const venvPython = fakeProgram(path.join(root, 'python', '.venv', 'bin', 'python'));
    assert.deepEqual(py.planScript('s.py', ['a'], { root, env }), { route: 'venv', file: venvPython, args: ['s.py', 'a'] });
    // an explicit PYTHON that does not work is an error, not a reason to look elsewhere
    assert.equal(py.planScript('s.py', [], { root, env: { ...env, PYTHON: path.join(bin, 'missing') } }), null);
  });

  test('runs a standard-library script with the arguments unchanged and its exit code', { skip: !systemPython && 'no Python 3.9+ on PATH' }, () => {
    const script = path.join(temp, 'echo_args.py');
    writeFileSync(script, 'import json, sys\nprint(json.dumps(sys.argv[1:]))\nsys.exit(7)\n');
    const args = ['a b', '--', '--flag', 'ü 🚀', '', '"quoted"'];
    const r = launch(['script', script, ...args]);
    assert.equal(r.code, 7, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), args);
  });

  test('ends the way the script ended when a signal stops it', { skip: (process.platform === 'win32' || !systemPython) && 'POSIX with Python only' }, () => {
    const script = path.join(temp, 'self_term.py');
    writeFileSync(script, 'import os, signal, time\nos.kill(os.getpid(), signal.SIGTERM)\ntime.sleep(10)\n');
    const r = launch(['script', script]);
    assert.ok(r.signal === 'SIGTERM' || r.code === 143, `code ${r.code}, signal ${r.signal}`);
  });

  test('says how to set up and exits 127 when no Python can run it', () => {
    const r = launch(['script', 'whatever.py'], { PYTHON: path.join(temp, 'no-such-python') });
    assert.equal(r.code, 127);
    assert.match(r.stderr, /is not a working Python 3\.9 or newer/);
  });

  test('py:setup: PYTHON picks the interpreter on the uv route too, and pip installs the versions of uv.lock', () => {
    const project = path.join(ROOT, 'python');
    assert.deepEqual(py.uvSyncArgs(project, {}), ['sync', '--project', project, '--extra', 'dev']);
    assert.deepEqual(py.uvSyncArgs(project, { PYTHON: '/opt/py/bin/python3.12' }), ['sync', '--project', project, '--extra', 'dev', '--python', '/opt/py/bin/python3.12']);
    assert.deepEqual(py.pipInstallArgs(project), [
      '-m', 'pip', 'install', '--disable-pip-version-check', '-c', path.join(project, 'constraints.txt'), '-e', `${project}[dev]`,
    ]);
    // a checkout without constraints.txt still installs
    const { root } = fakeRoot();
    assert.ok(!py.pipInstallArgs(path.join(root, 'python')).includes('-c'));
  });

  test('rejects an SWS_PY_RUNNER it does not know, instead of saying nothing is set up', () => {
    const r = launch(['run', 'sws-tools', '--version'], { SWS_PY_RUNNER: 'bogus' });
    assert.equal(r.code, 2);
    assert.equal(r.stderr, 'SWS_PY_RUNNER must be one of uv, venv, system, got "bogus".\n');
  });

  describe('Ctrl+C and SIGINT', { skip: (process.platform === 'win32' || !systemPython) && 'POSIX with Python only' }, () => {
    // counts the SIGINTs it gets, and exits 0.3 s after the first with 100 + that count (100: none in 10 s)
    const script = path.join(temp, 'count_sigint.py');
    writeFileSync(
      script,
      [
        'import signal, sys, time',
        'got = []',
        'signal.signal(signal.SIGINT, lambda *_: got.append(time.monotonic()))',
        'print("ready", flush=True)',
        'end = time.monotonic() + 10',
        'while time.monotonic() < end and not (got and time.monotonic() - got[0] > 0.3):',
        '    time.sleep(0.01)',
        'sys.exit(100 + len(got))',
        '',
      ].join('\n'),
    );

    /** Start the launcher in a process group of its own; `send` gets its pid when the script is ready. */
    function runAndSignal(send: (pid: number) => void) {
      return new Promise<{ code: number | null; ms: number }>((resolve, reject) => {
        const child = spawn(process.execPath, [LAUNCHER, 'script', script], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
        let sent = 0;
        child.stdout.setEncoding('utf8').on('data', (d: string) => {
          if (!sent && d.includes('ready')) {
            sent = performance.now();
            send(child.pid!);
          }
        });
        child.on('error', reject);
        child.on('exit', (code) => resolve({ code, ms: performance.now() - sent }));
      });
    }

    test('a SIGINT sent to the launcher alone (npm, an IDE, kill -INT) reaches the script once', async () => {
      const r = await runAndSignal((pid) => process.kill(pid, 'SIGINT'));
      assert.equal(r.code, 101, 'the script got exactly one SIGINT');
      assert.ok(r.ms < py.SIGINT_GRACE_MS + 3000, `stopped ${Math.round(r.ms)} ms after the signal`);
    });

    test('a terminal Ctrl+C (the whole process group) is not passed on a second time', async () => {
      const r = await runAndSignal((pid) => process.kill(-pid, 'SIGINT'));
      assert.equal(r.code, 101, 'the script got exactly one SIGINT');
    });
  });

  test('rejects unknown modes and commands with exit code 2', () => {
    const noMode = launch([]);
    assert.equal(noMode.code, 2);
    assert.match(noMode.stderr, /Usage: node scripts\/py\.mjs/);
    const unknown = launch(['run', 'no-such-command']);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /Unknown command: no-such-command\. Commands: sws-tools, sws-lmstudio-agent/);
  });

  test('runs a package command end to end', { skip: !py.planPackageCommand('sws-tools', []) && 'set up with npm run py:setup or install uv' }, () => {
    const version = launch(['run', 'sws-tools', '--version']);
    assert.equal(version.code, 0, version.stderr);
    assert.match(version.stdout, /^stealth-web-search-tools \d+\.\d+\.\d+/);
    const usage = launch(['run', 'sws-tools', 'info', 'a b', '--no-such-option']);
    assert.equal(usage.code, 2);
    assert.match(usage.stderr, /unrecognized arguments: a b --no-such-option/);
  });
});
