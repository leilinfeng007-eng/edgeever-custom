import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip.tsx";

const source = readFileSync(new URL("./EditorPane.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("EditorPane.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const chromeSource = readFileSync(new URL("./editor/EditorPaneChrome.tsx", import.meta.url), "utf8");
const chromeAst = ts.createSourceFile("EditorPaneChrome.tsx", chromeSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const find = (root, predicate) => {
  if (predicate(root)) return root;
  return ts.forEachChild(root, (child) => find(child, predicate));
};
const evaluate = (expression, scope) => {
  const code = ts.transpileModule(`const element = (${expression});`, {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function("React", ...Object.keys(scope), `${code}; return element;`)(React, ...Object.values(scope));
};
const Glyph = () => React.createElement("span");

test("opening the note menu can render its actual WeChat tooltip without a multiple-child crash", () => {
  const tooltip = find(ast, (node) => ts.isJsxElement(node)
    && node.openingElement.tagName.getText(ast) === "IconTooltip"
    && node.openingElement.attributes.getText(ast).includes('t("editor.copyToWeChatTooltip")'));
  expect(tooltip).toBeDefined();
  // Render the actual JSX from EditorPane through the same Radix asChild trigger.
  const tooltipComponent = find(chromeAst, (node) => ts.isVariableDeclaration(node) && node.name.getText(chromeAst) === "IconTooltip");
  const IconTooltip = evaluate(tooltipComponent.initializer.getText(chromeAst), {
    Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
  });
  const DropdownMenuItem = React.forwardRef(({ onSelect, children, ...props }, ref) => React.createElement("button", { ...props, ref }, children));
  const element = evaluate(tooltip.getText(ast), {
    IconTooltip, DropdownMenuItem, t: (key) => key, editor: {}, useMobilePlainTextEditor: false,
    wechatCopyState: "idle", handleCopyToWeChat() {}, setClassificationDetailsOpen() {},
    Sparkles: Glyph, LoaderCircle: Glyph, Check: Glyph, CircleAlert: Glyph, ClipboardType: Glyph,
  });
  expect(() => renderToStaticMarkup(element)).not.toThrow();
});

test("classification details is a direct more-menu action and opens the details dialog", () => {
  const menu = find(ast, (node) => ts.isJsxAttribute(node) && node.name.getText(ast) === "moreMenuItems");
  const entry = find(menu, (node) => ts.isJsxElement(node)
    && node.openingElement.tagName.getText(ast) === "DropdownMenuItem"
    && node.children.some((child) => ts.isJsxExpression(child)
      && child.expression?.getText(ast) === 't("inboxClassification.details")'));
  expect(entry).toBeDefined();
  expect(ts.isJsxFragment(entry.parent)).toBe(true);
  let opened = false;
  const element = evaluate(entry.getText(ast), {
    DropdownMenuItem: "button", Sparkles: Glyph, t: (key) => key,
    setClassificationDetailsOpen(value) { opened = value; },
  });
  expect(renderToStaticMarkup(element)).toContain("inboxClassification.details");
  element.props.onSelect();
  expect(opened).toBe(true);
});
