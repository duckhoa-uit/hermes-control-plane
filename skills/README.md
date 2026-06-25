# Hermes skills

Machine-readable contracts for orchestrating `hermes-control-plane`.
Loaded by the Hermes agent at boot (see `docs/DEPLOYMENT.md §12`).

Each subdirectory is one skill. Same three files in every skill:

- `skill.json` — tool schema (intent triggers, transport, input/output
  refs into `docs/openapi.yaml`, preconditions)
- `prompt.md` — system-prompt fragment Hermes inlines when the skill
  is loaded
- `examples.md` — 3–5 few-shot examples (optional, recommended)

## Loader contract

```ts
const SKILLS_DIR = process.env.HERMES_SKILLS_DIR ?? "./skills";
for (const name of readdirSync(SKILLS_DIR).filter(n => !n.startsWith("."))) {
  if (name === "README.md") continue;
  const skill = JSON.parse(readFileSync(`${SKILLS_DIR}/${name}/skill.json`, "utf8"));
  const prompt = readFileSync(`${SKILLS_DIR}/${name}/prompt.md`, "utf8");
  hermes.registerTool(skill, prompt);
}
```

## Adding a new skill

```bash
mkdir skills/<name>
$EDITOR skills/<name>/{skill.json,prompt.md,examples.md}
```

If the skill calls a new HTTP route, add the route to `docs/openapi.yaml`
in the same PR; `skill.json#input_schema` must `$ref` it.

## Versioning

Each `skill.json#version` is independent of the repo version. Bump major
on a breaking schema change; Hermes pins by major and refuses to load
a major it doesn't support.
