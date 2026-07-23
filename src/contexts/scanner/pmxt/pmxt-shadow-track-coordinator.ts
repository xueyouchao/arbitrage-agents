/**
 * Thrown when a track is excluded (e.g. scope_unproven) so the coordinator
 * can report it as "excluded" rather than "completed" or "failed".
 */
export class ExcludedTrackError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ExcludedTrackError";
  }
}

export type PmxtShadowTrackMode = "reads-only" | "router-only" | "both";

export interface PmxtShadowTrackCoordinatorDeps {
  runReadsTrack(): Promise<void>;
  runRouterTrack(): Promise<void>;
}

export interface PmxtShadowTrackCoordinatorInput {
  authoritativeScanRunId: string;
  shadowRunId: string;
  shadowRunAttemptId: string;
  mode: PmxtShadowTrackMode;
}

type TrackResult =
  | { status: "completed" }
  | { status: "excluded"; reason: string }
  | { status: "failed"; reason: string }
  | { status: "not_requested" };

export interface PmxtShadowTrackCoordinatorResult {
  mode: PmxtShadowTrackMode;
  tracks: {
    reads: TrackResult;
    router: TrackResult;
  };
}

export class PmxtShadowTrackCoordinator {
  constructor(private readonly deps: PmxtShadowTrackCoordinatorDeps) {}

  async run(input: PmxtShadowTrackCoordinatorInput): Promise<PmxtShadowTrackCoordinatorResult> {
    const runReads = input.mode === "reads-only" || input.mode === "both";
    const runRouter = input.mode === "router-only" || input.mode === "both";
    const [reads, router] = await Promise.all([
      runReads ? settle(this.deps.runReadsTrack) : Promise.resolve({ status: "not_requested" } as const),
      runRouter ? settle(this.deps.runRouterTrack) : Promise.resolve({ status: "not_requested" } as const),
    ]);
    return { mode: input.mode, tracks: { reads, router } };
  }
}

async function settle(action: () => Promise<void>): Promise<TrackResult> {
  try {
    await action();
    return { status: "completed" };
  } catch (error) {
    if (error instanceof ExcludedTrackError) {
      return { status: "excluded", reason: error.message };
    }
    return {
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
