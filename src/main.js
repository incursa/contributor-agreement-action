const fs = require("node:fs");

const apiVersion = "2022-11-28";
const userAgent = "incursa-contributor-agreement-action";
const commentMarker = "<!-- incursa-contributor-agreement -->";

if (require.main === module) {
  main().catch((error) => {
    logError(error);
    process.exitCode = 1;
  });
}

async function main() {
  const eventName = process.env.GITHUB_EVENT_NAME || "";
  const event = readEventPayload();
  const runtime = readRuntimeInputs();

  const pullRequest = await resolvePullRequest(eventName, event, runtime.githubToken);
  if (!pullRequest) {
    info("No pull request was found for this event. Nothing to check.");
    setOutput("signed", "true");
    setOutput("missing", "");
    return;
  }

  if (eventName === "issue_comment" && isSignatureComment(event, runtime)) {
    await recordSignature(event, pullRequest, runtime);
  }

  const storage = await loadSignatureStore(runtime);
  const contributors = await getRequiredContributors(pullRequest, runtime);
  const signed = getSignedContributors(storage, runtime.agreementId);
  const missing = contributors.required.filter((contributor) => !isContributorSigned(contributor, signed));
  const hasUnlinkedAuthors = runtime.failOnUnlinkedCommitAuthor && contributors.unlinkedCommitAuthors.length > 0;
  const allSigned = missing.length === 0 && !hasUnlinkedAuthors;

  setOutput("signed", allSigned ? "true" : "false");
  setOutput("missing", missing.map((contributor) => contributor.login).join(","));

  await publishStatus(pullRequest, runtime, allSigned, missing, contributors.unlinkedCommitAuthors);
  await publishComment(pullRequest, runtime, allSigned, missing, contributors.unlinkedCommitAuthors);

  if (!allSigned) {
    const missingText = missing.length === 0 ? "no linked GitHub users" : missing.map((user) => `@${user.login}`).join(", ");
    throw new Error(`Contributor agreement check failed. Missing signatures: ${missingText}.`);
  }
}

function readRuntimeInputs() {
  const runtime = {
    githubToken: getInput("github-token", true),
    storageToken: getInput("storage-token", true),
    storageOwner: getInput("storage-owner", true),
    storageRepo: getInput("storage-repo", true),
    storagePath: getInput("storage-path") || "signatures/incursa-contributor-agreement-v1.json",
    storageBranch: getInput("storage-branch") || "main",
    agreementId: getInput("agreement-id") || "incursa-contributor-agreement-v1",
    agreementUrl: getInput("agreement-url", true),
    signatureComment: getInput("signature-comment") ||
      "I have read the Incursa Contributor Agreement and I hereby assign my contribution rights as described.",
    recheckComment: getInput("recheck-comment") || "recheck contributor agreement",
    allowlist: parseAllowlist(getInput("allowlist") || "dependabot[bot],github-actions[bot],renovate[bot]"),
    statusContext: getInput("status-context") || "Contributor Agreement",
    failOnUnlinkedCommitAuthor: parseBoolean(getInput("fail-on-unlinked-commit-author") || "true"),
  };

  return runtime;
}

function getInput(name, required = false) {
  const variants = [
    `INPUT_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`,
    `INPUT_${name.toUpperCase().replace(/ /g, "_")}`,
  ];

  for (const variant of variants) {
    if (Object.prototype.hasOwnProperty.call(process.env, variant)) {
      return (process.env[variant] || "").trim();
    }
  }

  if (required) {
    throw new Error(`Missing required input '${name}'.`);
  }

  return "";
}

function readEventPayload() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error("GITHUB_EVENT_PATH is not set.");
  }

  return JSON.parse(fs.readFileSync(eventPath, "utf8"));
}

async function resolvePullRequest(eventName, event, githubToken) {
  if (event.pull_request) {
    return normalizePullRequest(event.pull_request);
  }

  if (eventName !== "issue_comment" || !event.issue?.pull_request?.url) {
    return null;
  }

  const pullRequest = await githubRequest(githubToken, "GET", event.issue.pull_request.url);
  return normalizePullRequest(pullRequest);
}

function normalizePullRequest(pullRequest) {
  const [owner, repo] = pullRequest.base.repo.full_name.split("/");
  return {
    number: pullRequest.number,
    htmlUrl: pullRequest.html_url,
    author: pullRequest.user ? normalizeUser(pullRequest.user) : null,
    owner,
    repo,
    fullName: pullRequest.base.repo.full_name,
    headSha: pullRequest.head.sha,
    baseBranch: pullRequest.base.ref,
  };
}

async function recordSignature(event, pullRequest, runtime) {
  const signer = event.comment?.user ? normalizeUser(event.comment.user) : null;
  if (!signer) {
    throw new Error("Signature comment did not include a GitHub user.");
  }

  await updateSignatureStore(runtime, (store) => {
    const signatures = getSignatureArray(store);
    const alreadySigned = signatures.some((signature) =>
      signature.agreement?.id === runtime.agreementId &&
      signature.github?.id === signer.id);

    if (alreadySigned) {
      info(`@${signer.login} has already signed ${runtime.agreementId}.`);
      return false;
    }

    signatures.push(buildSignatureRecord(
      signer,
      event.comment,
      pullRequest,
      runtime,
      new Date().toISOString(),
      process.env.GITHUB_RUN_ID || ""));

    signatures.sort(compareSignatures);
    return true;
  }, `Record ${signer.login}'s ${runtime.agreementId} signature`);
}

function buildSignatureRecord(signer, comment, pullRequest, runtime, signedAt, workflowRunId) {
  return {
    github: {
      login: signer.login,
      id: signer.id,
      htmlUrl: signer.htmlUrl,
    },
    agreement: {
      id: runtime.agreementId,
      url: runtime.agreementUrl,
    },
    signedAt,
    signatureText: runtime.signatureComment,
    source: {
      repository: pullRequest.fullName,
      pullRequest: pullRequest.number,
      pullRequestUrl: pullRequest.htmlUrl,
      commentId: comment.id,
      commentUrl: comment.html_url,
      commentBody: comment.body,
      commentCreatedAt: comment.created_at,
      commentUpdatedAt: comment.updated_at,
      workflowRunId,
      headSha: pullRequest.headSha,
    },
  };
}

async function loadSignatureStore(runtime) {
  const loaded = await readStorageFile(runtime);
  return loaded.store;
}

async function updateSignatureStore(runtime, updater, commitMessage) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const loaded = await readStorageFile(runtime);
    const changed = updater(loaded.store);
    if (!changed) {
      return;
    }

    normalizeStore(loaded.store, runtime);
    const content = Buffer.from(`${JSON.stringify(loaded.store, null, 2)}\n`, "utf8").toString("base64");
    const body = {
      message: commitMessage,
      content,
      branch: runtime.storageBranch,
    };

    if (loaded.sha) {
      body.sha = loaded.sha;
    }

    try {
      await githubRequest(
        runtime.storageToken,
        "PUT",
        `/repos/${runtime.storageOwner}/${runtime.storageRepo}/contents/${encodePath(runtime.storagePath)}`,
        body);
      return;
    } catch (error) {
      if (attempt === 1 && error.status === 409) {
        info("Signature store changed concurrently; retrying once.");
        continue;
      }

      throw error;
    }
  }
}

async function readStorageFile(runtime) {
  try {
    const response = await githubRequest(
      runtime.storageToken,
      "GET",
      `/repos/${runtime.storageOwner}/${runtime.storageRepo}/contents/${encodePath(runtime.storagePath)}?ref=${encodeURIComponent(runtime.storageBranch)}`);

    const decoded = Buffer.from(response.content.replace(/\n/g, ""), "base64").toString("utf8");
    const store = JSON.parse(decoded);
    normalizeStore(store, runtime);
    return { store, sha: response.sha };
  } catch (error) {
    if (error.status !== 404) {
      throw error;
    }

    const store = createEmptyStore(runtime);
    return { store, sha: null };
  }
}

function createEmptyStore(runtime) {
  return {
    schema: "https://incursa.com/schemas/contributor-agreement-signatures.v1.json",
    agreement: {
      id: runtime.agreementId,
      url: runtime.agreementUrl,
    },
    signatures: [],
  };
}

function normalizeStore(store, runtime) {
  if (!store.schema) {
    store.schema = "https://incursa.com/schemas/contributor-agreement-signatures.v1.json";
  }

  if (!store.agreement) {
    store.agreement = {};
  }

  store.agreement.id = store.agreement.id || runtime.agreementId;
  store.agreement.url = store.agreement.url || runtime.agreementUrl;

  if (!Array.isArray(store.signatures)) {
    store.signatures = [];
  }
}

function getSignatureArray(store) {
  if (!Array.isArray(store.signatures)) {
    store.signatures = [];
  }

  return store.signatures;
}

async function getRequiredContributors(pullRequest, runtime) {
  const contributors = new Map();
  const unlinkedCommitAuthors = [];

  if (pullRequest.author) {
    addContributor(contributors, pullRequest.author);
  }

  const commits = await paginate(
    runtime.githubToken,
    `/repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/commits?per_page=100`);

  for (const commit of commits) {
    if (commit.author) {
      addContributor(contributors, normalizeUser(commit.author));
    } else {
      unlinkedCommitAuthors.push({
        sha: commit.sha,
        name: commit.commit?.author?.name || "unknown",
      });
    }
  }

  const all = Array.from(contributors.values()).sort((left, right) => left.login.localeCompare(right.login));
  const required = all.filter((contributor) => !matchesAllowlist(contributor.login, runtime.allowlist));
  return { all, required, unlinkedCommitAuthors };
}

function addContributor(contributors, contributor) {
  contributors.set(String(contributor.id), contributor);
}

function getSignedContributors(store, agreementId) {
  const signed = new Map();

  for (const signature of getSignatureArray(store)) {
    if (signature.agreement?.id !== agreementId || !signature.github) {
      continue;
    }

    if (signature.github.id) {
      signed.set(`id:${signature.github.id}`, signature);
    }

    if (signature.github.login) {
      signed.set(`login:${signature.github.login.toLowerCase()}`, signature);
    }
  }

  return signed;
}

function isContributorSigned(contributor, signed) {
  return signed.has(`id:${contributor.id}`) || signed.has(`login:${contributor.login.toLowerCase()}`);
}

async function publishStatus(pullRequest, runtime, allSigned, missing, unlinkedCommitAuthors) {
  const state = allSigned ? "success" : "failure";
  const description = allSigned
    ? "All required contributors have signed."
    : buildFailureDescription(missing, unlinkedCommitAuthors);

  await githubRequest(
    runtime.githubToken,
    "POST",
    `/repos/${pullRequest.owner}/${pullRequest.repo}/statuses/${pullRequest.headSha}`,
    {
      state,
      context: runtime.statusContext,
      description,
      target_url: pullRequest.htmlUrl,
    });
}

function buildFailureDescription(missing, unlinkedCommitAuthors) {
  if (missing.length > 0) {
    return `${missing.length} contributor(s) need to sign the agreement.`;
  }

  if (unlinkedCommitAuthors.length > 0) {
    return `${unlinkedCommitAuthors.length} commit author(s) are not linked to GitHub users.`;
  }

  return "Contributor agreement check failed.";
}

async function publishComment(pullRequest, runtime, allSigned, missing, unlinkedCommitAuthors) {
  const existingComment = await findExistingComment(pullRequest, runtime);

  if (allSigned && !existingComment) {
    return;
  }

  const body = allSigned
    ? buildSuccessComment()
    : buildMissingComment(runtime, missing, unlinkedCommitAuthors);

  if (existingComment) {
    await githubRequest(
      runtime.githubToken,
      "PATCH",
      `/repos/${pullRequest.owner}/${pullRequest.repo}/issues/comments/${existingComment.id}`,
      { body });
    return;
  }

  await githubRequest(
    runtime.githubToken,
    "POST",
    `/repos/${pullRequest.owner}/${pullRequest.repo}/issues/${pullRequest.number}/comments`,
    { body });
}

async function findExistingComment(pullRequest, runtime) {
  const comments = await paginate(
    runtime.githubToken,
    `/repos/${pullRequest.owner}/${pullRequest.repo}/issues/${pullRequest.number}/comments?per_page=100`);

  return comments.find((comment) => comment.body && comment.body.includes(commentMarker)) || null;
}

function buildMissingComment(runtime, missing, unlinkedCommitAuthors) {
  const waitingOn = missing.length > 0
    ? missing.map((contributor) => `@${contributor.login}`).join(", ")
    : "No linked GitHub user signatures are missing.";

  const unlinked = unlinkedCommitAuthors.length === 0
    ? ""
    : [
        "",
        "Some commits are not linked to GitHub users, so their authors cannot be matched to a signature:",
        "",
        ...unlinkedCommitAuthors.map((author) => `- \`${shortSha(author.sha)}\` by ${author.name}`),
        "",
        "Use an email address linked to GitHub, squash/re-author the commit, or ask the maintainer how to handle the contribution.",
      ].join("\n");

  return [
    commentMarker,
    "### Contributor Agreement Required",
    "",
    "Thank you for contributing to Incursa. Before this pull request can be merged, each non-allowlisted contributor must read and sign the contributor agreement:",
    "",
    runtime.agreementUrl,
    "",
    "To sign, comment exactly:",
    "",
    `> ${runtime.signatureComment}`,
    "",
    "To re-run this check after fixing authorship or signatures, comment:",
    "",
    `> ${runtime.recheckComment}`,
    "",
    `Waiting on: ${waitingOn}`,
    unlinked,
  ].filter((line) => line !== "").join("\n");
}

function buildSuccessComment() {
  return [
    commentMarker,
    "### Contributor Agreement Complete",
    "",
    "All required contributors have signed the Incursa Contributor Agreement.",
  ].join("\n");
}

async function paginate(token, path) {
  const results = [];
  let next = path;

  while (next) {
    const response = await githubRequest(token, "GET", next, null, { includeHeaders: true });
    results.push(...response.body);
    next = parseNextLink(response.headers.get("link"));
  }

  return results;
}

function parseNextLink(linkHeader) {
  if (!linkHeader) {
    return null;
  }

  for (const part of linkHeader.split(",")) {
    const [urlPart, relPart] = part.split(";").map((value) => value.trim());
    if (relPart === 'rel="next"') {
      return urlPart.slice(1, -1);
    }
  }

  return null;
}

async function githubRequest(token, method, pathOrUrl, body = null, options = {}) {
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `https://api.github.com${pathOrUrl}`;

  const response = await fetch(url, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": userAgent,
      "x-github-api-version": apiVersion,
    },
    body: body === null ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message = parsed?.message || response.statusText;
    const error = new Error(`${method} ${url} failed with ${response.status}: ${message}`);
    error.status = response.status;
    error.body = parsed;
    throw error;
  }

  if (options.includeHeaders) {
    return { body: parsed, headers: response.headers };
  }

  return parsed;
}

function normalizeUser(user) {
  return {
    login: user.login,
    id: user.id,
    htmlUrl: user.html_url,
  };
}

function isSignatureComment(event, runtime) {
  return (event.comment?.body || "").trim() === runtime.signatureComment;
}

function parseAllowlist(value) {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => wildcardToRegex(entry.toLowerCase()));
}

function wildcardToRegex(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesAllowlist(login, allowlist) {
  return allowlist.some((pattern) => pattern.test(login));
}

function parseBoolean(value) {
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function compareSignatures(left, right) {
  return String(left.github?.login || "").localeCompare(String(right.github?.login || "")) ||
    String(left.agreement?.id || "").localeCompare(String(right.agreement?.id || ""));
}

function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function shortSha(sha) {
  return String(sha || "").slice(0, 7);
}

function setOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }

  fs.appendFileSync(outputPath, `${name}=${value}\n`, "utf8");
}

function info(message) {
  console.log(message);
}

function logError(error) {
  const message = error && error.stack ? error.stack : String(error);
  console.error(`::error::${message.replace(/\r?\n/g, "%0A")}`);
}

module.exports = {
  buildFailureDescription,
  buildMissingComment,
  buildSignatureRecord,
  buildSuccessComment,
  encodePath,
  matchesAllowlist,
  parseAllowlist,
  parseBoolean,
  parseNextLink,
  shortSha,
  wildcardToRegex,
};
