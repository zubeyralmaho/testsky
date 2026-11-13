# Tests on more than one phone

Status: design, not built. Nothing here changes how a test runs today.

Some behaviour only exists between two phones: a call that connects, a
message that arrives, a meeting the second phone joins. A test of it has to
drive both phones in one timeline, hand the turn from one to the other at the
right moment, and say which phone failed. Running two single-phone tests side
by side (`run --devices`) cannot do that: each run has its own clock, its own
report and no way to wait for the other.

This note is what such a test looks like, how a run executes it, and what has
to change in the runner first.

## What a test says

```yaml
id: call-connects-and-ends
title: A voice call between two phones connects and ends on both
roles:
  caller: { targets: [{ platform: android, app: com.example.chat }] }
  callee:
    targets:
      - { platform: android, app: com.example.chat }
      - { platform: ios, app: com.example.Chat }
policy: { runs: 1, pass_threshold: 1, budget: { max_usd: 0.60, max_seconds: 600 } }
setup: [launch app]
steps:
  - id: dial
    on: caller
    do: start a voice call with "Test Callee"
    expect: the call screen says "Calling" or "Ringing"
  - id: ring
    on: callee
    expect: an incoming call from "Test Caller" is showing
    within: 45s
  - id: answer
    on: callee
    do: answer the call
  - together:
      - { id: talking-caller, on: caller, expect: a call timer is counting }
      - { id: talking-callee, on: callee, expect: a call timer is counting }
  - id: hang-up
    on: caller
    do: end the call
  - id: ended
    on: callee
    expect: the call has ended
    within: 20s
teardown: [do end any call still in progress]
```

Four additions to the format, and nothing else:

- **`roles`** in place of `targets`. Each role is a phone the test needs at the
  same time, with the targets it may be: a role with two targets runs on
  either platform, as a single-phone test does today. A test has `targets` or
  `roles`, never both; a single-phone test is unchanged.
- **`on`** on every step of a test with roles: the role that does it. Required,
  not defaulted to the first role -- a step that runs on the wrong phone
  passes or fails for the wrong reason, and nobody can tell from the report.
  Setup and teardown lines without `on` apply to every role, each with its
  own app; `on: caller` limits one to a role.
- **`within`** on an expectation: keep looking until it holds, for at most
  this long. Without it an expectation is checked once, as now. This is the
  only way one phone waits for another -- there are no signals between roles,
  only screens that change.
- **`together`**: steps on different roles that run at the same time, each on
  its own phone; the block ends when all of them have. Two steps on one role
  in one block is an error: a phone does one thing at a time.

What the format does not get: variables, secrets, or loops. The accounts a
call is between are written in the steps, in plain words -- a test whose
words say which account it calls can be checked against the phone by anybody
reading the report. A value one phone shows and another has to type (a
meeting code) is the one case for passing data between roles; it waits until
a real test needs it, and then it is an `extract` on one step that a later
step quotes, logged in plain text like everything else.

## How a run executes it

```
testsky run call.testsky.yaml --as caller=R58M1234,callee=6F1C0D2A
```

Roles are always named. `--devices` already means "every test on every phone
given"; giving it a second meaning for tests with roles would make one
command line do two different things depending on the file.

1. **Phones.** Every role's phone is leased before any is touched, all or
   none: a lease that is busy releases the ones already taken and the run
   ends `BUSY`. Leases are tried without waiting and in one order (by device
   id), so two runs that want overlapping phones cannot deadlock.
2. **One process, one engine per role.** Unlike `run --devices`, the roles
   share one timeline, one clock, one budget and one report, so they are
   driven from one process. Engines attach one after another, not at once
   (see "First" below).
3. **Steps in file order.** A step runs on its role's engine with the loop a
   single-phone step has now -- planner, grounding, pop-up rules, the earned
   budget -- unchanged. The next step starts when it ends, on whichever
   phone it names.
4. **`within`.** The expectation is put to the screen when the step starts
   and again whenever the screen changes, never on a screen already judged:
   an unchanged screen (same tree hash, or a frame within the settle
   distance) is not asked again, so a 45-second wait on a still screen costs
   one model call, not forty-five. A tree that holds the words the
   expectation quotes asks for a model's confirmation at once. Not holding
   by the deadline is `FAIL_ASSERT` -- the author said it must happen in that
   time. A screen that turns blind while waiting is not a "no": the step ends
   as it does today on a blind screen.
5. **`together`.** Its steps run concurrently, one per engine. The first to
   fail stops the others between turns (no new action starts once one has
   failed), and the block takes the first failure's outcome.
6. **Memory.** Each role's steps are learned into the lock for that phone's
   platform and layout, as now: step ids are unique in a test, so a caller
   and a callee on two identical phones share one lock file without
   colliding, and on two different phones each writes its own. Both go
   through `saveLock`, which already merges.
7. **Failure.** The test's outcome is the first failing step's, with the
   same taxonomy, and the step result names its role. Teardown then runs on
   **every** role, failed or not: a test that fails mid-call must not leave a
   call open on the other phone.
8. **Report.** One report: each step tagged with its role, one recording per
   role (`run-caller.mp4`, `run-callee.mp4`), both stamped against the same
   clock so the viewer can show them side by side at any step.

## First: what single-phone code assumes today

Two engines in one process break assumptions that one engine never tested:

- **`quietly()`** swaps the global console and `process.stdout.write` while a
  device call runs. Two overlapping calls restore each other's swapped
  functions, and output can stay silenced for the rest of the run. Attach
  roles one after another, or make it count its holders.
- **Signals.** `run` installs one SIGINT/SIGTERM handler per run that stops
  its recorder, detaches its engine and exits. With roles it has to stop
  every recorder and detach every engine before the one exit.
- **The run record and recorder** assume one device: one video path, one
  `device` in `run.json`. They take a role.
- **`runTest`** takes one engine and one lock. It becomes engines and locks
  by role; the per-step loop (`runStep`) needs no change, which is the point
  of building this on it rather than beside it.

None of these is reached by `run --devices`, which keeps every phone in its
own process for exactly this reason.

## Without adb and WebDriverAgent

Nothing above names a driver: the coordinator holds `Engine`s, and whatever
replaces adb and WebDriverAgent is another `Engine`. One thing does depend on
the replacement. Call and chat screens are often secure -- a screenshot comes
back black while the accessibility tree still reads them -- and today that
tree comes from uiautomator over adb and XCUITest through WebDriverAgent. A
replacement that only captures pixels makes those screens blind, and a call
test on them could never pass. Whatever replaces them needs a way to read the
tree on the phone itself.

## Slices

1. **Format.** `roles`, `on`, `within`, `together`; the parser and its errors
   (a step without `on`, two steps on one role in a block, `within` beyond the
   test's `max_seconds`); single-phone tests read exactly as before.
2. **`within` on one phone.** Useful on its own -- "wait until the download
   finishes" -- and the hardest part to get cheap; built and measured before
   any second phone.
3. **Engines by role** in `runTest`, `together`, teardown on every role, the
   fixes listed under "First".
4. **CLI and report.** `--as`, leases all or none, one report with a
   recording per role.
5. **One real pair.** A call between two lab phones with fixed test accounts,
   run until it passes ten times in a row before it is trusted.
