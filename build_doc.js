// Build the end-to-end Secure-ECR Agent Word document.
// Run: node build_doc.js
const fs = require('fs');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, BorderStyle, WidthType, ShadingType,
  LevelFormat, PageBreak, Footer, Header, PageNumber, TabStopType,
  TabStopPosition,
} = require('docx');

// ---------- helpers ----------
const border = { style: BorderStyle.SINGLE, size: 4, color: "B8B8B8" };
const borders = { top: border, bottom: border, left: border, right: border };

const p = (text, opts = {}) => new Paragraph({
  spacing: { after: 120 },
  ...opts,
  children: opts.children || [new TextRun({ text, ...(opts.run || {}) })],
});

const h1 = (text) => new Paragraph({
  heading: HeadingLevel.HEADING_1,
  spacing: { before: 320, after: 200 },
  children: [new TextRun({ text })],
});
const h2 = (text) => new Paragraph({
  heading: HeadingLevel.HEADING_2,
  spacing: { before: 240, after: 140 },
  children: [new TextRun({ text })],
});
const h3 = (text) => new Paragraph({
  heading: HeadingLevel.HEADING_3,
  spacing: { before: 180, after: 100 },
  children: [new TextRun({ text })],
});

const bullet = (text) => new Paragraph({
  numbering: { reference: "bullets", level: 0 },
  spacing: { after: 60 },
  children: [new TextRun(text)],
});

const numbered = (text) => new Paragraph({
  numbering: { reference: "numbers", level: 0 },
  spacing: { after: 60 },
  children: [new TextRun(text)],
});

const callout = (text) => new Paragraph({
  spacing: { before: 100, after: 100 },
  shading: { fill: "F2F4F8", type: ShadingType.CLEAR },
  border: { left: { style: BorderStyle.SINGLE, size: 18, color: "3B82F6" } },
  indent: { left: 240 },
  children: [new TextRun({ text, italics: true })],
});

const cell = (text, opts = {}) => new TableCell({
  borders,
  width: { size: opts.width, type: WidthType.DXA },
  shading: opts.header
    ? { fill: "1F2937", type: ShadingType.CLEAR }
    : { fill: opts.alt ? "F8F9FB" : "FFFFFF", type: ShadingType.CLEAR },
  margins: { top: 100, bottom: 100, left: 140, right: 140 },
  children: [
    new Paragraph({
      children: [new TextRun({
        text,
        bold: !!opts.header,
        color: opts.header ? "FFFFFF" : "1F2937",
        size: 22,
      })],
    }),
  ],
});

// ---------- content ----------
const children = [];

// Title
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { before: 1600, after: 200 },
  children: [new TextRun({ text: "Secure-ECR Agent", bold: true, size: 56, color: "1F2937" })],
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { after: 600 },
  children: [new TextRun({ text: "End-to-End Architecture & Operation Guide", size: 32, color: "4B5563" })],
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { after: 200 },
  children: [new TextRun({ text: "A pre-ECR code & vulnerability agent that replaces Amazon Inspector", italics: true, color: "6B7280" })],
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { before: 1600 },
  children: [new TextRun({ text: "Prepared for stakeholder review", size: 22, color: "6B7280" })],
}));
children.push(new Paragraph({ children: [new PageBreak()] }));

// 1. Executive Summary
children.push(h1("1. Executive Summary"));
children.push(p("The Secure-ECR Agent is an in-house security pipeline that inspects every code change for bugs, secrets, vulnerable dependencies, and insecure patterns before the resulting container image is pushed to Amazon ECR. It replaces Amazon Inspector's per-image scanning role with cheaper open-source equivalents, and adds two capabilities Inspector does not provide: AI-assisted triage that explains each finding in plain language, and AI-drafted patches that engineers can apply with a single click."));
children.push(p("Three properties define the design. First, defense in depth: scans run on the developer's laptop, in CI on every pull request, and on the built image before the push to ECR. Second, human approval is mandatory: the agent never modifies code by itself; it only suggests. Third, the entire data plane stays inside the organisation's AWS account: code is never transmitted to a third party."));
children.push(p("Estimated total monthly cost for a moderate workload is roughly $20 to $35, compared with $100 to $500 or more for Amazon Inspector at the same scale. The savings come from replacing a per-image SaaS scan with self-hosted open-source scanners and pricing the AI component on a per-call basis rather than per-image."));

// 2. Problem Statement
children.push(h1("2. The Problem We Are Solving"));
children.push(p("Today the team relies on Amazon Inspector to scan container images after they reach ECR. That arrangement has three drawbacks:"));
children.push(bullet("Findings arrive too late. By the time Inspector flags a CVE, the vulnerable image has already been built, pushed, and possibly deployed."));
children.push(bullet("Inspector is narrow. It scans the OS and language packages inside the image but does not analyse source code, secrets accidentally committed to Git, or insecure patterns introduced by a recent change."));
children.push(bullet("Cost scales linearly. Inspector charges per image scan and per daily rescan; the bill grows with the number of images and accounts, not with engineering activity."));
children.push(p("The agent moves detection earlier in the pipeline, broadens it to cover code as well as images, and prices the work in a way that grows with pull-request activity rather than with image count."));

// 3. Architecture Overview
children.push(h1("3. Architecture Overview"));
children.push(p("The agent operates in three layers. Each layer catches what the previous layer missed, on a progressively smaller diff."));

children.push(h2("Layer 1 — Developer Machine"));
children.push(p("A pre-commit Git hook runs lightweight scanners on the developer's laptop before any push: gitleaks for committed secrets, a fast Semgrep ruleset for known-bad code patterns, language-specific linters (ruff, ESLint security plugin, SpotBugs, dotnet vulnerable packages), and lockfile audits. The whole layer completes in under thirty seconds and consumes no AWS resources. It catches the most obvious issues at the cheapest possible point in the lifecycle."));

children.push(h2("Layer 2 — Continuous Integration Pipeline"));
children.push(p("When the developer opens a pull request, the CI system triggers a parallel set of scanners against the diff: Semgrep for static application security testing, pip-audit / npm audit / OWASP Dependency-Check / dotnet for software composition analysis, and gitleaks against the full pull-request history. The results feed into the LLM agent (described in section 5), which deduplicates findings, classifies each as true positive or false positive, and drafts suggested fixes for High and Critical issues. The aggregated output is posted to the pull request as a single, grouped comment, and written to DynamoDB for the dashboard."));

children.push(h2("Layer 3 — Image Scan Before ECR"));
children.push(p("Once a pull request is merged, the workflow builds the Docker image and runs three open-source scanners against it: Trivy as the primary CVE gate, Grype as a second opinion, and Syft to generate a CycloneDX software bill of materials. If any Critical or High vulnerability is unresolved, a policy gate blocks the push to ECR. If the image passes the gate, cosign signs it with a KMS-backed key and the image is pushed to ECR."));

// 4. End-to-End Walkthrough
children.push(h1("4. End-to-End Walkthrough"));
children.push(p("The following sequence describes a single change moving through the pipeline from the moment a developer types code to the moment the resulting image is signed and stored in ECR."));

children.push(numbered("Code is written and staged. The developer runs `git commit`."));
children.push(numbered("The pre-commit hook runs gitleaks, fast Semgrep, language linters, and lockfile audits locally. Obvious issues are blocked here; the commit cannot land until they are fixed or explicitly bypassed."));
children.push(numbered("The developer runs `git push`. The change leaves the laptop and lands on the Git server (GitHub or GitLab)."));
children.push(numbered("A pull request is opened. CI begins running. Four jobs execute in parallel: SAST (Semgrep), SCA (per-language dependency audits), Secrets (gitleaks against PR history), and a placeholder for image scanning that will run later."));
children.push(numbered("Scanner outputs are uploaded as build artifacts in SARIF and JSON form."));
children.push(numbered("The LLM agent job downloads those artifacts. A Python script parses them into a unified list of findings, applies secret redaction, and sends only the pull-request diff and finding metadata (not the entire repository) to Claude on Amazon Bedrock."));
children.push(numbered("Claude Haiku triages each finding, removing duplicates and marking probable false positives. For each confirmed High or Critical finding, Claude Sonnet drafts a minimal patch as a unified diff."));
children.push(numbered("The agent posts a single comment on the pull request, grouped by severity, with the suggested fixes embedded as GitHub suggestion blocks. The same payload is written to DynamoDB for the dashboard."));
children.push(numbered("A human reviewer reads each finding. For acceptable fixes, they click \"Commit suggestion\" to apply the patch to the pull-request branch. For false positives, they click \"Reject\" and provide a justification. For risks they choose to accept, they click \"Accept Risk\" and supply an expiry date."));
children.push(numbered("CI re-runs on the updated branch. Findings that have been fixed disappear from the comment. The audit log in DynamoDB records the decision, the actor, and the timestamp."));
children.push(numbered("Once the pull request is approved by reviewers and merged into the main branch, the workflow restarts on `main`. The image is built and lint-checked with hadolint."));
children.push(numbered("Trivy scans the built image for CVEs. Grype runs in parallel as a second opinion. Syft generates the software bill of materials. The job fails if Trivy reports any unresolved Critical or High vulnerability."));
children.push(numbered("The final job, sign-and-push, waits at a manual approval gate (a protected GitHub Actions environment). A designated reviewer must click \"Approve\" before it can proceed."));
children.push(numbered("Once approved, cosign signs the image with a KMS key, the image is pushed to ECR, and the audit log is closed for that change."));

// 5. The LLM Agent
children.push(h1("5. The LLM Agent in Detail"));
children.push(p("The LLM is the only component that views source code beyond the open-source scanners. Its behaviour is constrained deliberately."));

children.push(h2("5.1 Two-Tier Model Usage"));
children.push(p("Claude Haiku, the lighter and faster model, performs triage. It reads the deduplicated scanner output plus the redacted pull-request diff and returns a structured JSON list classifying each finding as a true or false positive. Claude Sonnet, the stronger model, is invoked only for findings that survive triage and are rated High or Critical. Sonnet drafts a minimal patch as a unified diff. This split keeps token cost predictable: a typical pull request consumes a few cents of Haiku time and may use Sonnet for one or two findings at most."));

children.push(h2("5.2 What the Agent Receives"));
children.push(p("The agent receives the pull-request diff (truncated at 30 kilobytes), the parsed scanner findings, and no other source code. Filenames are preserved so that suggested fixes can target the right file. Any string that matches a secret pattern is redacted before transmission."));

children.push(h2("5.3 What the Agent Returns"));
children.push(p("The agent returns one pull-request comment per run. Findings are grouped by severity, each with the originating scanner, file and line number, a one-sentence rationale, and (for High and Critical) an expandable suggested fix shown as a unified diff inside a GitHub suggestion block. The reviewer can apply a suggestion with a single click."));

// 6. Human Approval
children.push(h1("6. Human Approval Flow"));
children.push(p("The agent never edits code on its own. Every finding offers the reviewer three actions:"));
children.push(bullet("Approve fix: clicking \"Commit suggestion\" in the GitHub UI applies the agent's drafted patch to the pull-request branch. The CI workflow re-runs and confirms the finding is resolved."));
children.push(bullet("Reject as false positive: a separate comment captures the justification. The finding is recorded as suppressed in DynamoDB so the same alert does not re-appear on subsequent runs against unchanged code."));
children.push(bullet("Accept risk: a designated security-approver group can mark a finding as accepted with an expiry date. The dashboard surfaces a banner seven days before the expiry lapses."));
children.push(p("In addition to per-finding approval, the final push to ECR is gated by a GitHub Actions protected environment. Even if all findings are resolved, the image cannot reach ECR until a named reviewer explicitly approves the deployment."));

// 7. Dashboard
children.push(h1("7. Dashboard"));
children.push(p("A single-page React application provides a unified view across all repositories. It is hosted on Amazon S3 with CloudFront in front of it, authenticated through Amazon Cognito (or federated to the organisation's existing identity provider), and reads from a Lambda-backed REST API powered by API Gateway."));
children.push(h2("7.1 What the Dashboard Shows"));
children.push(bullet("Overview: counts of open vs. fixed vs. accepted findings across all repositories, with a 90-day trend chart."));
children.push(bullet("Findings list: filterable by repository, severity, status, scanner, and language. Each row links to the pull request and the finding detail page."));
children.push(bullet("Finding detail: the LLM's full explanation, the suggested patch, links to relevant CVE entries, and the timeline of who reviewed, approved, or rejected the finding."));
children.push(bullet("SBOM viewer: per image, the full component tree, license summary, and free-text search across all SBOMs (\"which of our images contain log4j-core 2.14?\")."));
children.push(bullet("Accepted-risk register: every accept-risk decision with its expiry, justification, and approver."));
children.push(bullet("Coverage report: repositories whose pipelines have not produced findings in more than seven days, surfacing pipelines that may have silently broken."));

// 8. Security & Data Handling
children.push(h1("8. Security & Data Handling"));
children.push(p("The pipeline is designed so that source code does not leave the organisation's AWS account."));
children.push(bullet("The open-source scanners (Semgrep, Trivy, Grype, Syft, gitleaks, pip-audit, npm audit, OWASP Dependency-Check, hadolint, SpotBugs) run as binaries inside the CI runner. Their only outbound network calls are to refresh CVE databases. None of those calls transmit code."));
children.push(bullet("The LLM agent calls Claude through Amazon Bedrock, in the same AWS region as the runner. Under AWS's standard contract, Bedrock inputs and outputs are not used to train models, Anthropic does not see the data, and the call can be routed through a VPC endpoint so the traffic never traverses the public internet."));
children.push(bullet("Only the pull-request diff (capped at 30 kilobytes, with secrets redacted) plus structured finding metadata is sent to Bedrock. The full repository is not transmitted."));
children.push(bullet("Every Bedrock invocation is recorded in the organisation's CloudTrail for audit."));
children.push(bullet("The CI runner authenticates to AWS through OpenID Connect, so no long-lived AWS keys are stored in the Git platform."));
children.push(bullet("If even Bedrock is unacceptable for a particular workload, the LLM call is one function and can be redirected to a locally hosted model (for example Qwen Coder or DeepSeek Coder served by vLLM on EC2) without changing the rest of the pipeline."));

// 9. Cost Comparison
children.push(h1("9. Cost Comparison"));
children.push(p("The figures below are estimates for a moderate workload (approximately 100 pull requests per month and 50 images per month). They should be validated against current AWS pricing before final commitments are made."));

const costRows = [
  ["Component", "Estimated Monthly Cost"],
  ["Layer 1 (pre-commit hooks, local)", "$0"],
  ["Layer 2 scanners (Semgrep, gitleaks, language tools)", "$0 (open source; CI minutes only)"],
  ["LLM agent — Claude Haiku triage", "~$2–5"],
  ["LLM agent — Claude Sonnet fix drafting", "~$10–20"],
  ["Lambda (under free-tier at this volume)", "<$1"],
  ["DynamoDB on-demand", "<$2"],
  ["API Gateway", "<$1"],
  ["S3 + CloudFront for dashboard", "<$1"],
  ["Cognito (under 50,000 monthly users)", "$0"],
  ["Trivy / Grype / Syft / hadolint", "$0"],
  ["Total — Secure-ECR Agent", "~$20–35 / month"],
  ["Amazon Inspector enhanced ECR scanning (comparable scope)", "~$100–500+ / month"],
];

children.push(new Table({
  width: { size: 9360, type: WidthType.DXA },
  columnWidths: [5400, 3960],
  rows: costRows.map((row, i) =>
    new TableRow({
      children: [
        cell(row[0], { width: 5400, header: i === 0, alt: i > 0 && i % 2 === 0 }),
        cell(row[1], { width: 3960, header: i === 0, alt: i > 0 && i % 2 === 0 }),
      ],
    })
  ),
}));
children.push(p(""));
children.push(callout("The key insight: Inspector's bill grows with image count and account count; the agent's bill is mostly fixed, plus a token cost that grows with pull-request volume. At scale the gap widens further in the agent's favour."));

// 10. Implementation Phases
children.push(h1("10. Implementation Phases"));
children.push(p("A suggested rollout plan, with each phase deliberately scoped so progress is visible week by week."));
children.push(numbered("Week 1 — Layer 3 only on a single pilot repository. Trivy, Grype, and Syft run alongside Amazon Inspector in shadow mode. Findings are compared to validate parity."));
children.push(numbered("Week 2 — Layer 1 pre-commit configuration and Layer 2 open-source scanners. Pull-request comments are generated by a simple bot; no LLM involvement yet."));
children.push(numbered("Week 3 — DynamoDB schema and ingestion Lambdas. Findings begin landing in the persistent audit log."));
children.push(numbered("Week 4 — React dashboard minimum viable version with overview and findings list pages."));
children.push(numbered("Week 5 — Add Claude Haiku triage. Token cost is monitored daily."));
children.push(numbered("Week 6 — Add the suggestion-block workflow and the manual approval gate at the ECR-push environment. Claude Sonnet fix generation is enabled behind a feature flag."));
children.push(numbered("Week 7 — SBOM viewer and accepted-risk register."));
children.push(numbered("Week 8 — After a two-week shadow period showing parity, decommission Amazon Inspector enhanced scanning while keeping the free basic scan enabled as a redundant safety net."));

// 11. Risks
children.push(h1("11. Risks & Mitigations"));
const riskRows = [
  ["Risk", "Mitigation"],
  ["Developers bypass pre-commit with --no-verify", "Layer 2 in CI is mandatory and cannot be bypassed; pre-commit is a convenience layer only."],
  ["LLM hallucinates a fix that breaks behaviour", "Every suggestion is a human-approved diff, and CI re-runs tests on the patched branch before merge."],
  ["Token cost spikes on large pull requests", "Diff is capped at 30 KB; LLM is skipped when scanners report no findings; results are cached by file hash."],
  ["Trivy misses something Inspector caught", "Run both in parallel for two weeks; keep ECR basic scan enabled (free) as a safety net."],
  ["Vendor lock-in on Amazon Bedrock", "The LLM call is one function. Switching to the Anthropic API, Azure OpenAI, or a self-hosted model is a one-line change."],
  ["Dashboard becomes shelfware", "EventBridge fires a weekly digest email summarising new findings and expiring accepted-risk decisions."],
];
children.push(new Table({
  width: { size: 9360, type: WidthType.DXA },
  columnWidths: [3600, 5760],
  rows: riskRows.map((row, i) =>
    new TableRow({
      children: [
        cell(row[0], { width: 3600, header: i === 0, alt: i > 0 && i % 2 === 0 }),
        cell(row[1], { width: 5760, header: i === 0, alt: i > 0 && i % 2 === 0 }),
      ],
    })
  ),
}));

// 12. Out of Scope
children.push(h1("12. What This System Does Not Do"));
children.push(p("Defining the boundaries explicitly:"));
children.push(bullet("Runtime threat detection — use Amazon GuardDuty or Falco for that."));
children.push(bullet("Infrastructure-as-code scanning — add Checkov or tfsec separately if Terraform or CloudFormation is in scope."));
children.push(bullet("Secret rotation — the agent detects committed secrets; rotating them is a downstream process."));
children.push(bullet("Penetration testing or red-team exercises — these remain separate activities."));

// 13. Glossary
children.push(h1("13. Glossary"));
const gloss = [
  ["Amazon Bedrock", "AWS service that exposes foundation models, including Anthropic Claude, with the data plane staying inside AWS."],
  ["CVE", "Common Vulnerabilities and Exposures — an industry identifier for a known vulnerability."],
  ["CWE", "Common Weakness Enumeration — a taxonomy of software weaknesses (such as SQL injection, command injection)."],
  ["ECR", "Amazon Elastic Container Registry — AWS's managed container image registry."],
  ["LLM Agent", "In this document, the combination of Claude (on Bedrock), the Python triage script, and the IAM-scoped role that calls Bedrock from CI."],
  ["OIDC", "OpenID Connect — used by GitHub Actions to obtain short-lived AWS credentials without storing long-lived keys."],
  ["SAST", "Static Application Security Testing — analysing source code (not running it) to find security defects."],
  ["SBOM", "Software Bill of Materials — a structured inventory of every component inside a build or container."],
  ["SCA", "Software Composition Analysis — checking dependencies against known-vulnerability databases."],
  ["SARIF", "Static Analysis Results Interchange Format — the industry-standard JSON format for scanner output."],
];
children.push(new Table({
  width: { size: 9360, type: WidthType.DXA },
  columnWidths: [2200, 7160],
  rows: gloss.map((row, i) =>
    new TableRow({
      children: [
        cell(row[0], { width: 2200, alt: i % 2 === 1 }),
        cell(row[1], { width: 7160, alt: i % 2 === 1 }),
      ],
    })
  ),
}));

// ---------- document ----------
const doc = new Document({
  styles: {
    default: { document: { run: { font: "Arial", size: 22 } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 32, bold: true, font: "Arial", color: "1F2937" },
        paragraph: { spacing: { before: 320, after: 200 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 26, bold: true, font: "Arial", color: "1F2937" },
        paragraph: { spacing: { before: 240, after: 140 }, outlineLevel: 1 } },
      { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 22, bold: true, font: "Arial", color: "374151" },
        paragraph: { spacing: { before: 180, after: 100 }, outlineLevel: 2 } },
    ],
  },
  numbering: {
    config: [
      { reference: "bullets", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•",
        alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
      { reference: "numbers", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.",
        alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
    ],
  },
  sections: [{
    properties: {
      page: {
        size: { width: 12240, height: 15840 },
        margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
      },
    },
    headers: {
      default: new Header({
        children: [new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [new TextRun({ text: "Secure-ECR Agent — End-to-End Guide", color: "9CA3AF", size: 18 })],
        })],
      }),
    },
    footers: {
      default: new Footer({
        children: [new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({ text: "Page ", color: "9CA3AF", size: 18 }),
            new TextRun({ children: [PageNumber.CURRENT], color: "9CA3AF", size: 18 }),
          ],
        })],
      }),
    },
    children,
  }],
});

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync("secure-ecr-agent-overview.docx", buf);
  console.log("wrote secure-ecr-agent-overview.docx");
});
