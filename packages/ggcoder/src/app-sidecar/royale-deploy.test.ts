import { describe, expect, it } from "vitest";
import type { MessageLike } from "./royale-bug.js";
import { detectDeploy, isDeployCommand } from "./royale-deploy.js";

const run = (command: string, result: string, isError = false): MessageLike[] => [
  {
    role: "assistant",
    content: [{ type: "tool_call", id: "c1", name: "bash", args: { command } }],
  },
  { role: "tool", content: [{ type: "tool_result", toolCallId: "c1", content: result, isError }] },
];

describe("isDeployCommand", () => {
  it.each([
    "vercel --prod",
    "npx vercel deploy --prebuilt",
    "netlify deploy --prod --dir dist",
    "cd apps/server && npx wrangler deploy",
    "wrangler pages deploy dist",
    "fly deploy",
    "flyctl deploy --remote-only",
    "firebase deploy --only hosting",
    "railway up",
    "gcloud run deploy api --source .",
    "npx serverless deploy",
    "cdk deploy MyStack",
    "git push heroku main",
    "surge ./dist",
    "pnpm run deploy",
    "npm publish",
  ])("counts %s", (cmd) => expect(isDeployCommand(cmd)).toBe(true));

  it.each([
    "vercel env ls",
    "vercel env ls; echo deploy",
    "npm publish --dry-run",
    "wrangler dev",
    "git push origin main",
    "fly logs",
    "cat deploy.md",
    "pnpm build",
  ])("ignores %s", (cmd) => expect(isDeployCommand(cmd)).toBe(false));
});

describe("detectDeploy", () => {
  it("counts a deploy that exited 0", () => {
    expect(
      detectDeploy(run("vercel --prod", "Exit code: 0\nProduction: https://x.vercel.app")),
    ).toBe(true);
  });
  it("ignores a deploy that failed, and other commands", () => {
    expect(detectDeploy(run("vercel --prod", "Exit code: 1\nError: not linked"))).toBe(false);
    expect(detectDeploy(run("vercel --prod", "boom", true))).toBe(false);
    expect(detectDeploy(run("pnpm test", "Exit code: 0"))).toBe(false);
    expect(detectDeploy([])).toBe(false);
  });
});
