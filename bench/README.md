# The bar

Five flows across five apps, run the same way every release. `testsky bench bench/`
reports three numbers — step success, tokens per test, p95 call latency — and
writes `bench.json`. A model, prompt or tier change ships only if it does not
make those worse.

Why a suite of our own rather than a public benchmark: AndroidWorld is
saturated (99% claimed against a human baseline of 80%) and none of it looks
like a customer's screens. These are stock apps on a stock simulator, so the
suite runs anywhere Xcode does and nobody has to ship us a build.

Everything here is read-only. A benchmark that changes a device's state stops
being repeatable on the second run.
