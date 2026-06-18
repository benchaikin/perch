# Perch

Instructions for agents working in this repo. See `README.md` for architecture and core ideas.

## Code style

- **Let the code document itself.** Prefer clean structure, clear names, and small
  functions. Reach for a better name or a smaller function before reaching for a comment.
- **Comment only when it earns its place.** Add a comment when it conveys something the
  code cannot — WHY a non-obvious choice was made, a workaround, an invariant, a gotcha,
  or a link to context. Never write a comment that restates what the code already says.
- **Match the surrounding style when editing.** Don't add narration comments to existing
  code; follow the conventions of the file you're in.
- **Formatting and lint are handled for you.** prettier (`.prettierrc.json`) and eslint
  (`eslint.config.js`) own formatting and lint — don't hand-format or duplicate their work.
