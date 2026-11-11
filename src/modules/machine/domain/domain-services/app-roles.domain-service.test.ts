import { describe, expect, test } from "bun:test";

import { AppRoles } from "./app-roles.domain-service.ts";

describe("AppRoles", () => {
  test("each role keeps its key in an Environment of its own", () => {
    expect(AppRoles.environmentOf("author")).toBe("chernabog-author");
    expect(AppRoles.environmentOf("reviewer")).toBe("chernabog-review");
  });

  test("only the reviewer's Environment is kept to the default branch", () => {
    expect(AppRoles.defaultBranchOnly("author")).toBe(false);
    expect(AppRoles.defaultBranchOnly("reviewer")).toBe(true);
  });

  test("an App acts as its slug's bot, and is installed from its own page", () => {
    expect(AppRoles.loginOf("acme-chernabog-author")).toBe("acme-chernabog-author[bot]");
    expect(AppRoles.slugOf("acme-chernabog-author[bot]")).toBe("acme-chernabog-author");
    expect(AppRoles.installUrl("acme-chernabog-author")).toBe(
      "https://github.com/apps/acme-chernabog-author/installations/new",
    );
  });
});
