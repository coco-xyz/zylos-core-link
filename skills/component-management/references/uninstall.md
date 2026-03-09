# Uninstall Workflow

## Session Mode

When user asks to uninstall a component:

**If component is not installed, inform user and stop.**

### Step 1: Confirm and Ask About Data

```
Uninstall <component>?

Choose an option:
1. Remove code only (keep data in ~/zylos/components/<component>/)
2. Remove everything (code + data)
```

### Step 2: Execute Uninstall

The CLI automatically runs `pre-uninstall` hooks declared in SKILL.md before stopping services and removing files. Components use this hook to clean up runtime resources (PM2 processes, PID files, connections).

If the hook fails, the CLI warns and continues with the uninstall.

After user chooses:
```bash
# Option 1: Code only (default)
zylos uninstall <component> --yes --json

# Option 2: Including data
zylos uninstall <component> --purge --yes --json
```

### Step 3: Clean Environment Variables

Remove the component's declared environment variables from `~/zylos/.env` to avoid stale credentials.

## C4 Mode

Same two-step confirmation pattern as upgrades. User chooses whether to keep or delete data.

### Step 1 — User requests uninstall

User: `uninstall lark` or `remove lark`

Run `zylos uninstall lark --check --json`. The JSON output includes component info, service name, data directory path, and dependents. Present the preview and offer two options:
- `uninstall <name> confirm` — uninstall but keep data
- `uninstall <name> purge` — uninstall and delete all data

### Step 2 — User chooses

User: `uninstall lark confirm` (keep data) or `uninstall lark purge` (delete all)

1. Run `zylos uninstall lark confirm --json` or `zylos uninstall lark purge --json` (CLI handles pre-uninstall hooks automatically)
3. Clean component's environment variables from .env
4. Reply with result
