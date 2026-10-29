/**
 * @fileoverview The binary never recognizes a flow (docs/adr/0005, decision
 * 9): what it says about one, it learns from the flow, through what core lets
 * a flow declare. A recipe's name in src/ is the binary guessing which flow
 * does what, and a repo that renames the recipe, or writes its own, loses
 * whatever the binary keyed on it. So is a pattern matched against a flow's
 * code for the SDK's vocabulary.
 *
 * Reports a string literal (or a template with no expressions) that is
 * exactly a recipe's name, and a regular expression literal that names a
 * word of the SDK's vocabulary. Prose that mentions a recipe is left alone.
 * Tests are exempt: they name recipes as fixtures. Scoped to src/ in
 * .oxlintrc.json, which lists the names and the vocabulary.
 */

import { isTestFile } from "./is-test-file.mjs";

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Do not name a recipe, or match a flow's code for the SDK's vocabulary",
      category: "Possible Errors",
      recommended: false,
    },
    schema: [
      {
        type: "object",
        properties: {
          names: { type: "array", items: { type: "string" } },
          vocabulary: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
  },

  create: function (context) {
    if (isTestFile(context.filename)) {
      return {};
    }

    const options = context.options[0] ?? {};
    const names = new Set(options.names ?? []);
    const vocabulary = options.vocabulary ?? [];

    const reportName = (node, name) =>
      context.report({
        node,
        message: `"${name}" is a recipe's name. The binary never recognizes a flow by its name (docs/adr/0005, decision 9): learn what you need from what the flow declares, through core.`,
      });

    return {
      Literal(node) {
        if (typeof node.value === "string" && names.has(node.value)) {
          reportName(node, node.value);

          return;
        }

        const pattern = node.regex?.pattern;

        if (pattern === undefined) {
          return;
        }

        const word = vocabulary.find((term) => pattern.includes(term));

        if (word !== undefined) {
          context.report({
            node,
            message: `This pattern looks for "${word}", the SDK's vocabulary. The binary never recognizes a flow by its code (docs/adr/0005, decision 9): learn what you need from what the flow declares, through core.`,
          });
        }
      },
      TemplateLiteral(node) {
        const [only] = node.quasis;

        if (node.expressions.length === 0 && names.has(only.value.cooked)) {
          reportName(node, only.value.cooked);
        }
      },
    };
  },
};
