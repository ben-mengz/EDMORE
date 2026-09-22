# EDMORE Desktop

The Mac desktop application controls the EDMORE client in `../client`.
It launches that installation's `start.mjs` and uses the fixed `edmore-client`
profile. The previous Harness checkout and its CLI are not supported launch targets.

Install the client first (`cd ../client` then `npm ci`). In this directory:

```sh
npm ci
npm start
npm test
node tests/profile-smoke.mjs
npm run package:mac -- --arm64
```

The app keeps its menu-bar control, workspace window, MCP status, plugin controls,
and English/Chinese language selection. Closing the interface keeps the client
running; Quit Completely gracefully stops the client owned by this app.

Configuration is stored as `client.json` in Electron's user data directory.
On first launch, old `harness.json` settings are migrated to the sibling EDMORE
client installation. Endpoint, Node path, language preferences and plugin overrides
are retained. The original configuration remains as a backup. For another layout,
set `EDMORE_CLIENT_DIR` or select the EDMORE client directory in Settings.

The application does not bundle Node or the client. Installers are written to
`release/`. Mac development builds are ad-hoc signed, not notarized releases.
The lifecycle smoke test uses isolated data and an offline instrument address.

## Skills

The Skills tab separates Workflow and Support, each with its own count, filtered
list and Add action. Switching categories with an unsaved draft asks before
discarding it. Both categories support duplication and English/Chinese labels.

Add Workflow opens the existing sequential-step editor. Built-in workflows are
read-only and can be duplicated into custom workflows. The editor supports step ordering,
MCP-schema parameter controls, fixed values, runtime questions, earlier-tool result
references, and additional confirmation gates. Success advances to the next step;
failures use the existing pause/review flow. Arbitrary branches and retries are not
supported. Expected output is a planning description, not an executable predicate.

Add Support opens a Markdown editor with a name, description and standard
hyphenated skill ID; it requires no MCP connection or executable steps. Import
SKILL.md fills a new support draft from a single Markdown file, preserving its
frontmatter and invocation settings. Referenced scripts and other bundle files
are not copied by this single-file import. Saving writes only SKILL.md and marks
`metadata.edmore.authority: support`; imported workflow declarations do not grant
execution authority. Existing workflow IDs cannot be overwritten as support, or
vice versa.

Custom skills are stored under `$DSH_HOME/edmore/skills` (default
`~/.dsh/edmore/skills`), outside the checkout. Saves affect newly generated plans;
existing approved plans retain their snapshot. Schema availability requires a
running client and reachable MCP services. Saving a template does not approve or
execute it: generated plans still pass the existing tool/schema judge and approval
gates. Existing instrument-specific gates cannot be disabled in custom workflows.

Run `node tests/skills-ui-smoke.mjs` with Playwright installed for the native editor
test. It uses an isolated user-data directory and only reads MCP schemas, never
executes instrument tools.
