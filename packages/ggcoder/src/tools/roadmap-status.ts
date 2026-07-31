import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import {
  NOTES_ROADMAP_EVIDENCE_ITEM_MAX_LENGTH,
  NOTES_ROADMAP_EVIDENCE_MAX_ITEMS,
  NOTES_ROADMAP_PROPOSALS_MAX_ITEMS,
  NOTES_ROADMAP_REASON_MAX_LENGTH,
  isNotesRoadmapTransitionEvidenceSatisfied,
  isNotesVerificationEvidenceSatisfied,
  validateNotesCompletionReviewFields,
  type NotesCompletionGateOutcome,
  type NotesCompletionUnmetGateCode,
  type NotesRoadmapActor,
  type NotesRoadmapStatusOutcome,
} from "@kenkaiiii/gg-core/project-notes";
import type { ProjectNotesRoadmapProposalOutcome } from "../project-notes-repository.js";

const normalizedText = (value: string): string => value.replace(/\r\n?/g, "\n").trim();
const normalizedCoordinate = (value: string): string => value.trim();
const optionalCoordinate = z
  .string()
  .max(4_096)
  .transform(normalizedCoordinate)
  .refine((value) => value.length > 0, "Expected a non-empty string")
  .optional()
  .transform((value) => value ?? null);

const RoadmapReferenceRange = z
  .object({
    start_line: z.number().int().positive(),
    end_line: z.number().int().positive(),
  })
  .strict()
  .refine((range) => range.end_line >= range.start_line, {
    path: ["end_line"],
    message: "end_line must be at or after start_line",
  });

export const RoadmapReferenceProposalParams = z
  .object({
    provider: z
      .string()
      .max(4_096)
      .transform((value) => value.trim().toLowerCase())
      .refine((value) => value.length > 0, "Provider is required"),
    tool: optionalCoordinate,
    canonical_url: z
      .string()
      .max(2_048)
      .transform(normalizedCoordinate)
      .refine((value) => value.length > 0, "Canonical URL is required"),
    owner: z
      .string()
      .max(4_096)
      .transform(normalizedCoordinate)
      .refine((value) => value.length > 0, "Repository owner is required"),
    repo: z
      .string()
      .max(4_096)
      .transform(normalizedCoordinate)
      .refine((value) => value.length > 0, "Repository name is required"),
    revision: optionalCoordinate,
    path: optionalCoordinate,
    range: RoadmapReferenceRange.nullish().transform((value) => value ?? null),
    issue: z
      .number()
      .int()
      .positive()
      .nullish()
      .transform((value) => value ?? null),
    pull_request: z
      .number()
      .int()
      .positive()
      .nullish()
      .transform((value) => value ?? null),
    query: optionalCoordinate,
    anchor: optionalCoordinate,
    relevance: z.string().max(4_096).transform(normalizedText),
  })
  .strict()
  .superRefine((reference, context) => {
    if (reference.range !== null && reference.path === null) {
      context.addIssue({
        code: "custom",
        path: ["path"],
        message: "path is required when range is present",
      });
    }
    if (reference.issue !== null && reference.pull_request !== null) {
      context.addIssue({
        code: "custom",
        path: ["pull_request"],
        message: "A reference cannot target both an issue and a pull request",
      });
    }
  });

const StableId = z
  .string()
  .max(128)
  .transform(normalizedCoordinate)
  .refine((value) => value.length > 0, "update_id is required");
const PhaseId = z
  .string()
  .max(256)
  .transform(normalizedCoordinate)
  .refine((value) => value.length > 0, "phase_id is required");
const Progress = z
  .string()
  .max(4_096)
  .transform(normalizedText)
  .refine((value) => value.length > 0, "progress is required");
const Evidence = z
  .array(
    z
      .string()
      .max(NOTES_ROADMAP_EVIDENCE_ITEM_MAX_LENGTH)
      .transform(normalizedText)
      .refine((value) => value.length > 0, "Evidence items must not be empty"),
  )
  .max(NOTES_ROADMAP_EVIDENCE_MAX_ITEMS)
  .default([]);
const ProposedReferences = z
  .array(RoadmapReferenceProposalParams)
  .max(NOTES_ROADMAP_PROPOSALS_MAX_ITEMS)
  .default([]);
const ReviewReason = z
  .string()
  .max(NOTES_ROADMAP_REASON_MAX_LENGTH)
  .transform(normalizedText)
  .refine((value) => value.length > 0, "reason is required");
const Verification = z
  .discriminatedUnion("result", [
    z.object({ result: z.literal("passed") }).strict(),
    z.object({ result: z.literal("failed"), reason: ReviewReason }).strict(),
    z.object({ result: z.literal("exception-requested"), reason: ReviewReason }).strict(),
  ])
  .nullish()
  .transform((value) => value ?? null);
const FinalReview = z
  .discriminatedUnion("decision", [
    z
      .object({
        review_id: StableId,
        decision: z.literal("accepted"),
        evidence: Evidence,
        reason: ReviewReason.nullish().transform((value) => value ?? null),
        accepts_verification_exception: z.boolean().default(false),
      })
      .strict(),
    z
      .object({
        review_id: StableId,
        decision: z.literal("rejected"),
        evidence: Evidence,
        reason: ReviewReason.nullish().transform((value) => value ?? null),
        accepts_verification_exception: z.literal(false).default(false),
      })
      .strict(),
  ])
  .nullish()
  .transform((value) => value ?? null)
  .superRefine((review, context) => {
    if (review === null) return;
    const issue = validateNotesCompletionReviewFields(review);
    if (issue?.code === "accepted-requires-evidence") {
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "accepted reviews require at least one evidence item",
      });
    } else if (issue?.code === "rejected-requires-reason") {
      context.addIssue({ code: "custom", path: ["reason"], message: "reason is required" });
    }
  });

const commonFields = {
  update_id: StableId,
  phase_id: PhaseId,
  expected_revision: z.number().int().nonnegative().optional(),
  progress: Progress,
  evidence: Evidence,
  verification: Verification,
  final_review: FinalReview,
  proposed_references: ProposedReferences,
};

export const RoadmapStatusParams = z
  .discriminatedUnion("transition", [
    z
      .object({
        ...commonFields,
        transition: z.literal("pending"),
        blocker: z.never().optional(),
      })
      .strict(),
    z
      .object({
        ...commonFields,
        transition: z.literal("in-progress"),
        blocker: z.never().optional(),
      })
      .strict(),
    z
      .object({
        ...commonFields,
        transition: z.literal("blocked"),
        blocker: z
          .string()
          .max(1_024)
          .transform(normalizedText)
          .refine((value) => value.length > 0, "blocker is required for blocked reports"),
      })
      .strict(),
    z
      .object({
        ...commonFields,
        transition: z.literal("review"),
        blocker: z.never().optional(),
        evidence: Evidence,
      })
      .strict(),
  ])
  .superRefine((report, context) => {
    if (!isNotesRoadmapTransitionEvidenceSatisfied(report.transition, report.evidence)) {
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "review reports require at least one evidence item",
      });
    }
    if (
      !isNotesVerificationEvidenceSatisfied(report.verification?.result ?? null, report.evidence)
    ) {
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "passed verification requires at least one evidence item",
      });
    }
  });

export type RoadmapStatusInput = z.infer<typeof RoadmapStatusParams>;
export type RoadmapReferenceProposalInput = z.infer<typeof RoadmapReferenceProposalParams>;

export type RoadmapStatusActor = NotesRoadmapActor;

export interface RoadmapStatusToolContext {
  actor: RoadmapStatusActor;
  input: RoadmapStatusInput;
}

export type RoadmapStatusToolResult =
  | {
      result: "committed" | "duplicate";
      phaseId: string;
      revision: number;
      statusOutcome: NotesRoadmapStatusOutcome;
      proposals: ProjectNotesRoadmapProposalOutcome[];
    }
  | {
      result: "completion-review-committed" | "completion-review-duplicate";
      phaseId: string;
      revision: number;
      statusOutcome: NotesRoadmapStatusOutcome;
      proposals: ProjectNotesRoadmapProposalOutcome[];
      gateOutcome: NotesCompletionGateOutcome;
      unmetGateCodes: NotesCompletionUnmetGateCode[];
    }
  | {
      result:
        | "reviewer-not-authorized"
        | "reconciliation-in-progress"
        | "phase-not-bound"
        | "notes-missing"
        | "notes-corrupt"
        | "duplicate-id-conflict"
        | "stale-revision"
        | "phase-not-found"
        | "phase-archived"
        | "stale-session"
        | "invalid-reference"
        | "completion-checkpoint-blocked"
        | "invalid-review";
      phaseId: string;
      revision?: number;
      owner?: { operationId: string; kind: string } | null;
      path?: string;
      message?: string;
    };

export function createRoadmapStatusTool(
  actor: RoadmapStatusActor,
  record: (context: RoadmapStatusToolContext) => Promise<RoadmapStatusToolResult>,
): AgentTool<typeof RoadmapStatusParams> {
  return {
    name: "roadmap_status",
    description:
      "Append one bounded Roadmap progress, blocker, typed verification, final-review decision, and structured-reference report. " +
      "Report meaningful milestones promptly, one call at a time. Cite actual checks in evidence, " +
      "reuse IDs only when retrying the same report, and avoid repeating an unchanged report. " +
      "GG Coder may report verification but only Ken or Autopilot Ken may submit final_review; " +
      "the completion gate, not this tool text, decides Done and preserves user overrides.",
    parameters: RoadmapStatusParams,
    executionMode: "sequential",
    async execute(input) {
      return JSON.stringify(await record({ actor, input }));
    },
  };
}
