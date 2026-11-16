import { expect, it } from "vitest";
import { runningHubAccountSummary } from "../src/runninghub/account-status";

it("keeps RH coins and wallet as independent balances and includes explicit zero", () => {
  expect(runningHubAccountSummary({ valid: true, remainCoins: "1250.5", remainMoney: "0", currency: "CNY", apiType: "NORMAL" }))
    .toBe(" · RH 币：1250.5 · 钱包：0 CNY · 接口返回类型：消费级会员（NORMAL）");
});
it("does not invent zero balances or convert one balance into another", () => {
  expect(runningHubAccountSummary({ valid: true })).toBe("");
  expect(runningHubAccountSummary({ valid: true, remainCoins: "0" })).toBe(" · RH 币：0");
  expect(runningHubAccountSummary({ valid: true, remainMoney: "8", currency: "USD" })).toBe(" · 钱包：8 USD");
});
