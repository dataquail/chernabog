/**
 * @fileoverview A span's attributes are written to disk under the Chernabog
 * home and kept for 30 days, so an attribute says which thing a span was
 * about, by its ID or name, and never carries a secret or a piece of content.
 *
 * Checks where attributes are set:
 * - the objects returned by a `spanAttributes` map: one passed to
 *   `Command.dispatcher`, `Query.dispatcher` or `makeEventBus`, one built by
 *   `Event.spanAttributes`, and one declared under a name ending in
 *   `SpanAttributes` (the maps are declared in one file and passed in
 *   another, which a rule run file by file can't follow). A map entry or a
 *   spread that names a function declared in the same file is followed;
 * - `Effect.annotateCurrentSpan`, `Effect.annotateLogs`, and the
 *   `attributes` of `Effect.withSpan` and `Effect.fn`.
 *
 * Reports a key with a word that names a secret (on any segment of a dotted
 * key, `session` but for `session.id`), a value that reads something named
 * like a secret, and a value that is a whole prompt, body or environment.
 */

const SECRET_WORDS = new Set([
  "token",
  "secret",
  "password",
  "passwd",
  "apikey",
  "authorization",
  "auth",
  "cookie",
  "credential",
  "privatekey",
  "session",
]);

const CONTENT_NAMES = new Set(["prompt", "body", "env", "environment"]);

// The words of a name, lowercased: `run.apiKey` and `API_KEY` both give
// `api`, `key`, with each adjacent pair joined too, so `apikey` is a word of
// either.
const wordsOf = (segments) => {
  const words = segments.flatMap((segment) =>
    segment
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[^A-Za-z0-9]+/)
      .filter((word) => word !== "")
      .map((word) => word.toLowerCase()),
  );

  return words;
};

// The first word of the name that names a secret, or undefined. A plural
// counts; `session` followed by `id` is the session's ID, not the session.
const secretWordOf = (segments) => {
  const words = wordsOf(segments);

  for (let at = 0; at < words.length; at++) {
    const word = words[at];
    const next = words[at + 1];
    const candidates = [word, `${word}${next ?? ""}`];

    for (const candidate of candidates) {
      const singular = candidate.endsWith("s") ? candidate.slice(0, -1) : candidate;
      const found = [candidate, singular].find((name) => SECRET_WORDS.has(name));

      if (found === undefined) {
        continue;
      }

      if (found === "session" && candidate === word && next === "id") {
        continue;
      }

      return found;
    }
  }

  return undefined;
};

const unwrap = (node) => {
  let current = node;

  while (
    current !== null &&
    current !== undefined &&
    (current.type === "TSAsExpression" ||
      current.type === "TSSatisfiesExpression" ||
      current.type === "TSNonNullExpression" ||
      current.type === "ParenthesizedExpression")
  ) {
    current = current.expression;
  }

  return current;
};

const isFunction = (node) =>
  node?.type === "ArrowFunctionExpression" ||
  node?.type === "FunctionExpression" ||
  node?.type === "FunctionDeclaration";

// `Effect.annotateLogs` → "Effect", "annotateLogs".
const calleeName = (callee) => {
  if (callee.type === "Identifier") {
    return { object: undefined, name: callee.name };
  }

  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.object.type === "Identifier" &&
    callee.property.type === "Identifier"
  ) {
    return { object: callee.object.name, name: callee.property.name };
  }

  return undefined;
};

const propertyKeyName = (property) => {
  if (!property.computed && property.key.type === "Identifier") {
    return property.key.name;
  }

  if (property.key.type === "Literal" && typeof property.key.value === "string") {
    return property.key.value;
  }

  if (property.key.type === "TemplateLiteral" && property.key.expressions.length === 0) {
    return property.key.quasis[0].value.cooked;
  }

  return undefined;
};

const stringValue = (node) => {
  const value = unwrap(node);

  if (value?.type === "Literal" && typeof value.value === "string") {
    return value.value;
  }

  if (value?.type === "TemplateLiteral" && value.expressions.length === 0) {
    return value.quasis[0].value.cooked;
  }

  return undefined;
};

const findProperty = (object, name) =>
  object.properties.find(
    (property) => property.type === "Property" && propertyKeyName(property) === name,
  );

// The names a read goes through, `process.env.HOME` → process, env, HOME, or
// undefined when it is not a plain read.
const readPath = (node) => {
  const value = unwrap(node);

  if (value.type === "Identifier") {
    return [value.name];
  }

  if (value.type === "MemberExpression") {
    const object = readPath(value.object);
    const property = value.computed ? stringValue(value.property) : value.property.name;

    if (object === undefined || property === undefined) {
      return undefined;
    }

    return [...object, property];
  }

  return undefined;
};

const MEASURES = new Set(["length", "size"]);

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Do not put a secret or a piece of content in a span attribute",
      category: "Possible Errors",
      recommended: false,
    },
    schema: [],
  },

  create: function (context) {
    // The functions and objects declared at the top of the file, by name.
    const declared = new Map();
    const reported = new Set();
    const followed = new Set();

    const report = (node, message) => {
      const at = `${node.start}:${node.end}`;

      if (reported.has(at)) {
        return;
      }

      reported.add(at);
      context.report({ node, message });
    };

    const instead =
      "Spans are written to disk under the Chernabog home and kept for 30 days: record an ID, a name or a length instead.";

    const resolve = (node) => {
      const value = unwrap(node);

      if (value?.type === "Identifier" && declared.has(value.name)) {
        return unwrap(declared.get(value.name));
      }

      return value;
    };

    const checkKey = (node, key) => {
      const word = secretWordOf(key.split("."));

      if (word !== undefined) {
        report(node, `Span attribute "${key}" names a secret ("${word}"). ${instead}`);
      }
    };

    // A read the value makes, whole: a secret's name anywhere in it, or the
    // whole of a prompt, body or environment. A length or size of either is
    // fine.
    const checkRead = (node, path) => {
      const last = path[path.length - 1];

      if (MEASURES.has(last)) {
        return;
      }

      if (CONTENT_NAMES.has(last.toLowerCase())) {
        report(
          node,
          `This span attribute records "${path.join(".")}", a whole prompt, body or environment. An attribute should be an identifier or a name. ${instead}`,
        );

        return;
      }

      if (secretWordOf(path) !== undefined) {
        report(
          node,
          `This span attribute reads "${path.join(".")}", which is named like a secret. ${instead}`,
        );
      }
    };

    const checkValue = (node) => {
      const value = unwrap(node);

      if (value === null || value === undefined || isFunction(value)) {
        return;
      }

      const path = readPath(value);

      if (path !== undefined) {
        checkRead(value, path);

        return;
      }

      switch (value.type) {
        case "CallExpression":
          if (value.callee.type === "MemberExpression") {
            checkValue(value.callee.object);
          }

          value.arguments.forEach(checkValue);

          return;
        case "TemplateLiteral":
          value.expressions.forEach(checkValue);

          return;
        case "BinaryExpression":
        case "LogicalExpression":
          checkValue(value.left);
          checkValue(value.right);

          return;
        case "ConditionalExpression":
          checkValue(value.consequent);
          checkValue(value.alternate);

          return;
        case "ChainExpression":
          checkValue(value.expression);

          return;
        case "MemberExpression":
          checkValue(value.object);

          return;
        case "ArrayExpression":
          value.elements.forEach(checkValue);

          return;
        case "ObjectExpression":
          checkAttributes(value);

          return;
        default:
          return;
      }
    };

    // An object of attributes: its keys and values, and what it spreads.
    const checkAttributes = (object) => {
      object.properties.forEach((property) => {
        if (property.type === "SpreadElement") {
          checkReturned(property.argument);

          return;
        }

        const key = propertyKeyName(property);

        if (key !== undefined) {
          checkKey(property.key, key);
        }

        checkValue(property.value);
      });
    };

    // What a function in a map returns, or a helper it calls.
    const checkReturned = (node) => {
      const value = unwrap(node);

      if (value === null || value === undefined) {
        return;
      }

      switch (value.type) {
        case "ObjectExpression":
          checkAttributes(value);

          return;
        case "ConditionalExpression":
          checkReturned(value.consequent);
          checkReturned(value.alternate);

          return;
        case "CallExpression": {
          const callee = resolve(value.callee);

          if (isFunction(callee)) {
            checkFunction(callee);
          }

          return;
        }
        default:
          return;
      }
    };

    const returnsOf = (body) => {
      const found = [];
      const visit = (node) => {
        if (node === null || typeof node !== "object" || isFunction(node)) {
          return;
        }

        if (Array.isArray(node)) {
          node.forEach(visit);

          return;
        }

        if (node.type === "ReturnStatement") {
          found.push(node.argument);

          return;
        }

        Object.entries(node).forEach(([field, child]) => {
          if (field !== "parent" && child !== null && typeof child === "object") {
            visit(child);
          }
        });
      };

      visit(body);

      return found;
    };

    const checkFunction = (fn) => {
      if (followed.has(fn)) {
        return;
      }

      followed.add(fn);

      if (fn.body.type === "BlockStatement") {
        fn.body.body.forEach((statement) => returnsOf(statement).forEach(checkReturned));
      } else {
        checkReturned(fn.body);
      }
    };

    // A spanAttributes map: an entry per message, each a function of it.
    const checkMap = (node) => {
      const map = resolve(node);

      if (map?.type === "CallExpression") {
        const name = calleeName(map.callee);

        if (name?.object === "Event" && name.name === "spanAttributes") {
          checkMap(map.arguments[0]);
        }

        return;
      }

      if (map?.type !== "ObjectExpression") {
        return;
      }

      map.properties.forEach((property) => {
        if (property.type === "SpreadElement") {
          checkMap(property.argument);

          return;
        }

        const entry = resolve(property.value);

        if (isFunction(entry)) {
          checkFunction(entry);
        }
      });
    };

    const objectArguments = (call) =>
      call.arguments.map(unwrap).filter((argument) => argument?.type === "ObjectExpression");

    // `(key, value)`, `(record)`, and the data-first `(effect, key, value)`
    // and `(effect, record)`.
    const checkAnnotation = (call) => {
      const args = call.arguments;
      const keyAt = args.findIndex((argument) => stringValue(argument) !== undefined);

      if (keyAt !== -1 && args[keyAt + 1] !== undefined) {
        checkKey(args[keyAt], stringValue(args[keyAt]));
        checkValue(args[keyAt + 1]);

        return;
      }

      objectArguments(call).forEach(checkAttributes);
    };

    const checkOptionsAttributes = (call) => {
      objectArguments(call).forEach((options) => {
        const attributes = findProperty(options, "attributes");
        const value = unwrap(attributes?.value);

        if (value?.type === "ObjectExpression") {
          checkAttributes(value);
        }
      });
    };

    const checkDispatcherOptions = (call) => {
      objectArguments(call).forEach((options) => {
        const spanAttributes = findProperty(options, "spanAttributes");

        if (spanAttributes !== undefined) {
          checkMap(spanAttributes.value);
        }
      });
    };

    return {
      Program(program) {
        program.body.forEach((statement) => {
          const declaration =
            statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;

          if (declaration?.type === "FunctionDeclaration" && declaration.id !== null) {
            declared.set(declaration.id.name, declaration);
          }

          if (declaration?.type === "VariableDeclaration") {
            declaration.declarations.forEach((declarator) => {
              if (declarator.id.type === "Identifier" && declarator.init !== null) {
                declared.set(declarator.id.name, declarator.init);
              }
            });
          }
        });
      },
      VariableDeclarator(declarator) {
        if (
          declarator.id.type === "Identifier" &&
          declarator.id.name.endsWith("SpanAttributes") &&
          declarator.init !== null
        ) {
          checkMap(declarator.init);
        }
      },
      CallExpression(call) {
        const name = calleeName(call.callee);

        if (name === undefined) {
          return;
        }

        if (
          (name.object === "Command" || name.object === "Query") &&
          name.name === "dispatcher"
        ) {
          checkDispatcherOptions(call);

          return;
        }

        if (name.object === undefined && name.name === "makeEventBus") {
          checkDispatcherOptions(call);

          return;
        }

        if (name.object === "Event" && name.name === "spanAttributes") {
          checkMap(call.arguments[0]);

          return;
        }

        if (name.object !== "Effect") {
          return;
        }

        if (name.name === "annotateCurrentSpan" || name.name === "annotateLogs") {
          checkAnnotation(call);

          return;
        }

        if (name.name === "withSpan" || name.name === "fn") {
          checkOptionsAttributes(call);
        }
      },
    };
  },
};
