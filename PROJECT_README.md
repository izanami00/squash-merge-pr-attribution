# Project maintenance

This document is for maintainers of the repository. `README.md` is the product-facing page shown in the Visual Studio Marketplace and in the installed VSIX; do not add build or release instructions there.

## Local package

Install dependencies and build a VSIX:

    npm install
    npm run package

The package file is written to `dist/` as `<package-name>-<package-version>.vsix`. Both values are read from `package.json`; `dist/` is ignored by Git.

## GitHub Release

The **Build and publish GitHub Release** workflow is manual. Before running it, update the `version` field in `package.json` and commit the release changes. Then select the intended branch in **Actions** and run the workflow.

The workflow reads the version directly from `package.json`, derives the release tag as `v<version>`, builds the VSIX, creates the GitHub tag and release, and uploads the VSIX as a release asset. No release version or tag is entered manually.

The workflow uses the repository `GITHUB_TOKEN`; no Marketplace token is needed because it creates a GitHub Release only.
