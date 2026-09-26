import * as z from 'zod';
import { ToolError } from '../browser/errors.ts';
import { MAIN_BROWSER } from '../dashboard/hub.ts';
import {
  SnapshotConflictError,
  SnapshotSeedConflictError,
  SnapshotSignedOutError,
  actorText,
  countsText,
  domainsText,
  normalizeFilter,
  type SaveOutcome,
  type SnapshotService,
  type SnapshotView,
} from '../snapshots/service.ts';
import { SnapshotError, SnapshotNotFoundError, normalizeSnapshotName } from '../snapshots/store.ts';
import { DESTRUCTIVE_LOCAL, LOCAL_STATE, READ_ONLY, defineTool, textResult, type ToolContext } from './types.ts';

/**
 * Snapshots: saved sign-ins (cookies and site storage for chosen sites) that a browser can load so an
 * agent does not have to sign in again. Not page snapshots: browser_snapshot reads the page. Results
 * hold names, domains and counts only, never cookie names or values.
 */

function service(ctx: ToolContext): SnapshotService {
  if (!ctx.snapshots) throw new ToolError('Snapshots are not available on this server.');
  return ctx.snapshots;
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SnapshotError) throw new ToolError(err.message);
    throw err;
  }
}

function snapshotName(input: string): string {
  try {
    return normalizeSnapshotName(input);
  } catch (err) {
    throw new ToolError((err as Error).message);
  }
}

/** Whether this server offers agent_run (as enabledTools decides: a model is configured and TOOLSETS includes it). */
function agentRunOffered(ctx: ToolContext): boolean {
  const wanted = ctx.config.browser.toolsets;
  return ctx.config.agent.enabled && ['all', 'agents', 'agent_run'].some((w) => wanted.includes(w));
}

/** "Snapshot "a" is no longer loaded in this browser: <why, singular>." or the plural form for several. */
function unloadedText(names: string[], one: string, many: string): string {
  if (!names.length) return '';
  const quoted = names.map((n) => JSON.stringify(n)).join(', ');
  return names.length === 1 ? `Snapshot ${quoted} is no longer loaded in this browser: ${one}.` : `Snapshots ${quoted} are no longer loaded in this browser: ${many}.`;
}

const nameArg = z.string().min(1).max(200).describe('Snapshot name, e.g. "amazon" (see snapshot_list)');
const descriptionArg = z
  .string()
  .min(1)
  .max(500)
  .describe('Which site and account, e.g. "Amazon — personal account (Prime)". Never put passwords or codes in it: it is shown in logs, on the dashboard and to sub-agents');

function ago(iso: string | null | undefined): string {
  const ms = iso ? Date.now() - Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return 'at an unknown time';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return 'just now';
  if (s < 3_600) return `${Math.round(s / 60)} min ago`;
  if (s < 172_800) return `${Math.round(s / 3_600)} h ago`;
  return `${Math.round(s / 86_400)} days ago`;
}

function browserLabel(id: string, ctx: ToolContext): string {
  if (id === ctx.browser.id) return 'this browser';
  if (id === MAIN_BROWSER) return 'the main browser';
  return id.startsWith('agent-') ? `sub-agent run ${id.slice(6)}` : id;
}

function listLine(v: SnapshotView, ctx: ToolContext): string {
  if (v.incomplete && v.version === undefined) {
    return `- ${v.name} — incomplete: a saved sign-in without valid metadata; it cannot be loaded. Ask your user whether to delete it (snapshot_delete).`;
  }
  const parts = [`- ${v.name} — ${v.description}`];
  const cookies = v.cookie_count ?? 0;
  parts.push(
    cookies
      ? `${cookies} cookie${cookies === 1 ? '' : 's'} for ${domainsText(v.cookie_domains ?? [])}${v.expired_count ? ` (${v.expired_count} expired)` : ''}`
      : 'no cookies',
  );
  const sites = v.origins?.length ?? 0;
  if (sites) parts.push(`storage for ${sites} site${sites === 1 ? '' : 's'}`);
  const by = v.updated_by?.run_id ? `sub-agent run ${v.updated_by.run_id}` : (v.updated_by?.client ?? 'another client');
  parts.push(`v${v.version}, updated ${ago(v.updated_at)} by ${by}`);
  if (v.loaded_in.length) {
    parts.push(`loaded in: ${v.loaded_in.map((id) => `${browserLabel(id, ctx)}${v.active_in.includes(id) ? ' (active)' : ''}`).join(', ')}`);
  }
  if (v.incomplete) parts.push('incomplete: its saved sign-in is missing, so it cannot be loaded');
  else if (v.stale) parts.push('its details may be out of date');
  return parts.join(' · ');
}

export const snapshotList = defineTool({
  name: 'snapshot_list',
  title: 'List snapshots (saved sign-ins)',
  group: 'snapshots',
  description:
    'List the saved snapshots: sign-ins (cookies and site storage) saved for chosen sites so a browser can start signed in — not page snapshots (browser_snapshot reads the page). ' +
    'Shows each one\'s name, description (site and account), sites, cookie counts and where it is loaded. Pick one by its description.',
  inputSchema: z.object({}),
  annotations: { ...READ_ONLY, openWorldHint: false, title: 'List snapshots' },
  concurrent: true,
  handler: async (_args, ctx) =>
    guard(async () => {
      const payload = await service(ctx).list();
      const loadedHere = [...ctx.browser.loadedSnapshots.keys()];
      const structured = {
        snapshots: payload.snapshots.map(({ active_in: _active, ...v }) => v),
        loaded_here: loadedHere,
        active_here: ctx.browser.activeSnapshot,
      };
      if (!payload.snapshots.length) {
        return {
          content: [
            {
              type: 'text',
              text: 'No snapshots saved yet. To create one, sign in to the site in your browser (with your user\'s help), then call snapshot_save {"name": "…", "description": "<site> — <account>"}.',
            },
          ],
          structuredContent: structured,
        };
      }
      // a real name only when there is one to use: small models copy the example, whatever its account
      const usable = payload.snapshots.filter((v) => !v.incomplete);
      const example = usable.length === 1 ? usable[0]!.name : '<name>';
      const hint = agentRunOffered(ctx)
        ? `snapshot_load {"name": "${example}"} signs your browser in; agent_run {"snapshot": "${example}", …} starts a sub-agent signed in.`
        : `snapshot_load {"name": "${example}"} signs your browser in.`;
      const text = [
        `${payload.snapshots.length} snapshot(s) (saved sign-ins):`,
        ...payload.snapshots.map((v) => listLine(v, ctx)),
        '',
        usable.length === 1 ? `Use it: ${hint}` : `Pick one by its description: ${hint}`,
      ].join('\n');
      return { content: [{ type: 'text', text }], structuredContent: structured };
    }),
});

function savedText(out: SaveOutcome, ctx: ToolContext): string {
  const m = out.meta;
  const verb = out.action === 'created' ? 'Created' : out.action === 'refreshed' ? 'Refreshed' : 'Replaced';
  const storage = out.storageOrigin ? `, and the site storage of ${out.storageOrigin}` : '';
  const unloaded = unloadedText(
    out.unloaded,
    `this browser's cookies for its sites are now saved as "${m.name}"`,
    `this browser's cookies for their sites are now saved as "${m.name}"`,
  );
  return (
    `${verb} snapshot "${m.name}" (v${m.version}, ${JSON.stringify(m.description)}): ${m.cookieCount} cookie${m.cookieCount === 1 ? '' : 's'} for ${domainsText(out.cookieDomains, 5)}${storage}. ` +
    'It is loaded in this browser.' +
    (unloaded ? ` ${unloaded}` : '') +
    (agentRunOffered(ctx) ? ` To start a sub-agent signed in, call agent_run with {"snapshot": "${m.name}"}.` : '')
  );
}

export const snapshotSave = defineTool({
  name: 'snapshot_save',
  title: 'Save a sign-in as a snapshot',
  group: 'snapshots',
  description:
    "Save this browser's sign-in for chosen sites as a snapshot: creates a new one, or refreshes the one loaded in this browser. " +
    'A snapshot holds cookies and site storage (not page text: that is browser_snapshot), so agents do not have to sign in again. ' +
    'Sign in first; a new snapshot needs a name and a description (site and account). To overwrite a snapshot after signing in again by hand, pass replace: true.',
  inputSchema: z.object({
    name: nameArg.describe('Snapshot name, e.g. "amazon" or "amazon-work" (lowercase letters, digits, "-" and "_"; spaces become "-")'),
    description: descriptionArg.optional().describe(
      'Required for a new snapshot: which site and account, e.g. "Amazon — personal account (Prime)". Never put passwords or codes in it: it is shown in logs, on the dashboard and to sub-agents',
    ),
    domains: z
      .array(z.string().min(1).max(253))
      .max(50)
      .optional()
      .describe(
        'Sites to save, e.g. ["amazon.com"] (their subdomains too; "www.example.com" also keeps the example.com cookies). Default: the site of the active tab. ["*"] saves every cookie of this browser. Used when creating, or with replace',
      ),
    replace: z
      .boolean()
      .optional()
      .describe('Overwrite an existing snapshot that is not loaded in this browser (use after you signed in by hand to the account it is for). Default false'),
  }),
  annotations: { ...LOCAL_STATE, title: 'Save a sign-in' },
  handler: async ({ name, description, domains, replace }, ctx) =>
    guard(async () => {
      const svc = service(ctx);
      const n = snapshotName(name);
      const by = ctx.session.client ? { client: ctx.session.client } : {};
      const desc = description?.trim() || undefined;
      const existing = await svc.store.get(n).catch((err) => {
        if (err instanceof SnapshotNotFoundError) return null;
        throw err;
      });
      // the seed of a loaded snapshot writes its storage into every page of its site: only an empty browser is safe
      const seedAdvice = (err: SnapshotSeedConflictError) =>
        new ToolError(`${err.message} To save another account's sign-in, clear the cookies first (browser_clear_cookies, which also unloads "${err.other}"), sign in again, then save.`);
      let out: SaveOutcome;
      if (!existing) {
        if (!desc) {
          throw new ToolError(`Snapshot "${n}" does not exist yet: give a description (which site and account, e.g. "Amazon — personal account (Prime)") to create it.`);
        }
        let filter: string[];
        if (domains?.length) filter = normalizeFilter(domains);
        else {
          const site = await svc.activeSite(ctx.browser);
          if (!site) throw new ToolError('Open the site you signed in to first (the active tab is not on a web page), or pass domains, e.g. ["example.com"].');
          filter = [site];
        }
        try {
          out = await svc.create(ctx.browser, { name: n, description: desc, domains: filter, by });
        } catch (err) {
          if (err instanceof SnapshotSeedConflictError) throw seedAdvice(err);
          throw err;
        }
      } else {
        const advice = 'If you signed in by hand to the account this snapshot is for, call again with replace: true to overwrite it; otherwise load it first with snapshot_load, or save under a new name.';
        const loaded = ctx.browser.loadedSnapshots.get(n);
        try {
          if (replace) {
            out = await svc.update(ctx.browser, n, { mode: 'replace', by, domains: domains?.length ? normalizeFilter(domains) : undefined, description: desc });
          } else {
            if (!loaded) throw new ToolError(`Snapshot "${n}" is not loaded in this browser. ${advice}`);
            if (loaded.version !== existing.version) {
              throw new ToolError(`Snapshot "${n}" changed after this browser loaded it: ${actorText(existing.updatedBy)} saved v${existing.version} after this browser loaded v${loaded.version}. ${advice}`);
            }
            out = await svc.update(ctx.browser, n, { mode: 'refresh', by, expectVersion: loaded.version, description: desc });
          }
        } catch (err) {
          if (err instanceof SnapshotConflictError) throw new ToolError(`Snapshot "${n}" changed after this browser loaded it: ${err.message}. ${advice}`);
          if (err instanceof SnapshotNotFoundError) throw new ToolError(`Snapshot "${n}" was deleted meanwhile; nothing was saved.`);
          if (err instanceof SnapshotSignedOutError) {
            throw new ToolError(`${err.message} If this browser is signed in to the account this snapshot is for, call again with replace: true to overwrite it; otherwise load it again with snapshot_load.`);
          }
          if (err instanceof SnapshotSeedConflictError) throw seedAdvice(err);
          throw err;
        }
      }
      return {
        content: [{ type: 'text', text: savedText(out, ctx) }],
        structuredContent: {
          action: out.action,
          snapshot: {
            name: out.meta.name,
            version: out.meta.version,
            description: out.meta.description,
            domains: out.meta.domains,
            cookie_count: out.meta.cookieCount,
            cookie_domains: out.meta.cookieDomains,
            origins: out.meta.origins.map((o) => o.origin),
          },
          ...(out.unloaded.length ? { unloaded: out.unloaded } : {}),
        },
      };
    }),
});

export const snapshotDescribe = defineTool({
  name: 'snapshot_describe',
  title: 'Describe a snapshot',
  group: 'snapshots',
  description:
    'Change the description of a snapshot (saved sign-in), e.g. which site and account it is for, so the right one is picked later. Changes nothing else and does not load it.',
  inputSchema: z.object({ name: nameArg, description: descriptionArg }),
  annotations: { ...LOCAL_STATE, title: 'Describe a snapshot' },
  concurrent: true,
  handler: async ({ name, description }, ctx) =>
    guard(async () => {
      const svc = service(ctx);
      const n = snapshotName(name);
      await svc.get(n); // an unknown name lists the saved ones
      const meta = await svc.describe(n, description.trim());
      return {
        content: [{ type: 'text', text: `Snapshot "${meta.name}" (v${meta.version}) is now described as ${JSON.stringify(meta.description)}.` }],
        structuredContent: { name: meta.name, version: meta.version, description: meta.description },
      };
    }),
});

export const snapshotLoad = defineTool({
  name: 'snapshot_load',
  title: 'Load a snapshot',
  group: 'snapshots',
  description:
    "Load (activate) a snapshot in this browser: replaces this browser's cookies for the snapshot's sites with the saved ones " +
    '(other sites\' sign-ins stay, except for a snapshot saved with domains ["*"], which replaces every cookie) ' +
    'and restores its site storage on every page load of those sites. Only affects your own browser: to start a sub-agent signed in, pass the name to agent_run as snapshot.',
  inputSchema: z.object({ name: nameArg }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false, title: 'Load a snapshot' },
  handler: async ({ name }, ctx) =>
    guard(async () => {
      const svc = service(ctx);
      const n = snapshotName(name);
      await svc.get(n); // an unknown name lists the saved ones
      const res = await svc.apply(ctx.browser, n);
      const m = res.meta;
      const skipped = [
        res.expired.size ? `skipped ${countsText(res.expired, 'expired cookies')}` : '',
        res.refused.size ? `${countsText(res.refused, 'cookies refused by the browser')}` : '',
      ].filter(Boolean);
      const lines = [
        `Loaded snapshot "${m.name}" (v${m.version}, ${JSON.stringify(m.description)}) into this browser: restored ${res.restored} of ${res.total} cookies for ${domainsText(m.cookieDomains, 5)}${skipped.length ? ` (${skipped.join('; ')})` : ''}.`,
      ];
      if (res.storageOrigins.length) {
        lines.push(`Site storage of ${res.storageOrigins.join(', ')} is restored on every page load${res.appliedNow ? ' (the open page has it now)' : ''}.`);
      }
      const every = m.domains.includes('*');
      if (res.total > 0 && res.restored === 0) {
        lines.push(`No saved cookie could be restored: sign in again, then save it with snapshot_save {"name": "${m.name}", "replace": true}.`);
      } else {
        lines.push(`Open the site (browser_navigate): this browser should be signed in.${every ? '' : " Other sites' sign-ins in this browser were not changed."}`);
      }
      if (every) lines.push(`This snapshot covers every site (domains ["*"]): all of this browser's cookies were replaced by the saved ones, so other sign-ins in this browser are gone.`);
      const unloaded = unloadedText(res.unloaded, 'this load replaced its cookies', 'this load replaced their cookies');
      if (unloaded) lines.push(unloaded);
      if (ctx.browser.id === MAIN_BROWSER && ctx.config.obscura.storageDir) {
        lines.push('Note: OBSCURA_STORAGE_DIR is set, so the engine also keeps these cookies in its own cookie store.');
      }
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: {
          name: m.name,
          version: m.version,
          restored: res.restored,
          total: res.total,
          expired: Object.fromEntries(res.expired),
          refused: Object.fromEntries(res.refused),
          storage_origins: res.storageOrigins,
          ...(res.unloaded.length ? { unloaded: res.unloaded } : {}),
        },
      };
    }),
});

export const snapshotDelete = defineTool({
  name: 'snapshot_delete',
  title: 'Delete a snapshot',
  group: 'snapshots',
  description: 'Delete a snapshot for good. Only call this when your user explicitly asked to delete this snapshot — never to clean up, rename or make room.',
  inputSchema: z.object({ name: nameArg }),
  annotations: { ...DESTRUCTIVE_LOCAL, title: 'Delete a snapshot' },
  concurrent: true,
  handler: async ({ name }, ctx) =>
    guard(async () => {
      const svc = service(ctx);
      const n = snapshotName(name);
      let loadedIn: string[];
      try {
        ({ loadedIn } = await svc.delete(n, ctx.session.client));
      } catch (err) {
        if (!(err instanceof SnapshotNotFoundError)) throw err;
        await svc.get(n); // lists the saved names
        throw err;
      }
      let text = `Deleted snapshot "${n}". Cookies it already put into a browser stay there until cleared (browser_clear_cookies).`;
      if (loadedIn.length) text += ` It was loaded in: ${loadedIn.map((id) => browserLabel(id, ctx)).join(', ')}.`;
      if (ctx.config.obscura.storageDir && (ctx.browser.id === MAIN_BROWSER || loadedIn.includes(MAIN_BROWSER))) {
        text += ' OBSCURA_STORAGE_DIR is set: the engine also keeps those cookies in its own cookie store until they are cleared.';
      }
      return { content: [{ type: 'text', text }], structuredContent: { deleted: n, loaded_in: loadedIn } };
    }),
});

export default [snapshotList, snapshotSave, snapshotDescribe, snapshotLoad, snapshotDelete];
