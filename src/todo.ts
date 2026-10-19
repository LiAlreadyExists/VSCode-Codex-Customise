import * as path from 'node:path';

export interface TodoMatch { offset: number; comment: string; raw: string }
export interface TodoContext { file: string; workspace: string; line: number; comment: string }

/** Match exact trigger text and preserve the remainder of its line. */
export function findTodos(text: string, trigger: string): TodoMatch[] {
  if (!trigger || /[\r\n]/.test(trigger)) return [];
  const result: TodoMatch[] = [];
  let from = 0;
  while (from < text.length) {
    const offset = text.indexOf(trigger, from);
    if (offset < 0) break;
    const bodyStart = offset + trigger.length;
    const newline = text.indexOf('\n', bodyStart);
    let end = newline < 0 ? text.length : newline;
    if (newline >= 0 && text[end - 1] === '\r') end--;
    result.push({ offset, comment: text.slice(bodyStart, end), raw: text.slice(offset, end) });
    from = bodyStart;
  }
  return result;
}

export function buildPrompt(context: TodoContext, template: string): string {
  if (template.trim()) {
    const values: Record<string, string> = {
      comment: context.comment, file: context.file, relativeFile: path.isAbsolute(context.file) ? path.relative(context.workspace, context.file) : context.file,
      line: String(context.line), workspace: context.workspace,
    };
    // Replace once, so comment text containing braces cannot inject template substitutions.
    return template.replace(/\{(comment|file|relativeFile|line|workspace)\}/g, (_, key: string) => values[key]!);
  }
  return `Please implement the code as described by the comment on ${context.file}:${context.line}\n\nThe comment is:\n${context.comment}\n\nReplace the comment with your implementation.\nOptimize for speed. Don't over-explore or over-check your work other than what is absolutely necessary to implement the comment.\nOnce you are done, remove the comment.`;
}

export function usesNativeAction(message: string, target: string): boolean { return !message.trim() && !target.trim(); }
