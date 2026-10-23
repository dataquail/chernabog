// Path rules such as humanOnlyPaths: `.github/**`, `**/package.json`, `RELEASE.md`.

const escape = (text: string) => text.replace(/[.+^${}()|[\]\\]/g, "\\$&");

const doubleStar = (glob: string, index: number) => {
  if (glob[index + 2] === "/") {
    return { pattern: "(?:.*/)?", skip: 2 };
  }

  return { pattern: ".*", skip: 1 };
};

export const globToRegExp = (glob: string) => {
  let pattern = "";

  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];

    if (char === "*" && glob[index + 1] === "*") {
      const star = doubleStar(glob, index);
      pattern += star.pattern;
      index += star.skip;
    } else if (char === "*") {
      pattern += "[^/]*";
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += escape(char);
    }
  }

  // A directory rule covers everything under it.
  let rest = "(?:/.*)?";

  if (glob.endsWith("/")) {
    rest = ".*";
  }

  return new RegExp(`^${pattern}${rest}$`);
};

export const pathsMatching = (paths: ReadonlyArray<string>, globs: ReadonlyArray<string>) => {
  const rules = globs.map(globToRegExp);

  return paths.filter((path) => rules.some((rule) => rule.test(path)));
};
