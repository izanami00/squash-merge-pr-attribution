# User guide: Squash Merge PR Attribution

## Purpose

Use this extension when a file's target-branch history contains squash merges and you need to identify the people who authored the original commits inside the PR.

The viewer is designed for file-level attribution. It does not attempt to replace VS Code's built-in Timeline, Git History extensions, or pull request review tools.

## What the extension does

For the active file, the extension performs this sequence:

1. Reads the file's mainline history with rename following enabled.
2. Finds PR numbers in squash commit titles or bodies. Supported forms include (#123) and pull request #123.
3. Fetches refs/pull/123/head from the configured remote.
4. Uses the merge base against the remote default branch to exclude commits inherited from the PR base branch.
5. Lists the original commits that changed the selected file, using each commit's Git author and email.
6. Loads a selected commit's file diff only when you click it.

The left pane's Author field is the original Git commit author. It is not the GitHub PR creator, reviewer, assignee, or squash-merge operator.

## First use

1. Open the repository folder in VS Code.
2. Open the file to investigate in a normal editor tab.
3. Open the Command Palette with Ctrl+Shift+P.
4. Run Squash Merge Attribution: Open PR Commit Viewer.
5. Keep the viewer open while the status line progresses through history reading, PR retrieval, and commit indexing.
6. Select an entry from the version list to view its change.

Use the Refresh button in the viewer, or run Squash Merge Attribution: Refresh PR Commit Viewer, when the branch history or remote PR refs may have changed. Refresh intentionally fetches every discovered PR ref again; ordinary opens reuse locally stored PR refs and fetch only refs that are absent.

## Progress and diagnostics

Two progress surfaces are available:

- The viewer header shows the active operation, such as Reading mainline file history, Fetching original commits, or Loading file change.
- The Output panel contains a channel named Squash Merge PR Attribution. It records Git commands, cache usage, and Git errors.

To open the log, run View: Output and select Squash Merge PR Attribution from the channel selector. If the viewer does not finish, copy the final relevant log entry when requesting help.

## Settings

Configure these settings in Settings UI or settings.json:

| Setting | Default | Meaning |
| --- | --- | --- |
| squashMergePrAttribution.remote | origin | Remote that hosts GitHub PR refs. |
| squashMergePrAttribution.diffCacheEntries | 80 | Maximum selected-file diffs held in memory. |
| squashMergePrAttribution.prFetchBatchSize | 25 | PR refs requested by one Git fetch invocation. |

Example:

    {
      "squashMergePrAttribution.remote": "upstream",
      "squashMergePrAttribution.diffCacheEntries": 120
    }

## Performance behavior

The extension avoids loading every file diff up front:

- Mainline metadata is read once per file and cached until Refresh.
- PR refs are fetched in batches, reducing network setup overhead.
- Original PR histories are indexed with a maximum of four local Git operations in parallel.
- Diffs are fetched only when selected.
- Selected diffs use an in-memory least-recently-used cache limited by diffCacheEntries.

For a file touched by many squash-merged PRs, the initial retrieval can still take time because each PR ref must be verified. The progress status and output log identify the current batch and PR.

## Troubleshooting

### No versions or only mainline commits are shown

Confirm that the squash commit message contains a PR number. A message without #123 cannot be mapped safely to a PR.

### Fetch fails or original commits are absent

Check that the remote name is correct, GitHub credentials permit fetch access, and the PR ref is still retained by GitHub. Some repositories clean old pull-request refs.

### Viewer reports no Git history

Ensure the selected file is tracked by Git and is inside the opened repository. For deleted files, open a historical revision first; the extension operates on the active local file.

### The viewer appears stuck

Open the Squash Merge PR Attribution output channel. The latest Git command identifies whether the extension is reading history, fetching PR refs, or loading one diff.

### The author does not match expectations

The extension reports the Git author stored in the original commit. That may differ from a GitHub display name, commit committer, pair-programming co-author, or PR creator.

## Local development

Open this extension folder directly in VS Code, run npm install, then press F5. Use the Extension Development Host window to run the commands above.
