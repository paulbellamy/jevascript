# jevascript

probably-lang's primitives (`feels`, `match`, `chaos`, `llm`) as a plain TypeScript library.
jev + javascript. 85 lines of runtime, no deps. loops are loops, budgets are your problem, recording is opt-in.

the question this experiment answers: how close can a library get to
[probably](https://probably-lang.southpolesteve.workers.dev/) without a parser?
answer: **all the way, on the semantics.** probably's own shipped recordings (real jev + llama results
for its seven examples) replay through the ts ports byte-for-byte: same output, and re-recording the
replay reproduces probably's recording exactly. see `test/fidelity.test.ts`. what a library cannot give
you is the surface syntax and the sandbox; details in `NOTES.md`.

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

// while reply feels "…" { }   (a while loop)
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
| 12 calls, 5 loop iterations, 90 s, 200 statements | none. those were playground hygiene |
| replay tape | opt-in: `record(provider)` / `replay(recording)` in `src/recording.ts` |

`feels` resolves to a `Feeling`: `verdict` is `'yes' | 'maybe' | 'no'` (tri-state because of the confidence
gate), `.yes/.no/.maybe` are booleans, `probability` is p(yes). at the default 50% gate `maybe` cannot happen,
so `.yes` is a plain boolean there.

lower level: `p.classify(value, labels, confidence)` is the one judgment call `feels` and `match` are sugar over.

## recording

the runtime knows nothing about it. wrap the provider:

```ts
import {record, replay} from './src/recording';
const live = record(provider);          // every judgment, generation and chaos draw lands in live.recording
await program(new Jevascript(live));
await Bun.write('run.json', JSON.stringify(live.recording));

const again = replay(await Bun.file('run.json').json());   // no keys, no model calls
await program(new Jevascript(again));
again.finish();                          // throws if any recorded result went unused
```

effects match by kind and args, first unconsumed wins, so `Promise.all` programs replay too. the effect
shape is probably's, which is how `test/fixtures/recordings.json` (their file, verbatim) loads unchanged.
this is the same idea as jev-vim's `RecordingJevClient` / `FakeJevClient`: contract tests with zero spend.

## run

```sh
bun install && bun test        # 23 tests, 7 of them replaying probably's recordings, zero model calls
bun run check                  # tsc
JEV_API_KEY=… TEXT_API_KEY=… TEXT_BASE_URL=https://gateway.ai.cloudflare.com/v1/<acct>/<gw>/workers-ai/v1 \
  bun src/cli.ts examples/urgent.ts 'The demo starts in two minutes.' --record urgent.run.json
bun src/cli.ts --replay urgent.run.json   # no keys needed
```

`src/providers.ts` sends the same jev request and the same writer system prompt as probably, so judgments
are comparable. `JEV_MODEL` pins a jev version (`jev-1.13.0`); aliases rot. any openai-compatible chat
endpoint works for the writer.

## layout

```
src/jevascript.ts    runtime: Jevascript (classify, feels, match, chaos, llm), Feeling, distribution()
src/recording.ts     record(provider) / replay(recording)
src/providers.ts     jev judge, chat-completions writer, fromEnv()
src/cli.ts           run an example live / replay a saved run
examples/*.prob      probably originals (unchanged, from the source zip)
examples/*.ts        ports, side by side
test/jevascript.test.ts   probably's runtime tests that still apply, ported, plus library-only behaviour
test/recording.test.ts    record / replay
test/fidelity.test.ts     replay probably's recordings through the ports
test/fixtures/recordings.json   probably's src/recordings.json, verbatim
```
