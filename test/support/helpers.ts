import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeTempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

export function writeSkillFile(root: string, folder: string, content: string): string {
	const dir = join(root, folder);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "SKILL.md");
	writeFileSync(path, content);
	return path;
}

export const DEPLOY_FLEET_SKILL = `---
name: deploy-fleet
description: Manage deploy fleet instances with the deploy-fleet CLI, create, list, start, stop, destroy, ssh, and status. Use for "spin up a deploy environment".
---

# deploy-fleet

Run \`deploy-fleet create\` to make a new environment.
`;

export const DEPLOY_TEST_SKILL = `---
name: deploy-test
description: Run tests and verify fixes on a running deploy environment before merging a change.
---

# deploy-test

Run the project test suite inside the deploy environment over ssh.
`;

export const REVIEW_PR_SKILL = `---
name: review-pr
description: Open and update a pull request from the command line, including description and reviewers.
---

# review-pr

Use the \`gh\` CLI to open a pull request.
`;

export const FALLBACK_YAML_SKILL = `---
name: fallback-skill
description: "Unterminated quote breaks real YAML parsing
---

# fallback-skill

Body text for the fallback skill.
`;

export const NO_NAME_SKILL = `---
description: A skill with no name field in frontmatter, so the folder name is used instead.
---

# no-name-folder

Body text.
`;

export const NO_DESCRIPTION_SKILL = `---
name: no-description
---

# no-description

This skill has no description and must be skipped entirely.
`;

export const DEPLOY_SKILL = `---
name: deploy
description: Overview of the deploy tooling and where to start for any deploy request.
---

# deploy

Route to the right deploy sub-skill.
`;

export const API_SERVICE_E2E_ON_DEPLOY_SKILL = `---
name: api-service-e2e-on-deploy
description: Run the api-service end-to-end suite against a live deploy environment.
---

# api-service-e2e-on-deploy

Run the e2e suite over ssh on the deploy environment.
`;

export const ORACLE_CDC_DEPLOY_SKILL = `---
name: oracle-cdc-deploy
description: Set up Oracle CDC on a deploy environment for local testing.
---

# oracle-cdc-deploy

Configure the Oracle CDC connector on the deploy environment.
`;

export const HUMAN_REVIEW_SKILL = `---
name: human-review
description: Run a human review loop. This one is excluded by config.
---

# human-review

Body text.
`;
