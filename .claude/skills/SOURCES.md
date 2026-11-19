# Installed Agent Skills

Third-party skills copied unmodified (complete directories) for project-scoped use.

| Skill | Source | Revision | License |
|---|---|---|---|
| frontend-design | https://github.com/anthropics/skills/tree/main/skills/frontend-design | e4bb5d9 | see `frontend-design/LICENSE.txt` |
| frontend-ui-engineering | https://github.com/addyosmani/agent-skills/tree/main/skills/frontend-ui-engineering | 8c99fa3 | MIT (`../references/LICENSE.addyosmani-agent-skills`) |
| ui-ux-pro-max | https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/tree/main/.claude/skills/ui-ux-pro-max | 2de1134 | MIT (upstream repo) |
| banner-design, brand, design, design-system, slides, ui-styling | https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/tree/main/.claude/skills | 2de1134 | MIT (upstream repo; `ui-styling/LICENSE.txt`) |

`../references/accessibility-checklist.md` comes from addyosmani/agent-skills@8c99fa3 (`references/`); it is placed so the relative link in `frontend-ui-engineering/SKILL.md` resolves.

`ui-ux-pro-max` commands use `${CLAUDE_PLUGIN_ROOT}`; set it to the repository root, e.g. `python3 .claude/skills/ui-ux-pro-max/scripts/search.py "<query>" --domain style`.

Prerequisites: Python 3 (stdlib) and Node (built-ins only). `design` logo/CIP image generation needs a Gemini, Atlas Cloud, MuAPI or UberLLM API key. `ui-styling` targets shadcn/ui + Tailwind, which this frontend does not use.
