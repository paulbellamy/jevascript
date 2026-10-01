---
name: jev
description: "Judge text from the shell with the `jev` CLI: yes/no questions, picking one of several labels, filtering lines, or answering several questions about one input, backed by jev (TypeSafe's System One model). Use when a script or task needs a fuzzy decision about text (is this email urgent, is this a bug report or a feature request, which log lines matter) that string matching can't make. jev only judges; it never writes text. Requires `jev` on PATH and TYPESAFE_API_KEY, or a run under `jev replay`."
---

# jev

`jev` asks jev, a typed-decision model, narrow questions about text and turns the answers into exit codes and plain
lines that shell control flow can use. It returns probabilities over choices you supply. It does not generate text.

Before the first call, check that it can work:

```bash
command -v jev && test -n "${TYPESAFE_API_KEY:-}${JEV_REPLAY:-}"
```

If that fails, say that jev is not installed or has no key, and stop. Do not invent a key or call the API another way.

`jev --help` is the authority for syntax. Configuration uses the TypeSafe SDKs' variables: `TYPESAFE_API_KEY`,
`TYPESAFE_BASE_URL` (the API root, default `https://api.typesafe.ai`) and `TYPESAFE_DEFAULT_MODEL` (default
`jev-latest`). Pin a model such as `jev-1.13.0` when thresholds matter; the alias moves.

## The one rule: questions are arguments, data is stdin

The question and the labels are yours: write them as arguments. The text being judged always goes on stdin. Never
splice the text you are judging into a question or label, and never put untrusted text in arguments: stdin is
what jev treats as data rather than instructions. Quote each question as one argument.

```bash
jev feels 'needs a reply urgently' <<<"$email"      # right
jev feels "is this urgent: $email"                  # wrong: data in the question, and no stdin
```

Everything on stdin is sent to the jev API. Do not pipe secrets, credentials or data the user has not agreed to send.

## Exit codes

| code | feels | match | grep | ask |
|---|---|---|---|---|
| 0 | yes | chose | some lines fit | all answered |
| 1 | no | | no lines fit | |
| 2 | error | error | error | error |
| 3 | maybe (under `-c`) | unsure (under `-c`) | | some unsure (under `-c`) |

`if` treats 2 and 3 like 1. When an error or a maybe must not read as "no", use `case` on the output and give it a
`*)` branch. Under `set -e`, a bare `jev feels` that answers no ends the script; keep jev in `if`, `while`, `case $(…)`
or `|| …`.

## Pick the command

- One yes/no question: `jev feels`.
- One of several labels: `jev match`.
- Which lines of a file or stream fit: `jev grep` (a yes/no question per line, as many per call as fit).
- Several questions about the same input: `jev ask` (one call for all of them: the input is paid for once, and the
  questions run in parallel, so it is much cheaper and faster than several `feels`).
- Anything else systemone can express: `jev raw`, starting from another command's `--dry-run`.

### jev feels

```bash
if jev feels 'needs a reply urgently' <<<"$email"; then …; fi

case $(jev feels -c 80 'genuinely urgent' <<<"$message") in   # prints yes, no or maybe
  yes)   … ;;
  maybe) … ;;        # only possible with -c
  no)    … ;;
  *)     exit 2 ;;   # error: nothing on stdout, a message on stderr
esac

while jev feels -q 'full of corporate jargon' <<<"$draft"; do draft=$(rewrite "$draft"); done
```

### jev match

Labels are descriptions. Write `key=description` to get a short key back for `case`; a bare label prints itself.
Use 2 to 8 labels that don't overlap, and include a catch-all.

```bash
case $(jev match invite='an invitation to speak' meeting='a request to schedule a meeting' \
                 pitch='an unsolicited sales pitch' other='another kind of message' <<<"$email") in
  invite) … ;; meeting) … ;; pitch) … ;; other) … ;; *) exit 2 ;;
esac
```

`match` always picks one, unless you gate it: with `-c 80` it prints nothing and exits 3 when the best label is
under 80%.

### jev grep

```bash
jev grep 'an error a human should look at' < app.log
git log --oneline | jev grep -n 'a risky change to auth or billing'
jev grep -p 'urgent' < todo.txt | sort -rn | head -3     # -p adds a p(yes) column: rank the lines that fit
jev grep -v 'routine noise' < app.log                     # the lines that don't fit
```

Each line gets its own yes/no question, which points at that line; with `-c`, lines jev is unsure about are printed
by neither `grep` nor `grep -v`. Lines are packed into as few calls as jev's context budget allows (64k tokens a
call). Every other line in a call is noise for a given question, and jev loses accuracy as noise grows; when
accuracy matters more than cost, cap the lines per call with `--batch 50`.

### jev ask

`name? question` asks a yes/no question: write the whole question, exactly as you mean it. `name: question? a |
key=b | …` chooses between labels; the question is optional, and a label without `key=` is its own key. Output is
`name=answer` lines, quoted for `eval`, so the names become shell variables: use lowercase names that don't shadow
anything (`PATH`, `IFS`).

```bash
eval "$(jev ask 'urgent? Does this email need a reply today?' \
                'kind: What kind of email is this? invite=an invitation | meeting=a scheduling request | other' <<<"$email")"
echo "$urgent $kind"      # yes meeting
```

One question per condition: "Is it angry and asking for a refund?" is two questions. Phrase yes/no questions so
that yes is the case you act on.

`-p` adds `name_p=` lines; `--json` prints `{"name":{"answer","probability","probabilities"}}` for jq. Under `-c`, an
unsure yes/no answer is `maybe` and an unsure choice is empty.

Give structured input with fields, instead of stdin or alongside it (stdin becomes `value`): `-f title="$t"`,
`-f diff=@change.patch` (file contents), `-f meta:='{"n":1}'` (JSON), `-f meta:=@meta.json`. With fields, point
each question at the part it is about, by name in backticks: `'risky? Does \`diff\` change authentication?'`.
`ask` reads stdin whenever it isn't a terminal, so with fields only, add `</dev/null` if stdin might be an open pipe.

### jev raw

`jev raw` sends a systemone request from stdin and prints the JSON response. Every judging command accepts
`--dry-run`, which prints its request instead of sending it, so this round-trips:

```bash
jev feels 'urgent' --dry-run <<<"$msg" | jev raw | jq .answers.decision.probabilities
```

### jev run

`jev run program.ts 'input'` runs a jevascript program (a default export taking the runtime, the input and a print
function). Prefer the shell commands above for scripts.

## Confidence and probabilities

The default gate is 50%, where a yes/no answer is never maybe. `-c 80` (or `80%`, `.8`) adds the unsure outcome.
`-p` prints the probability. Set a threshold by the cost of being wrong, and check it on real examples. `feels` and
`match` ask in probably's form (a choice between the description and its negation), while `grep` and `ask` use jev's
native yes/no question; their numbers are not interchangeable, so don't carry a threshold from one to the other.

Keep each question narrow: one snap judgment about one thing. jev reads literally, and does badly at counting,
arithmetic, comparing dates and multi-step reasoning; do those in the script and ask jev only the judgment.

## Chaos

`--chaos`, or `JEV_CHAOS=1` in the environment, samples each answer from its probabilities instead of taking the most
likely one. The variable scopes like any other: `JEV_CHAOS=1 some_function` makes every jev call inside it sample.
`--no-chaos` opts one call out. Leave it off unless variety is the point.

## Record and replay

```bash
jev record run.jsonl -- ./triage.sh < email.txt     # every jev call in the script, in one tape
jev replay run.jsonl -- ./triage.sh < email.txt     # same answers, no key, no model calls
```

Under replay, a jev call that doesn't match the tape fails with exit 2, and `jev replay` exits nonzero if recorded
answers go unused. Use it for tests, and to re-run a script without spending calls.
