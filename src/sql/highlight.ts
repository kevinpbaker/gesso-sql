import type { UiTextSpan } from 'gesso-core';

import { tokenize, type Token, type TokenKind } from './tokenize';

/**
 * SQL as coloured runs, for an `EditableText` to draw.
 *
 * The runs tile the whole string, since the engine checks that they
 * spell the value and draws the text plain when they do not. A run is
 * one token, or a stretch of tokens that share a colour, so a long query
 * is tens of runs rather than hundreds.
 *
 * The colours are hex rather than theme tokens, as the formula colours
 * in gesso-sheets are: the theme's colours are roles, and none of them
 * means "a keyword". They are mid-tones picked to read on the light
 * ground and the dark one.
 */
export const SYNTAX = {
  keyword: '#6b5cf0',
  string: '#2f9e5f',
  number: '#d0782a',
  comment: '#8b919a',
  quoted: '#c2477f',
  function: '#1593b5',
  parameter: '#d0782a'
} as const;

const COLOURED: Partial<Record<TokenKind, string>> = {
  keyword: SYNTAX.keyword,
  string: SYNTAX.string,
  number: SYNTAX.number,
  comment: SYNTAX.comment,
  quoted: SYNTAX.quoted,
  parameter: SYNTAX.parameter
};

/** A token's colour, or undefined for one drawn in the field's own. */
export function colourOf(tokens: readonly Token[], index: number): string | undefined {
  const token = tokens[index];
  if (token.kind === 'identifier') {
    // An identifier followed by an opening bracket is being called.
    let next = index + 1;
    while (next < tokens.length && tokens[next].kind === 'whitespace') {
      next++;
    }
    return tokens[next]?.text === '(' ? SYNTAX.function : undefined;
  }
  return COLOURED[token.kind];
}

export function sqlSpans(text: string): readonly UiTextSpan[] | undefined {
  if (text.length === 0) {
    return undefined;
  }
  const tokens = tokenize(text);
  const runs: UiTextSpan[] = [];
  let runStart = 0;
  let runColour: string | undefined;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    // Whitespace takes whichever colour it sits in, so it never splits
    // a run of plain text from the next plain token.
    const colour = token.kind === 'whitespace' ? runColour : colourOf(tokens, index);
    if (colour !== runColour && token.start > runStart) {
      runs.push(run(text.slice(runStart, token.start), runColour));
      runStart = token.start;
    }
    runColour = colour;
  }
  runs.push(run(text.slice(runStart), runColour));
  return runs;
}

function run(text: string, color: string | undefined): UiTextSpan {
  return color === undefined ? { text } : { text, color };
}

/** A stretch of the editor's text, by offset. */
export interface Range {
  readonly start: number;
  readonly end: number;
}

/** The wash behind the statement Run will run, and behind where an error is. */
export const ACTIVE_WASH = 'rgba(107, 92, 240, 0.07)';
export const ERROR_WASH = 'rgba(220, 53, 69, 0.28)';

/**
 * The editor's runs: the syntax colours, plus a wash behind the
 * statement the caret is in, so that what Run will run is always on
 * screen, and a stronger one behind the token an error points at.
 *
 * Built by cutting the text at every token edge and at the edges of the
 * two ranges, styling each piece, and merging neighbours that came out
 * the same. The tiling is the same guarantee `sqlSpans` gives.
 */
export function editorSpans(text: string, active: Range | null, error: Range | null): readonly UiTextSpan[] | undefined {
  if (text.length === 0) {
    return undefined;
  }
  const tokens = tokenize(text);
  const cuts = new Set<number>([0, text.length]);
  for (const token of tokens) {
    cuts.add(token.start);
  }
  for (const range of [active, error]) {
    if (range !== null) {
      cuts.add(Math.max(0, Math.min(text.length, range.start)));
      cuts.add(Math.max(0, Math.min(text.length, range.end)));
    }
  }
  const edges = [...cuts].sort((a, b) => a - b);

  const runs: { text: string; color: string | undefined; backgroundColor: string | undefined }[] = [];
  let tokenIndex = 0;
  for (let index = 0; index < edges.length - 1; index++) {
    const start = edges[index];
    const end = edges[index + 1];
    if (end <= start) {
      continue;
    }
    while (tokenIndex < tokens.length - 1 && tokens[tokenIndex].end <= start) {
      tokenIndex++;
    }
    const color = tokens[tokenIndex].kind === 'whitespace' ? undefined : colourOf(tokens, tokenIndex);
    const backgroundColor =
      error !== null && start >= error.start && start < error.end
        ? ERROR_WASH
        : active !== null && start >= active.start && start < active.end
          ? ACTIVE_WASH
          : undefined;
    const last = runs[runs.length - 1];
    // Whitespace has no colour of its own, so it joins whichever run it follows.
    if (last !== undefined && last.backgroundColor === backgroundColor && (last.color === color || color === undefined && tokens[tokenIndex].kind === 'whitespace')) {
      last.text += text.slice(start, end);
      continue;
    }
    runs.push({ text: text.slice(start, end), color, backgroundColor });
  }
  return runs.map(entry => ({
    text: entry.text,
    ...(entry.color === undefined ? {} : { color: entry.color }),
    ...(entry.backgroundColor === undefined ? {} : { backgroundColor: entry.backgroundColor })
  }));
}
