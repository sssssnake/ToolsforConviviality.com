// Weekly health check. Reads data/tools.json, visits every tool's website and,
// where a tool lists a GitHub "repo", asks GitHub whether it is archived or quiet.
// Writes a Markdown report to health-report.md and sets exit code 0 either way;
// the workflow decides what to do with the report. No dependencies (Node 22).
import fs from "node:fs/promises";

const TOOLS = JSON.parse(await fs.readFile(new URL("../data/tools.json", import.meta.url), "utf8"));
const TOKEN = process.env.GITHUB_TOKEN;
const QUIET_DAYS = 365;
const UA = "Mozilla/5.0 (compatible; ToolsForConvivialityHealth/1.0; +https://toolsforconviviality.org)";
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function visit(url) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { redirect: "follow", headers: { "user-agent": UA, accept: "text/html,*/*" }, signal: AbortSignal.timeout(20000) });
      await res.body?.cancel();
      return { status: res.status, finalUrl: res.url };
    } catch (e) { last = e; await sleep(1500); }
  }
  return { error: String(last?.cause?.code || last?.message || last) };
}

async function repoInfo(repo) {
  const res = await fetch(`https://api.github.com/repos/${repo}`, {
    headers: { "user-agent": UA, accept: "application/vnd.github+json", ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) return { error: `GitHub answered ${res.status}` };
  const j = await res.json();
  return { archived: j.archived, pushedAt: j.pushed_at, renamed: j.full_name && j.full_name.toLowerCase() !== repo.toLowerCase() ? j.full_name : null };
}

const problems = [], notes = [];
const host = u => { try { return new URL(u).hostname.split(".").slice(-2).join("."); } catch { return ""; } };
const signIn = u => /accounts\.google\.com|login\.microsoftonline|signin|\/login/i.test(u);
const pool = 6; let i = 0;
async function worker() {
  while (i < TOOLS.length) {
    const t = TOOLS[i++];
    const r = await visit(t.url);
    if (r.error) (/abort|timeout/i.test(r.error) ? notes : problems).push(`${/abort|timeout/i.test(r.error) ? "" : "**"}${t.name}${/abort|timeout/i.test(r.error) ? "" : "**"} (${t.slug}): could not reach ${t.url} (${r.error}).${/abort|timeout/i.test(r.error) ? " Timeouts are often bot blocking." : ""}`);
    else if (r.status === 404 || r.status === 410) problems.push(`**${t.name}** (${t.slug}): ${t.url} answers ${r.status}. The page may be gone.`);
    else if (r.status >= 500) problems.push(`**${t.name}** (${t.slug}): ${t.url} answers ${r.status}. Check again in a few days.`);
    else if ([401, 403, 429, 999].includes(r.status)) notes.push(`${t.name}: ${t.url} refused the check (${r.status}), which usually means it blocks bots.`);
    else if (host(r.finalUrl) && host(r.finalUrl) !== host(t.url) && !signIn(r.finalUrl)) notes.push(`${t.name}: ${t.url} now lands on ${r.finalUrl}. Update the address if the move is permanent.`);
    if (t.repo) {
      try {
        const g = await repoInfo(t.repo);
        if (g.error) problems.push(`**${t.name}** (${t.slug}): repo ${t.repo}: ${g.error}.`);
        else {
          if (g.archived) problems.push(`**${t.name}** (${t.slug}): repo ${t.repo} is **archived**. Re-check its Longevity score.`);
          const days = Math.round((Date.now() - new Date(g.pushedAt)) / 864e5);
          if (days > QUIET_DAYS) problems.push(`**${t.name}** (${t.slug}): repo ${t.repo} has had no push for ${days} days. Re-check its Longevity score.`);
          if (g.renamed) notes.push(`${t.name}: repo ${t.repo} is now ${g.renamed}.`);
        }
      } catch (e) { notes.push(`${t.name}: could not ask GitHub about ${t.repo} (${e.message}).`); }
    }
  }
}
await Promise.all(Array.from({ length: pool }, worker));

const date = new Date().toISOString().slice(0, 10);
let md = `Health check on ${date}: ${TOOLS.length} tools checked, ${problems.length} need a look.\n\n`;
if (problems.length) md += "## Needs a look\n\n" + problems.sort().map(x => "- " + x).join("\n") + "\n\n";
if (notes.length) md += "## For information\n\n" + notes.sort().map(x => "- " + x).join("\n") + "\n\n";
md += "Reviews are opinions based on public sources. A flag here is a prompt to look again, not a verdict.\n";
await fs.writeFile("health-report.md", md);
await fs.writeFile("health-problems.txt", String(problems.length));
console.log(md);
