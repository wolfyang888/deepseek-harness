# Why the web-model track passes locally and fails in a real session

This note exists because the same thing kept happening: every change shipped with
green tests, and the next real session failed. The gap is not bad luck and not a
missing test case — it is a difference in what the two runs are allowed to prove.

## What the unit tests actually prove

`llm-chathub` and `chathub-host` tests drive a `FakePage` / `FakeSource`. That
double encodes **my model of the site**: which selector finds the composer, that
Enter submits, that a reply appears in `.ds-markdown`, that a guest session
behaves like a signed-in one. When the model is wrong, the test agrees with the
bug and goes green. Three real failures came from exactly that:

| Real failure | What the test believed | Why it was green |
| --- | --- | --- |
| Guest session accepted the send and never generated → 180 s timeout | any page that renders an input is signed in | `FakePage` has no login wall |
| Qianwen read the runtime-context blurb as the task | `# NOW` is the last user entry | no fixture ever sent an auxiliary message |
| 19 k prompt silently truncated to 10 k → drift, then timeout | `composerMarker` (first 24 chars) proves delivery | no fixture sent more than a few hundred chars |

The tests answer "does the code do what I described". The real session answers
"does the site accept what the code sends". Only the second question is the one
the user asks, and only a browser can answer it.

## Why my "it works" and your run disagree

1. **Different subject.** I ran the seam (`transport.send` with `Reply with
   exactly: ok`), you ran the product (a coding task that must produce a legal
   tool call, twice, in one topic). A page can answer "ok" and still be unable
   to carry a 12 k-character protocol prompt.
2. **Different state.** My profile was freshly signed in; yours drifts into
   guest or expired sessions, and each site shows that differently.
3. **Different size.** My prompts were small; yours are project-sized, so any
   silent composer ceiling becomes the failure.
4. **Different probability.** Unit tests are deterministic. Anti-abuse pacing,
   page drift, and network hiccups are not: a single successful run proves
   nothing about the next twenty turns.
5. **I fixed mechanisms, not scenarios.** After a report I changed the code path
   the report pointed at, then re-ran the unit suite. I did not replay your
   scenario end to end, so the next unknown in the same path stayed unknown.

## The rule that replaces "tests are green"

A change on this track is proven only by a run that has all five properties:

1. real Chrome, real profile, the site actually signed in;
2. a prompt of realistic size (project context, tool schemas, history);
3. at least two turns of one topic, so affinity and follow-up rendering are exercised;
4. a task that requires a legal tool call, not a chat reply;
5. printed per-turn evidence: site, failure code, prompt length, tool name.

`packages/experimental/llm-chathub/manual-check.mts` is that run:

```sh
pnpm exec tsx packages/experimental/llm-chathub/manual-check.mts "qianwen-web,deepseek-web,chatgpt-web"
```

It reports one line per attempt, including attempts that failed before the turn
moved to another site, so a wrong site never hides behind a good answer.

Unit tests stay as they are — they are how the policy is specified — but a green
suite is a precondition, never the evidence.
