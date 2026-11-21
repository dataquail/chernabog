// A Stryker ignorer (#586): skips string mutants in text meant for a person,
// which no test should pin word for word. A string, or a template, inside the
// value of an object property named `message`, `reason`, `fix` or `title`
// (an error's message, a refusal's reason and fix, a held item's title) is
// left alone. Every other string is still mutated: the spike found real gaps
// in prefixes, keys and tags (docs/testing/mutation-spike.md, section 5).

const MESSAGE_KEYS = new Set(["message", "reason", "fix", "title"]);

const keyName = (property) => {
  const { key } = property.node;

  if (property.node.computed) {
    return undefined;
  }

  return key.type === "Identifier"
    ? key.name
    : key.type === "StringLiteral"
      ? key.value
      : undefined;
};

// The property whose value this expression is part of, stopping at a function
// or a statement: text built inside a callback is not the property's text.
const messageProperty = (path) => {
  let child = path;
  let parent = path.parentPath;

  while (parent !== null && !parent.isFunction() && !parent.isStatement()) {
    if (parent.isObjectProperty()) {
      return child.key === "value" && MESSAGE_KEYS.has(keyName(parent))
        ? keyName(parent)
        : undefined;
    }

    child = parent;
    parent = parent.parentPath;
  }

  return undefined;
};

const messageText = {
  shouldIgnore(path) {
    if (!path.isStringLiteral() && !path.isTemplateLiteral()) {
      return undefined;
    }

    const key = messageProperty(path);

    return key === undefined ? undefined : `Text for a person, in a \`${key}\``;
  },
};

// What @stryker-mutator/api's declareValuePlugin(PluginKind.Ignore, …) builds,
// written out so this file needs no import that isn't hoisted.
export const strykerPlugins = [{ kind: "Ignore", name: "message-text", value: messageText }];
