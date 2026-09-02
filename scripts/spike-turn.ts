// QM Phase-1 spike turn driver (2026-08-05, homelab QM dev session)
// Modeled on scripts/pi-smoke.ts — in-process app, memory stores, per-turn
// harness/model override, and per-turn LLM usage/cost dump from the session store.
//
// Usage (from repo root, env supplied by caller — never argv):
//   SPIKE_HARNESS=pi SPIKE_MODEL=moonshotai/kimi-k3 SPIKE_SCENARIO=basic node scripts/spike-turn.ts
// Scenarios: basic | tools | korean
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { buildApp } from "../src/wiring.ts";
import type { TurnRequest } from "../src/types.ts";

const harness = (process.env.SPIKE_HARNESS ?? "pi") as any;
const model = process.env.SPIKE_MODEL || undefined;
const scenario = process.env.SPIKE_SCENARIO ?? "basic";
const label = process.env.SPIKE_LABEL ?? `${harness}:${model ?? "(default)"}:${scenario}`;

const cfg = {
  ...loadConfig(),
  port: 0,
  dataDir: mkdtempSync(join(tmpdir(), "qm-spike-")),
  sessionStore: "memory" as const,
  runStore: "memory" as const,
  harness,
  databaseUrl: undefined,
};
const { app, sessions } = buildApp(cfg);

const actor = { externalId: "U1" };
function dm(text: string, thread = "t1"): TurnRequest {
  return {
    surface: "spike",
    actor,
    conversation: { kind: "dm", threadRef: thread },
    text,
    ...(model ? { model } : {}),
    ...(harness ? { harness } : {}),
  };
}

async function run(step: string, req: TurnRequest): Promise<boolean> {
  const started = Date.now();
  console.log(`\n=== [${label}] ${step} ===`);
  console.log(`> ${req.text}`);
  let r;
  try {
    r = await app.turn(req);
  } catch (e: any) {
    console.log(`STATUS: THREW (${Date.now() - started}ms)`);
    console.log(`ERROR : ${e?.message ?? e}`);
    return false;
  }
  const ms = Date.now() - started;
  console.log(`STATUS: ${r.status}  (${ms}ms)`);
  console.log(`REPLY : ${(r.reply ?? r.reason ?? "").slice(0, 500)}`);
  if (r.sessionId) {
    try {
      const reqs = await sessions.listLlmRequests(r.sessionId);
      let cost = 0;
      const models = new Set<string>();
      let inTok = 0, outTok = 0;
      for (const rec of reqs) {
        const u: any = (rec as any).usage ?? {};
        cost += u.costUsd ?? 0;
        inTok += u.inputTokens ?? u.input ?? 0;
        outTok += u.outputTokens ?? u.output ?? 0;
        if ((rec as any).model) models.add((rec as any).model);
      }
      console.log(`USAGE : llmRequests=${reqs.length} models=[${[...models].join(",")}] inTok=${inTok} outTok=${outTok} costUsd=${cost}`);
    } catch (e: any) {
      console.log(`USAGE : (dump failed: ${e?.message})`);
    }
  }
  return r.status === "ok" || r.status === "silent";
}

let allOk = true;
if (scenario === "basic") {
  allOk = await run("basic", dm("Reply with exactly the single word: PONG"));
} else if (scenario === "tools") {
  allOk = await run(
    "execute-tool",
    dm("Use your execute tool to run the command `echo spike-ok`, then tell me exactly what it printed."),
  );
} else if (scenario === "korean") {
  const t = `kr-${Date.now()}`;
  const ok1 = await run(
    "kr-1 write",
    dm(
      "write 툴로 notes.txt 파일을 만들어줘. 내용은 다음 세 줄이야:\n" +
        "- 수요일까지 견적서 보내기\n- 목요일 오전 미팅 준비\n- 서버 백업 확인\n" +
        "파일을 만든 뒤 '작성 완료'라고만 답해.",
      t,
    ),
  );
  const ok2 = await run(
    "kr-2 read+memory",
    dm(
      "방금 만든 notes.txt를 read 툴로 읽고, 거기서 할 일 3개를 뽑아서 memory 툴로 저장해줘. 저장한 할 일 목록을 번호를 붙여 한국어로 알려줘.",
      t,
    ),
  );
  const ok3 = await run(
    "kr-3 recall",
    dm("memory에 저장된 내 할 일이 뭐였지? 한국어로 답해줘.", t),
  );
  allOk = ok1 && ok2 && ok3;
} else {
  console.error(`unknown scenario: ${scenario}`);
  process.exit(2);
}

console.log(`\nRESULT [${label}]: ${allOk ? "PASS" : "FAIL"}`);
process.exit(allOk ? 0 : 1);
