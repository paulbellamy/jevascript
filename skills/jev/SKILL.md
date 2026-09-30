---
name: jev
description: "Judge text from the shell with the `jev` CLI: yes/no questions, picking one of several labels, filtering lines, or answering several questions about one input, backed by jev (typesafe.ai's system-one judge). Use when a script or task needs a fuzzy decision about text (is this email urgent, is this a bug report or a feature request, which log lines matter) that string matching can't make. jev only judges; it never writes text. Requires `jev` on PATH and JEV_API_KEY (or TYPESAFE_API_KEY), or a run under `jev replay`."
---

# jev

`jev` asks jev, a typed-decision model, narrow questions about text and turns the answers into exit codes and plain
lines that shell control flow can use. It returns probabilities over choices you supply. It does not generate text.

Before the first call, check that it can work:

```bash
command -v jev && test -n "${JEV_API_KEY:-${TYPESAFE_API_KEY:-}}${JEV_REPLAY:-}"
```

If that fails, say that jev is not installed or has no key, and stop. Do not invent a key or call the API another way.

`jev --help` is the authority for syntax. Set `JEV_MODEL` to a pinned model (for example `jev-1.13.0`); the default
alias moves.

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
- Which lines of a file or stream fit: `jev grep` (one question per line, batched, so it is cheap).
- Several questions about the same input: `jev ask` (one call for all of them; cheaper than several `feels`).
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

Each line is judged on its own, without the lines around it. With `-c`, lines jev is unsure about are printed by
neither `grep` nor `grep -v`.

### jev ask

`name? question` asks yes/no; `name: a | key=b | …` chooses. Output is `name=answer` lines, quoted for `eval`, so
the names become shell variables: use lowercase names that don't shadow anything (`PATH`, `IFS`).

```bash
eval "$(jev ask 'urgent? needs a reply urgently' \
                'kind: invite=an invitation | meeting=a scheduling request | other=anything else' <<<"$email")"
echo "$urgent $kind"      # yes meeting
```

`-p` adds `name_p=` lines; `--json` prints `{"name":{"answer","probability","probabilities"}}` for jq. Under `-c`, an
unsure yes/no answer is `maybe` and an unsure choice is empty. Give structured input with fields, instead of stdin
or alongside it (stdin becomes `value`): `-f title="$t"`, `-f diff=@change.patch` (file contents),
`-f meta:='{"n":1}'` (JSON), `-f meta:=@meta.json`. `ask` reads stdin whenever it isn't a terminal, so with fields
only, add `</dev/null` if stdin might be an open pipe.

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
`-p` prints the probability. Treat probabilities as a ranking signal, not a calibrated guarantee: check a threshold
on real examples before relying on it.

Keep each question narrow: one typed decision about one thing. jev is good at a single shallow choice and poor at
composing several into one question. Ask several small questions and let the script combine the answers.

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
