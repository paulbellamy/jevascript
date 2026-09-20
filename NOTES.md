# NOTES: how close is a library to the language?

2026-09-20. reference: probably 0.1 source zip from the playground (478 loc total; `runtime.ts` is ~90).

## verdict

semantically identical on everything probably can express. proof is mechanical: the seven bundled
recordings (`src/recordings.json`, real jev + llama results captured once by the reference interpreter)
replay through the ts ports with identical output, identical effect tape, identical judge/loop trace.
that works because the ts ports issue the same effects with the same args in the same order, which means
the *decisions* (argmax, `NOT:` negation label, confidence gate, gate-then-sample in chaos, loop cap) are
the same code paths. 18 more unit tests are ports of probably's own.

## what maps 1:1

- `feels` = judge over `[q, "NOT: q"]`, gate on the winner's probability, tri-state result.
- `match` = judge over labels, argmax, first-label ties, no maybe branch (threshold 0).
- `while feels` = `while ((await p.feels(v,q)).yes)`. break on no OR uncertain, same as the dsl. no 5-iteration
  cap: the 12-call budget bounds a runaway loop anyway. (a `whileFeels` async iterator existed in the first cut,
  purely for the cap and the `Iteration n of 5` trace events; removed. control flow is the host's job, that's
  the whole thesis.)
- `chaos` = same "gate first, then sample with the draw" order. scope is an `AsyncLocalStorage`, so it
  behaves like the lexical block even across awaits and nested calls.
- `llm` = same `{prompt, value}` args; the model sees only what you pass.
- budgets: 12 effects, 90 s, 25 s per call (provider side), 6 k input, 12 k output.
- provider interface is byte-compatible; probably's `providers.ts` drops in.
- `Run` shape is the same minus `source` (we store the program name), line numbers and loop-iteration events
  in the trace. the fidelity test compares output, tape and judge trace.

## where the library is better

- `match` returns a value. the dsl has to assign inside branches.
- loops are host loops; the body is ordinary code.
- `feels` is a value (`verdict`, `probability`, `probabilities`) not just a branch. you can log it, gate on
  `p.probability > .95` yourself, or aggregate several judgments in code (which is what the jev-vim
  experiment found jev is actually good at: local yes/no, code does the counting).
- concurrency: `Promise.all([p.feels(a,q), p.feels(b,q)])` works and still replays, because tape lookup
  is by `(kind, args)` first-unconsumed rather than by cursor. the dsl is strictly sequential.
- arithmetic, arrays, objects, functions, imports, types. the dsl's 0.1 has none, deliberately.
- one judgment primitive underneath (`classify`), so new sugar is a few lines.

## what a library cannot give you

- **the syntax.** `if x feels "…" with confidence 80% { } otherwise maybe { }` reads like prose;
  `.when({yes, maybe, no})` reads like code. this is the whole aesthetic of the thing and it is not
  recoverable without a parser or a babel plugin. `while ((await p.feels(v, q)).yes)` is honestly fine.
- **the sandbox.** probably's parser rejects `print(process.env)` and `fetch(...)` before execution; the
  hosted worker never executes user programs at all. a ts program is arbitrary code. if you want
  untrusted programs, you want the language (or a vm boundary), not this.
- **static budgets.** the 200-statement limit and 12-block nesting limit are meaningless for js; only
  the effect count, loop cap and wall clock survive. you can't bound a program by looking at it.
- **`using` as an isolation guarantee at the program level.** the *model* still only sees what you pass,
  but nothing stops a ts closure from reading a variable it "shouldn't". in the dsl the syntax makes the
  data flow explicit and auditable. a lint rule could approximate it; didn't bother.
- **line numbers in the trace.** could recover from `new Error().stack`; skipped as cute-but-fragile.

## smaller things

- `feels` returns a promise augmented with `.when`, so `await p.feels(...).when({...})` is one expression.
  `await (await p.feels(...)).when(...)` was too ugly to ship.
- `chaos` via `AsyncLocalStorage` means it needs node/bun. for browsers you'd pass an explicit chaotic
  handle instead; not done.
- confidence is a fraction (`.8`) not a percent; the dsl's `50–100%` range isn't enforced, only `0–1`.
- no live calls were made in this session: no `JEV_API_KEY` or text key in the env. the jev adapter is a
  transliteration of probably's and untested against the real endpoint. the jev-vim notes say the sdk
  route is `POST https://api.typesafe.ai/v1/systemone` with `model` in the body, which matches.

## open questions

- is jev's `NOT: q` negation trick well-calibrated? probably uses it for every `feels`. the jev-vim
  calibration plot found jev *under*-confident on choice questions; a `feels` at 80% may be gating
  harder than intended. a `Noul`-based `feels` (jev has a native yes/no primitive) might be better and
  cheaper than a two-option `Choice`, but would break recording compatibility. worth an a/b with real keys.
- would people actually write the `.when({...})` form, or reach for `if ((await p.feels(...)).yes)`
  and lose the maybe branch by default? the dsl forces you to at least see `otherwise maybe` in the
  docs. the library's `missing maybe handler runs nothing` matches the dsl but is a foot-gun.
