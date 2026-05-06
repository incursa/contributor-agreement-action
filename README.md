# Incursa Contributor Agreement Action

Reusable GitHub Action for checking pull request contributors against a centralized contributor agreement signature store.

This action is intentionally small:

- no package dependencies
- no checkout of pull request code
- GitHub API calls only
- private JSON signature storage in a repository you control
- one reusable workflow block for every Incursa public repository

## Workflow

Create `.github/workflows/contributor-agreement.yml` in each repository:

```yaml
name: Contributor Agreement

on:
  pull_request_target:
    types: [opened, reopened, synchronize, ready_for_review]
  issue_comment:
    types: [created]

permissions:
  contents: read
  issues: write
  pull-requests: read
  statuses: write

jobs:
  contributor-agreement:
    name: Agreement Gate
    if: github.event_name == 'pull_request_target' || github.event.issue.pull_request
    runs-on: ubuntu-24.04

    steps:
      - name: Check contributor agreement
        uses: incursa/contributor-agreement-action@v0.1.1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          storage-token: ${{ secrets.INCURSA_CONTRIBUTOR_AGREEMENTS_TOKEN }}
          storage-owner: incursa
          storage-repo: contributor-agreements
          storage-path: signatures/incursa-contributor-agreement-v1.json
          agreement-id: incursa-contributor-agreement-v1
          agreement-url: ${{ github.server_url }}/${{ github.repository }}/blob/main/CONTRIBUTOR-AGREEMENT.md
          allowlist: SamuelMcAravey,dependabot[bot],github-actions[bot],renovate[bot]
```

The required branch or ruleset status check name is:

```text
Contributor Agreement
```

That name is the commit status published by the action through the `status-context` input.

## Signature Store

The private storage repository should be writable only by maintainers and by the token used for this action.

Recommended token:

1. Fine-grained personal access token.
2. Resource owner: `incursa`.
3. Repository access: only `incursa/contributor-agreements`.
4. Repository permissions: Contents read/write and Metadata read.
5. Store it as the organization secret `INCURSA_CONTRIBUTOR_AGREEMENTS_TOKEN`.

Set the organization secret with GitHub CLI after creating the token:

```powershell
gh auth refresh -s admin:org
gh secret set INCURSA_CONTRIBUTOR_AGREEMENTS_TOKEN --org incursa --visibility all
```

GitHub CLI will prompt for the secret value if `--body` is omitted.

## Signing

When a pull request is missing signatures, the action comments with the agreement URL and the exact signature phrase:

```text
I have read the Incursa Contributor Agreement and I hereby assign my contribution rights as described.
```

A contributor signs by posting that exact phrase as a pull request comment. The action records the GitHub login, GitHub user ID, agreement ID, agreement URL, source repository, pull request number, comment ID, comment URL, exact comment body, GitHub comment creation/update timestamps, workflow run ID, pull request head SHA, and signature timestamp in the private JSON signature store.

The action checks the pull request author and linked GitHub commit authors. Bot accounts and maintainers can be bypassed through `allowlist`.

## Security Notes

Use `pull_request_target` only because this action does not check out or execute pull request code. Do not add checkout, build, test, package install, or arbitrary script execution to the same job.

The public action repository stores only automation code. The signature JSON and token remain private.
