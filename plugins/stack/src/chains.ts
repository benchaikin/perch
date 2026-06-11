/**
 * Shared `base.ref → head.ref` chaining logic.
 *
 * A stack is a linear chain of PRs where each PR's base branch is the head
 * branch of the PR below it. Both the fallback `baseRefProvider` (which
 * reconstructs one stack's graph) and the cross-repo `stack.prs` read (which
 * partitions a repo's PRs into stack groups vs. standalone PRs) need to walk
 * these chains, so the logic lives here once.
 *
 * Generic over the item type: callers supply `headOf`/`baseOf` accessors, so the
 * same walk serves both raw `gh pr list` rows and normalized `PrInfo`s.
 */

/**
 * Build the ordered (bottom → top) chain that contains the item whose head is
 * `anchorHead`, given the items indexed by head and by base.
 *
 * Walks DOWN (prepend the item whose head is this item's base) until the base is
 * no longer any item's head (trunk), and UP (append the item whose base is this
 * tip's head) until no item builds on top. Cycle-guarded both ways.
 */
export function chainContaining<T>(
  anchorHead: string,
  byHead: Map<string, T>,
  byBase: Map<string, T>,
  headOf: (item: T) => string | undefined,
  baseOf: (item: T) => string | undefined,
): T[] {
  const anchor = byHead.get(anchorHead);
  if (!anchor) return [];

  const chain: T[] = [anchor];

  // Walk DOWN: while this layer's base is another item's head, prepend it.
  let base = baseOf(anchor);
  const seenDown = new Set<string>([anchorHead]);
  while (base && byHead.has(base) && !seenDown.has(base)) {
    const lower = byHead.get(base)!;
    chain.unshift(lower);
    seenDown.add(base);
    base = baseOf(lower);
  }

  // Walk UP: while some item's base is this tip's head, append it. The cycle
  // guard tracks heads we've already followed (seeded empty, marked before
  // following) so the first step — from the anchor's own head — isn't blocked.
  let head = headOf(anchor);
  const seenUp = new Set<string>();
  while (head && byBase.has(head) && !seenUp.has(head)) {
    seenUp.add(head);
    const upper = byBase.get(head)!;
    chain.push(upper);
    head = headOf(upper);
  }

  return chain;
}

/**
 * Partition `items` into all maximal bottom → top chains. Items linked by
 * `base → head` end up in the same chain (in order); an item linked to no other
 * comes back as a singleton chain (`[item]`). Each item appears in exactly one
 * returned chain.
 *
 * Indexing is last-writer-wins per branch (matching the providers' maps), so a
 * duplicated head/base resolves deterministically rather than throwing.
 */
export function allChains<T>(
  items: T[],
  headOf: (item: T) => string | undefined,
  baseOf: (item: T) => string | undefined,
): T[][] {
  const byHead = new Map<string, T>();
  const byBase = new Map<string, T>();
  for (const item of items) {
    const head = headOf(item);
    if (head === undefined) continue;
    byHead.set(head, item);
    const base = baseOf(item);
    if (base !== undefined) byBase.set(base, item);
  }

  const chains: T[][] = [];
  const seen = new Set<T>();
  for (const item of items) {
    if (seen.has(item)) continue;
    const head = headOf(item);
    if (head === undefined) {
      // No resolvable head → cannot chain; emit as its own singleton.
      chains.push([item]);
      seen.add(item);
      continue;
    }
    const chain = chainContaining(head, byHead, byBase, headOf, baseOf);
    // `chain` is empty only if the anchor wasn't indexed (shouldn't happen here).
    const resolved = chain.length > 0 ? chain : [item];
    for (const member of resolved) seen.add(member);
    chains.push(resolved);
  }
  return chains;
}
