# jevascript

probably-lang's primitives (`feels`, `match`, `chaos`, `llm`) as a plain TypeScript library, and `jev`, a cli
that brings them to the shell. jev + javascript. 142 lines of runtime, no deps.

how close can a library get to [probably](https://github.com/southpolesteve/probably) ([playground](https://probably-lang.southpolesteve.workers.dev/)) without a
parser? all the way, on the semantics: probably's own shipped recordings (real jev + llama results for
its seven examples) replay through the ts ports with identical output, and re-recording the replay
reproduces probably's recording exactly (`test/fidelity.test.ts`). what you don't get is the prose-like
syntax and the sandbox: probably's parser rejects `fetch(...)` before execution and bounds every program
by construction; a ts program is arbitrary code.

## the primitives

```ts
import {Jevascript} from './src/jevascript';
const p = new Jevascript(provider);

// if email feels "…" with confidence 80% { } otherwise maybe { } else { }
await p.feels(email, 'needs a reply urgently', {confidence: .8}).when({
  yes:   () => console.log('reply soon'),
  maybe: () => console.log('unclear, check the deadline yourself'),
  no:    () => console.log('finish your coffee'),
});

// match email { "label" => { } … }   (returns a value; the dsl can't)
let reply = await p.match(email, {
  'an invitation to speak': () => p.llm('Draft a brief reply expressing interest…', email),
  'an unsolicited sales pitch': () => p.llm('Politely decline in one sentence.', email),
  'another kind of message': () => p.llm('Draft a warm acknowledgement…', email),
});

// while reply feels "…" { }
while ((await p.feels(reply, 'stiff, corporate, or unnecessarily wordy')).yes)
  reply = await p.llm('Make this brief and natural.', reply);

// chaos { }   sample from the distribution instead of argmax; scope follows async control flow
await p.chaos(() => p.feels(reply, 'a risky send').when({yes: () => console.log('send it anyway')}));
```

| probably | jevascript |
|---|---|
| `if v feels "q" with confidence 80% {a} otherwise maybe {b} else {c}` | `await p.feels(v,'q',{confidence:.8}).when({yes:a, maybe:b, no:c})` |
| `if v feels "q" {a}` | `if ((await p.feels(v,'q')).yes) a()` |
| `match v { "l1" => {a} "l2" => {b} }` | `await p.match(v, {l1:a, l2:b})` |
| `while v feels "q" { body }` | `while ((await p.feels(v,'q')).yes) body` |
| `llm "instruction" using v` | `await p.llm('instruction', v)` |
| `chaos { … }` | `await p.chaos(async () => { … })` |
| `repeat 3 { … }` / `print` / `let` / `input()` | javascript |
| call, time and size limits | none |
| replay | opt-in: `record(provider)` / `replay(recording)` |

`feels` resolves to a `Feeling`: `verdict` is `'yes' | 'maybe' | 'no'` (tri-state because of the confidence
gate), `.yes/.no/.maybe` are booleans, `probability` is p(yes). at the default 50% gate `maybe` cannot happen,
so `.yes` is a plain boolean there. `feels` asks the judge to choose between `q` and `NOT: q`, like probably.

`p.classify(value, labels, confidence)` is the one judgment call `feels` and `match` are sugar over; `decide()` is
its decision rule (argmax, confidence gate, chaos sample), exported so batched judgments make the same decision.
`Promise.all` over judgments works; the dsl is sequential.

## providers and recording

```ts
interface Provider {
  write(prompt: string, context?: Value): Promise<string>;
  judge(value: Value, labels: string[], options?: {sample?: boolean}): Promise<{probabilities: Record<string, number>; draw?: number}>;
}
```

`src/providers.ts` has a jev judge (configured like the TypeSafe SDKs: `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`,
`TYPESAFE_DEFAULT_MODEL`, and retrying 408/429/5xx like them; pin a model, aliases rot) and a writer for any
openai-compatible chat endpoint (`TEXT_API_KEY`, `TEXT_BASE_URL`, `TEXT_MODEL`). both send probably's exact
prompts, so judgments are comparable.

recording is a provider wrapper; the runtime knows nothing about it:

```ts
import {record, replay} from './src/recording';
const live = record(provider);          // every judgment, generation and chaos draw lands in live.recording
await program(new Jevascript(live));

const again = replay(live.recording);   // no keys, no model calls
await program(new Jevascript(again));
again.finish();                          // throws if any recorded result went unused
```

effects match by kind and args, first unconsumed wins, so concurrent programs replay. a replaying provider
returns the recorded chaos `draw` alongside the probabilities so sampling reproduces; a live provider can
ignore `draw` and `record` fills it in. the effect shape is probably's, so its recordings load unchanged.
`replay(recording, claim)` takes an optional `claim(i)` that marks effect i used and says whether it was still free,
so several replays can share one recording; the cli shares one across processes this way.

## the cli

`jev` puts the judgments in the shell. questions are arguments, the value to judge comes on stdin, and answers come
back as exit codes and plain lines.

```sh
bun install -g github:paulbellamy/jevascript    # or bun run build: dist/jev, one standalone binary
curl -fLo jev https://github.com/paulbellamy/jevascript/releases/latest/download/jev-linux-x64 && chmod +x jev
export TYPESAFE_API_KEY=… TYPESAFE_DEFAULT_MODEL=jev-1.13.0    # and TYPESAFE_BASE_URL for another server
```

```sh
case $(jev feels -c 80 'genuinely urgent' <<<"$message") in    # examples/urgent.sh
  yes) … ;; maybe) … ;; no) … ;; *) exit 2 ;;
esac
case $(jev match bug='a bug report' idea='a useful suggestion' <<<"$feedback") in bug) … ;; idea) … ;; esac
while jev feels -q 'full of corporate jargon' <<<"$draft"; do draft=$(rewrite <<<"$draft"); done

jev grep -n 'something an on-call engineer should act on' < app.log     # a yes/no per line, batched
eval "$(jev ask 'urgent? Does this need a reply today?' 'kind: invite=an invitation | other' <<<"$email")"
jev feels urgent --dry-run <<<"$msg" | jev raw                          # print the request, then send it
jev run examples/urgent.ts 'The demo starts in two minutes.'            # a jevascript program
```

| exit | feels | match | grep | ask |
|---|---|---|---|---|
| 0 | yes | chose | some lines fit | answered |
| 1 | no | | no lines fit | |
| 2 | error | error | error | error |
| 3 | maybe (`-c`) | unsure (`-c`) | | some unsure (`-c`) |

errors are never 1, so a `case` can't mistake one for "no"; `if` folds 2 and 3 into false, like grep.

`feels`, `match` and `run` go through the library's `Provider`, so they send probably's exact request (a choice
between a description and its negation). `grep`, `ask` and `raw` talk to [systemone](https://docs.typesafe.ai/api)
directly, because one call carries many native questions: `grep` puts the lines in the state as an array and asks a
Noul per line that points at it (`` `lines[3]` ``), packing lines into calls by jev's context budget (64k tokens a
call, 32k for the state plus the longest question; there is no limit on the number of questions), or `--batch N` a
call; `ask` asks Nouls (`name? question`) and Choices (`name: question? a | key=b`) about one state (`-f key=value`,
`key=@file` and `key:=json` build a structured one). there is no text generation command; pair jev with any llm cli.

chaos is `--chaos` or `JEV_CHAOS=1`, and the flag wins (`--no-chaos` opts out). the env var is the shell's version
of the runtime's async scope: `JEV_CHAOS=1 some_function` makes every call inside it sample.

every jev call is its own process, so record and replay wrap a whole command:

```sh
jev record run.jsonl -- ./triage.sh < email.txt    # json lines, one effect each, in probably's shape
jev replay run.jsonl -- ./triage.sh < email.txt    # no keys, no model calls; fails on unused results
```

replaying processes claim effects by creating a file per effect, so concurrent calls (`&`) each get their own.

`jev --skill` prints `skills/jev/SKILL.md`, an agent skill for driving the cli. the binary embeds it, so it always
matches the version, and `jev --help` ends by pointing agents at it, the way herdr's does.

## run

```sh
bun install && bun test        # 42 tests; 10 replay probably's recordings (7 ts ports, 3 shell ports); zero model calls
bun run check                  # tsc
bun run lint                   # biome: format, lint, import order (bunx biome check --write . fixes)
bun install -g .               # jev on PATH
TYPESAFE_API_KEY=… TEXT_API_KEY=… TEXT_BASE_URL=https://gateway.ai.cloudflare.com/v1/<acct>/<gw>/workers-ai/v1 \
  jev record inbox.run.jsonl -- jev run examples/inbox.ts "$(cat email.txt)"
jev replay inbox.run.jsonl -- jev run examples/inbox.ts "$(cat email.txt)"
```

ci runs biome, tsc and the tests on every push and pull request. a merge to the default branch also builds jev for
linux, macos (x64, arm64) and windows (x64) and publishes them, with a `SHA256SUMS`, as a release tagged
`v<version>-<sha>`; `releases/latest/download/jev-<os>-<arch>` is always the newest.

## layout

```
src/jevascript.ts    Jevascript (classify, feels, match, chaos, llm), Feeling, decide(), distribution()
src/recording.ts     record(provider) / replay(recording, claim)
src/providers.ts     jev judge, systemone client, chat-completions writer, fromEnv()
src/jev.ts           the cli
skills/jev/SKILL.md  the agent skill `jev --skill` prints
examples/*.prob      probably originals, unchanged
examples/*.ts        ports, side by side
examples/*.sh        shell ports of the three without llm
test/                runtime, recording, cli, fidelity (test/fixtures/recordings.json is probably's, verbatim)
```

## license

MIT, see `LICENSE`. the probably examples, recordings and ported bits are probably's (MIT, Steve Faulkner);
see `THIRD_PARTY_NOTICES.md`.
