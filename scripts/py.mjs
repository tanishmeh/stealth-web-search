#!/usr/bin/env node
/**
 * Runs the repository's Python tools for the npm scripts, on macOS, Linux and Windows.
 *
 *   node scripts/py.mjs run <command> [args...]     a command of the python/ package (sws-lmstudio-agent, ...)
 *   node scripts/py.mjs script <file.py> [args...]  a standard-library script (any Python 3.9 or newer)
 *   node scripts/py.mjs setup                       python/.venv with the package and its dev tools (npm run py:setup)
 *   node scripts/py.mjs pytest [args...]            the Python tests, run from python/ (npm run test:py)
 *   node scripts/py.mjs lint [--fix]                ruff over python/ and scripts/*.py (npm run lint:py)
 *
 * Package commands run with `uv run --project python` when uv is on PATH, else from python/.venv,
 * else with a Python 3.10+ that already has the package; SWS_PY_RUNNER=uv|venv|system forces one.
 * Package commands and dev tools get python/src first on PYTHONPATH, so the checkout's source runs.
 * Standard-library scripts run with $PYTHON, else the first Python 3.9+ among python3, python and python3.X
 * (`py -3` first on Windows), else python/.venv, else `uv run --no-project`.
 * Arguments are passed on unchanged, and the tool's exit code (or the signal that ended it) becomes
 * this process's. When nothing can run the command, it says how to set up and exits with 127.
 * SIGTERM and SIGHUP are passed on to the tool; so is a SIGINT sent to this process alone (see execute).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { constants } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Exit code when no Python can run the command (the shell's "command not found"). */
export const NOT_SET_UP = 127;
export const USAGE_ERROR = 2;

const PACKAGE_MIN = [3, 10];
const SCRIPT_MIN = [3, 9];
const RUNNERS = ['uv', 'venv', 'system'];
/** How long a SIGINT this process gets waits before it is passed on to a tool that is still running. */
export const SIGINT_GRACE_MS = 1000;
const UV_INSTALL = 'https://docs.astral.sh/uv/getting-started/installation/';

const USAGE = `Usage: node scripts/py.mjs <mode> ...
  run <command> [args...]      run a command of the python/ package
  script <file.py> [args...]   run a standard-library Python script
  setup                        create python/.venv with the package and its dev tools
  pytest [args...]             run the Python tests (from python/)
  lint [--fix]                 ruff check and format check (python/ and scripts/*.py)`;

/** Full path of an executable on PATH, or null. */
export function which(name, env = process.env, platform = process.platform) {
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  // .cmd/.bat shims cannot be spawned without a shell, so only real executables count on Windows
  const exts = platform === 'win32' ? ['.exe', '.com'] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        if (statSync(file).isFile()) return file;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/** Interpreter commands to try, in order. */
export function interpreterCandidates(platform = process.platform) {
  if (platform === 'win32') return [['py', '-3'], ['python'], ['python3']];
  // versioned names too: python3 may be older than 3.9 (e.g. Enterprise Linux 8, where python39 is an add-on)
  return [['python3'], ['python'], ...['3.14', '3.13', '3.12', '3.11', '3.10', '3.9'].map((v) => [`python${v}`])];
}

/** [major, minor] >= min */
export function atLeast(version, min) {
  return version[0] > min[0] || (version[0] === min[0] && version[1] >= min[1]);
}

/**
 * The version of a Python command as [major, minor], or null when it does not run (missing, the
 * Windows Store alias, a broken venv). With `requirePackage`, also null when it cannot import sws_tools.
 */
export function probe(cmd, { env = process.env, requirePackage = false } = {}) {
  const check = requirePackage ? 'import importlib.util as u; u.find_spec("sws_tools") or sys.exit(3); ' : '';
  const code = `import sys; ${check}print("%d.%d" % sys.version_info[:2])`;
  const res = spawnSync(cmd[0], [...cmd.slice(1), '-c', code], {
    encoding: 'utf8',
    env,
    timeout: 30_000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const m = !res.error && res.status === 0 ? /^(\d+)\.(\d+)$/.exec(res.stdout.trim()) : null;
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** The first working Python >= min: $PYTHON when set (and only it), else the platform's candidates. */
export function findInterpreter(min, { env = process.env, platform = process.platform, requirePackage = false } = {}) {
  const candidates = env.PYTHON ? [[env.PYTHON]] : interpreterCandidates(platform);
  for (const cmd of candidates) {
    const version = probe(cmd, { env, requirePackage });
    if (version && atLeast(version, min)) return { cmd, version };
  }
  return null;
}

export function venvDir(root = ROOT) {
  return path.join(root, 'python', '.venv');
}

/** An executable inside python/.venv (bin/ on POSIX, Scripts\ with .exe on Windows). */
export function venvBin(name, { root = ROOT, platform = process.platform } = {}) {
  return platform === 'win32' ? path.join(venvDir(root), 'Scripts', `${name}.exe`) : path.join(venvDir(root), 'bin', name);
}

/** The [project.scripts] table of python/pyproject.toml: command -> "module:function". */
export function readEntryPoints(root = ROOT) {
  const entries = new Map();
  let inTable = false;
  for (const raw of readFileSync(path.join(root, 'python', 'pyproject.toml'), 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inTable = line === '[project.scripts]';
      continue;
    }
    const m = inTable ? /^"?([\w.-]+)"?\s*=\s*"([\w.]+:[\w.]+)"/.exec(line) : null;
    if (m) entries.set(m[1], m[2]);
  }
  return entries;
}

/**
 * The environment for package commands and dev tools: python/src first on PYTHONPATH, so the
 * checkout's source runs even when the editable install's .pth file is skipped (Python 3.13+ skips
 * .pth files flagged hidden, and some macOS setups flag everything inside dot-folders like .venv).
 */
export function sourceEnv(root = ROOT, env = process.env, platform = process.platform) {
  const src = path.join(root, 'python', 'src');
  const current = env.PYTHONPATH;
  return { ...env, PYTHONPATH: current ? `${src}${platform === 'win32' ? ';' : ':'}${current}` : src };
}

/** The SWS_PY_RUNNER problem to report (a value that is not uv, venv or system), or null. */
export function runnerProblem(env = process.env) {
  const forced = env.SWS_PY_RUNNER;
  return forced && !RUNNERS.includes(forced) ? `SWS_PY_RUNNER must be one of ${RUNNERS.join(', ')}, got "${forced}".` : null;
}

function routesFor(env) {
  const forced = env.SWS_PY_RUNNER;
  return forced ? [forced] : RUNNERS;
}

/** How to run a package command: { file, args, route } or null when nothing can. */
export function planPackageCommand(command, args, { root = ROOT, env = process.env, platform = process.platform } = {}) {
  const target = readEntryPoints(root).get(command);
  if (!target) return null;
  const runEnv = sourceEnv(root, env, platform);
  for (const route of routesFor(env)) {
    if (route === 'uv') {
      const uv = which('uv', env, platform);
      if (uv) return { route, env: runEnv, file: uv, args: ['run', '--project', path.join(root, 'python'), command, ...args] };
    } else if (route === 'venv') {
      const bin = venvBin(command, { root, platform });
      if (existsSync(bin)) return { route, env: runEnv, file: bin, args };
    } else if (route === 'system') {
      // the probe runs without python/src on the path: the interpreter must have the package and its dependencies
      const found = findInterpreter(PACKAGE_MIN, { env, platform, requirePackage: true });
      if (found) {
        const [module, fn] = target.split(':');
        const shim = `import sys; sys.argv[0] = ${JSON.stringify(command)}; from ${module} import ${fn} as main; sys.exit(main())`;
        return { route, env: runEnv, file: found.cmd[0], args: [...found.cmd.slice(1), '-c', shim, ...args] };
      }
    }
  }
  return null;
}

/** How to run a dev tool (pytest, ruff) from python/: uv with the dev extra, else python/.venv. */
export function planDevTool(tool, args, { root = ROOT, env = process.env, platform = process.platform } = {}) {
  const cwd = path.join(root, 'python');
  const runEnv = sourceEnv(root, env, platform);
  for (const route of routesFor(env)) {
    if (route === 'uv') {
      const uv = which('uv', env, platform);
      if (uv) return { route, cwd, env: runEnv, file: uv, args: ['run', '--project', cwd, '--extra', 'dev', tool, ...args] };
    } else if (route === 'venv') {
      const bin = venvBin(tool, { root, platform });
      if (existsSync(bin)) return { route, cwd, env: runEnv, file: bin, args };
    }
  }
  return null;
}

/** How to run a standard-library script: a system Python 3.9+, else python/.venv, else uv. */
export function planScript(file, args, { root = ROOT, env = process.env, platform = process.platform } = {}) {
  const found = findInterpreter(SCRIPT_MIN, { env, platform });
  if (found) return { route: 'system', file: found.cmd[0], args: [...found.cmd.slice(1), file, ...args] };
  if (env.PYTHON) return null; // an explicit choice that does not work is an error, not a hint to look elsewhere
  const venvPython = venvBin('python', { root, platform });
  if (existsSync(venvPython)) return { route: 'venv', file: venvPython, args: [file, ...args] };
  const uv = which('uv', env, platform);
  if (uv) return { route: 'uv', file: uv, args: ['run', '--no-project', '--python', '>=3.9', file, ...args] };
  return null;
}

/**
 * Run a plan with this terminal; resolves to { code, signal } or { error }.
 *
 * Ctrl+C in a terminal reaches the tool directly (it shares this process group), and the tool
 * decides what it means (the CLI agent stops its run; a second Ctrl+C ends it at once). A SIGINT
 * sent to this process alone (npm passing one on, an IDE's stop button, `kill -INT`) would never
 * reach it, so a SIGINT is passed on when the tool is still running `sigintGraceMs` later: a tool
 * that stops on the terminal's Ctrl+C by then never gets a second one. SIGTERM and SIGHUP are
 * passed on at once. On Windows every console process gets Ctrl+C itself, and there is no SIGINT
 * to pass on (kill() would end the tool without cleanup), so it is left alone.
 */
export function execute(plan, { sigintGraceMs = SIGINT_GRACE_MS, platform = process.platform } = {}) {
  return new Promise((resolve) => {
    const child = spawn(plan.file, plan.args, { stdio: 'inherit', cwd: plan.cwd, env: plan.env ?? process.env });
    const forward = (signal) => () => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    };
    let sigintTimer = null;
    const onSigint = () => {
      if (platform === 'win32' || sigintTimer) return; // one pass-on per grace period
      sigintTimer = setTimeout(() => {
        sigintTimer = null;
        forward('SIGINT')();
      }, sigintGraceMs);
    };
    const handlers = { SIGINT: onSigint, SIGTERM: forward('SIGTERM'), SIGHUP: forward('SIGHUP') };
    for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler);
    const done = (result) => {
      clearTimeout(sigintTimer);
      for (const [signal, handler] of Object.entries(handlers)) process.off(signal, handler);
      resolve(result);
    };
    child.once('error', (error) => done({ error }));
    child.once('exit', (code, signal) => done({ code, signal }));
  });
}

/** End this process the way the child ended. */
function finish(plan, result) {
  if (result.error) {
    console.error(`Could not start ${plan.file}: ${result.error.message}`);
    process.exit(NOT_SET_UP);
  }
  if (result.signal) {
    process.kill(process.pid, result.signal); // our handlers are gone: the default action ends us the same way
    process.exit(128 + (constants.signals[result.signal] ?? 0));
  }
  process.exit(result.code ?? 1);
}

function notSetUp(what, { root = ROOT, platform = process.platform, command } = {}) {
  const lines = [`Cannot run ${what}: the Python tools are not set up. Either`];
  lines.push(`  - install uv (${UV_INSTALL}) and run the command again, or`);
  lines.push('  - run `npm run py:setup` to create python/.venv (needs Python 3.10 or newer; set PYTHON to pick one).');
  if (command && existsSync(venvDir(root)) && !existsSync(venvBin(command, { root, platform }))) {
    lines.push(`python/.venv exists but has no ${command}: run \`npm run py:setup\` again to refresh it.`);
  }
  console.error(lines.join('\n'));
  return NOT_SET_UP;
}

function runSync(file, args, options = {}) {
  const res = spawnSync(file, args, { stdio: 'inherit', ...options });
  if (res.error) {
    console.error(`Could not start ${file}: ${res.error.message}`);
    return NOT_SET_UP;
  }
  return res.status ?? 128 + (constants.signals[res.signal] ?? 0);
}

/** The `uv sync` arguments of npm run py:setup; PYTHON, when set, picks the interpreter. */
export function uvSyncArgs(project, env = process.env) {
  return ['sync', '--project', project, '--extra', 'dev', ...(env.PYTHON ? ['--python', env.PYTHON] : [])];
}

/**
 * The `pip install` arguments of npm run py:setup without uv: the editable package with its dev
 * tools, held to the versions of uv.lock by python/constraints.txt (exported from it), so this route
 * installs what CI tests.
 */
export function pipInstallArgs(project) {
  const constraints = path.join(project, 'constraints.txt');
  return ['-m', 'pip', 'install', '--disable-pip-version-check', ...(existsSync(constraints) ? ['-c', constraints] : []), '-e', `${project}[dev]`];
}

/** npm run py:setup: uv sync when uv is installed, else python -m venv + pip install -e 'python[dev]'. */
function setup(env = process.env) {
  const project = path.join(ROOT, 'python');
  const uv = env.SWS_PY_RUNNER !== 'venv' && which('uv', env);
  if (uv) {
    console.log(`Installing the Python tools with uv into python/.venv${env.PYTHON ? ` (Python: ${env.PYTHON})` : ''}`);
    return runSync(uv, uvSyncArgs(project, env));
  }
  const venvPython = venvBin('python');
  const current = existsSync(venvPython) ? probe([venvPython], { env }) : null;
  if (!current || !atLeast(current, PACKAGE_MIN)) {
    const found = findInterpreter(PACKAGE_MIN, { env });
    if (!found) {
      console.error(
        env.PYTHON
          ? `PYTHON=${env.PYTHON} is not a working Python 3.10 or newer.`
          : `No Python 3.10 or newer found (tried ${interpreterCandidates().map((c) => c.join(' ')).join(', ')}).\n` +
              `Install one (https://www.python.org/downloads/) and set PYTHON to it if it is not on PATH, or install uv (${UV_INSTALL}).`,
      );
      return NOT_SET_UP;
    }
    console.log(`Creating python/.venv with Python ${found.version.join('.')} (${found.cmd.join(' ')})`);
    const created = runSync(found.cmd[0], [...found.cmd.slice(1), '-m', 'venv', ...(existsSync(venvDir()) ? ['--clear'] : []), venvDir()]);
    if (created !== 0) return created;
  }
  const pipVersion = () => {
    const res = spawnSync(venvPython, ['-c', 'import pip; print(pip.__version__)'], { encoding: 'utf8' });
    return res.status === 0 ? res.stdout.trim().split('.').map(Number) : null;
  };
  let pip = pipVersion();
  if (!pip) {
    const ensured = runSync(venvPython, ['-m', 'ensurepip', '--upgrade']); // a venv made by uv has no pip
    if (ensured !== 0) return ensured;
    pip = pipVersion();
  }
  if (!pip || !atLeast(pip, [21, 3])) {
    // editable installs from pyproject.toml need pip 21.3 or newer
    const upgraded = runSync(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', 'pip']);
    if (upgraded !== 0) return upgraded;
  }
  console.log('Installing the Python tools into python/.venv (pip install -e "python[dev]", versions from uv.lock)');
  const installed = runSync(venvPython, pipInstallArgs(project));
  if (installed === 0) console.log('\nDone. Try: npm run test:py');
  return installed;
}

/** npm run lint:py: ruff over the package (Python 3.10+) and the standard-library scripts (3.9+). */
async function lint(args) {
  const fix = args.includes('--fix');
  const scripts = path.join(ROOT, 'scripts');
  const runs = [
    fix ? ['check', '--fix', '.'] : ['check', '.'],
    fix ? ['format', '.'] : ['format', '--check', '.'],
    [...(fix ? ['check', '--fix'] : ['check']), '--config', 'pyproject.toml', '--target-version', 'py39', scripts],
    [...(fix ? ['format'] : ['format', '--check']), '--config', 'pyproject.toml', '--target-version', 'py39', scripts],
  ];
  let worst = 0;
  for (const ruffArgs of runs) {
    const plan = planDevTool('ruff', ruffArgs);
    if (!plan) return notSetUp('ruff', { command: 'ruff' });
    const result = await execute(plan);
    if (result.error || result.signal) finish(plan, result);
    worst = Math.max(worst, result.code ?? 1);
  }
  return worst;
}

export async function main(argv = process.argv.slice(2)) {
  const [mode, ...rest] = argv;
  const problem = runnerProblem();
  if (problem) {
    console.error(problem);
    return USAGE_ERROR;
  }
  if (mode === 'run') {
    const [command, ...args] = rest;
    const known = readEntryPoints();
    if (!command || !known.has(command)) {
      console.error(`${command ? `Unknown command: ${command}.` : 'Missing command.'} Commands: ${[...known.keys()].join(', ')}`);
      return USAGE_ERROR;
    }
    const plan = planPackageCommand(command, args);
    if (!plan) return notSetUp(command, { command });
    return finish(plan, await execute(plan));
  }
  if (mode === 'script') {
    const [file, ...args] = rest;
    if (!file) {
      console.error(USAGE);
      return USAGE_ERROR;
    }
    const plan = planScript(file, args);
    if (!plan) {
      console.error(
        process.env.PYTHON
          ? `PYTHON=${process.env.PYTHON} is not a working Python 3.9 or newer.`
          : `Cannot run ${file}: no Python 3.9 or newer found (tried ${interpreterCandidates().map((c) => c.join(' ')).join(', ')}).\n` +
              `Install Python (https://www.python.org/downloads/) or uv (${UV_INSTALL}), or set PYTHON to the interpreter.`,
      );
      return NOT_SET_UP;
    }
    return finish(plan, await execute(plan));
  }
  if (mode === 'setup') return setup();
  if (mode === 'pytest') {
    const plan = planDevTool('pytest', rest);
    if (!plan) return notSetUp('pytest', { command: 'pytest' });
    return finish(plan, await execute(plan));
  }
  if (mode === 'lint') return lint(rest);
  console.error(USAGE);
  return USAGE_ERROR;
}

function invokedDirectly() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) process.exitCode = await main();
