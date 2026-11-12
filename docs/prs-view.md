# Perch v1.2 — the "My PRs" view (stacks as grouping)

> Adds a cross-repo **My PRs** read (`stack.prs`) and reworks the GUI panel from
> a single-repo stack graph into a grouped **My PRs** list. The repo switcher is
> retired: instead of choosing one repo at a time, the panel shows *all* of your
> open PRs across every configured repo at once, with stacked PRs grouped
> together.

---

## 1. Motivation

The v1 panel showed one repo's stack at a time, behind a switcher. In practice
you work across several repos and want a single glanceable answer to "what PRs
do I have open, and what's their status?" — with stacks recognized as a unit so
a 3-PR stack reads as one thing, not three scattered rows.

`stack.prs` is the cross-repo "my PRs + status" read. It's the first read worth
exposing to MCP: an agent asking "what are my open PRs and are they green?" gets
a single typed answer spanning all repos. (`stack.view` stays single-repo and
keeps its existing MCP opt-in; the actions stay MCP-off.)

---

## 2. The read: `stack.prs`

Input: none (`z.object({}).default({})` so it's invocable bare).
Output: **`PrOverview`** — repos, each with a list of **`PrGroup`**s.

```ts
/** Normalized CI rollup (same enum as stack.view). */
CiStatus = "pass" | "fail" | "pending" | "none"

/** One open PR — authored by the current user, or awaiting their review. */
PrInfo = {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  author?: string;                                     // only on review requests
  ciStatus: CiStatus;                                  // default "none"
  reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";
  mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  needsRebase: boolean;                                // default false
  conflict: boolean;                                   // default false; = mergeable === "CONFLICTING"
}

/** A group is either a single standalone PR or a stack of ≥2 chained PRs. */
PrGroup =
  | { kind: "pr"; pr: PrInfo }
  | {
      kind: "stack";
      layers: PrInfo[];        // bottom → top (trunk-adjacent first)
      tracked: boolean;        // true when gh-stack locally tracks this stack
      needsRebase: boolean;    // stack-level: any layer needs rebase
    }

/** One configured repo's PRs. */
PrRepo = {
  name: string;               // basename of the repo path
  path?: string;              // the local path, when repos are configured
  groups: PrGroup[];
  reviewRequests: PrInfo[];   // open PRs awaiting my review; default []
  mentions: PrInfo[];         // open PRs that @-mention me (not mine, not review-requested); default []
  error?: string;             // set (with groups: []) when this repo's lookup failed
}

PrOverview = {
  repos: PrRepo[];
}
```

### Grouping

For each configured repo (or `process.cwd()` when none are configured, name =
its basename):

1. `gh pr list --author @me --state open --json number,title,url,headRefName,
   baseRefName,statusCheckRollup,reviewDecision,mergeable` — run with the repo's
   **cwd**.
2. Map rows → `PrInfo` (reusing `rollupToCiStatus` + the review/mergeable enum
   mapping; `conflict = mergeable === "CONFLICTING"`).
3. **Chain** the PRs into maximal `base→head` chains among *these* PRs (shared
   helper, see below). A chain of length ≥2 → `{ kind: "stack", layers }`
   (bottom→top); a PR not chained to another of yours → `{ kind: "pr", pr }`.

### Review requests

Alongside the authored list, and in the same repo cwd, a second parallel read
lists the open PRs the user is a **requested reviewer** on:

```
gh pr list --search "review-requested:@me" --state open --json number,title,url,
  headRefName,baseRefName,statusCheckRollup,reviewDecision,mergeable,author
```

Rows map through the same `rowToPrInfo` projection, plus `author` (whose PR it
is). They land in `PrRepo.reviewRequests` — deliberately a **sibling** of
`groups`, never part of it. Everything downstream that walks `groups` assumes
"PRs I own": stack chaining, the notification diff, the GUI's dex↔PR landable
join (which matches on `headRefName`, so a same-named branch on someone else's PR
would mis-link a task), the PRs tab count/tint, and the dashboard's
needs-rebase / ci-failing / ready-to-merge alerts. Keeping the two apart makes
all of those correct by construction; each opts in explicitly if it ever should.

Notes:

- **Best-effort and isolated.** A failed review lookup yields `[]` and never sets
  `PrRepo.error` — a search-index hiccup must not blank out a repo's own PRs.
  (`--search` reads GitHub's search index, which trails the API by seconds;
  harmless at a 60s poll.)
- **No per-PR comment fetch.** The "review comments to address" badge means *my*
  comments to address, so `fetchHumanReviewCommentCount` is not run for these —
  which also keeps the per-poll `gh api` fan-out flat.
- **Toggle:** `plugins.stack.showReviewRequests` (a boolean settings field,
  default `true`). When false the extra `gh` call is not made at all.
- **Team review requests are not covered.** `review-requested:@me` matches
  *direct* requests only; a review routed through a team needs
  `team-review-requested:<org>/<team>`, which needs the team name — out of scope.

### Mentions

A third parallel read, same cwd, lists the open PRs that **@-mention** the user
(in the body or a comment):

```
gh pr list --search "mentions:@me" --state open --json <same fields as review requests>
```

Both searches share one best-effort `fetchSearch` helper. Results land in
`PrRepo.mentions`, another sibling of `groups` for the same reasons as
`reviewRequests`.

**Inline review comments need a second source.** GitHub's `mentions:` search
doesn't index inline review (diff) comments, so a mention there never matches.
Alongside the search, the user's repo notifications from the last 30 days are
read and filtered to `reason: "mention"` on pull requests:

```
gh api "repos/{owner}/{repo}/notifications?all=true&participating=true&since=<30d ago>" --paginate
```

Each PR number the search didn't already return is fetched with
`gh pr view <n> --json <same fields>,state` and kept only if `OPEN`. Search
results lead, notification-only PRs follow. `all=true` keeps read notifications,
but GitHub moves a thread's `reason` to the latest event, so a later comment can
retire a review-comment mention from this source.

- **Dedupe — a PR appears in at most one section.** Precedence is
  *mine > review-requested > mentioned*. Unlike review requests, `mentions:@me`
  routinely matches the user's **own** PRs (reviewers and bots @-ing them there),
  so the ownership filter is load-bearing. It drops a mention whose number is in
  the authored list, and also any whose `author` is the authenticated login — so
  even when the authored lookup failed (and the repo shows `error`), the user's
  own PRs can't leak into Mentioned. With `showReviewRequests` off there is no
  review-request list to dedupe against, so a PR that is both review-requested
  and mentioning the user shows under Mentioned.
- **@user only.** A team mention (`@org/team`) doesn't match `mentions:@me`, and
  arrives as `reason: "team_mention"`, which the notifications filter skips.
- **Best-effort and isolated**, exactly like review requests: each failed lookup
  (search, notifications, or one `gh pr view`) logs and drops only its own
  results, and never sets `PrRepo.error`. No per-PR comment fetch.
- **Toggle:** `plugins.stack.showMentions` (boolean settings field, default
  `true`). When false none of the mention `gh` calls are made.

### Shared chaining helper

The `base.ref → head.ref` chaining logic is extracted from
`base-ref-provider.ts` into **`plugins/stack/src/chains.ts`** and used in BOTH
places. It exposes:

- `chainContaining(anchorHead, byHead, byBase)` — the ordered (bottom→top) chain
  a given head belongs to (used by `baseRefProvider`).
- `allChains(items, headOf, baseOf)` — partition a list into all maximal
  bottom→top chains (used by `stack.prs` grouping). Items in no multi-chain come
  back as singletons.

### gh-stack enrichment

If the repo has local gh-stack tracking (`.git/gh-stack` exists) and
`gh stack view --json` (run in that cwd) succeeds, the matching base-ref stack
group is marked `tracked: true` and re-ordered + `needsRebase`-flagged from
gh-stack's authoritative output. Resilient: any failure (no tracking, command
error, parse error, no matching group) → enrichment is skipped, the base-ref
grouping stands, and `tracked` stays `false`.

### Per-repo error resilience

Each repo is fetched independently and best-effort: if a repo's authored
`gh pr list` throws (e.g. a 504, no remote, auth), that repo gets `error` set to
the message and `groups: []` — the rest of the overview is unaffected, and its
`reviewRequests` and `mentions` still surface. The review and mentions lookups
are the mirror image: their failure is swallowed to `[]` and never sets `error`.

### Exposure

`expose: { mcp: true }` — the cross-repo "my PRs + status" read is high-value
for agents. `stack.view`, `stack.repos`, and the actions keep their existing
exposure.

---

## 3. GUI — grouped "My PRs" panel

- Primary data source switches from `stack.view` to **`stack.prs`** (subscribe +
  `capability.update`; Refresh re-invokes it; `registry.changed` re-fetches it).
- `panel-state.ts` derives a grouped view-model from `PrOverview`: repo headers →
  standalone PR rows + nested stack groups (indented, with a "stack of N"
  header), each group flagged `tracked`. PR CI/review/mergeable map to the
  existing chips; `needsRebase`/`conflict` to badges. A per-repo `error` renders
  as an inline note under that repo's header. Daemon-down / empty ("no open
  PRs") / loading states are preserved.
- The renderer draws the grouped list. A **Sync** button shows on `tracked` stack
  groups and invokes `stack.sync` with that repo. Clicking a PR row opens its URL
  in the browser (IPC → `shell.openExternal`).
- Below a repo's groups, a labelled **Review requested** sub-section lists that
  repo's `reviewRequests` (with the PR's author), hidden along with the groups by
  the repo's collapse. Owner-only affordances are withheld there: **Merge**
  (never merge a PR you don't own), and **Resolve conflicts** / **Open agent**
  (both check out `headRefName` in a worktree, and for a PR from another author —
  often a fork — that branch may not exist locally). Click-to-open stays. A repo
  with only review requests renders its section rather than "No open PRs".
- Below that, a **Mentioned** sub-section lists the repo's `mentions` the same
  way — author, status chips, click-to-open only, collapsed with the repo — and
  likewise never counts toward the tab's PR count or health tint.
- The **repo-switcher dropdown is retired** — the grouped all-repos view replaces
  it. (No repo filter — that's a future enhancement.)
- The tray menu and `registry.changed` live-reload wiring are unchanged (reload
  re-fetches `stack.prs`).
