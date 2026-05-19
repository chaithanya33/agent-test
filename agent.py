"""
LLM triage agent for the Secure-ECR pipeline.

Place at <repo>/.github/scripts/agent.py

Inputs (all via env vars set by the workflow):
    AWS_REGION, BEDROCK_MODEL_HAIKU, BEDROCK_MODEL_SONNET
    GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_PR_NUMBER, DDB_TABLE

Inputs from disk (downloaded by the workflow):
    ./scanner-out/**/*.sarif | *.json   raw scanner output
    ./pr.diff                           diff being reviewed

Behaviour:
    1. Parse SARIF + JSON scanner outputs into a unified finding list.
    2. Redact obvious secrets before sending anything to Bedrock.
    3. Call Claude Haiku to dedupe + classify (TP / FP / needs-context).
    4. For confirmed High/Critical, call Claude Sonnet to draft a patch.
    5. Post a single PR comment grouping findings by severity.
    6. Write each finding to DynamoDB for the dashboard.
"""

from __future__ import annotations
import json, os, re, sys, hashlib, pathlib, datetime, traceback
import boto3, requests

# ----------------------- config -----------------------
REGION         = os.environ["AWS_REGION"]
MODEL_TRIAGE   = os.environ["BEDROCK_MODEL_HAIKU"]
MODEL_FIX      = os.environ["BEDROCK_MODEL_SONNET"]
DDB_TABLE      = os.environ["DDB_TABLE"]
GH_TOKEN       = os.environ["GITHUB_TOKEN"]
GH_REPO        = os.environ["GITHUB_REPOSITORY"]
GH_PR          = int(os.environ["GITHUB_PR_NUMBER"])

MAX_DIFF_BYTES = 30_000
MAX_FINDINGS_TO_LLM = 40

SECRET_PATTERNS = [
    r"AKIA[0-9A-Z]{16}",                    # AWS access key
    r"(?i)aws[_\- ]?secret[_\- ]?access[_\- ]?key.{0,20}['\"][A-Za-z0-9/+=]{40}['\"]",
    r"(?i)password\s*[:=]\s*['\"][^'\"]{6,}['\"]",
    r"-----BEGIN [A-Z ]+PRIVATE KEY-----",
    r"(?i)bearer\s+[A-Za-z0-9._\-]{20,}",
]

bedrock = boto3.client("bedrock-runtime", region_name=REGION)
ddb     = boto3.resource("dynamodb", region_name=REGION).Table(DDB_TABLE)

# ----------------------- helpers ----------------------
def redact(s: str) -> str:
    for pat in SECRET_PATTERNS:
        s = re.sub(pat, "[REDACTED]", s)
    return s

def load_scanner_outputs(root: str = "./scanner-out") -> list[dict]:
    """Flatten every scanner artifact into a uniform finding list."""
    findings: list[dict] = []
    for p in pathlib.Path(root).rglob("*"):
        if not p.is_file():
            continue
        try:
            data = json.loads(p.read_text(encoding="utf-8", errors="ignore"))
        except Exception:
            continue
        # SARIF
        if isinstance(data, dict) and "runs" in data:
            for run in data["runs"]:
                tool = run.get("tool", {}).get("driver", {}).get("name", "scanner")
                for r in run.get("results", []):
                    loc = (r.get("locations") or [{}])[0].get("physicalLocation", {})
                    findings.append({
                        "scanner": tool,
                        "rule":    r.get("ruleId"),
                        "severity": (r.get("level") or "warning").upper(),
                        "message": (r.get("message") or {}).get("text", ""),
                        "file":    loc.get("artifactLocation", {}).get("uri", ""),
                        "line":    loc.get("region", {}).get("startLine"),
                    })
        # pip-audit JSON
        elif isinstance(data, dict) and "dependencies" in data:
            for d in data["dependencies"]:
                for v in d.get("vulns", []):
                    findings.append({
                        "scanner": "pip-audit",
                        "rule":    v.get("id"),
                        "severity": "HIGH",
                        "message": v.get("description", "")[:300],
                        "file":    "requirements.txt",
                        "line":    None,
                    })
        # npm audit JSON
        elif isinstance(data, dict) and "vulnerabilities" in data:
            for name, v in data["vulnerabilities"].items():
                findings.append({
                    "scanner": "npm-audit",
                    "rule":    f"{name}@{v.get('range','?')}",
                    "severity": v.get("severity", "moderate").upper(),
                    "message": str(v.get("via", "")),
                    "file":    "package-lock.json",
                    "line":    None,
                })
    return findings

def load_diff(path: str = "pr.diff") -> str:
    try:
        d = pathlib.Path(path).read_text(errors="ignore")
    except FileNotFoundError:
        return ""
    return redact(d[:MAX_DIFF_BYTES])

def claude(model: str, system: str, user: str, max_tokens: int = 2000) -> str:
    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": user}],
    }
    resp = bedrock.invoke_model(modelId=model, body=json.dumps(body))
    payload = json.loads(resp["body"].read())
    return payload["content"][0]["text"]

# ----------------------- pipeline ---------------------
def triage(findings: list[dict], diff: str) -> list[dict]:
    """Haiku — dedupe + mark TP/FP, attach severity."""
    if not findings:
        return []
    user = (
        "You are a security triage assistant. Given raw scanner findings and "
        "the PR diff, return STRICT JSON: a list of objects with keys "
        "{id, severity (CRITICAL|HIGH|MEDIUM|LOW), is_true_positive (bool), "
        "rationale (≤200 chars), needs_fix (bool)}. Dedupe identical rule+file+line. "
        "If a finding is not reachable from the diff and not a known CVE, mark FP.\n\n"
        f"FINDINGS:\n{json.dumps(findings[:MAX_FINDINGS_TO_LLM], indent=2)}\n\n"
        f"DIFF (truncated, secrets redacted):\n{diff}"
    )
    raw = claude(MODEL_TRIAGE, "Return only JSON. No prose.", user, 3000)
    try:
        verdicts = json.loads(re.search(r"\[.*\]", raw, re.S).group(0))
    except Exception:
        print("Triage parse failed; raw output:", raw, file=sys.stderr)
        verdicts = []
    by_id = {v["id"]: v for v in verdicts if "id" in v}
    enriched = []
    for i, f in enumerate(findings[:MAX_FINDINGS_TO_LLM]):
        v = by_id.get(i) or by_id.get(str(i)) or {}
        if v.get("is_true_positive", True):
            enriched.append({**f, **v, "id": i})
    return enriched

def draft_fix(finding: dict, diff: str) -> str | None:
    """Sonnet — draft a suggested patch for High/Critical only."""
    if finding["severity"] not in ("HIGH", "CRITICAL") or not finding.get("needs_fix"):
        return None
    user = (
        "Given this confirmed security finding and the PR diff, draft a minimal "
        "code fix as a unified diff. Keep it self-contained and explain in ≤2 "
        "sentences. If unfixable without more context, say 'NEEDS HUMAN REVIEW'.\n\n"
        f"FINDING:\n{json.dumps(finding, indent=2)}\n\nDIFF:\n{diff}"
    )
    return claude(MODEL_FIX, "You are a senior security engineer.", user, 1500)

def post_pr_comment(findings: list[dict]) -> None:
    sev_order = ["CRITICAL", "HIGH", "MEDIUM", "LOW"]
    grouped = {s: [f for f in findings if f["severity"] == s] for s in sev_order}
    lines = ["## Secure-ECR Agent — findings\n"]
    total = sum(len(v) for v in grouped.values())
    if total == 0:
        lines.append(":white_check_mark: No security findings on this PR.")
    else:
        lines.append(f"**{total}** finding(s) — "
                     + ", ".join(f"{len(v)} {s}" for s, v in grouped.items() if v))
        for sev in sev_order:
            if not grouped[sev]:
                continue
            lines.append(f"\n### {sev}")
            for f in grouped[sev]:
                lines.append(f"- **{f['scanner']} / {f['rule']}** "
                             f"in `{f['file']}`"
                             f"{':' + str(f['line']) if f.get('line') else ''}")
                lines.append(f"  > {f.get('rationale') or f.get('message','')[:240]}")
                if f.get("suggested_fix"):
                    lines.append("  <details><summary>Suggested fix</summary>\n\n"
                                 "```diff\n" + f["suggested_fix"] + "\n```\n</details>")
    body = "\n".join(lines)
    r = requests.post(
        f"https://api.github.com/repos/{GH_REPO}/issues/{GH_PR}/comments",
        headers={"Authorization": f"Bearer {GH_TOKEN}",
                 "Accept": "application/vnd.github+json"},
        json={"body": body}, timeout=15,
    )
    r.raise_for_status()

def write_ddb(findings: list[dict]) -> None:
    now = datetime.datetime.utcnow().isoformat()
    for f in findings:
        fid = hashlib.sha1(
            f"{GH_REPO}|{f['scanner']}|{f['rule']}|{f['file']}|{f.get('line')}".encode()
        ).hexdigest()[:16]
        ddb.put_item(Item={
            "PK": f"REPO#{GH_REPO}",
            "SK": f"FINDING#{fid}",
            "pr": GH_PR,
            "scanner": f["scanner"],
            "rule": f.get("rule"),
            "severity": f["severity"],
            "file": f["file"],
            "line": f.get("line"),
            "rationale": f.get("rationale"),
            "suggested_fix": f.get("suggested_fix"),
            "status": "OPEN",
            "detected_at": now,
        })

# ----------------------- main -------------------------
def main() -> int:
    try:
        raw = load_scanner_outputs()
        print(f"Loaded {len(raw)} raw findings")
        diff = load_diff()
        if not raw:
            post_pr_comment([])
            return 0
        confirmed = triage(raw, diff)
        print(f"After LLM triage: {len(confirmed)} confirmed")
        for f in confirmed:
            fix = draft_fix(f, diff)
            if fix:
                f["suggested_fix"] = fix
        write_ddb(confirmed)
        post_pr_comment(confirmed)
        # Exit non-zero only if any unresolved Critical
        if any(f["severity"] == "CRITICAL" for f in confirmed):
            print("Critical findings present", file=sys.stderr)
            return 1
        return 0
    except Exception:
        traceback.print_exc()
        # Never fail the build solely because the agent crashed —
        # the scanners are still authoritative.
        return 0

if __name__ == "__main__":
    sys.exit(main())
