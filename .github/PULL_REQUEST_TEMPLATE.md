## Summary

<!-- What does this change and why? Link the issue it addresses, for example "Fixes #12". -->

## Tests run

<!-- Check what you ran. See CONTRIBUTING.md for what each command needs. -->

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run test:integration`
- [ ] Docker suite: `docker compose -f compose.yaml -f compose.test.yaml up -d --build`, then `npm run test:docker`
- [ ] `npm run lmstudio:e2e` (LM Studio changes)
- [ ] `npm run agents:e2e` (sub-agent or script changes)
- [ ] `npm run config:check` (configuration or models file changes)

## Docs updated

- [ ] README.md or `docs/`
- [ ] `.env.example` and `docs/CONFIGURATION.md` (new or changed environment variables)
- [ ] `config/models.example.json` (new or changed models file fields)
- [ ] `docs/TOOLS.md` regenerated with `npm run docs:tools` (tool definitions changed)
- [ ] `CHANGELOG.md` (changes users will notice)
- [ ] No docs change needed

## Checklist

- [ ] Tests cover the change (bug fixes include a test that fails without the fix)
- [ ] No secrets, private addresses or unredacted logs and transcripts in the code, tests or this description
