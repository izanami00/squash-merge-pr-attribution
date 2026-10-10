# Squash Merge PR Attribution

VS Code extension for answering one specific question:

> After a GitHub PR was squash-merged, who actually changed this file and what did each original PR commit change?

A squash merge replaces a PR's original commits on the target branch with one new commit. That new commit often identifies only the person who merged it, not each developer who authored the underlying changes. This extension follows the PR number retained in the squash commit message, retrieves the GitHub pull-request head ref, and displays the original commit authors and file-level diffs.

It is not a general-purpose Git history browser. It is intentionally focused on PR commits hidden by squash merges.

## Install

Install from the Visual Studio Code Marketplace:

1. Open the Extensions view in Visual Studio Code.
2. Search for **Squash Merge PR Attribution**.
3. Select **Install**.
4. Reload the window if prompted.

After installation, the extension commands are available from the Command Palette.

## Use

1. Open a tracked file in a Git repository.
2. Run Squash Merge Attribution: Open PR Commit Viewer from the Command Palette.
3. Wait for the progress line to report that original PR commits are ready.
4. Select a version on the left to see the original Git commit author and that commit's exact diff for the active file.

The extension uses the Git author recorded on each original commit. It does not show the PR creator as the change author.

On ordinary opens, locally cached PR refs are reused and only missing refs are fetched. Use Refresh only when you intentionally want to refetch every discovered PR ref from the remote.

## Requirements and limits

- Git must be available on PATH in the VS Code extension host environment.
- The repository must have access to the configured remote, normally origin.
- Squash commit messages must retain a recognizable PR number, such as Feature: add validation (#413) or Merge pull request #413.
- GitHub must still expose refs/pull/PR_NUMBER/head and the current user must have permission to fetch it.
- If the PR number was removed from the squash commit message, Git cannot infer the original PR reliably.

See USER_GUIDE.md for diagnostics, settings, performance behavior, and troubleshooting.
