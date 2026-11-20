// The real-model evaluation of the AI advisor (Project 3). It sends each
// scenario's evidence to Claude through adviseFromEvidence(), the exact code the
// Edge Function runs (prompt, schema, request, checks), and grades the brief
// that comes back.
//
// It calls the Anthropic API and costs money, so it runs only on request:
//   npm run eval:advisor           (with ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN set)
// Without credentials, or under a plain `npm test`, every case is SKIPPED, and
// Vitest reports it as skipped, never as passed. Nothing here substitutes a
// stand-in reply: a brief written by the engine instead of the model counts as
// a failure of the model run, and says so.
//
// Results, including every brief and every point the checks removed, are
// written to ADVISOR_EVAL_OUT (default: advisor-eval-results.json in the system
// temp folder). Only invented scenario data is sent; no customer data.
import { describe, it, expect, afterAll } from "vitest";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCENARIOS } from "./advisor-scenarios.js";
import { sanitizeEvidence, adviseFromEvidence, engineStatus } from "../../supabase/functions/_shared/advisor-contract.ts";

const env = process.env;
const requested = env.ADVISOR_EVAL === "1" || env.npm_lifecycle_event === "eval:advisor";
// ADVISOR_EVAL_KEY_FILE: a file outside the repository holding only the key, so
// a run can be started without the key ever being typed into a command or a
// chat. Read here, never printed, never written to the results.
const keyFile = env.ADVISOR_EVAL_KEY_FILE && existsSync(env.ADVISOR_EVAL_KEY_FILE) ? readFileSync(env.ADVISOR_EVAL_KEY_FILE, "utf8").replace(/^﻿/, "").trim() : null;
const credentials = { apiKey: env.ANTHROPIC_API_KEY || keyFile || null, authToken: env.ANTHROPIC_AUTH_TOKEN || null };
const ready = requested && !!(credentials.apiKey || credentials.authToken);
const runs = Math.max(1, Number(env.ADVISOR_EVAL_RUNS) || 1);
// ADVISOR_EVAL_ONLY=healthy,no_action runs only those scenarios, to recheck a
// fix at a fraction of the cost. A partial run is labelled as such in the file.
const only = (env.ADVISOR_EVAL_ONLY || "").split(",").map(x => x.trim()).filter(Boolean);
const selected = only.length ? SCENARIOS.filter(s => only.includes(s.id)) : SCENARIOS;
const out = env.ADVISOR_EVAL_OUT || join(tmpdir(), "advisor-eval-results.json");
const results = [];
// Written after every case, so an interrupted run still leaves what it got, and
// written when the run is skipped, saying why. Never contains a credential.
const save = (status) => writeFileSync(out, JSON.stringify({ ranAt: new Date().toISOString(), status, runs, scenarios: only.length ? only : "all",
  requested, credentialPresent: !!(credentials.apiKey || credentials.authToken), completed: results.length, results }, null, 2));

const textOf = brief => [brief.summary, brief.answer || "", ...brief.findings.flatMap(f => [f.title, f.observation, f.interpretation, f.hypothesis || "", f.impact, f.nextStep]), ...brief.limitations].join("\n");

describe.skipIf(!ready)("the real model, on the eleven scenarios", () => {
  afterAll(() => save("finished"));

  for (const s of selected) {
    for (let run = 1; run <= runs; run++) {
      it(`${s.id} (run ${run})`, async () => {
        const checked = sanitizeEvidence(JSON.parse(JSON.stringify(s.build().evidence)));
        expect(checked.ok).toBe(true);
        const evidence = checked.evidence;
        const started = Date.now();
        const { brief, call } = await adviseFromEvidence({ evidence, fetchImpl: fetch, credentials, timeoutMs: 180_000 });
        const record = { scenario: s.id, run, ms: Date.now() - started, model: call?.ok ? call.model : null, usage: call?.ok ? call.usage : null,
          callError: call && !call.ok ? { kind: call.kind, message: call.message } : null, brief,
          // The model's own reply before any check, so every removed point can be read and judged.
          rawReply: call?.ok ? call.reply : null };
        const x = s.expect;
        // A grade written into the results file, so every case can be reviewed
        // even where an assertion below stops the test early.
        const citedIds = new Set(brief.findings.flatMap(f => f.evidence));
        record.grade = {
          writtenBy: brief.source === "model" ? `model (${record.model})` : "engine fallback: NOT a model result",
          fallbackReason: brief.checks.fallbackReason, removed: brief.checks.removed, confidenceAdjusted: brief.checks.adjusted,
          statusExpected: x.status || engineStatus(evidence), status: brief.status,
          missingCitations: (x.mustCite || []).filter(id => !citedIds.has(id)),
          explainsF1: brief.findings.some(f => f.engineFinding === "F1"),
          answered: evidence.question ? !!brief.answer : null,
        };
        results.push(record);
        save("running");

        // Held scenarios never reach the model.
        if (x.engineOnly) {
          expect(call).toBeNull();
          expect(brief.source).toBe("engine");
          return;
        }
        // The model answered, and its reply passed the checks as a whole.
        expect(record.callError, "the model call failed").toBeNull();
        expect(brief.source, `replaced by the engine: ${brief.checks.fallbackReason}`).toBe("model");
        // Numerical fidelity and every other rule: no point was removed.
        expect(brief.checks.removed, "points removed by the checks").toEqual([]);
        expect(brief.status).toBe(x.status || engineStatus(evidence));
        const cited = new Set(brief.findings.flatMap(f => f.evidence));
        (x.mustCite || []).forEach(id => expect(cited.has(id), `cites ${id}`).toBe(true));
        (x.mustMention || []).forEach(re => expect(textOf(brief)).toMatch(re));
        if (evidence.question && x.answerRequired !== false) expect(brief.answer, "answers the question").toBeTruthy();
        if (x.noCauseAsFact) brief.findings.forEach(f => expect(f.observation).not.toMatch(/\bbecause\b/i));
        if (x.noTaxLiabilityWords) expect(textOf(brief)).not.toMatch(/\b(?:tax|VAT) (?:is )?(?:owed|due|payable)\b|\brefund due\b/i);
      }, 240_000);
    }
  }
});

// Hooks do not run in a skipped block, so the skip is recorded here.
if (requested && !ready) save("skipped: no ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN in the environment");

describe.skipIf(ready)("the real-model evaluation", () => {
  it.skip(requested ? "is SKIPPED: no ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN in the environment" : "is SKIPPED: run `npm run eval:advisor` to call the model", () => {});
});
