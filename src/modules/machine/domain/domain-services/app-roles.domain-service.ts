// What each GitHub App role (#477) is on GitHub once its App exists (#481):
// its bot's login, which role an App plays, where it's installed from, and the GitHub Environment a
// repo's CI job reads its key from. A domain service: it holds before any
// persona does, for an App only just created.

import { type AppRole } from "../machine-setup/app-role.value-object.ts";

// The Environment holding each role's App id and key. A run job picks its
// role's, so it can read only that App's key (#477).
const ENVIRONMENTS: Readonly<Record<AppRole, string>> = {
  author: "chernabog-author",
  reviewer: "chernabog-review",
};

// What the Environment calls the App's id and its private key, which CI's
// token step reads.
const APP_ID_VARIABLE = "CHERNABOG_APP_ID";
const APP_KEY_SECRET = "CHERNABOG_APP_KEY";

const environmentOf = (role: AppRole) => ENVIRONMENTS[role];

// Only the default branch's runs may read the reviewer's key: a job a pull
// request's branch starts never approves it (#477).
const defaultBranchOnly = (role: AppRole) => role === "reviewer";

// Which role an App plays, from what GitHub says it may do: only the
// reviewer writes checks, since the check that gates a merge is its own
// (#477). A person may rename an App on GitHub, so its name can't say.
const roleOf = (permissions: Readonly<Record<string, string>>): AppRole => {
  if (permissions.checks === "write") {
    return "reviewer";
  }

  return "author";
};

// An App acts on GitHub as its bot, `<slug>[bot]`.
const loginOf = (slug: string) => `${slug}[bot]`;

// The slug of the App whose bot is `login`.
const slugOf = (login: string) => login.replace(/\[bot\]$/, "");

// Where a person installs an App on their repos. For an App already installed
// on the owner, GitHub offers to add repos to that installation instead.
const installUrl = (slug: string) => `https://github.com/apps/${slug}/installations/new`;

export const AppRoles = {
  APP_ID_VARIABLE,
  APP_KEY_SECRET,
  environmentOf,
  defaultBranchOnly,
  roleOf,
  loginOf,
  slugOf,
  installUrl,
} as const;
