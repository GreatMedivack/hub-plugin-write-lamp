// What counts as a "write outside": a session step (the tool and its input) → {kind, label, danger, what} or null.
// Bash goes by the commands at the start of each segment (`;`, `&&`, `||`, `|`, a newline), not by the whole text:
// `grep "git push"` or echo with these words is not a write.
const PREFIX = /^(?:(?:sudo|exec|time|nohup|command)\s+|timeout\s+\S+\s+|env\s+|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/;
const SQL_WRITE = /\b(insert\s+into|update\s+\S+\s+set|delete\s+from|alter\s+table|drop\s+(table|database|schema|index)|truncate|create\s+(table|index|database|schema))\b/i;

const BASH = [
  { kind: "PUSH", re: /^git\s+(?:-C\s+\S+\s+|-c\s+\S+\s+)*push\b/ },
  { kind: "MR", re: /^(?:glab|gh)\s+(?:mr|pr)\s+(?:create|merge)\b/ },
  { kind: "INFRA", re: /^kubectl\s+(?:\S+\s+)*?(?:apply|patch|rollout|scale|edit|replace|create|label|annotate|set)\b/ },
  { kind: "INFRA", danger: true, re: /^kubectl\s+(?:\S+\s+)*?delete\b/ },
  { kind: "INFRA", re: /^helm\s+(?:upgrade|install|rollback)\b/ },
  { kind: "INFRA", danger: true, re: /^helm\s+(?:uninstall|delete)\b/ },
  { kind: "INFRA", re: /^(?:terraform|tofu)\s+(?:-chdir=\S+\s+)?apply\b/ },
  { kind: "INFRA", danger: true, re: /^(?:terraform|tofu)\s+(?:-chdir=\S+\s+)?destroy\b/ },
  { kind: "INFRA", re: /^argocd\s+app\s+(?:sync|rollback|set|patch)\b/ },
  { kind: "INFRA", danger: true, re: /^argocd\s+app\s+delete\b/ },
  { kind: "DB", danger: true, re: /^(?:alembic\s+(?:upgrade|downgrade)|(?:python3?\s+)?manage\.py\s+migrate|prisma\s+migrate\s+deploy|goose\s+\S*\s*up|flyway\s+migrate)\b/ },
];
const SQL_CLIENT = /^(?:psql|mysql|mariadb|sqlite3|clickhouse-client|clickhouse|cqlsh|mongosh)\b/;

function segments(cmd) {
  return String(cmd || "").split(/\n|;|&&|\|\||\||\$\(|`/).map((s) => s.trim().replace(PREFIX, "")).filter(Boolean);
}

function bash(cmd) {
  const hits = [];   // all segments: "git push && glab mr create" is an MR, not only a push
  for (const seg of segments(cmd)) {
    const r = BASH.find((x) => x.re.test(seg));
    if (r) hits.push({ kind: r.kind, danger: !!r.danger || r.kind === "DB", what: seg });
    else if (SQL_CLIENT.test(seg) && SQL_WRITE.test(cmd)) hits.push({ kind: "DB", danger: true, what: seg });
  }
  if (hits.length) {
    const rank = ["DB", "INFRA", "MR", "PUSH"], top = rank.find((k) => hits.some((h) => h.kind === k));
    return { kind: top, danger: hits.some((h) => h.danger), what: hits.map((h) => h.what).join(" + ") };
  }
  if (/\b(?:psql|mysql|sqlite3|clickhouse-client)\b/.test(cmd) && SQL_WRITE.test(cmd)) {   // SQL in a heredoc / -c "…"
    return { kind: "DB", danger: true, what: String(cmd).split("\n")[0] };
  }
  return null;
}

// MCP: mcp__<server>__<tool>. A write goes by the verb in the tool name; SQL tools by the query text
const MCP_WRITE = /^(?:create|update|delete|remove|merge|approve|push|apply|edit|patch|set|add|insert|upsert|write|send|publish|transition|close|reopen|resolve|retry|trigger|play|cancel|sync|deploy|rollback|move|rename|upload|import|execute|run)(?:_|$)/;
function mcp(name, input) {
  const m = /^mcp__(.+?)__(.+)$/.exec(name || "");
  if (!m) return null;
  const [, server, raw] = m, text = JSON.stringify(input || {});
  const tool = raw.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/-/g, "_").toLowerCase();   // editJiraIssue → edit_jira_issue
  if (/sql|query|execute/i.test(tool)) return SQL_WRITE.test(text) ? { kind: "DB", danger: true, what: `${server}: ${tool}` } : null;
  if (!MCP_WRITE.test(tool)) return null;
  const kind = /merge_request|pull_request|(^|_)mr($|_)|(^|_)pr($|_)/.test(tool) ? "MR" : "MCP";
  return { kind, danger: /delete|remove|drop/.test(tool), what: `${server}: ${raw}` };
}

// where the write goes: the project, repo, namespace, whatever is found in the input
function where(input) {
  const i = input || {};
  return i.project_id || i.repo || i.repository || i.namespace || i.cluster || i.database || i.cloudId && i.issueIdOrKey || "";
}

export function classify(step) {
  if (!step || step.kind !== "tool") return null;
  const hit = step.name === "Bash" ? bash(step.input?.command) : mcp(step.name, step.input);
  return hit && { ...hit, where: where(step.input) };
}
