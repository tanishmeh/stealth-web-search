import * as z from 'zod';
import { StaleRefError, ToolError, UnknownRefError } from '../browser/errors.ts';
import { IS_LIVE_ELEMENT } from '../browser/scripts.ts';
import type { ElementHandle, RemoteObject, Tab } from '../browser/tab.ts';
import { pretty } from './format.ts';
import {
  LABEL_OF,
  SENSITIVE_FIELD,
  clickElement,
  describeBox,
  fillElement,
  formatOption,
  inspectElement,
  navigationNote,
  selectOptions,
  setCheckedState,
  type PreparedElement,
} from './interaction.ts';
import { ACTION, READ_ONLY, defineTool, textResult } from './types.ts';

const MAX_OPTIONS = 25;
const MAX_VALUE_CHARS = 200;

/**
 * Every <form> with its fields. Labels come from label[for], a wrapping
 * <label>, aria attributes or placeholder; values of password-like fields are
 * masked; long option lists and values are cut to keep the output small.
 */
const DETECT_FORMS = `function detectForms(sensitiveSource, maxOptions, maxValue) {
  ${LABEL_OF}
  var sensitive = null;
  try { sensitive = new RegExp(sensitiveSource, 'i'); } catch (_e) {}
  function clip(s) { s = String(s == null ? '' : s); return s.length > maxValue ? s.slice(0, maxValue) + '…(' + s.length + ' chars)' : s; }
  function clean(s) { return String(s == null ? '' : s).replace(/\\s+/g, ' ').trim(); }
  var forms = document.querySelectorAll('form');
  var out = [];
  for (var i = 0; i < forms.length; i++) {
    var f = forms[i];
    var fields = [];
    var inputs = f.querySelectorAll('input, select, textarea, button');
    for (var j = 0; j < inputs.length; j++) {
      var el = inputs[j];
      var tag = el.tagName.toLowerCase();
      var type = (el.getAttribute('type') || (tag === 'input' ? 'text' : tag === 'button' ? 'submit' : tag)).toLowerCase();
      if (tag === 'input' && type === 'hidden') continue;
      var name = el.getAttribute('name') || '';
      var label = labelOf(el);
      var value = String(el.value == null ? '' : el.value);
      var secret = type === 'password' || (!!sensitive && tag !== 'button' && type !== 'checkbox' && type !== 'radio' && type !== 'submit'
        && sensitive.test(name + ' ' + (el.id || '') + ' ' + (el.getAttribute('autocomplete') || '') + ' ' + label));
      var field = {
        nid: el._nid, tag: tag, type: type, name: name, label: label,
        value: secret ? (value ? '••••' : '') : clip(value),
        checked: !!el.checked,
        required: el.hasAttribute('required'),
        disabled: !!(el.disabled || el.hasAttribute('disabled')),
        readonly: el.hasAttribute('readonly'),
        multiple: tag === 'select' && el.hasAttribute('multiple'),
        options: null, moreOptions: 0,
      };
      if (tag === 'select') {
        var os = el.querySelectorAll('option');
        field.options = [];
        for (var k = 0; k < os.length && k < maxOptions; k++) field.options.push({ value: os[k].value, text: clean(os[k].textContent) });
        field.moreOptions = Math.max(0, os.length - maxOptions);
      }
      fields.push(field);
    }
    out.push({ index: i, id: f.id || '', name: f.getAttribute('name') || '', action: f.action || '', method: (f.getAttribute('method') || 'get').toLowerCase(), fields: fields });
  }
  return out;
}`;

/** `this` = radio. Its group (same name and form) and the member whose value or label matches `want`. */
const RADIO_GROUP = `function radioGroup(want) {
  ${LABEL_OF}
  var el = this;
  var name = el.getAttribute('name');
  if (!name) return null;
  var formOf = function (n) { return n.form || (n.closest ? n.closest('form') : null); };
  var owner = formOf(el);
  var ownerId = owner ? owner._nid : null;
  var inputs = (owner || document).querySelectorAll('input');
  var list = [];
  for (var i = 0; i < inputs.length; i++) {
    var r = inputs[i];
    if ((r.getAttribute('type') || '').toLowerCase() !== 'radio' || r.getAttribute('name') !== name) continue;
    var rf = formOf(r);
    if ((rf ? rf._nid : null) !== ownerId) continue;
    list.push({ nid: r._nid, value: String(r.value == null ? '' : r.value), text: labelOf(r) });
  }
  var w = String(want).trim().toLowerCase();
  var match = list.find(function (x) { return x.value === want; }) ||
    list.find(function (x) { return x.value.toLowerCase() === w; }) ||
    list.find(function (x) { return x.text.toLowerCase() === w; });
  return { name: name, options: list.map(function (x) { return { value: x.value, text: x.text }; }), match: match ? match.nid : null };
}`;

interface DetectedField {
  nid: number;
  tag: string;
  type: string;
  name: string;
  label: string;
  value: string;
  checked: boolean;
  required: boolean;
  disabled: boolean;
  readonly: boolean;
  multiple: boolean;
  options: Array<{ value: string; text: string }> | null;
  moreOptions: number;
}

interface DetectedForm {
  index: number;
  id: string;
  name: string;
  action: string;
  method: string;
  fields: DetectedField[];
}

export const detectForms = defineTool({
  name: 'browser_detect_forms',
  title: 'Detect forms',
  group: 'forms',
  description:
    'List every <form> on the page with its action, method and fields (type, name, label, current value, options for selects), ' +
    'each with a ref usable in browser_fill_form, browser_fill, browser_check, browser_select_option and browser_click. ' +
    'Use it to understand a form before filling it. Password values are masked.',
  inputSchema: z.object({}),
  annotations: { ...READ_ONLY, title: 'Detect forms' },
  handler: async (_args, ctx) => {
    const tab = await ctx.tab();
    const forms = (await tab.callFunction<DetectedForm[]>(DETECT_FORMS, [SENSITIVE_FIELD.source, MAX_OPTIONS, MAX_VALUE_CHARS])) ?? [];
    if (forms.length === 0) return textResult('No forms found on this page. Inputs outside a <form> are listed by browser_snapshot.');
    const out = forms.map((f) => ({
      index: f.index,
      id: f.id,
      name: f.name,
      action: f.action,
      method: f.method,
      fields: f.fields.map((field) => {
        const entry: Record<string, unknown> = {
          ref: typeof field.nid === 'number' ? tab.assignRef(field.nid, field.tag, field.label, field.type) : null,
          tag: field.tag,
          type: field.type,
          name: field.name,
          label: field.label,
          value: field.value,
        };
        if (field.type === 'checkbox' || field.type === 'radio') entry.checked = field.checked;
        if (field.required) entry.required = true;
        if (field.disabled) entry.disabled = true;
        if (field.readonly) entry.readonly = true;
        if (field.multiple) entry.multiple = true;
        if (field.options) entry.options = field.options;
        if (field.moreOptions > 0) entry.more_options = field.moreOptions;
        return entry;
      }),
    }));
    const count = out.length === 1 ? '1 form' : `${out.length} forms`;
    const cut = forms.some((f) => f.fields.some((field) => field.moreOptions > 0))
      ? ` Long option lists are cut to ${MAX_OPTIONS}; browser_select_option accepts any option value or text.`
      : '';
    return textResult(`Found ${count}. Pass field refs to browser_fill_form (or browser_fill / browser_check / browser_select_option).${cut}\n${pretty(out)}`);
  },
});

const TRUE_VALUES = new Set(['true', 'yes', 'on', '1', 'checked', 'check', 'y']);
const FALSE_VALUES = new Set(['false', 'no', 'off', '0', 'unchecked', 'uncheck', 'n', '']);

const fieldShape = z.object({
  ref: z.string().optional().describe('Field ref from browser_detect_forms or browser_snapshot (preferred)'),
  selector: z.string().optional().describe('CSS selector of the field, used when no ref is available'),
  value: z.string().optional().describe('Text to enter, the option value/text for selects, "true"/"false" for checkboxes, or the value/label of the radio button to pick'),
  type: z
    .enum(['text', 'check', 'uncheck', 'select'])
    .optional()
    .describe('"text" replaces the value, "check"/"uncheck" set a checkbox or radio, "select" picks an option. Default: chosen from the element'),
});

interface RadioGroup {
  name: string;
  options: Array<{ value: string; text: string }>;
  match: number | null;
}

/**
 * Obscura reports history.pushState/replaceState as a main-frame navigation
 * although the document is unchanged; performance.timeOrigin only changes
 * when a new document loads.
 */
async function documentOrigin(tab: Tab): Promise<number | null> {
  return tab.callFunction<number>('function () { return performance.timeOrigin; }').catch(() => null);
}

function sameDocumentNote(url: string): string {
  return `The URL changed to ${url} while filling (same page, no reload; element refs are still valid).`;
}

/**
 * Resolve a field or submit target. Refs are looked up in `nids` (captured
 * before filling) when the tab forgot them because of a same-document URL change.
 */
async function resolveTarget(tab: Tab, target: { ref?: string; selector?: string }, nids: Map<string, number>): Promise<ElementHandle> {
  try {
    return await tab.resolveElement(target);
  } catch (err) {
    const nid = target.ref ? nids.get(target.ref) : undefined;
    if (!(err instanceof UnknownRefError) || nid === undefined) throw err;
    const res = await tab.send<{ object?: RemoteObject }>('DOM.resolveNode', { backendNodeId: nid }).catch(() => null);
    const objectId = res?.object?.objectId;
    if (!objectId || !(await tab.callFunction<boolean>(IS_LIVE_ELEMENT, [], { objectId }).catch(() => false))) throw new StaleRefError(target.ref!);
    return { objectId, target: `ref ${target.ref}`, ref: target.ref, nid };
  }
}

export const fillForm = defineTool({
  name: 'browser_fill_form',
  title: 'Fill form',
  group: 'forms',
  description:
    'Fill several form fields in one call, then optionally click a submit button (submit_ref or submit_selector) and wait for the resulting page. ' +
    'Each field is {ref or selector, value, type?}; type is inferred when omitted (checkboxes accept value "true"/"false"; for a radio button, ' +
    'value may name any option of its group by value or label). Per-field errors are reported; the form is not submitted if any field failed.',
  inputSchema: z.object({
    fields: z.array(fieldShape).min(1).max(200).describe('Fields to fill, in order'),
    submit_ref: z.string().optional().describe('Ref of the button to click after filling (e.g. the submit button)'),
    submit_selector: z.string().optional().describe('CSS selector of the button to click after filling'),
  }),
  annotations: { ...ACTION, title: 'Fill form' },
  handler: async ({ fields, submit_ref, submit_selector }, ctx) => {
    const tab = await ctx.tab();
    const errors: string[] = [];
    let filled = 0;
    let navigatedAt = -1;
    const nids = new Map<string, number>();
    for (const ref of [...fields.map((f) => f.ref), submit_ref]) {
      const nid = ref ? tab.refInfo(ref)?.nid : undefined;
      if (ref && nid !== undefined) nids.set(ref, nid);
    }
    const origin = await documentOrigin(tab);

    const filling = await tab.trackNavigation(async () => {
      for (const [i, field] of fields.entries()) {
        const navSeq = tab.navSeq;
        const target = field.ref ? `ref ${field.ref}` : field.selector ? `selector ${JSON.stringify(field.selector)}` : `field ${i + 1}`;
        try {
          if (!field.ref && !field.selector) throw new ToolError("provide 'ref' or 'selector'");
          let handle: ElementHandle = await resolveTarget(tab, { ref: field.ref, selector: field.selector }, nids);
          let prepared: PreparedElement = await inspectElement(tab, handle);
          const kind = field.type ?? (prepared.info.checkable ? 'check' : prepared.info.select ? 'select' : 'text');
          if (kind === 'check' || kind === 'uncheck') {
            let checked = kind === 'check';
            if (field.type === undefined && field.value !== undefined) {
              const v = field.value.trim().toLowerCase();
              const group =
                prepared.info.tag === 'input' && prepared.info.type === 'radio'
                  ? await tab.callFunction<RadioGroup | null>(RADIO_GROUP, [field.value], { objectId: handle.objectId })
                  : null;
              if (group && group.match !== null) {
                checked = true;
                if (group.match !== prepared.info.nid) {
                  const res = await tab.send<{ object?: RemoteObject }>('DOM.resolveNode', { backendNodeId: group.match });
                  if (!res.object?.objectId) throw new ToolError(`the radio button ${JSON.stringify(field.value)} of group "${group.name}" is no longer in the page`);
                  handle = { objectId: res.object.objectId, target: handle.target, nid: group.match };
                  prepared = await inspectElement(tab, handle);
                }
              } else if (TRUE_VALUES.has(v)) {
                checked = true;
              } else if (FALSE_VALUES.has(v)) {
                checked = false;
              } else if (group) {
                throw new ToolError(
                  `no radio button in group ${JSON.stringify(group.name)} has the value or label ${JSON.stringify(field.value)}; options: ${group.options.map(formatOption).join(', ')}`,
                );
              } else {
                throw new ToolError(`value ${JSON.stringify(field.value)} is not valid for a checkbox/radio; use "true" or "false"`);
              }
            }
            await setCheckedState(ctx, tab, handle, checked, prepared);
          } else if (kind === 'select') {
            if (field.value === undefined) throw new ToolError('value is required to select an option');
            await selectOptions(ctx, tab, handle, [field.value], prepared);
          } else {
            if (field.value === undefined) throw new ToolError('value is required for text fields (use "" to clear a field)');
            await fillElement(ctx, tab, handle, field.value, prepared);
          }
          filled++;
        } catch (err) {
          if (!(err instanceof ToolError)) throw err;
          // messages already name the element; avoid repeating the target when they do
          errors.push(err.message.includes(target) ? err.message : `${target}: ${err.message}`);
        }
        // a change handler loaded another page: the remaining fields (and the submit target) belong to the old one
        if (tab.navSeq !== navSeq) {
          const now = await documentOrigin(tab);
          if (origin === null || now === null || now !== origin) {
            navigatedAt = i;
            break;
          }
        }
      }
    });

    const lines = [`Filled ${filled} of ${fields.length} field${fields.length === 1 ? '' : 's'}.`];
    if (errors.length) lines.push(`Errors:\n${errors.map((e) => `- ${e}`).join('\n')}`);

    const wantsSubmit = Boolean(submit_ref || submit_selector);
    let note = '';
    if (navigatedAt >= 0) {
      const field = fields[navigatedAt]!;
      const target = field.ref ? `ref ${field.ref}` : `selector ${JSON.stringify(field.selector)}`;
      const remaining = fields.length - navigatedAt - 1;
      const parts = [`The page navigated while filling field ${navigatedAt + 1} (${target})`];
      if (remaining > 0) parts.push(`the remaining ${remaining} field${remaining === 1 ? ' was' : 's were'} not filled`);
      lines.push(`${parts.join('; ')}${wantsSubmit ? `${remaining > 0 ? ' and' : ';'} the form was not submitted` : ''}.`);
      note = navigationNote(filling);
    } else if (wantsSubmit) {
      if (filling.urlChanged && !filling.navigated) lines.push(sameDocumentNote(filling.info.url));
      if (errors.length) {
        lines.push('The form was not submitted because some fields failed; fix them and submit with browser_click.');
      } else {
        try {
          const handle = await resolveTarget(tab, { ref: submit_ref, selector: submit_ref ? undefined : submit_selector }, nids);
          const { box, method, outcome } = await clickElement(ctx, tab, handle);
          lines.push(`Clicked ${describeBox(box, handle)}${method !== 'mouse' ? ` using a ${method} click` : ''} to submit.`);
          note = navigationNote(outcome);
          if (!outcome.urlChanged) lines.push('The page did not navigate (the form may have been sent in the background or shown validation errors); call browser_snapshot to check.');
        } catch (err) {
          if (!(err instanceof ToolError)) throw err;
          lines.push(`Could not submit: ${err.message}`);
        }
      }
    } else if (filling.urlChanged && !filling.navigated) {
      lines.push(sameDocumentNote(filling.info.url));
    }

    const text = `${lines.join('\n')}${note}`;
    if (filled === 0) return { content: [{ type: 'text', text: `Error: ${text}` }], isError: true };
    return textResult(text);
  },
});

export default [detectForms, fillForm];
