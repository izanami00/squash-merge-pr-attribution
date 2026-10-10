const vscode = require('vscode');
const { execFile } = require('child_process');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const metadataCache = new Map();
const diffCache = new Map();
const output = vscode.window.createOutputChannel('Squash Merge PR Attribution');
let panel;

function log(message) {
  output.appendLine('[' + new Date().toLocaleTimeString() + '] ' + message);
}

function setStatus(message, level = 'info') {
  log(message);
  if (panel) panel.webview.postMessage({ type: 'status', message, level });
}

async function runGit(cwd, args, options = {}) {
  log('git ' + args.join(' '));
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: options.maxBuffer || 8 * 1024 * 1024,
      windowsHide: true
    });
    return result.stdout;
  } catch (error) {
    const detail = (error.stderr || error.message || String(error)).trim();
    log('Git command failed: ' + detail);
    throw error;
  }
}

function parseCommits(text) {
  return text.split('\x1e').filter(Boolean).map((record) => {
    const fields = record.split('\x1f');
    return {
      sha: fields[0].trim(),
      author: fields[1] || '',
      email: fields[2] || '',
      date: fields[3] || '',
      subject: fields[4] || '',
      body: (fields[5] || '').trim()
    };
  }).filter((record) => record.sha);
}

async function getCommits(repoRoot, filePath, revisions = []) {
  const format = '%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1e';
  const args = ['log', '--follow', '--format=' + format].concat(revisions, ['--', filePath]);
  return parseCommits(await runGit(repoRoot, args));
}

function findPullRequests(commit) {
  const result = new Set();
  const pattern = /(?:\(#|pull request\s+#)(\d+)\b/gi;
  const value = commit.subject + '\n' + commit.body;
  let match;
  while ((match = pattern.exec(value))) result.add(Number(match[1]));
  return [...result];
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

async function mapLimit(values, limit, action) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const current = nextIndex++;
      results[current] = await action(values[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

async function existingCommit(repoRoot, ref) {
  try {
    await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', ref + '^{commit}']);
    return true;
  } catch {
    return false;
  }
}

async function getExistingPullRefNumbers(repoRoot, remote) {
  const prefix = 'refs/remotes/' + remote + '/pull/';
  try {
    const output = await runGit(repoRoot, ['for-each-ref', '--format=%(refname)', prefix]);
    const numbers = new Set();
    for (const ref of output.split(/\r?\n/)) {
      const match = ref.match(/\/pull\/(\d+)\/head$/);
      if (match) numbers.add(Number(match[1]));
    }
    return numbers;
  } catch {
    return new Set();
  }
}

function addCacheValue(cache, key, value, limit) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) cache.delete(cache.keys().next().value);
}

function cacheKey(repoRoot, filePath, sha) {
  return repoRoot + '\u0000' + filePath + '\u0000' + sha;
}

async function buildVersionList(document, progress, forceFetch = false) {
  const documentPath = document.uri.fsPath;
  const repoRoot = (await runGit(path.dirname(documentPath), ['rev-parse', '--show-toplevel'])).trim();
  const filePath = path.relative(repoRoot, documentPath).split(path.sep).join('/');
  const cacheId = repoRoot + '\u0000' + filePath;
  if (!forceFetch && metadataCache.has(cacheId)) {
    setStatus('Using cached version list for ' + filePath + '.');
    return metadataCache.get(cacheId);
  }

  setStatus('Reading mainline file history for ' + filePath + '...');
  progress.report({ message: 'Reading mainline file history...' });
  const mainline = await getCommits(repoRoot, filePath);
  if (!mainline.length) throw new Error('No Git history was found for this file.');

  const prsByCommit = new Map();
  const prNumbers = new Set();
  for (const commit of mainline) {
    const numbers = findPullRequests(commit);
    prsByCommit.set(commit.sha, numbers);
    numbers.forEach((number) => prNumbers.add(number));
  }

  const config = vscode.workspace.getConfiguration('squashMergePrAttribution');
  const remote = config.get('remote', 'origin');
  const batchSize = config.get('prFetchBatchSize', 25);
  let defaultBranch;
  try {
    defaultBranch = (await runGit(repoRoot, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/' + remote + '/HEAD'])).trim();
  } catch {
    defaultBranch = undefined;
  }

  const orderedPrs = [...prNumbers].sort((a, b) => a - b);
  setStatus('Found ' + orderedPrs.length + ' PR reference(s) in ' + mainline.length + ' mainline commit(s).');
  const existingPrRefs = forceFetch ? new Set() : await getExistingPullRefNumbers(repoRoot, remote);
  const prsToFetch = forceFetch ? orderedPrs : orderedPrs.filter((number) => !existingPrRefs.has(number));
  if (!prsToFetch.length) {
    setStatus('Using ' + existingPrRefs.size + ' locally cached PR reference(s); no fetch is needed.');
  }
  else if (!forceFetch) {
    setStatus('Using local PR refs and fetching only ' + prsToFetch.length + ' missing PR reference(s).');
  }
  for (const batch of chunks(prsToFetch, batchSize)) {
    const fetchMessage = 'Fetching original commits for ' + batch.map((number) => '#' + number).join(', ') + '...';
    setStatus(fetchMessage);
    progress.report({ message: fetchMessage });
    const refspecs = batch.map((number) => '+refs/pull/' + number + '/head:refs/remotes/' + remote + '/pull/' + number + '/head');
    try {
      await runGit(repoRoot, ['fetch', remote].concat(refspecs));
    } catch (error) {
      setStatus('Fetch completed with unavailable PR references. Existing local refs will still be checked.', 'warning');
    }
  }

  const seen = new Set();
  const versions = [];
  await mapLimit(orderedPrs, 4, async (number, index) => {
    const indexMessage = 'Indexing original commits ' + (index + 1) + '/' + orderedPrs.length + ': PR #' + number + '...';
    setStatus(indexMessage);
    progress.report({ message: indexMessage });
    const ref = 'refs/remotes/' + remote + '/pull/' + number + '/head';
    if (!(await existingCommit(repoRoot, ref))) return;
    let revisions = [ref];
    if (defaultBranch) {
      try {
        const base = (await runGit(repoRoot, ['merge-base', ref, defaultBranch])).trim();
        revisions = [base + '..' + ref];
      } catch {}
    }
    const commits = await getCommits(repoRoot, filePath, revisions);
    for (const commit of commits) {
      if (seen.has(commit.sha)) continue;
      seen.add(commit.sha);
      versions.push({
        sha: commit.sha,
        author: commit.author,
        email: commit.email,
        date: commit.date,
        subject: commit.subject,
        source: 'PR #' + number + ' (before squash)'
      });
    }
  });

  for (const commit of mainline) {
    if ((prsByCommit.get(commit.sha) || []).length || seen.has(commit.sha)) continue;
    seen.add(commit.sha);
    versions.push({
      sha: commit.sha,
      author: commit.author,
      email: commit.email,
      date: commit.date,
      subject: commit.subject,
      source: 'Mainline commit'
    });
  }

  versions.sort((left, right) => Date.parse(right.date) - Date.parse(left.date));
  const data = { repoRoot, filePath, versions };
  metadataCache.set(cacheId, data);
  setStatus('Ready: ' + versions.length + ' version(s) can be inspected.');
  return data;
}

async function getDiff(data, sha) {
  if (!data.versions.some((version) => version.sha === sha)) throw new Error('Unknown commit.');
  const key = cacheKey(data.repoRoot, data.filePath, sha);
  if (diffCache.has(key)) {
    const value = diffCache.get(key);
    diffCache.delete(key);
    diffCache.set(key, value);
    setStatus('Showing cached change for ' + sha.slice(0, 12) + '.');
    return { diff: value, cached: true };
  }
  setStatus('Loading file change for ' + sha.slice(0, 12) + '...');
  const diff = await runGit(data.repoRoot, ['show', '--format=', '--find-renames', '--unified=3', sha, '--', data.filePath]);
  const limit = vscode.workspace.getConfiguration('squashMergePrAttribution').get('diffCacheEntries', 80);
  addCacheValue(diffCache, key, diff, limit);
  setStatus('Loaded file change for ' + sha.slice(0, 12) + '.');
  return { diff, cached: false };
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function getWebviewHtml(webview) {
  const nonce = String(Date.now()) + String(Math.random()).slice(2);
  const csp = "default-src 'none'; style-src " + webview.cspSource + " 'unsafe-inline'; script-src 'nonce-" + nonce + "';";
  return [
    '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<meta http-equiv="Content-Security-Policy" content="' + csp + '">',
    '<style>',
    'body{color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family);margin:0}',
    'header{padding:16px 20px;border-bottom:1px solid var(--vscode-panel-border)}h1{font-size:18px;margin:0}.meta,#status{color:var(--vscode-descriptionForeground);margin:6px 0 0;font-size:12px}#status.warning{color:var(--vscode-editorWarning-foreground)}button.refresh{float:right;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:0;border-radius:3px;padding:5px 9px;cursor:pointer}',
    'main{display:grid;grid-template-columns:minmax(260px,36%) minmax(0,1fr);height:calc(100vh - 75px)}aside,section{overflow:auto;padding:12px}aside{border-right:1px solid var(--vscode-panel-border)}',
    '.version{display:block;width:100%;text-align:left;padding:10px;margin:0 0 8px;border:1px solid var(--vscode-panel-border);border-radius:5px;background:transparent;color:inherit;cursor:pointer}.version:hover,.version.active{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}.subject{display:block;font-weight:600;line-height:1.4}.author,.date,.source{display:block;margin-top:4px;font-size:12px;color:var(--vscode-descriptionForeground)}.version.active .author,.version.active .date,.version.active .source{color:inherit}',
    '#details{display:none}#details.visible{display:block}.grid{display:grid;grid-template-columns:max-content 1fr;gap:8px 18px;margin:16px 0 20px}.label{color:var(--vscode-descriptionForeground)}pre{margin:0;padding:14px;background:var(--vscode-textCodeBlock-background);overflow:auto;white-space:pre;font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size)}.add{color:var(--vscode-gitDecoration-addedResourceForeground)}.del{color:var(--vscode-gitDecoration-deletedResourceForeground)}.hunk,.file{color:var(--vscode-editorInfo-foreground)}.loading{color:var(--vscode-descriptionForeground)}',
    '@media(max-width:650px){main{grid-template-columns:1fr;height:auto}aside{max-height:42vh;border-right:0;border-bottom:1px solid var(--vscode-panel-border)}section{min-height:58vh}}',
    '</style></head><body><header><button class="refresh" id="refresh" type="button">Refresh</button><h1 id="title">Squash Merge PR Attribution</h1><p class="meta" id="meta">Waiting for PR commit history...</p><p id="status" aria-live="polite">Preparing viewer...</p></header>',
    '<main><aside aria-label="File versions"><div id="versions"></div></aside><section aria-live="polite"><p id="empty">Select a version to inspect its file change.</p><div id="details"><h2 id="subject"></h2><div class="grid"><span class="label">Author</span><span id="author"></span><span class="label">Date</span><span id="date"></span><span class="label">Commit</span><code id="sha"></code><span class="label">Source</span><span id="source"></span></div><pre id="diff"></pre></div></section></main>',
    '<script nonce="' + nonce + '">',
    "const vscode=acquireVsCodeApi();const versions=document.getElementById('versions');const details=document.getElementById('details');const empty=document.getElementById('empty');const diff=document.getElementById('diff');const status=document.getElementById('status');let active;document.getElementById('refresh').addEventListener('click',()=>vscode.postMessage({type:'refresh'}));",
    "function renderDiff(text){const f=document.createDocumentFragment();const lines=(text||'No textual diff.').split('\\n');lines.forEach((line,i)=>{const s=document.createElement('span');s.textContent=line;if(line.startsWith('+')&&!line.startsWith('+++'))s.className='add';else if(line.startsWith('-')&&!line.startsWith('---'))s.className='del';else if(line.startsWith('@@'))s.className='hunk';else if(line.startsWith('diff --git')||line.startsWith('+++')||line.startsWith('---'))s.className='file';f.appendChild(s);if(i<lines.length-1)f.appendChild(document.createTextNode('\\n'));});return f;}",
    "function selectVersion(version,button){if(active)active.classList.remove('active');active=button;button.classList.add('active');empty.hidden=true;details.classList.add('visible');document.getElementById('subject').textContent=version.subject;document.getElementById('author').textContent=version.author+' <'+version.email+'>';document.getElementById('date').textContent=new Date(version.date).toLocaleString();document.getElementById('sha').textContent=version.sha;document.getElementById('source').textContent=version.source;diff.textContent='Loading this file change...';diff.className='loading';vscode.postMessage({type:'getDiff',sha:version.sha});}",
    "function renderVersions(data){document.getElementById('title').textContent='Squash Merge PR Attribution: '+data.filePath;document.getElementById('meta').textContent=data.versions.length+' recoverable PR commit(s). Authors are Git commit authors, not PR creators.';versions.replaceChildren();data.versions.forEach(version=>{const b=document.createElement('button');b.type='button';b.className='version';const subject=document.createElement('span');subject.className='subject';subject.textContent=version.subject;const author=document.createElement('span');author.className='author';author.textContent='Author: '+version.author;const date=document.createElement('span');date.className='date';date.textContent=new Date(version.date).toLocaleString();const source=document.createElement('span');source.className='source';source.textContent=version.source;b.append(subject,author,date,source);b.addEventListener('click',()=>selectVersion(version,b));versions.appendChild(b);});}",
    "window.addEventListener('message',event=>{const message=event.data;if(message.type==='versions')renderVersions(message.data);if(message.type==='diff'){diff.className='';diff.replaceChildren(renderDiff(message.diff));}if(message.type==='status'){status.textContent=message.message;status.className=message.level==='warning'?'warning':'';}if(message.type==='error'){status.textContent='Error: '+message.message;status.className='warning';diff.className='loading';diff.textContent=message.message;}});vscode.postMessage({type:'ready'});",
    '</script></body></html>'
  ].join('');
}

async function loadPanelData(document, forceFetch = false) {
  if (!panel || !document || document.uri.scheme !== 'file') {
    throw new Error('Open a local file before viewing its history.');
  }
  panel.__document = document;
  setStatus('Preparing history for ' + path.basename(document.uri.fsPath) + '...');
  const data = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Squash merge PR attribution', cancellable: false },
    (progress) => buildVersionList(document, progress, forceFetch)
  );
  if (!panel) return;
  panel.__historyData = data;
  panel.webview.postMessage({ type: 'versions', data });
}

async function showForActiveDocument() {
  const document = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
  if (!document || document.uri.scheme !== 'file') {
    vscode.window.showErrorMessage('Open a local file before viewing its history.');
    return;
  }
  output.show(true);
  setStatus('Opening attribution viewer for ' + document.uri.fsPath + '...');
  if (panel) {
    panel.reveal(vscode.ViewColumn.Beside);
    try {
      await loadPanelData(document);
    } catch (error) {
      panel.webview.postMessage({ type: 'error', message: error.message || String(error) });
    }
  }
  else {
    panel = vscode.window.createWebviewPanel('squashMergePrAttribution', 'Squash Merge PR Attribution', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
    panel.__document = document;
    panel.onDidDispose(() => { panel = undefined; });
    panel.webview.html = getWebviewHtml(panel.webview);
    panel.webview.onDidReceiveMessage(async (message) => {
      if (!panel) return;
      try {
        if (message.type === 'ready' || message.type === 'refresh') {
          const current = panel.__document || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document);
          await loadPanelData(current, message.type === 'refresh');
        }
        if (message.type === 'getDiff') {
          const data = panel.__historyData;
          if (!data) throw new Error('Version list is not ready.');
          const result = await getDiff(data, message.sha);
          panel.webview.postMessage({ type: 'diff', diff: result.diff, cached: result.cached });
        }
      } catch (error) {
        panel.webview.postMessage({ type: 'error', message: error.message || String(error) });
      }
    });
  }
}

function activate(context) {
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('squashMergePrAttribution.open', showForActiveDocument),
    vscode.commands.registerCommand('squashMergePrAttribution.refresh', async () => {
      metadataCache.clear();
      if (!panel) return showForActiveDocument();
      const document = (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document) || panel.__document;
      try {
        await loadPanelData(document, true);
      } catch (error) {
        panel.webview.postMessage({ type: 'error', message: error.message || String(error) });
      }
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
