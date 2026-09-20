## Summary

Describe the change and why it is needed.

## Linked Issue

Use `Fixes #...` or `Refs #...` when available.  
If no issue exists, include a short rationale/scope summary.

## OpenCode Validation

- Current production released OpenCode version tested:
- Why this version is relevant to the fix:

## Before-and-after evidence

Does this change affect visible UI or human-readable output? If yes, attach matching before-and-after screenshots for each affected surface, using the same configuration, model/provider, theme, and window size.

For quota changes, report the result for Web output, TUI sidebar, toast, and the compact line below the message input. Identify unchanged or untested surfaces explicitly. Include the prompt bar or command dialog when relevant.

Redact credentials, account identifiers, private paths, and other sensitive information. For text-formatting changes, include the relevant text output as well as screenshots.

Formatter tests do not count as screenshot evidence.

If a surface could not be tested, identify it and explain why. If there is no visible effect, write `Not applicable` and explain briefly.

Before:

After:

Surface checks:

## Quality Checklist

- [ ] I ran `pnpm verify`
- [ ] This change is focused and avoids unrelated behavior changes
- [ ] I updated or added tests when behavior changed
- [ ] I updated docs when user-facing workflow, command, or config behavior changed
- [ ] For provider changes, I followed [Provider Changes](https://github.com/slkiser/opencode-quota/blob/main/CONTRIBUTING.md#provider-changes), or this does not apply
