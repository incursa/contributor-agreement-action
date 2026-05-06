const assert = require("node:assert/strict");
const test = require("node:test");

const {
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
} = require("../src/main");

test("allowlist matches exact and wildcard bot logins", () => {
  const allowlist = parseAllowlist("SamuelMcAravey,dependabot[bot],bot-*");

  assert.equal(matchesAllowlist("SamuelMcAravey", allowlist), true);
  assert.equal(matchesAllowlist("dependabot[bot]", allowlist), true);
  assert.equal(matchesAllowlist("bot-reviewer", allowlist), true);
  assert.equal(matchesAllowlist("external-contributor", allowlist), false);
});

test("parseNextLink extracts the next relation", () => {
  const link = '<https://api.github.com/repos/incursa/repo/pulls/1/commits?page=2>; rel="next", <https://api.github.com/repos/incursa/repo/pulls/1/commits?page=5>; rel="last"';

  assert.equal(parseNextLink(link), "https://api.github.com/repos/incursa/repo/pulls/1/commits?page=2");
});

test("parseNextLink returns null when no next relation exists", () => {
  const link = '<https://api.github.com/repos/incursa/repo/pulls/1/commits?page=1>; rel="prev"';

  assert.equal(parseNextLink(link), null);
});

test("buildFailureDescription prefers missing signatures", () => {
  const description = buildFailureDescription([{ login: "octocat" }], [{ sha: "abcdef" }]);

  assert.equal(description, "1 contributor(s) need to sign the agreement.");
});

test("buildFailureDescription reports unlinked commit authors", () => {
  const description = buildFailureDescription([], [{ sha: "abcdef" }]);

  assert.equal(description, "1 commit author(s) are not linked to GitHub users.");
});

test("comments include marker and exact signing phrase", () => {
  const runtime = {
    agreementUrl: "https://github.com/incursa/example/blob/main/CONTRIBUTOR-AGREEMENT.md",
    signatureComment: "I have read the Incursa Contributor Agreement and I hereby assign my contribution rights as described.",
    recheckComment: "recheck contributor agreement",
  };

  const comment = buildMissingComment(runtime, [{ login: "octocat" }], [{ sha: "abcdef123456", name: "Unknown Author" }]);

  assert.match(comment, /<!-- incursa-contributor-agreement -->/);
  assert.match(comment, /@octocat/);
  assert.match(comment, /I have read the Incursa Contributor Agreement/);
  assert.match(comment, /`abcdef1` by Unknown Author/);
});

test("success comment includes marker", () => {
  assert.match(buildSuccessComment(), /<!-- incursa-contributor-agreement -->/);
});

test("signature records preserve the source comment audit fields", () => {
  const record = buildSignatureRecord(
    {
      login: "octocat",
      id: 583231,
      htmlUrl: "https://github.com/octocat",
    },
    {
      id: 12345,
      html_url: "https://github.com/incursa/example/pull/7#issuecomment-12345",
      body: "I have read the Incursa Contributor Agreement and I hereby assign my contribution rights as described.",
      created_at: "2026-05-06T04:00:00Z",
      updated_at: "2026-05-06T04:00:00Z",
    },
    {
      fullName: "incursa/example",
      number: 7,
      htmlUrl: "https://github.com/incursa/example/pull/7",
      headSha: "abcdef123456",
    },
    {
      agreementId: "incursa-contributor-agreement-v1",
      agreementUrl: "https://github.com/incursa/example/blob/main/CONTRIBUTOR-AGREEMENT.md",
      signatureComment: "I have read the Incursa Contributor Agreement and I hereby assign my contribution rights as described.",
    },
    "2026-05-06T04:01:00Z",
    "987654321");

  assert.equal(record.source.commentBody, "I have read the Incursa Contributor Agreement and I hereby assign my contribution rights as described.");
  assert.equal(record.source.commentCreatedAt, "2026-05-06T04:00:00Z");
  assert.equal(record.source.commentUpdatedAt, "2026-05-06T04:00:00Z");
  assert.equal(record.source.commentUrl, "https://github.com/incursa/example/pull/7#issuecomment-12345");
});

test("helpers normalize paths, booleans, and short SHAs", () => {
  assert.equal(encodePath("signatures/incursa contributor agreement.json"), "signatures/incursa%20contributor%20agreement.json");
  assert.equal(parseBoolean("true"), true);
  assert.equal(parseBoolean("no"), false);
  assert.equal(shortSha("abcdef123456"), "abcdef1");
});
