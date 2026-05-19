# Secure-ECR Agent — Design Document

A pre-ECR code & vulnerability agent that replaces Amazon Inspector with a cheaper, multi-stage pipeline. The agent **only suggests** — every fix requires human approval before it lands.

---

## 1. Goals

1. Catch bugs, code-quality issues, and vulnerabilities **before** an image is pushed to ECR.
2. Cover three languages: **Python, Node.js / TypeScript, Java / JVM**.
3. Suggest fixes; never auto-modify code — humans approve each change.
4. Replace Amazon Inspector's image-scan role with cheaper, open-source equivalents.
5. Provide a custom dashboard (React + API Gateway + Lambda) showing what was fixed, what is open, and what was accepted as risk.

---

## 2. High-Level Architecture

```
Developer machine                CI pipeline                       ECR
─────────────────                ────────────────────────          ─────
 [Layer 1]                        [Layer 2]                         [Layer 3]
 pre-commit hook   ──► git push ─► PR scan + LLM review  ─► build ─► image scan
 (fast, local)                     (comprehensive)                   (gates push)
                                          │                                │
                                          ▼                                ▼
                                  Findings ──► DynamoDB ──► API GW ──► Lambda ──► React Dashboard
                                                                                        │
                                                                                        ▼
                                                                              Approver clicks "Apply fix"
                                                                              → PR comment → committed by bot
```

Three layers, defense-in-depth. Each layer runs progressively heavier scans on a smaller diff.

---

## 3. Layer 1 — Pre-push Git Hook (Developer Machine)

**Purpose:** catch the obvious stuff in under 30 seconds before code even leaves the laptop.

**Framework:** [pre-commit](https://pre-commit.com) — single `.pre-commit-config.yaml` checked into every repo.

**Scanners:**

| Concern | Tool | All 3 languages? |
|---|---|---|
| Secrets in commits | `gitleaks` or `detect-secrets` | yes |
| Fast SAST (rules subset) | `semgrep --config p/ci` | yes |
| Python lint/security | `bandit`, `ruff` | Python only |
| Node lint/security | `eslint-plugin-security` | Node/TS only |
| Java lint/security | `spotbugs` (sample mode) | Java only |
| Lockfile drift | language-native (`pip-audit`, `npm audit`, `mvn dependency:check`) | yes |

**Cost:** $0 — runs locally.

**Bypass risk:** a developer can `git commit --no-verify`. That's why Layer 2 is mandatory.

---

## 4. Layer 2 — CI Stage (PR-triggered)

**Purpose:** comprehensive scan on every pull request; this is the brain of the agent.

**Trigger:** GitHub Actions / GitLab CI / AWS CodeBuild on `pull_request` event.

**Steps in order:**

1. **Static analysis (SAST)**
   - `semgrep --config auto` with custom rulepack per language.
   - Findings emitted as SARIF.

2. **Software composition analysis (SCA)**
   - Python: `pip-audit` + `safety check`.
   - Node/TS: `npm audit --audit-level=moderate` or `pnpm audit`.
   - Java: OWASP Dependency-Check (Maven/Gradle plugin).
   - Generates SBOM via `syft` (CycloneDX format).

3. **Secrets**
   - `gitleaks detect` over full git history of the PR diff.

4. **LLM-powered review (the "agent" layer)**
   - Calls **Claude via Amazon Bedrock** (in-region — no data egress, no API key to leak).
   - Sends only the PR **diff** plus surrounding context windows (not the whole repo) to keep token cost predictable.
   - Two-tier model use:
     - **Haiku** for triage: classify each scanner finding as *true positive / false positive / needs-context*, dedupe across tools.
     - **Sonnet** only for generating suggested patches on confirmed Critical/High findings.
   - Output: structured JSON with `{file, line, severity, cwe, explanation, suggested_diff, confidence}`.

5. **Aggregate + post to PR**
   - All findings collapsed into a single PR comment with collapsible sections per severity.
   - Each finding renders as a GitHub *suggestion block* — the reviewer clicks "Commit suggestion" to apply.
   - Findings also written to DynamoDB for the dashboard.

6. **CI verdict**
   - Critical → blocks merge. High → requires approver override. Medium/Low → reported, not blocking.

**LLM token budget guardrails:**
- Cap diff size sent to Bedrock at 30 KB per call.
- Cache by `(file_hash, rule_id)` — never re-scan unchanged code.
- Skip LLM review entirely if scanners report zero findings on the diff.

---

## 5. Layer 3 — Post-build, Pre-ECR Push (Image Scan)

**Purpose:** the direct replacement for Amazon Inspector ECR scanning.

**Tools:**

| Job | Tool | License |
|---|---|---|
| Container vuln scan (OS + libs) | **Trivy** (Aqua) | Apache-2.0 |
| Cross-check / second opinion | **Grype** (Anchore) | Apache-2.0 |
| SBOM | **Syft** | Apache-2.0 |
| Dockerfile lint | **hadolint** | GPL-3.0 |
| Image signing | **cosign** (Sigstore) | Apache-2.0 |

**Flow inside the same CI job that builds the image:**

```
docker build -t app:${sha} .
hadolint Dockerfile
trivy image --severity HIGH,CRITICAL --exit-code 1 app:${sha}
grype app:${sha} -o sarif > grype.sarif
syft app:${sha} -o cyclonedx-json > sbom.json
# only if scans pass policy:
cosign sign --key awskms://... ${ECR_URI}:${sha}
docker push ${ECR_URI}:${sha}
```

**Why this replaces Inspector:**
- Inspector's ECR enhanced scanning is itself a wrapper on the Clair/Snyk database. Trivy uses the same NVD + GHSA feeds plus Aqua's own DB and typically matches or beats Inspector on detection.
- Inspector charges per image + per rescan/day. Trivy is free; you pay only the CI minutes it runs in.
- You get **SBOM** and **signing** as a bonus, which Inspector doesn't bundle.

**ECR-side policy:** keep ECR's basic scan **on** (it's free) as a redundant safety net, but the build gate is Trivy.

---

## 6. Human Approval Flow

Hard rule from your answer: **agent only suggests; nothing is auto-applied**.

```
Finding generated
   │
   ▼
Posted as GitHub suggestion in PR
   │
   ├──► Reviewer clicks "Commit suggestion"      ──► committed to PR branch, marked "Fixed by <user>"
   ├──► Reviewer clicks "Mark as false positive" ──► moved to suppressions.yaml with required justification
   └──► Reviewer clicks "Accept risk"            ──► requires Sec-approver group, logged with expiry date
```

Each action calls a small **GitHub App** (Lambda behind API Gateway with a webhook). The app:
1. Writes the decision to DynamoDB with timestamp + actor.
2. For "Apply fix", commits the suggestion via GitHub API on the PR branch.
3. Re-runs the relevant scanner on that file to confirm the fix.

**Audit trail:** every finding has a full lifecycle — `detected → suggested → approved/rejected → verified` — visible on the dashboard.

---

## 7. Dashboard (React + API Gateway + Lambda)

**Frontend:** React SPA, hosted on S3 + CloudFront, auth via Cognito (or your existing SSO).

**Backend:** API Gateway → Lambda (Python) → DynamoDB.

**Data model (DynamoDB single-table design):**

| PK | SK | Attributes |
|---|---|---|
| `REPO#<name>` | `FINDING#<id>` | severity, cwe, file, line, status, detected_at, fixed_at, fixer, llm_explanation, suggested_diff |
| `REPO#<name>` | `SBOM#<image_sha>` | image, components[], created_at |
| `REPO#<name>` | `META#latest` | open_critical, open_high, fixed_30d, accepted_risk |
| `USER#<id>` | `ACTION#<ts>` | finding_id, action, justification |

**Pages:**

1. **Overview** — counts of open vs. fixed vs. accepted, broken down by severity. Trend chart (last 90 days).
2. **Findings list** — filterable by repo, severity, status, scanner, language. Each row links to PR + finding detail.
3. **Finding detail** — full LLM explanation, suggested diff, CVE links, history of who saw/approved/rejected.
4. **SBOM viewer** — per image, component tree, license summary, "which images contain log4j-core 2.14?" search.
5. **Accepted-risk register** — every "accept risk" decision with expiry. Banner if any expire in <7 days.
6. **Coverage report** — repos that haven't been scanned in >7 days (catches misconfigured pipelines).

**Lambda endpoints:**

```
GET  /api/findings?repo=&severity=&status=
GET  /api/findings/{id}
POST /api/findings/{id}/decision   { action: "approve"|"reject"|"accept-risk", justification }
GET  /api/sbom/{image_sha}
GET  /api/metrics/overview?range=30d
POST /webhooks/github               (PR events, suggestion-applied events)
POST /webhooks/ci                   (scanner results from Layers 1–3)
```

All Lambdas in Python 3.12, deployed via SAM or CDK. DynamoDB on-demand billing.

---

## 8. Cost Model

**Amazon Inspector** (the thing you're replacing) — ECR enhanced scanning is ~$0.09 per image scan + rescans daily as new CVEs are published, so a 50-image / 30-account setup commonly runs **$100–500+/month**, growing with image count.

**This agent** (steady-state monthly estimate, ~100 PRs / 50 images):

| Component | Estimate |
|---|---|
| CI minutes (existing GH/GitLab/CodeBuild) | usually covered by existing plan; +5–10 min per PR |
| Bedrock — Claude Haiku triage (~100 PRs × 20K tokens) | **~$2–5** |
| Bedrock — Claude Sonnet fixes (~30 PRs × 30K tokens) | **~$10–20** |
| Lambda (well under free tier for this volume) | **<$1** |
| DynamoDB on-demand | **<$2** |
| API Gateway | **<$1** |
| S3 + CloudFront for SPA | **<$1** |
| Cognito (under 50K MAU free tier) | **$0** |
| Trivy / Grype / Syft / Semgrep OSS | **$0** |
| **Total** | **~$20–35/month** |

The big win isn't the AWS infra (it's tiny) — it's that **per-image Inspector scanning grows linearly with images and accounts, while this approach is mostly fixed cost** plus Bedrock tokens that scale with PR volume, not image count.

> Numbers above are estimates. Verify current Inspector and Bedrock pricing before committing — AWS pricing changes.

---

## 9. Build Order (Suggested)

1. **Week 1** — Layer 3 only. Get Trivy + Grype + Syft running in CI on one pilot repo. Compare findings against Inspector for a week to validate parity.
2. **Week 2** — Layer 1 pre-commit config + Layer 2 scanners (Semgrep/SCA/gitleaks). PR comment bot, no LLM yet.
3. **Week 3** — DynamoDB schema + ingestion Lambdas. Findings start landing in the table.
4. **Week 4** — React dashboard MVP (Overview + Findings list).
5. **Week 5** — Add Bedrock LLM triage (Haiku only — keeps cost predictable).
6. **Week 6** — Suggestion-block flow + approval webhook. Sonnet for fix generation behind feature flag.
7. **Week 7** — SBOM viewer + accepted-risk register.
8. **Week 8** — Roll off Inspector enhanced scanning after a 2-week shadow period showed parity.

---

## 10. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Developers bypass pre-commit with `--no-verify` | Layer 2 is mandatory in CI; pre-commit is convenience only. |
| LLM hallucinates a "fix" that breaks behaviour | Every suggestion is a human-approved diff; CI re-runs tests on the suggested patch before merge. |
| Token cost spikes on huge PRs | 30 KB diff cap; skip LLM when scanners are clean; cache by file hash. |
| Trivy misses something Inspector caught | Run both for a 2-week shadow period; keep ECR basic scan on as a free safety net. |
| Single-vendor lock-in on Bedrock | LLM call is one function — swap to Anthropic API / Azure OpenAI / local model with a config change. |
| Dashboard becomes shelfware | Wire weekly digest email summarising new findings + accepted-risk expirations. |

---

## 11. What This Does Not Do

- Does **not** replace runtime threat detection (use GuardDuty / Falco for that).
- Does **not** replace IaC scanning — add `checkov` or `tfsec` as a separate hook if you ship Terraform/CloudFormation.
- Does **not** replace secrets rotation — only detects committed secrets.
- Does **not** replace pen testing or red-team exercises.

---

## 12. Next Decisions You Need to Make

1. **CI system** — GitHub Actions, GitLab CI, or CodeBuild? Affects how the bot is packaged.
2. **PR platform** — GitHub or GitLab? Webhook format differs.
3. **SSO** — Cognito with social login, or federate to existing Okta/Entra?
4. **Approval thresholds** — define "Critical" precisely (CVSS ≥ 9.0? KEV-listed? Exploitable in your context?).
5. **Suppression policy** — who can mark something "accept risk", and for how long?
