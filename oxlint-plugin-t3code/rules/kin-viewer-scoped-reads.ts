import { defineRule, type ESTree } from "@oxlint/plugins";

const VIEWER_NAMES = new Set(["viewer", "viewers", "view", "sees", "team"]);
/** Calls that resolve who a request reads for; their results scope the function's reads. */
const RESOLVERS = new Set(["viewerOf", "viewOf", "reader", "moneyReader"]);
/** Calls that refuse anyone below the owner level; a function making one reads for them. */
const OWNER_GATES = new Set(["theOwner", "ownerOnlyGate", "ownerTurn"]);
/** Wrappers whose second argument is an agent tool's body (`leadTool` in work/leadWork.ts). */
const TOOL_WRAPPERS = new Set(["leadTool"]);
const VIEWER_TYPE = /\b(?:KinViewer|KinPersonId|Fragment)\b/;
const RECORDS = /\bkin_records\b/;

type FunctionNode = ESTree.Function | ESTree.ArrowFunctionExpression;

const readOptions = (options: ReadonlyArray<unknown>) => {
  const [first] = options;
  const value = (key: string) =>
    typeof first === "object" && first !== null && key in first
      ? (first as Record<string, unknown>)[key]
      : undefined;
  const helpers = value("recordHelpers");
  return {
    transport: value("transport") === true,
    readModel: value("readModel") === true,
    recordHelpers: new Set(
      Array.isArray(helpers)
        ? helpers.filter((one): one is string => typeof one === "string")
        : ["selectRecords"],
    ),
  };
};

const isNode = (value: unknown): value is ESTree.Node =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { type?: unknown }).type === "string";

/** Every node under `node`, skipping the `parent` back-reference. */
const walk = (node: ESTree.Node, visit: (node: ESTree.Node) => void) => {
  visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (key === "parent") continue;
    if (Array.isArray(child)) {
      for (const item of child) if (isNode(item)) walk(item, visit);
    } else if (isNode(child)) walk(child, visit);
  }
};

const identifiersIn = (node: ESTree.Node) => {
  const names = new Set<string>();
  walk(node, (one) => {
    if (one.type === "Identifier") names.add(one.name);
  });
  return names;
};

const bindingNames = (pattern: ESTree.Node): Array<string> => {
  if (pattern.type === "Identifier") return [pattern.name];
  if (pattern.type === "AssignmentPattern") return bindingNames(pattern.left);
  if (pattern.type === "RestElement") return bindingNames(pattern.argument);
  if (pattern.type === "ArrayPattern")
    return pattern.elements.flatMap((element) => (element === null ? [] : bindingNames(element)));
  if (pattern.type === "ObjectPattern")
    return pattern.properties.flatMap((property) =>
      property.type === "RestElement" ? bindingNames(property) : bindingNames(property.value),
    );
  return [];
};

const isSqlTag = (node: ESTree.TaggedTemplateExpression) =>
  node.tag.type === "Identifier" && node.tag.name === "sql";

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Kin reads for a person take a required KinViewer and apply it to every record query.",
    },
    schema: [
      {
        type: "object",
        properties: {
          transport: {
            type: "boolean",
            description: "RPC handlers and agent tools: no record SQL at all.",
          },
          readModel: {
            type: "boolean",
            description:
              "A screen's read model: every exported record read takes a KinViewer or is named ownerLevel*.",
          },
          recordHelpers: {
            type: "array",
            items: { type: "string" },
            description: "Calls that expand to a SELECT over kin_records.",
          },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ transport: false, readModel: false, recordHelpers: ["selectRecords"] }],
  },
  create(context) {
    const { transport, readModel, recordHelpers } = readOptions(context.options);
    const text = (node: ESTree.Node) => context.sourceCode.getText(node);

    const readsRecords = (node: ESTree.TaggedTemplateExpression) =>
      node.quasi.quasis.some((quasi) => RECORDS.test(quasi.value.raw)) ||
      node.quasi.expressions.some(
        (expression) =>
          expression.type === "CallExpression" &&
          expression.callee.type === "Identifier" &&
          recordHelpers.has(expression.callee.name),
      );

    const optionalViewer = (name: string, annotation: ESTree.Node | null | undefined) => {
      if (!VIEWER_NAMES.has(name) || annotation == null) return false;
      return VIEWER_TYPE.test(text(annotation));
    };

    const checkParams = (node: FunctionNode) => {
      for (const param of node.params) {
        if (param.type !== "Identifier") continue;
        const annotation = param.typeAnnotation?.typeAnnotation;
        if (!optionalViewer(param.name, annotation)) continue;
        if (param.optional || /\bundefined\b/.test(text(annotation!)))
          context.report({
            node: param,
            message: `An absent \`${param.name}\` reads everything. Take a required \`viewer: KinViewer\` (work/teamView.ts); owner-level reads pass \`KIN_OWNER_LEVEL\`.`,
          });
      }
    };

    const calls = (node: ESTree.Node, names: ReadonlySet<string>) => {
      let found = false;
      walk(node, (one) => {
        if (
          one.type === "CallExpression" &&
          one.callee.type === "Identifier" &&
          names.has(one.callee.name)
        )
          found = true;
      });
      return found;
    };
    const ownerGated = (node: FunctionNode) => node.body != null && calls(node.body, OWNER_GATES);
    const checkScopedSql = (node: FunctionNode) => {
      const tainted = new Set<string>();
      for (const param of node.params) {
        const annotation = param.type === "Identifier" ? param.typeAnnotation : null;
        if (annotation != null && /\bKinViewer\b/.test(text(annotation)))
          for (const name of bindingNames(param)) tainted.add(name);
      }
      const declarators: Array<ESTree.VariableDeclarator> = [];
      const templates: Array<ESTree.TaggedTemplateExpression> = [];
      if (node.body == null) return;
      walk(node.body, (one) => {
        if (one.type === "VariableDeclarator" && one.init != null) {
          declarators.push(one);
          if (calls(one.init, RESOLVERS))
            for (const name of bindingNames(one.id)) tainted.add(name);
        }
        if (one.type === "TaggedTemplateExpression" && isSqlTag(one) && readsRecords(one))
          templates.push(one);
      });
      if (tainted.size === 0 || ownerGated(node)) return;
      // A value built from the viewer (a fragment, rows read with it, their ids) carries it on.
      let grew = true;
      while (grew) {
        grew = false;
        for (const declarator of declarators) {
          const names = bindingNames(declarator.id);
          if (names.every((name) => tainted.has(name))) continue;
          const used = identifiersIn(declarator.init!);
          if (![...used].some((name) => tainted.has(name))) continue;
          for (const name of names) tainted.add(name);
          grew = true;
        }
      }
      for (const template of templates) {
        const used = template.quasi.expressions.flatMap((expression) => [
          ...identifiersIn(expression),
        ]);
        if (used.some((name) => tainted.has(name))) continue;
        context.report({
          node: template,
          message:
            "This record query ignores the viewer. Apply it (`seenBy(sql, viewer)` from work/teamView.ts, or a value read with it), or move the owner-level read out of the viewer's function.",
        });
      }
    };

    const takesViewer = (node: FunctionNode) =>
      ownerGated(node) ||
      (node.body != null && calls(node.body, RESOLVERS)) ||
      node.params.some(
        (param) =>
          param.type === "Identifier" &&
          param.typeAnnotation != null &&
          /\bKinViewer\b/.test(text(param.typeAnnotation)),
      );
    const queriesRecords = (node: ESTree.Node) => {
      let found = false;
      walk(node, (one) => {
        if (one.type === "TaggedTemplateExpression" && isSqlTag(one) && readsRecords(one))
          found = true;
      });
      return found;
    };
    const firstFunction = (node: ESTree.Node) => {
      let found: FunctionNode | undefined;
      walk(node, (one) => {
        if (
          found === undefined &&
          (one.type === "FunctionExpression" || one.type === "ArrowFunctionExpression")
        )
          found = one;
      });
      return found;
    };
    const checkExport = (name: string, fn: FunctionNode | undefined, node: ESTree.Node) => {
      if (fn === undefined || name.startsWith("ownerLevel") || takesViewer(fn)) return;
      if (fn.body == null || !queriesRecords(fn.body)) return;
      context.report({
        node,
        message: `\`${name}\` reads records for a screen without a viewer. Take \`viewer: KinViewer\` (work/teamView.ts) and apply it, or name the owner-level read \`ownerLevel…\`.`,
      });
    };

    const onFunction = (node: FunctionNode) => {
      checkParams(node);
      if (!transport) checkScopedSql(node);
    };

    // An agent tool's body runs in turns teammates read, so it is a read for a person even with no
    // viewer in sight; the scoped check above only starts from one.
    const functionsByName = new Map<string, FunctionNode>();
    const toolBodies: Array<{ call: ESTree.CallExpression; body: ESTree.Node }> = [];
    const checkToolBody = (call: ESTree.CallExpression, body: ESTree.Node) => {
      const fn = body.type === "Identifier" ? functionsByName.get(body.name) : firstFunction(body);
      if (fn === undefined || takesViewer(fn) || fn.body == null || !queriesRecords(fn.body))
        return;
      context.report({
        node: call,
        message:
          "This agent tool reads records with no viewer, and teammates read its turns. Resolve with `viewOf(lead)` and apply it (`viewSees`/`viewVisible`, or `resolveRef`), or gate it to the owner level.",
      });
    };

    return {
      FunctionDeclaration: onFunction,
      FunctionExpression: onFunction,
      ArrowFunctionExpression: onFunction,
      VariableDeclarator(node) {
        if (node.id.type !== "Identifier" || node.init == null) return;
        const fn = firstFunction(node.init);
        if (fn !== undefined) functionsByName.set(node.id.name, fn);
      },
      CallExpression(node) {
        const body = node.arguments[1];
        if (
          !transport &&
          node.callee.type === "Identifier" &&
          TOOL_WRAPPERS.has(node.callee.name) &&
          body !== undefined &&
          isNode(body)
        )
          toolBodies.push({ call: node, body });
      },
      "Program:exit"() {
        for (const { call, body } of toolBodies) checkToolBody(call, body);
      },
      ExportNamedDeclaration(node) {
        if (!readModel || node.declaration == null) return;
        const declaration = node.declaration;
        if (declaration.type === "FunctionDeclaration" && declaration.id != null)
          checkExport(declaration.id.name, declaration, declaration.id);
        if (declaration.type === "VariableDeclaration")
          for (const one of declaration.declarations)
            if (one.id.type === "Identifier" && one.init != null)
              checkExport(one.id.name, firstFunction(one.init), one.id);
      },
      TSPropertySignature(node) {
        if (node.key.type !== "Identifier") return;
        const annotation = node.typeAnnotation?.typeAnnotation;
        if (!optionalViewer(node.key.name, annotation)) return;
        if (node.optional || /\bundefined\b/.test(text(annotation!)))
          context.report({
            node,
            message: `An absent \`${node.key.name}\` reads everything. Make it a required \`KinViewer\` (work/teamView.ts); owner-level reads pass \`KIN_OWNER_LEVEL\`.`,
          });
      },
      TaggedTemplateExpression(node) {
        if (!transport || !isSqlTag(node) || !readsRecords(node)) return;
        context.report({
          node,
          message:
            "RPC handlers and agent tools don't query records. Call a read that takes a `KinViewer` (work/teamView.ts) so the person's view applies.",
        });
      },
    };
  },
});
