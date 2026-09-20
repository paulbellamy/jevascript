# jevascript

probably-lang's primitives (`feels`, `match`, `chaos`, `llm`) as a plain TypeScript library.
jev + javascript. 85 lines of runtime, no deps.

how close can a library get to [probably](https://probably-lang.southpolesteve.workers.dev/) without a
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

`p.classify(value, labels, confidence)` is the one judgment call `feels` and `match` are sugar over.
`Promise.all` over judgments works; the dsl is sequential.

## providers and recording

```ts
interface Provider {
  write(prompt: string, context?: Value): Promise<string>;
  judge(value: Value, labels: string[], options?: {sample?: boolean}): Promise<{probabilities: Record<string, number>; draw?: number}>;
}
```

`src/providers.ts` has a jev judge (`JEV_API_KEY`, `JEV_MODEL`; pin one, aliases rot) and a writer for any
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

## run

```sh
bun install && bun test        # 23 tests, 7 of them replaying probably's recordings, zero model calls
bun run check                  # tsc
JEV_API_KEY=… TEXT_API_KEY=… TEXT_BASE_URL=https://gateway.ai.cloudflare.com/v1/<acct>/<gw>/workers-ai/v1 \
  bun src/cli.ts examples/urgent.ts 'The demo starts in two minutes.' --record urgent.run.json
bun src/cli.ts --replay urgent.run.json
```

## layout

```
src/jevascript.ts    Jevascript (classify, feels, match, chaos, llm), Feeling, distribution()
src/recording.ts     record(provider) / replay(recording)
src/providers.ts     jev judge, chat-completions writer, fromEnv()
src/cli.ts           run an example live / replay a saved run
examples/*.prob      probably originals, unchanged
examples/*.ts        ports, side by side
test/                runtime, recording, fidelity (test/fixtures/recordings.json is probably's, verbatim)
```
