/**
 * SQL, cut into tokens.
 *
 * One scanner feeds the highlighter, the statement splitter and the
 * completion, so the three cannot disagree about where a string ends.
 * A semicolon inside a quoted string is not the end of a statement, a
 * keyword inside a comment is not a keyword, and a `--` inside a
 * string is not a comment. Three scanners would get those three right
 * separately, and one of them would be wrong.
 *
 * The dialect is DuckDB's, which is PostgreSQL's with a few additions:
 * `$tag$...$tag$` strings, `1_000_000` digit separators, and `"..."`
 * for identifiers. A string that is never closed runs to the end of the
 * text, which is what the person typing it is in the middle of doing.
 *
 * Every character of the input belongs to exactly one token, in order.
 * That is what lets the highlighter tile the text without gaps, and the
 * spec checks it over a pile of awkward inputs.
 */

export type TokenKind =
  | 'whitespace'
  | 'comment'
  | 'string'
  | 'number'
  | 'keyword'
  | 'identifier'
  | 'quoted'
  | 'operator'
  | 'punctuation'
  | 'semicolon'
  | 'parameter';

export interface Token {
  readonly kind: TokenKind;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * The words drawn as keywords and offered by completion.
 *
 * Not DuckDB's whole reserved list: that list includes words like
 * `name` and `type` that are far more often a column than a keyword,
 * and colouring every `name` column as a keyword reads as a bug.
 */
export const KEYWORDS: readonly string[] = [
  'ALL', 'ALTER', 'AND', 'ANTI', 'ANY', 'AS', 'ASC', 'ASOF', 'ATTACH', 'BETWEEN', 'BY', 'CASE', 'CAST', 'CHECKPOINT',
  'COLUMNS', 'COPY', 'CREATE', 'CROSS', 'CUBE', 'DATABASE', 'DEFAULT', 'DELETE', 'DESC', 'DESCRIBE', 'DETACH', 'DISTINCT',
  'DROP', 'ELSE', 'END', 'EXCEPT', 'EXCLUDE', 'EXISTS', 'EXPLAIN', 'EXPORT', 'FALSE', 'FILTER', 'FIRST', 'FOLLOWING',
  'FOR', 'FROM', 'FULL', 'GROUP', 'GROUPING', 'HAVING', 'IF', 'ILIKE', 'IN', 'INNER', 'INSERT', 'INSTALL', 'INTERSECT',
  'INTERVAL', 'INTO', 'IS', 'JOIN', 'LAST', 'LATERAL', 'LEFT', 'LIKE', 'LIMIT', 'LOAD', 'MACRO', 'NATURAL', 'NOT', 'NULL',
  'NULLS', 'OFFSET', 'ON', 'OR', 'ORDER', 'OUTER', 'OVER', 'PARTITION', 'PIVOT', 'POSITIONAL', 'PRAGMA', 'PRECEDING',
  'PRIMARY', 'QUALIFY', 'RANGE', 'RECURSIVE', 'REPLACE', 'RETURNING', 'RIGHT', 'ROLLUP', 'ROW', 'ROWS', 'SAMPLE',
  'SELECT', 'SEMI', 'SET', 'SETTINGS', 'SHOW', 'SIMILAR', 'SUMMARIZE', 'TABLE', 'TABLES', 'TEMP', 'TEMPORARY', 'THEN',
  'TO', 'TRUE', 'TRY_CAST', 'UNBOUNDED', 'UNION', 'UNPIVOT', 'UPDATE', 'USING', 'VALUES', 'VIEW', 'WHEN', 'WHERE',
  'WINDOW', 'WITH', 'WITHIN'
];

const KEYWORD_SET = new Set(KEYWORDS);

export function isKeyword(word: string): boolean {
  return KEYWORD_SET.has(word.toUpperCase());
}

const OPERATOR_CHARS = '+-*/<>=~!@#%^&|`?:';
const PUNCTUATION_CHARS = '(),.[]{}';

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const length = text.length;
  let at = 0;

  const push = (kind: TokenKind, start: number, end: number): void => {
    tokens.push({ kind, start, end, text: text.slice(start, end) });
  };

  while (at < length) {
    const start = at;
    const char = text[at];
    const next = text[at + 1];

    if (isSpace(char)) {
      while (at < length && isSpace(text[at])) {
        at++;
      }
      push('whitespace', start, at);
      continue;
    }

    if (char === '-' && next === '-') {
      const newline = text.indexOf('\n', at);
      at = newline === -1 ? length : newline;
      push('comment', start, at);
      continue;
    }

    if (char === '/' && next === '*') {
      const close = text.indexOf('*/', at + 2);
      at = close === -1 ? length : close + 2;
      push('comment', start, at);
      continue;
    }

    if (char === "'" || ((char === 'E' || char === 'e') && next === "'")) {
      at = closeQuoted(text, char === "'" ? at : at + 1, "'");
      push('string', start, at);
      continue;
    }

    if (char === '"') {
      at = closeQuoted(text, at, '"');
      push('quoted', start, at);
      continue;
    }

    if (char === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(at, at + 64));
      if (tag !== null) {
        const close = text.indexOf(tag[0], at + tag[0].length);
        at = close === -1 ? length : close + tag[0].length;
        push('string', start, at);
        continue;
      }
      if (next !== undefined && isDigit(next)) {
        at++;
        while (at < length && isDigit(text[at])) {
          at++;
        }
        push('parameter', start, at);
        continue;
      }
    }

    if (isDigit(char) || (char === '.' && next !== undefined && isDigit(next))) {
      at = scanNumber(text, at);
      push('number', start, at);
      continue;
    }

    if (isWordStart(char)) {
      while (at < length && isWordPart(text[at])) {
        at++;
      }
      push(isKeyword(text.slice(start, at)) ? 'keyword' : 'identifier', start, at);
      continue;
    }

    if (char === ';') {
      at++;
      push('semicolon', start, at);
      continue;
    }

    if (PUNCTUATION_CHARS.includes(char)) {
      at++;
      push('punctuation', start, at);
      continue;
    }

    if (OPERATOR_CHARS.includes(char)) {
      while (at < length && OPERATOR_CHARS.includes(text[at]) && !(text[at] === '-' && text[at + 1] === '-')) {
        at++;
      }
      push('operator', start, at);
      continue;
    }

    // Anything else is one character of punctuation, so that every
    // character is still in exactly one token.
    at += char.length;
    push('punctuation', start, at);
  }
  return tokens;
}

/** Past the closing quote, where a doubled quote is an escaped one. */
function closeQuoted(text: string, open: number, quote: string): number {
  let at = open + 1;
  while (at < text.length) {
    if (text[at] === quote) {
      if (text[at + 1] === quote) {
        at += 2;
        continue;
      }
      return at + 1;
    }
    at++;
  }
  return text.length;
}

function scanNumber(text: string, at: number): number {
  if (text[at] === '0' && (text[at + 1] === 'x' || text[at + 1] === 'X')) {
    at += 2;
    while (at < text.length && /[0-9a-fA-F_]/.test(text[at])) {
      at++;
    }
    return at;
  }
  while (at < text.length && (isDigit(text[at]) || text[at] === '_')) {
    at++;
  }
  if (text[at] === '.' && text[at + 1] !== '.') {
    at++;
    while (at < text.length && (isDigit(text[at]) || text[at] === '_')) {
      at++;
    }
  }
  if ((text[at] === 'e' || text[at] === 'E') && /[0-9+-]/.test(text[at + 1] ?? '')) {
    at += 2;
    while (at < text.length && isDigit(text[at])) {
      at++;
    }
  }
  return at;
}

function isSpace(char: string): boolean {
  return char === ' ' || char === '\n' || char === '\t' || char === '\r' || char === '\f';
}

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

function isWordStart(char: string): boolean {
  return (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || char === '_' || char > '\u007f';
}

function isWordPart(char: string): boolean {
  return isWordStart(char) || isDigit(char) || char === '$';
}
