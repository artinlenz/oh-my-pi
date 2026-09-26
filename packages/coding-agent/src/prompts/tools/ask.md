Ask only for materially different tradeoffs the user must decide. Default: act using code/config/docs/history and conventions. Several viable choices: pick conservative/standard, proceed, state choice.

<instruction>
- Batch related questions; 2–5 distinct options each; short labels, tradeoffs in `description`.
- `recommended` auto-adds " (Recommended)"; `multi: true` permits multiple selections.
- NEVER supply "Other": UI adds "Other (type your own)". Clarifying custom input? Answer first; re-ask unresolved questions.
{{#if chatOption}}
- User chose to chat about it instead of answering? Discuss their questions or concerns in plain replies; NEVER re-ask until they're ready.
{{/if}}
</instruction>
