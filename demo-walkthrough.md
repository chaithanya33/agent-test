# Demo Walkthrough — Secure-ECR Agent

Run this **exactly** as written and you will have a working live demo of the agent in roughly 60 minutes. It uses a tiny vulnerable Flask app as the demo target so the agent has something to find on stage.

> Pre-requisite: you have already completed Phase 0 of `pilot-test-plan.md` (Bedrock model access approved, ECR repo, DynamoDB table, KMS key, GitHub OIDC role + IAM policy).

---

## What the audience will see at the end

1. You open a pull request that adds a vulnerable dependency, a hard-coded password, and an insecure piece of code.
2. Within ~2 minutes, the agent posts a comment on the PR listing every issue, with severity, explanation, and a clickable suggested fix.
3. You click "Commit suggestion." The fix lands on the branch. The next CI run shows the finding cleared.
4. You merge to `main`. The workflow **pauses** at a human-approval gate.
5. You click "Approve" — the image builds, gets signed with cosign, and pushes to ECR.
6. You open the dashboard (or the DynamoDB console for the demo) and show the full audit trail: who detected what, who approved what, when.

---

## Step 1 — Create the demo repo (5 min)

On GitHub, create a new private repo named `secure-ecr-demo`.

Clone it locally and copy the four demo files from this outputs folder:

```bash
git clone git@github.com:<your-org>/secure-ecr-demo.git
cd secure-ecr-demo

cp /path/to/outputs/demo-app.py        ./app.py
cp /path/to/outputs/demo-requirements.txt   ./requirements.txt
cp /path/to/outputs/demo-Dockerfile    ./Dockerfile
cp /path/to/outputs/pre-commit-config.yaml  ./.pre-commit-config.yaml

mkdir -p .github/workflows .github/scripts
cp /path/to/outputs/security.yml  .github/workflows/security.yml
cp /path/to/outputs/agent.py      .github/scripts/agent.py

git add .
git commit -m "initial: clean baseline"   # this commit is clean on purpose
git push -u origin main
```

The initial commit is intentionally clean so the demo "before/after" is dramatic.

---

## Step 2 — Wire the repo into AWS (10 min)

In the repo's **Settings → Secrets and variables → Actions → Variables**, add:

| Variable | Value |
|---|---|
| `AWS_ROLE_ARN` | the OIDC role ARN from Phase 0 |
| `AWS_REGION` | `us-east-1` (or whichever region you used) |
| `ECR_REPO` | `<account-id>.dkr.ecr.us-east-1.amazonaws.com/secure-ecr-pilot` |
| `KMS_KEY_ID` | the KMS key ID from Phase 0 |
| `DDB_TABLE` | `secure-ecr-findings` |
| `BEDROCK_MODEL_HAIKU` | `anthropic.claude-3-5-haiku-20241022-v1:0` |
| `BEDROCK_MODEL_SONNET` | `anthropic.claude-3-5-sonnet-20241022-v2:0` |

In **Settings → Environments**, create an environment named **`ecr-push`** with:

- *Required reviewers:* yourself + one teammate (so the demo has someone to click "Approve").
- *Deployment branches:* `main` only.

Update the trust policy on the OIDC role to also allow this new repo (`repo:<org>/secure-ecr-demo:*`).

---

## Step 3 — Smoke-test Layer 1 locally (5 min)

```bash
pipx install pre-commit
pre-commit install
pre-commit run --all-files
```

All hooks should pass on the clean baseline. Now prove it can block a bad commit:

```bash
echo 'AWS_SECRET = "AKIAIOSFODNN7EXAMPLE"' > leak.txt
git add leak.txt
git commit -m "demo: trigger gitleaks"   # → gitleaks blocks it
rm leak.txt
```

On demo day, **don't** show this part to the audience — it's just for your own confidence the local layer is wired up.

---

## Step 4 — Open the "bad" PR (the live demo starts here)

This is the moment to start screen-sharing.

```bash
git checkout -b demo/vulnerable-change

# 1. Add a known-vulnerable dependency
sed -i.bak 's/requests==2.32.3/requests==2.20.0/' requirements.txt
rm requirements.txt.bak

# 2. Add a hard-coded password (the agent will catch this)
cat >> app.py <<'PY'

API_PASSWORD = "Sup3rSecret!2024"   # demo: hard-coded credential
def login_admin():
    return shell_out("ls " + request.args.get("dir"))   # demo: command injection
PY

git add -A
git commit -m "feat: admin login + faster requests"
git push -u origin demo/vulnerable-change
gh pr create --title "Add admin login" --body "Nothing to see here."
```

(You can also do the edits in the GitHub web UI for a cleaner stage presence — drop the same diffs in via the editor.)

---

## Step 5 — Show what the agent does (the headline moment)

Open the PR in your browser. In the **Checks** tab you'll see the workflow run.

Walk the audience through what's happening, in order:

1. **`SAST` job** — Semgrep flags the command-injection.
2. **`SCA` job** — pip-audit flags `requests==2.20.0` as having multiple CVEs.
3. **`Secrets` job** — gitleaks flags `API_PASSWORD`.
4. **`Agent` job** — the LLM aggregates, classifies, and writes one PR comment with everything grouped by severity. This typically takes ~30–60 seconds because of the Bedrock call.

Switch tabs to **Conversation**. The agent's comment is now there. Read the headline finding aloud, expand the "Suggested fix" section, and **click "Commit suggestion"** on one of them — for example, removing the hard-coded password.

Push of approval lands a commit; CI re-runs; show that the finding has cleared.

---

## Step 6 — Show the approval gate (Layer 3)

Approve and merge the PR into `main`.

The workflow restarts on `main`. Watch the **`build-and-scan`** job pass through Trivy → Grype → Syft. Then the **`sign-and-push`** job appears with a yellow "Waiting" badge — it's blocked at the `ecr-push` environment.

Click into the run and show the **"Review deployments"** button. Click **Approve**. The job resumes, cosign signs the image with the KMS key, and the image lands in ECR.

Show the ECR console: the new tag is there. Optionally show the basic ECR scan results to point out parity with Inspector.

---

## Step 7 — Show the audit trail

For demo day, you don't need the full React dashboard — open the DynamoDB console, click into `secure-ecr-findings`, and run a **Scan**.

You'll see rows like:

```
PK: REPO#<org>/secure-ecr-demo
SK: FINDING#a8c3...
severity: HIGH
file: app.py
line: 14
status: OPEN
detected_at: 2026-05-19T15:42:11
suggested_fix: "- API_PASSWORD = ..."
```

This is the data the dashboard reads from. Walk the audience through how each row is one finding with full lineage — detected → suggested → approved/rejected → verified.

---

## Step 8 — Closing slide (talking points, not a screen)

- "Everything you just saw ran inside our AWS account — code never left the VPC."
- "Three layers caught the issues. The LLM only handled triage and fix-drafting — every change required a human click."
- "Cost for this entire demo run was about $0.10 in Bedrock tokens. Inspector would have done the OS-layer scan piece only, for a higher per-image fee."
- "Next steps: 2-week parity test against Inspector on one more repo, then we decommission Inspector."

---

## Demo-day cheatsheet (pin this on a sticky note)

```
1. Open PR  →  Actions tab  →  show 4 jobs running
2. Conversation tab  →  read agent comment
3. Click "Commit suggestion"  →  finding clears
4. Merge to main
5. Wait for "Review deployments" yellow badge
6. Approve  →  cosign sign  →  ECR push
7. DynamoDB console  →  Scan  →  show audit trail
```

---

## If something goes wrong on stage

| Failure | Fast recovery |
|---|---|
| Bedrock returns AccessDenied | "Looks like model access in this region isn't approved — the agent step is skippable; the scanner findings are still in the Checks tab." Then walk through the SARIF tabs directly. |
| pip-audit DB refresh fails | Retry the job; it's a transient network thing. |
| Trivy DB pull is slow on first run | Pre-warm before the demo by running the workflow once on a throwaway branch. |
| OIDC role mismatch | Open IAM → role's trust policy → confirm `repo:<org>/secure-ecr-demo:*` is allowed. |

---

## Files in this folder used by the demo

| File | Goes where |
|---|---|
| `demo-app.py` | `<demo-repo>/app.py` |
| `demo-requirements.txt` | `<demo-repo>/requirements.txt` |
| `demo-Dockerfile` | `<demo-repo>/Dockerfile` |
| `pre-commit-config.yaml` | `<demo-repo>/.pre-commit-config.yaml` |
| `security.yml` | `<demo-repo>/.github/workflows/security.yml` |
| `agent.py` | `<demo-repo>/.github/scripts/agent.py` |
| `iam-policy.json` | attach to the OIDC role in IAM |
