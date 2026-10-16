import * as path from 'node:path';

export interface TodoMatch { offset: number; comment: string; raw: string }
export interface TodoContext { file: string; workspace: string; line: number; comment: string }

/** Scan comments, excluding quoted strings. Markers are literal, never executable regex. */
export function findTodos(text: string, trigger: string, language = ''): TodoMatch[] {
  trigger = trigger.trim();
  if (!trigger || /[\r\n]/.test(trigger)) return [];
  const result: TodoMatch[] = [];
  const percent = ['latex', 'tex', 'matlab', 'octave'].includes(language);
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const triple = (ch === '"' || ch === "'") && text.startsWith(ch.repeat(3), i);
    if (ch === '"' || ch === "'" || ch === '`') {
      const delimiter = triple ? ch.repeat(3) : ch;
      i += delimiter.length;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text.startsWith(delimiter, i)) { i += delimiter.length; break; }
        i++;
      }
      continue;
    }
    const block = text.startsWith('/*', i) ? ['/*', '*/'] : text.startsWith('<!--', i) ? ['<!--', '-->'] : null;
    const marker = block?.[0] ?? (text.startsWith('//', i) ? '//' : text.startsWith('--', i) ? '--' : ch === '#' ? '#' : percent && ch === '%' ? '%' : null);
    if (!marker) { i++; continue; }
    const start = i;
    const bodyStart = i + marker.length;
    let end: number;
    if (block) {
      end = text.indexOf(block[1]!, bodyStart);
      if (end < 0) end = text.length;
      i = Math.min(text.length, end + block[1]!.length);
    } else {
      end = text.indexOf('\n', bodyStart);
      if (end < 0) end = text.length;
      i = end;
    }
    let body = text.slice(bodyStart, end);
    if (block) body = body.replace(/^\s*\*?\s*/u, '').replace(/\n[ \t]*\*[ ]?/g, '\n');
    else body = body.replace(new RegExp(`^${escapeRegex(marker[0]!)}*`), '').trimStart();
    const explicit = trigger.startsWith(marker);
    const matchTrigger = explicit ? marker + trigger.slice(marker.length).trimStart() : trigger;
    const candidate = explicit ? marker + body.trimStart() : body.trimStart();
    if (!candidate.toLowerCase().startsWith(matchTrigger.toLowerCase())) continue;
    const rest = candidate.slice(matchTrigger.length);
    // A TODO marker does not match TODOsomething.
    if (/\w$/.test(trigger) && /^\w/.test(rest)) continue;
    result.push({ offset: start, comment: rest.replace(/^[:\-]?\s*/, '').trimEnd(), raw: text.slice(start, i) });
  }
  return result;
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function buildPrompt(context: TodoContext, template: string): string {
  if (template.trim()) {
    const values: Record<string, string> = {
      comment: context.comment, file: context.file, relativeFile: path.relative(context.workspace, context.file),
      line: String(context.line), workspace: context.workspace,
    };
    // Replace once, so comment text containing braces cannot inject template substitutions.
    return template.replace(/\{(comment|file|relativeFile|line|workspace)\}/g, (_, key: string) => values[key]!);
  }
  return `Please implement the code as described by the comment on ${context.file}:${context.line}\n\nThe comment is:\n${context.comment.trim()}\n\nReplace the comment with your implementation.\nOptimize for speed. Don't over-explore or over-check your work other than what is absolutely necessary to implement the comment.\nOnce you are done, remove the comment.`;
}

export function usesNativeAction(message: string, target: string): boolean { return !message.trim() && !target.trim(); }
