# jevascript

probably-lang's primitives (`feels`, `match`, `chaos`, `llm`, replay) as a plain TypeScript library.
jev + javascript. 141 lines of runtime, no deps. loops are just loops.

the question this experiment answers: how close can a library get to
[probably](https://probably-lang.southpolesteve.workers.dev/) without a parser?
answer: **all the way, on the semantics.** probably's own shipped recordings (real jev + llama results
for its seven examples) replay through the ts ports byte-for-byte, same output, same effect tape,
same decision trace. see `test/fidelity.test.ts`. what a library cannot give you is the surface syntax
and the sandbox; details in `NOTES.md`.

## the primitives

```ts
import {run, Jevascript} from './src/jevascript';

await run(async (p, email) => {
  // if email feels "…" with confidence 80% { } otherwise maybe { } else { }
  await p.feels(email, 'needs a reply urgently', {confidence: .8}).when({
    yes:   () => p.print('reply soon'),
    maybe: () => p.print('unclear, check the deadline yourself'),
    no:    () => p.print('finish your coffee'),
  });

  // match email { "label" => { } … }   (returns a value; the dsl can't)
  let reply = await p.match(email, {
    'an invitation to speak': () => p.llm('Draft a brief reply expressing interest…', email),
    'an unsolicited sales pitch': () => p.llm('Politely decline in one sentence.', email),
    'another kind of message': () => p.llm('Draft a warm acknowledgement…', email),
  });

  // while reply feels "…" { }   (a while loop; the 12-call budget bounds it)
  while ((await p.feels(reply, 'stiff, corporate, or unnecessarily wordy')).yes)
    reply = await p.llm('Make this brief and natural.', reply);

  // chaos { }   sample from the distribution instead of argmax; scope follows async control flow
  await p.chaos(() => p.feels(reply, 'a risky send').when({yes: () => p.print('send it anyway')}));

  p.print(reply);
}, {provider, input: email});
```

| probably | jevascript |
|---|---|
| `if v feels "q" with confidence 80% {a} otherwise maybe {b} else {c}` | `await p.feels(v,'q',{confidence:.8}).when({yes:a, maybe:b, no:c})` |
| `if v feels "q" {a}` | `if ((await p.feels(v,'q')).yes) a()` |
| `match v { "l1" => {a} "l2" => {b} }` | `await p.match(v, {l1:a, l2:b})` |
| `while v feels "q" { body }` | `while ((await p.feels(v,'q')).yes) body` |
| `llm "instruction" using v` | `await p.llm('instruction', v)` |
| `chaos { … }` | `await p.chaos(async () => { … })` |
| `repeat 3 { … }` | a for loop |
| `print(v)` | `p.print(v)` (collected into `run().output`) |
| `let` / `=` / `input()` | javascript |
| 12 calls, 5 loop iterations, 90 s | 12 calls and 90 s (`maxCalls`, `timeoutMs`); no loop cap, the call budget bounds loops |
| replay tape | same `Effect[]` shape, and order-independent (survives `Promise.all`) |

lower level: `p.classify(value, labels, confidence)` is the one judgment call everything else is sugar over.

`feels` resolves to a `Feeling`: `verdict` is `'yes' | 'maybe' | 'no'` (tri-state because of the confidence
gate), `.yes/.no/.maybe` are booleans, `probability` is p(yes). at the default 50% gate `maybe` cannot happen,
so `.yes` is a plain boolean there.

## run

```sh
bun install && bun test        # 24 tests, 7 of them replaying probably's recordings, zero model calls
bun run check                  # tsc
JEV_API_KEY=… TEXT_API_KEY=… TEXT_BASE_URL=https://gateway.ai.cloudflare.com/v1/<acct>/<gw>/workers-ai/v1 \
  bun src/cli.ts examples/urgent.ts 'The demo starts in two minutes.' --save urgent.run.json
bun src/cli.ts --replay urgent.run.json   # no keys needed
```

`src/providers.ts` sends the same jev request and the same writer system prompt as probably, so judgments
are comparable. `JEV_MODEL` pins a jev version (`jev-1.13.0`); aliases rot. any openai-compatible chat
endpoint works for the writer.

## layout

```
src/jevascript.ts    runtime: Jevascript class, Feeling, run(), distribution()
src/providers.ts     jev judge, chat-completions writer, fromEnv()
src/cli.ts           run an example live / replay a saved run
examples/*.prob      probably originals (unchanged, from the source zip)
examples/*.ts        ports, side by side
test/jevascript.test.ts   probably's runtime tests, ported, plus library-only behaviour
test/fidelity.test.ts     replay probably's recordings through the ports
test/fixtures/recordings.json   probably's src/recordings.json, verbatim
```
