#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function parseArgs(argv) {
  const args = { env: '.deploy/env.prod', artifact: '', out: '' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--env') args.env = argv[++i];
    else if (a === '--artifact') args.artifact = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/check-output.js --env .deploy/env.prod --artifact artifacts/repo-sync.log --out artifacts/check-report.json');
      process.exit(0);
    }
  }
  return args;
}

function unquote(v) {
  let s = v.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  return s.replace(/\\n/g, '\n');
}

function loadEnvFile(file) {
  const env = { ...process.env };
  if (!fs.existsSync(file)) return env;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = unquote(trimmed.slice(idx + 1));
    value = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, k) => env[k] || '');
    env[key] = value;
  }
  return env;
}

function parseJsonValue(name, env, fallback) {
  const raw = env[name];
  if (!raw || !raw.trim()) return fallback;
  const v = raw.trim();
  try {
    if (!v.startsWith('{') && !v.startsWith('[') && /^[A-Za-z0-9+/]+={0,2}$/.test(v) && v.length % 4 === 0) {
      return JSON.parse(Buffer.from(v, 'base64').toString('utf8'));
    }
  } catch {}
  try { return JSON.parse(v); } catch (err) {
    throw new Error(`Cannot parse ${name} as JSON: ${err.message}`);
  }
}

function runGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function repoName(full) {
  const clean = full.replace(/\.git$/, '');
  const parts = clean.split('/').filter(Boolean);
  return parts[parts.length - 1];
}

function authUrl(provider, repo, env) {
  if (/^https?:\/\//.test(repo)) return repo;
  if (provider === 'github') {
    const token = env.TOKEN__GITHUB || env.SYNC_GITHUB_TOKEN || '';
    if (token) return `https://x-access-token:${encodeURIComponent(token)}@github.com/${repo}.git`;
    return `https://github.com/${repo}.git`;
  }
  if (provider === 'azure') {
    const token = env.TOKEN__AZURE || env.SYNC_AZURE_TOKEN || '';
    if (repo.includes('/_git/')) {
      const [org, project, , gitRepo] = repo.split('/');
      return `https://:${encodeURIComponent(token)}@dev.azure.com/${org}/${project}/_git/${gitRepo}`;
    }
    return repo;
  }
  return repo;
}

function inspectRepo(item, env, baseDir) {
  const name = repoName(item.repo);
  const dir = path.join(baseDir, `${item.provider}-${name}-${Math.random().toString(16).slice(2)}`);
  const url = authUrl(item.provider, item.repo, env);
  const branch = item.branch || 'main';
  fs.mkdirSync(dir, { recursive: true });
  runGit(['clone', '--depth=1', '--branch', branch, url, dir], baseDir);
  const head = runGit(['rev-parse', 'HEAD'], dir);
  let commitCount = 0;
  try { commitCount = Number(runGit(['rev-list', '--count', 'HEAD'], dir)); } catch {}
  const files = runGit(['ls-files'], dir).split('\n').filter(Boolean);
  let totalBytes = 0;
  for (const f of files) {
    try { totalBytes += fs.statSync(path.join(dir, f)).size; } catch {}
  }
  return { provider: item.provider, repo: item.repo, branch, name, dir, head, commitCount, fileCount: files.length, totalBytes, files };
}

function parseArtifact(file) {
  if (!file || !fs.existsSync(file)) return { exists: false, lines: 0, statuses: {} };
  const text = fs.readFileSync(file, 'utf8');
  const statuses = { done: 0, partial: 0, failed: 0, skipped: 0, error: 0 };
  for (const [k] of Object.entries(statuses)) {
    statuses[k] = (text.match(new RegExp(k, 'gi')) || []).length;
  }
  return { exists: true, bytes: Buffer.byteLength(text), lines: text.split(/\r?\n/).length, statuses };
}

function main() {
  const args = parseArgs(process.argv);
  const env = loadEnvFile(args.env);
  const sources = parseJsonValue('CHECK_SOURCE_REPOS', env, []);
  const targets = parseJsonValue('TARGETS', env, []);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-sync-check-'));
  const report = { ok: true, generatedAt: new Date().toISOString(), envFile: args.env, artifact: parseArtifact(args.artifact), sources: [], targets: [], checks: [] };

  try {
    for (const src of sources) report.sources.push(inspectRepo(src, env, tmp));
    for (const tgt of targets) report.targets.push(inspectRepo(tgt, env, tmp));

    for (const src of report.sources) {
      for (const tgt of report.targets) {
        const expectedPrefix = `${src.name}/`;
        const matchedFiles = tgt.files.filter(f => f === src.name || f.startsWith(expectedPrefix));
        const targetDirExists = matchedFiles.length > 0;
        report.checks.push({
          source: src.repo,
          target: tgt.repo,
          expectedTargetDir: src.name,
          targetDirExists,
          matchedFileCount: matchedFiles.length,
          sourceFileCount: src.fileCount,
        });
        if (!targetDirExists) report.ok = false;
      }
    }

    // avoid leaking local clone paths in final output
    for (const group of [report.sources, report.targets]) {
      for (const r of group) delete r.dir;
    }

    const json = JSON.stringify(report, null, 2);
    if (args.out) {
      fs.mkdirSync(path.dirname(args.out), { recursive: true });
      fs.writeFileSync(args.out, json + '\n');
    }
    console.log(json);
    process.exit(report.ok ? 0 : 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main();
