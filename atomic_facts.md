<!--
  Sample profile for Career Copilot Lite.

  Paste this whole file into the Profile drawer (👤) of the side panel, or
  load it via the file input. Every `-` bullet under an `## H2` (and
  optional `### H3`) becomes one atomic fact. The fact's `text` is embedded
  verbatim with a `section › subsection\ntext` breadcrumb prefix so a bullet
  like "Primary language: Go" is grounded by which project it belongs to.

  Authoring rules (enforced by src/profile/parse-markdown.js):

    - `## X`            sets the current section
    - `### X`           sets the current subsection (resets on next ## )
    - `- text`          one fact, kept verbatim
    - `[ADD] …`         placeholder gap, SKIPPED
    - `[VERIFY] …`      flagged but KEPT (still indexed as content)
    - `[ ] …` / `[x] …` your own todos, SKIPPED
    - `> - …`           blockquoted bullet, SKIPPED
    - HTML comments     stripped before parsing — anything inside <!-- … -->
                        is invisible to the parser, including section blocks

  One claim per bullet. Long bullets are fine; the embedding model handles up
  to ~256 tokens per fact. But a tight bullet retrieves better than a paragraph.
-->

## Summary

- Senior backend engineer with 9 years building distributed systems, payments infrastructure, and ML inference platforms across two startups and one large company
- Comfortable across the stack from Linux internals up to product UX, but most effective leading platform / infra engineering work
- Strong written communicator; have written and shipped public-facing engineering blog posts and internal RFCs that drove cross-team alignment

## Experience

### Stripe (2023–2026) — Staff Engineer, Risk Platform

- Owned the realtime fraud-decisioning service that gates ~14M API calls per day with a p99 latency budget of 30ms
- Designed and rolled out a sharded transaction-graph store on top of TiDB, replacing a single-node Postgres that was hitting write-throughput ceilings
- Led the migration of three legacy risk models from Python+pickle to Triton inference servers running on GPU, halving p50 inference cost
- Mentored four engineers, two of whom were promoted during the cycle; ran a weekly platform-engineering reading group of ~25 engineers
- [VERIFY] Co-authored an internal proposal that became the team's roadmap for shadow-traffic-based model evaluation in production

### Anthropic (2026–present) — Member of Technical Staff, Inference

- Working on the inference serving stack for Claude — request batching, KV cache management, and tail-latency reduction
- [ADD] specific shipped projects once the public ones land

### Square (2018–2023) — Senior Engineer, Payments Reliability

- Built the cross-region failover orchestration for the merchant-acquiring path, cutting MTTR on regional outages from ~22 minutes to under 4
- Maintained the team's chaos-engineering harness; ran a monthly game day across four engineering teams
- Primary on-call for the payments authorization service for 18 months — handled three Sev-1 incidents as IC, two as IC + IM

## Skills

### Languages

- Strong: Go (8 years production), Python (10 years, ML + backend), TypeScript (4 years, internal tooling)
- Working: Rust (read-fluent, written ~3kloc of production code), SQL (Postgres + MySQL daily)
- Reading-only: C++, Lua

### Infrastructure & runtimes

- Kubernetes — written custom operators using controller-runtime; comfortable with admission webhooks and CRDs
- Service mesh — operated Linkerd in production at Square and Istio at Stripe; opinionated about avoiding Istio unless you need its featureset
- Datastores — production experience with Postgres, MySQL, TiDB, Cassandra, Redis, and ClickHouse for analytics workloads
- Observability — Prometheus + Grafana daily; built two custom OpenTelemetry exporters for non-standard signal types

### Machine learning

- Productionizing ML models for low-latency inference: quantization, batching, model sharding across GPU
- Familiar with the training side at the level of "I can read a paper and reproduce the eval", but I am not a researcher

## Education

- M.S. Computer Science, Carnegie Mellon University (2018) — focus on distributed systems
- B.Tech Computer Science, IIT Bombay (2016)

## Public work

- Maintainer of `goleak`-style internal Go libraries open-sourced at Square; ~1.4k GitHub stars
- Three conference talks at SREcon and KubeCon on running stateful workloads at scale
- [VERIFY] Personal blog at example.com averages 3k monthly readers; topics are systems internals and post-mortem patterns

<!--
  Section below is commented out — useful while drafting but not yet ready
  for the model. Uncomment when polished.

  ## Side projects

  - Building a small distributed key-value store in Rust as a learning project
  - Maintain a personal homelab running k3s on three Raspberry Pi 5s
-->

## Authoring TODOs

- [ ] Add a Patents / publications section once I locate the patent numbers
- [x] Move the "Skills" subsections out of "Experience" — done
- [ ] Verify the SREcon talk year before sharing the profile externally

## Working preferences

- Strongly prefer staff-IC tracks; have managed before but not where I do my best work
- Remote-first since 2020; comfortable with up to ~25% travel for offsites and design weeks
- Care a lot about teams that practice operational rigor — written runbooks, on-call schedules, blameless post-mortems

> Authoring note to myself: the bullets below were brainstormed during a
> career-coaching session and are NOT claims I'd put on a resume yet —
> blockquoted so the parser ignores them.
>
> - Lead a platform-team rebuild from scratch
> - Sabbatical to write a book on distributed systems
