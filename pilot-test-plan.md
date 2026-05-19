# Secure-ECR Agent — Pilot Test Plan

Goal: prove the full pipeline (Layer 1 + Layer 2 + LLM agent + Layer 3) works end-to-end on **one** pilot repository, covering .NET, Python, Java, and Node.js, before rolling out across the org.

Estimated time to first green run: **1–2 days of focused work**. Plus ~24 hours of clock time waiting on Bedrock model access approval.

---

## Phase 0 — Prerequisites (do this BEFORE anything else)

### 0.1 Request Bedrock model access (this is the long-pole item)

Bedrock requires you to request access to each model. It can take a few hours to a day.

1. Sign in to the AWS console as someone with IAM admin rights.
2. Go to **Bedrock → Model access** in the region you'll deploy in (recommend `us-east-1` or `us-west-2`).
3. Click **Manage model access**.
4. Tick **Anthropic — Claude 3.5 Haiku** AND **Anthropic — Claude 3.5 Sonnet** (or the latest versions available to you).
5. Submit. You'll get email when it's approved.

**Verify it works** with this CLI call (after approval lands):

```bash
aws bedrock-runtime invoke-model \
  --model-id anthropic.claude-3-5-haiku-20241022-v1:0 \
  --body '{"anthropic_version":"bedrock-2023-05-31","max_tokens":50,"messages":[{"role":"user","content":"say hi"}]}' \
  --cli-binary-format raw-in-base64-out \
  /tmp/out.json && cat /tmp/out.json
```

If you see a reply in `/tmp/out.json`, access is live.

### 0.2 Create AWS resources (one-time setup)

Run these in the region you'll use. Replace `<account-id>` and `<region>` everywhere.

```bash
# ECR repo for the pilot image (skip if you already have one)
aws ecr create-repository \
  --repository-name secure-ecr-pilot \
  --image-scanning-configuration scanOnPush=true \
  --image-tag-mutability IMMUTABLE

# DynamoDB table for findings (single-table design)
aws dynamodb create-table \
  --table-name secure-ecr-findings \
  --attribute-definitions AttributeName=PK,AttributeType=S AttributeName=SK,AttributeType=S \
  --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST

# KMS key for cosign image signing
aws kms create-key --description "secure-ecr-agent image signing" \
  --key-usage SIGN_VERIFY --key-spec ECC_NIST_P256
# Note the KeyId → save it as KMS_KEY_ID
```

### 0.3 Set up GitHub OIDC to AWS (no long-lived keys in GitHub)

Follow the AWS doc *Configuring OpenID Connect in Amazon Web Services* once, then create an IAM role with the policy in `iam-policy.json` (in this folder). The trust policy must allow your GitHub org+repo:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike":   { "token.actions.githubusercontent.com:sub": "repo:<your-org>/<pilot-repo>:*" }
    }
  }]
}
```

Save the role ARN — you'll paste it into the workflow.

### 0.4 Pick the pilot repo

Pick a repo that:
- Has an existing Dockerfile that already pushes to ECR.
- Has active development (so PRs actually get opened).
- Is not your most critical production workload (this is a pilot).

Create a branch: `git checkout -b sec-agent-pilot`.

---

## Phase 1 — Layer 1: local pre-commit hook (15 minutes)

### 1.1 Install pre-commit on your laptop
```bash
pipx install pre-commit   # or: pip install --user pre-commit
```

### 1.2 Drop in the config

Copy `.pre-commit-config.yaml` (in this folder) to the **root of your pilot repo**.

```bash
cp pre-commit-config.yaml /path/to/pilot-repo/.pre-commit-config.yaml
cd /path/to/pilot-repo
pre-commit install
```

### 1.3 Verify it works

```bash
# Test on an existing commit
pre-commit run --all-files

# You should see each hook PASS or FAIL with output
```

If everything's clean, deliberately make a bad commit to confirm it blocks you:

```bash
echo 'aws_access_key_id = "AKIAIOSFODNN7EXAMPLE"' > test-secret.txt
git add test-secret.txt
git commit -m "test"   # → gitleaks should BLOCK this
rm test-secret.txt
```

**Checkpoint:** Layer 1 is working when (a) `pre-commit run --all-files` runs all the hooks and (b) the fake secret commit was rejected.

---

## Phase 2 — Layer 2 & 3: GitHub Actions workflow (1–2 hours)

### 2.1 Add repository secrets and variables

Go to your repo → **Settings → Secrets and variables → Actions**.

Add **Variables** (not secrets):
- `AWS_ROLE_ARN` — the OIDC role ARN from Phase 0.3
- `AWS_REGION` — e.g. `us-east-1`
- `ECR_REPO` — e.g. `<account-id>.dkr.ecr.us-east-1.amazonaws.com/secure-ecr-pilot`
- `KMS_KEY_ID` — from Phase 0.2
- `DDB_TABLE` — `secure-ecr-findings`
- `BEDROCK_MODEL_HAIKU` — `anthropic.claude-3-5-haiku-20241022-v1:0`
- `BEDROCK_MODEL_SONNET` — `anthropic.claude-3-5-sonnet-20241022-v2:0`

You do not need any long-lived AWS keys. OIDC handles auth.

### 2.2 Drop in the workflow

Copy the file `security.yml` from this outputs folder to `.github/workflows/security.yml` in the pilot repo.

Also copy `agent.py` to `.github/scripts/agent.py`.

### 2.3 Open a test PR

```bash
git checkout -b test-pr-1
# make a deliberately bad change, e.g. add an outdated dependency
echo "requests==2.20.0" >> requirements.txt   # known CVEs
git commit -am "test: trigger scanners"
git push -u origin test-pr-1
gh pr create --fill
```

Watch the Actions tab. The workflow will run:

1. `sast` (Semgrep)
2. `sca` (per-language dependency audits)
3. `secrets` (gitleaks)
4. `agent` (Claude on Bedrock triages, drafts suggestions)
5. `build-and-scan` (docker build → Trivy → Grype → Syft SBOM)
6. `sign-and-push` (only if approval granted via environment protection rule)

You should see a **PR comment** show up from the workflow with grouped findings.

**Checkpoint:** Layer 2 + LLM agent is working when (a) the PR comment appears, (b) it has actual triaged findings, and (c) DynamoDB has new rows (`aws dynamodb scan --table-name secure-ecr-findings --max-items 5`).

### 2.4 Configure the approval gate

In repo **Settings → Environments**, create an environment called `ecr-push`.

- Add **Required reviewers** (yourself + one teammate).
- Add **Deployment branches** restriction: only `main`.

The workflow's `sign-and-push` job is bound to this environment, so it will pause and require a human click before pushing to ECR.

**Checkpoint:** Layer 3 gate is working when a PR merge into `main` pauses the workflow and waits for a reviewer to click "Approve and deploy."

---

## Phase 3 — Run side-by-side with Amazon Inspector (2 weeks)

This is the parity test. Both Inspector and your new agent run on every PR / image push. You compare findings.

### 3.1 Leave Inspector on

Don't touch Inspector yet. It keeps doing its thing.

### 3.2 Track parity

For each image scanned in the pilot period, record:

| Image SHA | Inspector findings | Agent findings | Agent-only | Inspector-only | Notes |

Use a spreadsheet or a small script. After 2 weeks you'll see:

- **Inspector-only findings** = things you'll need to teach the agent (usually OS package CVEs Trivy missed — typically zero, Trivy is excellent).
- **Agent-only findings** = upside your agent gives you (Inspector doesn't do SAST, secrets, or LLM-based root-cause).
- **Both** = parity confirmed.

### 3.3 Decommission decision

If parity holds for 2 weeks **and** the team is happy with the PR-comment flow, disable Inspector ECR enhanced scanning. (Keep basic scan on — it's free.)

```bash
aws inspector2 disable --account-ids <account-id> --resource-types ECR
```

---

## Phase 4 — Dashboard (defer until pipeline is stable)

Don't build the dashboard until you've got at least 2 weeks of findings in DynamoDB. Otherwise you're building a UI for an empty table.

Once you have data, the dashboard is a separate ~3-day build: React SPA → S3+CloudFront, API Gateway → Lambda → DynamoDB, Cognito auth. I can scaffold this when you're ready.

---

## What's in this outputs folder

| File | Purpose | Where it goes |
|---|---|---|
| `pilot-test-plan.md` | This guide | keep locally |
| `pre-commit-config.yaml` | Layer 1 hooks | `<repo>/.pre-commit-config.yaml` |
| `security.yml` | Layer 2 + 3 workflow | `<repo>/.github/workflows/security.yml` |
| `agent.py` | LLM triage script | `<repo>/.github/scripts/agent.py` |
| `iam-policy.json` | Permissions for the GitHub OIDC role | attach to the role in IAM |

---

## Troubleshooting cheatsheet

| Symptom | Likely cause | Fix |
|---|---|---|
| `AccessDeniedException` calling Bedrock | Model access not approved yet | Wait, or re-check `Bedrock → Model access` |
| `AccessDenied` on DynamoDB / KMS | OIDC role missing IAM perms | Re-apply `iam-policy.json` |
| `AssumeRoleWithWebIdentity` fails | Trust policy `sub:` mismatch | Check `repo:<org>/<repo>:*` matches exactly |
| Trivy reports zero findings on an obviously vulnerable image | DB not updated | Add `--db-update` once or pre-pull the DB |
| PR comment never appears | `GITHUB_TOKEN` perms missing | Workflow needs `permissions: pull-requests: write` |
| Bedrock 400 on long diffs | Diff > token budget | The agent script auto-chunks; if still failing reduce `MAX_DIFF_BYTES` |

---

## Quick reference — minimum success criteria for the pilot

You declare the pilot a success when **all** of these are true:

1. A deliberately vulnerable PR produces a PR comment from the agent with grouped, severity-sorted findings.
2. At least one Critical/High finding includes an LLM-suggested patch as a GitHub suggestion block.
3. Clicking "Commit suggestion" applies the fix and the next workflow run shows the finding resolved.
4. A merge to `main` pauses at the `ecr-push` environment for human approval.
5. After 2 weeks side-by-side, Trivy findings match Amazon Inspector findings within an acceptable delta (typically ≥95% overlap on Critical/High).
6. Per-PR Bedrock token cost stays under $0.50 (check Cost Explorer filtered to Bedrock).

If 5 of 6 are green, you're ready to scale to more repos and decommission Inspector.
