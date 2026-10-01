#!/usr/bin/env bun
// jev: jevascript's judgments from the shell. Questions are arguments; the value to judge comes on stdin.
// feels / match / run go through the library's Provider (probably's protocol); grep / ask / raw talk to systemone
// directly (https://docs.typesafe.ai/api), so one call carries many native questions. record / replay wrap a whole
// command, so every jev call inside it shares one tape.

import {
  appendFileSync,
  closeSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isatty } from 'node:tty';
import { parseArgs } from 'node:util';
import skill from '../skills/jev/SKILL.md' with { type: 'text' };
import { decide, Jevascript, JevascriptError, type Provider } from './jevascript';
import {
  type Choice,
  choiceAnswer,
  fromEnv,
  jevConfig,
  judgeRequest,
  type Noul,
  noulAnswer,
  type SystemOneRequest,
  type SystemOneResponse,
  systemOne,
} from './providers';
import { type Effect, type Recording, record, replay } from './recording';

// Like herdr's: help ends by pointing agents at the skill, and only when their task calls for it.
const AGENT_HELP_FOOTER = `Are you an AI? Use these resources ONLY IF your task specifically asks you to:
  Judge text with jev from a shell or a script:
    SKIP if a jev skill is already in your context. Otherwise run: jev --skill
  Build on the TypeSafe API that jev calls:
    https://docs.typesafe.ai/llms.txt`;

const USAGE = `jev: judge text from the shell with jev, TypeSafe's System One model

Usage: jev COMMAND [options] ...     (the value to judge comes on stdin)

Commands:
  jev feels [-c 80] [-q] [-p] DESCRIPTION       prints yes|no|maybe, exits 0|1|3
  jev match [-c 80] [-p] LABEL|KEY=LABEL ...    prints the chosen key, exits 3 if unsure
  jev grep  [-c 80] [-q] [-p] [-v] [-n] [--batch N] DESCRIPTION
                                                prints the lines that fit: a yes/no per line
  jev ask   [-c 80] [-p] [--json] [-f K=V|K=@FILE|K:=JSON]...
            'NAME? QUESTION' 'NAME: [QUESTION?] A | KEY=B ...'
                                                asks them all in one call, prints NAME=answer
  jev raw                                       sends a systemone request, prints the response
  jev run PROGRAM.ts [INPUT]                    runs a jevascript program
  jev record FILE -- COMMAND ...                records every jev call COMMAND makes
  jev replay FILE -- COMMAND ...                replays them: no keys, no model calls

Options:
  -c N                confidence gate: 80, 80% or .8
  -p                  prefix a probability column
  --chaos             sample instead of taking the argmax (default: JEV_CHAOS); --no-chaos to opt out
  --dry-run           print the request instead of sending it (jev raw sends it)
  --skill             print the agent skill file and exit
  --help, -h          show this help

Exit:   2 is an error; 0, 1 and 3 are answers, as above
Env:    TYPESAFE_API_KEY, TYPESAFE_BASE_URL, TYPESAFE_DEFAULT_MODEL (as in the TypeSafe SDKs), JEV_CHAOS
Home:   https://github.com/paulbellamy/jevascript

${AGENT_HELP_FOOTER}`;

const YES = 0,
  NO = 1,
  ERROR = 2,
  UNSURE = 3;
class UsageError extends Error {}
const out = (line: string) => console.log(line);
const fmt = (p: number) => p.toFixed(3);

// ---- model access: live, or replaying JEV_REPLAY; recording to JEV_RECORD --------------------------------------

/** A direct systemone call (grep, ask, raw), with each question's chaos draw when sampled. */
type Call = { kind: 'systemone'; args: SystemOneRequest; result: SystemOneResponse; draws?: Record<string, number> };
type Tape = (Effect | Call)[];
type Session = {
  provider: Provider;
  ask(
    request: SystemOneRequest,
    sample: boolean,
  ): Promise<{ response: SystemOneResponse; draws?: Record<string, number> }>;
  save(): void;
};

/** JSON lines, one effect each (what `jev record` writes), or a JSON array (probably's tape). */
function readTape(file: string): Tape {
  const text = readFileSync(file, 'utf8');
  return text.trimStart().startsWith('[')
    ? JSON.parse(text)
    : text
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
}

/** Claim effect i of a shared tape by creating a file named i in `dir`. Creation is atomic, so exactly one process
 *  gets each effect, with no locks to leak. */
const claimer = (dir: string) => (i: number) => {
  try {
    closeSync(openSync(join(dir, String(i)), 'wx'));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
};

function session(env = process.env): Session {
  let provider: Provider, ask: Session['ask'];
  if (env.JEV_REPLAY) {
    if (!env.JEV_REPLAY_CLAIMS)
      throw new UsageError('JEV_REPLAY is set by `jev replay FILE -- COMMAND`; run under that.');
    const tape = readTape(env.JEV_REPLAY),
      claim = claimer(env.JEV_REPLAY_CLAIMS);
    provider = replay(tape as Recording, claim);
    ask = async (args, sample) => {
      const key = JSON.stringify(args);
      const i = tape.findIndex((e, i) => e.kind === 'systemone' && JSON.stringify(e.args) === key && claim(i));
      if (i === -1) throw new JevascriptError('Recording does not match this program and input.');
      const { result, draws } = tape[i] as Call;
      if (sample && !draws) throw new JevascriptError('Recording has no chaos draw for this judgment.');
      return { response: result, draws };
    };
  } else {
    provider = fromEnv(env);
    const jev = jevConfig(env),
      post = jev && systemOne(jev);
    ask = async (args, sample) => {
      if (!post) throw new Error('No judge (TYPESAFE_API_KEY) configured. See README.');
      return {
        response: await post(args),
        draws: sample
          ? Object.fromEntries(Object.keys(args.questions).map((name) => [name, Math.random()]))
          : undefined,
      };
    };
  }
  if (!env.JEV_RECORD) return { provider, ask, save() {} };
  const live = record(provider),
    tape: Tape = live.recording,
    file = env.JEV_RECORD,
    inner = ask;
  return {
    provider: live,
    async ask(args, sample) {
      const r = await inner(args, sample);
      tape.push({ kind: 'systemone', args, result: r.response, ...(r.draws ? { draws: r.draws } : {}) });
      return r;
    },
    save() {
      if (tape.length) appendFileSync(file, tape.map((e) => `${JSON.stringify(e)}\n`).join(''));
    },
  };
}

// ---- arguments ---------------------------------------------------------------------------------------------------

const judging = {
  confidence: { type: 'string', short: 'c' },
  chaos: { type: 'boolean' },
  'no-chaos': { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  probability: { type: 'boolean', short: 'p' },
} as const;
const quiet = { quiet: { type: 'boolean', short: 'q' } } as const;
type Options = Parameters<typeof parseArgs>[0] extends infer C
  ? C extends { options?: infer O }
    ? NonNullable<O>
    : never
  : never;
const parse = <O extends Options>(args: string[], options: O) =>
  parseArgs({ args, options, allowPositionals: true, strict: true });

const truthy = (v?: string) => !!v && !/^(0|false|no|off)$/i.test(v);
function chaotic(values: { chaos?: boolean; 'no-chaos'?: boolean }): boolean {
  if (values.chaos && values['no-chaos']) throw new UsageError('--chaos and --no-chaos conflict.');
  return values.chaos ? true : values['no-chaos'] ? false : truthy(process.env.JEV_CHAOS);
}
/** 80, 80% and .8 all mean 80%. */
function confidence(s: string | undefined, fallback: number): number {
  if (s === undefined) return fallback;
  const m = /^(\d+(?:\.\d+)?|\.\d+)(%?)$/.exec(s),
    n = m ? Number(m[1]) / (m[2] || Number(m[1]) > 1 ? 100 : 1) : NaN;
  if (!(n >= 0 && n <= 1)) throw new UsageError(`-c takes a confidence like 80, 80% or .8, not ${JSON.stringify(s)}.`);
  return n;
}
function one(positionals: string[], what: string): string {
  if (positionals.length !== 1)
    throw new UsageError(`expected ${what} as one argument (quote it), got ${positionals.length}.`);
  return positionals[0];
}
/** `key=label` answers with key; a bare label answers with itself. */
const KEYED = /^([A-Za-z_][\w-]*)=([\s\S]+)$/;
type Label = { key: string; label: string };
function labels(args: string[]): Label[] {
  const ls = args.map((arg) => {
    const m = KEYED.exec(arg);
    return m ? { key: m[1], label: m[2] } : { key: arg, label: arg };
  });
  if (ls.length < 2) throw new UsageError('give at least two labels.');
  for (const k of ['key', 'label'] as const)
    if (new Set(ls.map((l) => l[k])).size < ls.length)
      throw new UsageError(`duplicate ${k}s in ${JSON.stringify(args)}.`);
  return ls;
}
const yesNo = (question: string) => [question, `NOT: ${question}`];
/** A Noul's verdict under the gate (and chaos draw), by the rule every other judgment uses. */
const verdictOf = (p: number, c: number, draw?: number) =>
  decide({ yes: p, no: 1 - p }, ['yes', 'no'], c, draw) ?? 'maybe';
function count(s: string, flag: string): number {
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`${flag} takes a whole number, not ${JSON.stringify(s)}.`);
  return n;
}

async function stdin(): Promise<string> {
  if (isatty(0)) throw new UsageError('pipe the value to judge on stdin, e.g. jev feels "urgent" <<<"$message".');
  return await Bun.stdin.text();
}
/** Like $(…): trailing newlines are not part of the value. */
const trim = (text: string) => text.replace(/\n+$/, '');
const within = <R>(p: Jevascript, chaos: boolean, body: () => Promise<R>) => (chaos ? p.chaos(body) : body());

// ---- commands ----------------------------------------------------------------------------------------------------

async function feels(args: string[], s: Session): Promise<number> {
  const { values, positionals } = parse(args, { ...judging, ...quiet });
  const question = one(positionals, 'a question'),
    c = confidence(values.confidence, 0.5),
    value = trim(await stdin());
  if (values['dry-run']) {
    out(JSON.stringify(judgeRequest(value, yesNo(question))));
    return YES;
  }
  const p = new Jevascript(s.provider);
  const f = await within(p, chaotic(values), () => p.feels(value, question, { confidence: c }));
  if (!values.quiet) out(values.probability ? `${fmt(f.probability)}\t${f.verdict}` : f.verdict);
  return f.yes ? YES : f.no ? NO : UNSURE;
}

async function match(args: string[], s: Session): Promise<number> {
  const { values, positionals } = parse(args, judging);
  const ls = labels(positionals),
    c = confidence(values.confidence, 0),
    value = trim(await stdin());
  if (values['dry-run']) {
    out(
      JSON.stringify(
        judgeRequest(
          value,
          ls.map((l) => l.label),
        ),
      ),
    );
    return YES;
  }
  const p = new Jevascript(s.provider);
  const r = await within(p, chaotic(values), () =>
    p.classify(
      value,
      ls.map((l) => l.label),
      c,
    ),
  );
  if (r.label === null) return UNSURE;
  const key = ls.find((l) => l.label === r.label)?.key ?? r.label;
  out(values.probability ? `${fmt(r.probabilities[r.label])}\t${key}` : key);
  return YES;
}

// jev-1.13's budget (https://docs.typesafe.ai/models): 64k tokens for the state plus every question, 32k for the
// state plus the longest question; no limit on the number of questions. There is no tokenizer here, so count a
// token per 3 bytes and keep some headroom.
const REQUEST_TOKENS = 56000,
  STATE_TOKENS = 28000,
  PARALLEL_CALLS = 4;
const tokens = (json: unknown) => Math.ceil(Buffer.byteLength(JSON.stringify(json)) / 3);
/** One Noul per line, pointing at the line by path (https://docs.typesafe.ai/primitives#reference-specific-fields). */
const lineQuestion = (description: string, j: number): Noul => ({
  type: 'noul',
  instructions: `Does \`lines[${j}]\` match this description: ${JSON.stringify(description)}?`,
});
/** Lines go into the state as {lines:[…]}, as many per request as the budget (or `max`) allows. */
function batches(lines: string[], description: string, max: number): number[][] {
  const all: number[][] = [];
  let batch: number[] = [],
    state = 0,
    questions = 0,
    longest = 0;
  lines.forEach((line, i) => {
    const l = tokens(line) + 1,
      q = tokens(lineQuestion(description, batch.length)) + 4;
    if (
      batch.length &&
      (batch.length >= max ||
        state + l + Math.max(longest, q) > STATE_TOKENS ||
        state + l + questions + q > REQUEST_TOKENS)
    ) {
      all.push(batch);
      batch = [];
      state = questions = longest = 0;
    }
    batch.push(i);
    state += l;
    questions += q;
    longest = Math.max(longest, q);
  });
  if (batch.length) all.push(batch);
  return all;
}
async function pool<T>(tasks: (() => Promise<T>)[], n: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, tasks.length) }, async () => {
      while (next < tasks.length) {
        const i = next++;
        results[i] = await tasks[i]();
      }
    }),
  );
  return results;
}

async function grep(args: string[], s: Session): Promise<number> {
  const { values, positionals } = parse(args, {
    ...judging,
    ...quiet,
    invert: { type: 'boolean', short: 'v' },
    'line-number': { type: 'boolean', short: 'n' },
    batch: { type: 'string' },
  });
  const description = one(positionals, 'a description'),
    c = confidence(values.confidence, 0.5),
    chaos = chaotic(values);
  const max = values.batch === undefined ? Infinity : count(values.batch, '--batch');
  const lines = (await stdin()).split('\n');
  if (lines.at(-1) === '') lines.pop();
  const plan = batches(lines, description, max);
  const requests: SystemOneRequest[] = plan.map((batch) => ({
    state: { lines: batch.map((i) => lines[i]) },
    questions: Object.fromEntries(batch.map((i, j) => [`L${i + 1}`, lineQuestion(description, j)])),
  }));
  if (values['dry-run']) {
    for (const r of requests) out(JSON.stringify(r));
    return YES;
  }
  const results = await pool(
    requests.map((r) => () => s.ask(r, chaos)),
    PARALLEL_CALLS,
  );
  const wanted = values.invert ? 'no' : 'yes';
  let matched = 0;
  plan.forEach((batch, b) => {
    const { response, draws } = results[b];
    for (const i of batch) {
      const name = `L${i + 1}`,
        p = noulAnswer(response, name);
      if (verdictOf(p, c, chaos ? draws?.[name] : undefined) !== wanted) continue;
      matched++;
      if (!values.quiet)
        out(`${values.probability ? `${fmt(p)}\t` : ''}${values['line-number'] ? `${i + 1}:` : ''}${lines[i]}`);
    }
  });
  return matched ? YES : NO;
}

/** `name? question` asks a Noul; `name: [question?] a | key=b | …` a Choice between the labels, keyed by their keys. */
const SPEC = /^([A-Za-z_]\w*)\s*([?:])\s*([\s\S]+)$/;
type Spec = { name: string; question: string; labels?: Label[] };
function spec(arg: string): Spec {
  const m = SPEC.exec(arg);
  if (!m)
    throw new UsageError(
      `ask questions look like 'name? question' or 'name: [question?] label | key=label', not ${JSON.stringify(arg)}.`,
    );
  const [, name, kind, text] = m;
  if (kind === '?') return { name, question: text.trim() };
  const bar = text.indexOf('|'),
    asked = text.slice(0, bar < 0 ? text.length : bar).lastIndexOf('?');
  const ls = labels(
    text
      .slice(asked + 1)
      .split('|')
      .map((l) => l.trim()),
  );
  if (ls.length > 255) throw new UsageError('a choice takes at most 255 labels.');
  return { name, question: text.slice(0, asked + 1).trim(), labels: ls };
}
/** -f key=value, key=@file (text), key:=json, key:=@file.json */
function field(arg: string): [string, unknown] {
  const m = /^([^=:@]+?)(:=|=)(@?)([\s\S]*)$/.exec(arg);
  if (!m) throw new UsageError(`-f takes key=value, key=@file, key:=json or key:=@file, not ${JSON.stringify(arg)}.`);
  const raw = m[3] ? trim(readFileSync(m[4], 'utf8')) : m[4];
  return [m[1], m[2] === ':=' ? JSON.parse(raw) : raw];
}
const sh = (v: string) => (/^[\w./:+-]+$/.test(v) ? v : `'${v.replaceAll("'", `'\\''`)}'`);

async function ask(args: string[], s: Session): Promise<number> {
  const { values, positionals } = parse(args, {
    ...judging,
    json: { type: 'boolean' },
    field: { type: 'string', short: 'f', multiple: true },
  });
  const specs = positionals.map(spec);
  if (!specs.length) throw new UsageError('ask needs at least one question.');
  if (new Set(specs.map((q) => q.name)).size < specs.length) throw new UsageError('ask question names must be unique.');
  let value: string | undefined;
  if (!isatty(0)) {
    const text = trim(await Bun.stdin.text());
    if (text) value = text;
  }
  const fields = Object.fromEntries((values.field ?? []).map(field)),
    structured = Object.keys(fields).length > 0;
  if (value === undefined && !structured)
    throw new UsageError('ask needs something to judge: pipe it on stdin, or pass -f key=value.');
  // Plain text is the state itself; fields make an object (stdin under `value`) that questions point into by path.
  const state = structured ? { ...(value === undefined ? {} : { value }), ...fields } : value;
  const request: SystemOneRequest = {
    state,
    questions: Object.fromEntries(
      specs.map((q) => [
        q.name,
        q.labels
          ? ({
              type: 'choice',
              instructions: q.question || `Which option best describes ${structured ? 'the state' : 'this'}?`,
              criteria: Object.fromEntries(q.labels.map((l) => [l.key, l.key === l.label ? null : l.label])),
            } satisfies Choice)
          : ({ type: 'noul', instructions: q.question } satisfies Noul),
      ]),
    ),
  };
  if (values['dry-run']) {
    out(JSON.stringify(request));
    return YES;
  }
  const chaos = chaotic(values),
    { response, draws } = await s.ask(request, chaos);
  let unsure = false;
  const answers = specs.map((q) => {
    const draw = chaos ? draws?.[q.name] : undefined;
    if (!q.labels) {
      const p = noulAnswer(response, q.name),
        verdict = verdictOf(p, confidence(values.confidence, 0.5), draw);
      unsure ||= verdict === 'maybe';
      return { name: q.name, answer: verdict, probability: p, probabilities: { yes: p, no: 1 - p } };
    }
    const keys = q.labels.map((l) => l.key),
      probabilities = choiceAnswer(response, q.name, keys);
    const chosen = decide(probabilities, keys, confidence(values.confidence, 0), draw);
    unsure ||= chosen === null;
    return {
      name: q.name,
      answer: chosen,
      probability:
        probabilities[chosen ?? keys.reduce((best, k) => (probabilities[k] > probabilities[best] ? k : best))],
      probabilities,
    };
  });
  if (values.json) out(JSON.stringify(Object.fromEntries(answers.map(({ name, ...a }) => [name, a]))));
  else
    for (const a of answers) {
      out(`${a.name}=${sh(a.answer ?? '')}`);
      if (values.probability) out(`${a.name}_p=${fmt(a.probability)}`);
    }
  return unsure ? UNSURE : YES;
}

async function raw(args: string[], s: Session): Promise<number> {
  parse(args, {});
  const { response } = await s.ask(JSON.parse(await stdin()) as SystemOneRequest, false);
  out(JSON.stringify(response));
  return YES;
}

async function run(args: string[], s: Session): Promise<number> {
  const { values, positionals } = parse(args, { chaos: judging.chaos, 'no-chaos': judging['no-chaos'] });
  if (positionals.length < 1 || positionals.length > 2) throw new UsageError('jev run PROGRAM.ts [INPUT]');
  const program = (await import(resolve(positionals[0]))).default;
  const p = new Jevascript(s.provider);
  await within(p, chaotic(values), () => program(p, positionals[1] ?? '', out));
  return YES;
}

async function wrap(mode: 'record' | 'replay', args: string[]): Promise<number> {
  const [file, ...rest] = args,
    command = rest[0] === '--' ? rest.slice(1) : rest;
  if (!file || !command.length) throw new UsageError(`jev ${mode} FILE -- COMMAND ...`);
  const path = resolve(file);
  const spawn = (env: Record<string, string>) =>
    Bun.spawn(command, { stdio: ['inherit', 'inherit', 'inherit'], env: { ...process.env, ...env } }).exited;
  if (mode === 'record') {
    writeFileSync(path, '');
    return spawn({ JEV_RECORD: path });
  }
  const effects = readTape(path).length,
    claims = mkdtempSync(join(tmpdir(), 'jev-replay-'));
  try {
    const code = await spawn({ JEV_REPLAY: path, JEV_REPLAY_CLAIMS: claims });
    const unused = effects - readdirSync(claims).length;
    if (unused > 0) {
      console.error(`jev: recording has ${unused} unused model result${unused === 1 ? '' : 's'}.`);
      return code || ERROR;
    }
    return code;
  } finally {
    rmSync(claims, { recursive: true, force: true });
  }
}

// ---- main --------------------------------------------------------------------------------------------------------

const commands: Record<string, (args: string[], s: Session) => Promise<number>> = { feels, match, grep, ask, raw, run };
const [command, ...args] = process.argv.slice(2);
const wrapping = command === 'record' || command === 'replay';
// `jev COMMAND --help` shows help too, but never for what record / replay run (everything after FILE) or after `--`.
const own = wrapping ? args.slice(0, 1) : args.slice(0, args.indexOf('--') + 1 || undefined);
const help =
  command === 'help' ||
  command === '-h' ||
  command === '--help' ||
  ((wrapping || Object.hasOwn(commands, command ?? '')) && own.some((a) => a === '--help' || a === '-h'));
let s: Session | undefined;
try {
  if (help) {
    out(USAGE);
    process.exitCode = YES;
  } else if (command === '--skill') {
    process.stdout.write(skill);
    process.exitCode = YES;
  } else if (wrapping) process.exitCode = await wrap(command, args);
  else if (command && Object.hasOwn(commands, command)) {
    s = session();
    process.exitCode = await commands[command](args, s);
  } else if (command) throw new UsageError(`unknown command ${JSON.stringify(command)}.`);
  else {
    console.error(USAGE);
    process.exitCode = ERROR;
  }
} catch (error) {
  const usage = error instanceof UsageError || String((error as { code?: unknown })?.code).startsWith('ERR_PARSE_ARGS');
  console.error(`jev: ${error instanceof Error ? error.message : error}${usage ? '\nsee jev --help' : ''}`);
  process.exitCode = ERROR;
} finally {
  s?.save();
}
