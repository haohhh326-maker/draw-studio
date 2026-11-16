import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { OptimizationContextTokenSetting, OptimizationOutputTokenSetting } from "../src/prompt-optimization/OptimizationControls";

it("renders the 10000-token output maximum with integer steps", () => {
  const markup = renderToStaticMarkup(createElement(OptimizationOutputTokenSetting, { value: 10000, disabled: false, onChange: () => {} }));
  expect(markup).toContain('type="number"');
  expect(markup).toContain('min="512"');
  expect(markup).toContain('max="10000"');
  expect(markup).toContain('step="1"');
  expect(markup).toContain('value="10000"');
  expect(markup).toContain('aria-describedby="optimization-output-token-help"');
  expect(markup).toContain("最大输出（token）");
  expect(markup).toContain("必须小于总上下文容量");
});
it("renders a separate 100000-token context capacity including input and output", () => {
  const markup = renderToStaticMarkup(createElement(OptimizationContextTokenSetting, { value: 100000, disabled: false, onChange: () => {} }));
  expect(markup).toContain('type="number"');
  expect(markup).toContain('min="2048"');
  expect(markup).toContain('max="100000"');
  expect(markup).toContain('step="1"');
  expect(markup).toContain('value="100000"');
  expect(markup).toContain('aria-describedby="optimization-context-token-help"');
  expect(markup).toContain("上下文容量（token）");
  expect(markup).toContain("token 不是字数。上下文包含输入与输出");
});
