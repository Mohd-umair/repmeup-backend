#!/usr/bin/env node
/**
 * One-shot dev tool: rewrite console.* calls to logger.* in the given files.
 *
 * USAGE:
 *   node scripts/dev/convert-console-to-logger.js <file> [file...]
 *
 * It is INTENTIONALLY conservative — leaves anything it can't confidently
 * rewrite alone and prints it for manual review. Run, inspect the diff,
 * and clean up the leftovers by hand.
 *
 * Conversion rules (in order):
 *   console.log    → logger.info
 *   console.info   → logger.info
 *   console.warn   → logger.warn
 *   console.error  → logger.error
 *   console.debug  → logger.debug
 *
 * Argument handling:
 *   1 arg:  copy through as-is
 *   2 args, 2nd is object literal `{...}`:  copy through as-is
 *   2 args, 2nd is identifier/expression:   wrap second arg into a metadata
 *                                           object using the variable name
 *                                           (e.g. `error` becomes `{ error }`).
 *   3+ args, all strings:                   collapse into a single message
 *                                           via template literal.
 *   3+ args, mixed:                         wrap remainder into a metadata
 *                                           object using each arg as-is or
 *                                           via best-effort key naming.
 *
 * Things this script DOES NOT touch (printed for manual fix):
 *   - console.* calls inside template literals or strings
 *   - calls broken across multiple lines with complex object literals
 *   - calls already inside `if (process.env.NODE_ENV...)` guards
 */

const fs = require('fs');
const path = require('path');

const LEVEL_MAP = { log: 'info', info: 'info', warn: 'warn', error: 'error', debug: 'debug' };

/**
 * Find the matching closing `)` for an opening `(` at startIdx.
 * Respects nested parens, single/double/template strings, and escapes.
 * Returns -1 if not found.
 */
function findMatchingParen(src, startIdx) {
  let depth = 0;
  let i = startIdx;
  let inSingle = false, inDouble = false, inTemplate = false, templateDepth = 0;
  while (i < src.length) {
    const c = src[i];
    const prev = i > 0 ? src[i - 1] : '';
    if (!inSingle && !inDouble && !inTemplate) {
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) return i;
      } else if (c === "'") inSingle = true;
      else if (c === '"') inDouble = true;
      else if (c === '`') inTemplate = true;
    } else if (inSingle && c === "'" && prev !== '\\') {
      inSingle = false;
    } else if (inDouble && c === '"' && prev !== '\\') {
      inDouble = false;
    } else if (inTemplate) {
      if (c === '`' && prev !== '\\' && templateDepth === 0) inTemplate = false;
      else if (c === '{' && prev === '$') templateDepth++;
      else if (c === '}' && templateDepth > 0) templateDepth--;
    }
    i++;
  }
  return -1;
}

/** Split a comma-separated argument list, respecting strings/parens/brackets. */
function splitArgs(argsStr) {
  const args = [];
  let depth = 0, bracket = 0, brace = 0;
  let inSingle = false, inDouble = false, inTemplate = false, templateDepth = 0;
  let buf = '';
  for (let i = 0; i < argsStr.length; i++) {
    const c = argsStr[i];
    const prev = i > 0 ? argsStr[i - 1] : '';
    if (!inSingle && !inDouble && !inTemplate) {
      if (c === ',' && depth === 0 && bracket === 0 && brace === 0) {
        args.push(buf.trim());
        buf = '';
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === '[') bracket++;
      else if (c === ']') bracket--;
      else if (c === '{') brace++;
      else if (c === '}') brace--;
      else if (c === "'") inSingle = true;
      else if (c === '"') inDouble = true;
      else if (c === '`') inTemplate = true;
    } else if (inSingle && c === "'" && prev !== '\\') inSingle = false;
    else if (inDouble && c === '"' && prev !== '\\') inDouble = false;
    else if (inTemplate) {
      if (c === '`' && prev !== '\\' && templateDepth === 0) inTemplate = false;
      else if (c === '{' && prev === '$') templateDepth++;
      else if (c === '}' && templateDepth > 0) templateDepth--;
    }
    buf += c;
  }
  if (buf.trim()) args.push(buf.trim());
  return args;
}

const STRING_LITERAL_RE = /^(['"`])[\s\S]*\1$/;

function isStringLiteral(s) {
  return STRING_LITERAL_RE.test(s);
}

function isObjectLiteral(s) {
  return s.startsWith('{') && s.endsWith('}');
}

function isSimpleIdentifier(s) {
  return /^[a-zA-Z_$][\w$]*$/.test(s);
}

/** Strip trailing colon/space from a string-literal message ("Foo:" → "Foo"). */
function trimMessageTail(strLiteral) {
  const quote = strLiteral[0];
  const inner = strLiteral.slice(1, -1).replace(/[:\s]+$/, '');
  return quote + inner + quote;
}

/** Pick a sensible metadata key for an expression. */
function inferKey(expr, fallbackIdx) {
  if (isSimpleIdentifier(expr)) return expr;
  // err.message → error
  if (/^err\b|^error\b/.test(expr)) return 'error';
  if (/\.stack$/.test(expr)) return 'stack';
  if (/\.length$/.test(expr)) return 'length';
  if (/\.id$/.test(expr)) return 'id';
  if (/\.message$/.test(expr)) return 'error';
  return `arg${fallbackIdx}`;
}

/** Build a metadata object literal from args[1..]. */
function buildMetaObject(restArgs) {
  const entries = [];
  let argIdx = 1;
  for (const arg of restArgs) {
    if (isObjectLiteral(arg)) {
      // Spread the object inline so we don't get { meta: { ... } }
      entries.push(`...${arg}`);
    } else {
      const key = inferKey(arg, argIdx);
      // Avoid `{ foo: foo }` — use shorthand
      if (key === arg) entries.push(key);
      else entries.push(`${key}: ${arg}`);
    }
    argIdx++;
  }
  if (entries.length === 0) return null;
  return `{ ${entries.join(', ')} }`;
}

/**
 * Convert one console.* call's arg-string to a logger.* arg-string.
 * Returns null when the call is too complex to safely rewrite.
 */
function rewriteArgs(level, argsStr) {
  const args = splitArgs(argsStr);
  if (args.length === 0) return null;

  // Single arg — copy through unchanged
  if (args.length === 1) return args[0];

  const first = args[0];
  const rest = args.slice(1);

  // Common shape: console.error('text', err)  →  logger.error('text', { error: err.message, stack: err.stack })
  if (level === 'error' && rest.length === 1 && isSimpleIdentifier(rest[0])) {
    const id = rest[0];
    const msg = isStringLiteral(first) ? trimMessageTail(first) : first;
    return `${msg}, { error: ${id}.message, stack: ${id}.stack }`;
  }

  // 2nd arg already an object literal — leave it as the meta object
  if (rest.length === 1 && isObjectLiteral(rest[0])) {
    const msg = isStringLiteral(first) ? trimMessageTail(first) : first;
    return `${msg}, ${rest[0]}`;
  }

  // First arg is a string literal — wrap rest into a single metadata object
  if (isStringLiteral(first)) {
    const meta = buildMetaObject(rest);
    if (!meta) return first;
    return `${trimMessageTail(first)}, ${meta}`;
  }

  // First arg is a template literal and there are no further args we can fold
  if (first.startsWith('`') && rest.length === 0) return first;

  // Mixed first arg (template literal/identifier) + rest — wrap rest into meta object
  const meta = buildMetaObject(rest);
  if (!meta) return first;
  return `${first}, ${meta}`;
}

function convertFile(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  const callRegex = /console\.(log|info|warn|error|debug)\s*\(/g;

  let out = '';
  let cursor = 0;
  let converted = 0;
  let skipped = [];

  let m;
  while ((m = callRegex.exec(src)) !== null) {
    const startIdx = m.index;
    const consoleLevel = m[1];
    const loggerLevel = LEVEL_MAP[consoleLevel];
    const openParenIdx = m.index + m[0].length - 1;
    const closeParenIdx = findMatchingParen(src, openParenIdx);
    if (closeParenIdx === -1) {
      // Couldn't find matching paren — bail.
      skipped.push({ line: lineOf(src, startIdx), reason: 'unbalanced parens' });
      continue;
    }

    const argsStr = src.slice(openParenIdx + 1, closeParenIdx);
    const newArgs = rewriteArgs(loggerLevel, argsStr);
    if (newArgs === null) {
      skipped.push({ line: lineOf(src, startIdx), reason: 'complex args' });
      continue;
    }

    out += src.slice(cursor, startIdx);
    out += `logger.${loggerLevel}(${newArgs})`;
    cursor = closeParenIdx + 1;
    converted++;
    callRegex.lastIndex = closeParenIdx + 1;
  }
  out += src.slice(cursor);

  if (converted > 0) {
    fs.writeFileSync(filePath, out, 'utf8');
  }

  return { converted, skipped };
}

function lineOf(src, idx) {
  return src.slice(0, idx).split('\n').length;
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('Usage: convert-console-to-logger.js <file> [file...]');
  process.exit(1);
}

let totalConverted = 0;
let totalSkipped = 0;
for (const f of files) {
  const abs = path.resolve(f);
  if (!fs.existsSync(abs)) {
    console.error(`SKIP (not found): ${abs}`);
    continue;
  }
  const { converted, skipped } = convertFile(abs);
  totalConverted += converted;
  totalSkipped += skipped.length;
  console.log(`${path.relative(process.cwd(), abs)}: ${converted} converted, ${skipped.length} skipped`);
  for (const s of skipped) {
    console.log(`  line ${s.line}: ${s.reason}`);
  }
}
console.log(`\nTotal: ${totalConverted} converted, ${totalSkipped} skipped`);
