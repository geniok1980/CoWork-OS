import type { LLMMessage } from "../llm/types";

export type TurnKernelMode = "step" | "follow_up";

export interface TurnKernelInput {
  mode: TurnKernelMode;
  messages: LLMMessage[];
  maxIterations: number;
  maxEmptyResponses: number;
}

export interface TurnKernelIterationState {
  mode: TurnKernelMode;
  messages: LLMMessage[];
  iterationCount: number;
  emptyResponseCount: number;
  continueLoop: boolean;
}

export interface TurnKernelPreparedResponse {
  response: Any;
  availableTools: Any[];
}

export interface TurnKernelRecoveredResponse {
  recovered: true;
  messages: LLMMessage[];
}

export interface TurnKernelStoppedResponse {
  stopped: true;
  messages: LLMMessage[];
  stopReason?: string;
}

export interface TurnKernelDecision {
  continueLoop?: boolean;
  emptyResponseCount?: number;
  repeatIteration?: boolean;
  stopReason?: string;
}

export interface TurnKernelPolicy {
  shouldStopBeforeIteration?: (
    state: TurnKernelIterationState,
  ) => { stop: boolean; reason?: string } | void;
  drainPendingMessages?: (state: TurnKernelIterationState) => Promise<void> | void;
  beforeIteration?: (state: TurnKernelIterationState) => Promise<void> | void;
  requestResponse: (
    state: TurnKernelIterationState,
  ) => Promise<TurnKernelPreparedResponse | TurnKernelRecoveredResponse | TurnKernelStoppedResponse>;
  handleResponse: (
    prepared: TurnKernelPreparedResponse,
    state: TurnKernelIterationState,
  ) => Promise<TurnKernelDecision | void> | TurnKernelDecision | void;
  afterIteration?: (state: TurnKernelIterationState) => Promise<void> | void;
}

export interface TurnKernelOutcome {
  messages: LLMMessage[];
  iterations: number;
  emptyResponseCount: number;
  stopReason?: string;
}

export class TurnKernel {
  constructor(
    private readonly input: TurnKernelInput,
    private readonly policy: TurnKernelPolicy,
  ) {}

  async run(): Promise<TurnKernelOutcome> {
    const state: TurnKernelIterationState = {
      mode: this.input.mode,
      messages: this.input.messages,
      iterationCount: 0,
      emptyResponseCount: 0,
      continueLoop: true,
    };
    let stopReason: string | undefined;

    while (state.continueLoop && state.iterationCount < this.input.maxIterations) {
      const stopBeforeIteration = this.policy.shouldStopBeforeIteration?.(state);
      if (stopBeforeIteration?.stop) {
        stopReason = stopBeforeIteration.reason;
        break;
      }

      await this.policy.drainPendingMessages?.(state);

      if (state.emptyResponseCount >= this.input.maxEmptyResponses) {
        stopReason = "max_empty_responses";
        break;
      }

      state.iterationCount += 1;
      await this.policy.beforeIteration?.(state);

      const prepared = await this.policy.requestResponse(state);
      if (isTurnKernelStoppedResponse(prepared)) {
        state.messages = prepared.messages;
        stopReason = prepared.stopReason;
        break;
      }
      if (isTurnKernelRecoveredResponse(prepared)) {
        state.messages = prepared.messages;
        state.iterationCount -= 1;
        continue;
      }

      const decision = (await this.policy.handleResponse(prepared, state)) || {};
      if (Array.isArray(state.messages) !== true) {
        state.messages = this.input.messages;
      }
      if (
        typeof decision.emptyResponseCount === "number" &&
        Number.isFinite(decision.emptyResponseCount)
      ) {
        state.emptyResponseCount = decision.emptyResponseCount;
      }
      if (typeof decision.continueLoop === "boolean") {
        state.continueLoop = decision.continueLoop;
      }
      if (decision.stopReason) {
        stopReason = decision.stopReason;
      }
      if (decision.repeatIteration) {
        state.iterationCount -= 1;
      }

      await this.policy.afterIteration?.(state);
    }

    return {
      messages: state.messages,
      iterations: state.iterationCount,
      emptyResponseCount: state.emptyResponseCount,
      stopReason,
    };
  }
}

function isTurnKernelRecoveredResponse(
  prepared:
    | TurnKernelPreparedResponse
    | TurnKernelRecoveredResponse
    | TurnKernelStoppedResponse,
): prepared is TurnKernelRecoveredResponse {
  return "recovered" in prepared && prepared.recovered === true;
}

function isTurnKernelStoppedResponse(
  prepared:
    | TurnKernelPreparedResponse
    | TurnKernelRecoveredResponse
    | TurnKernelStoppedResponse,
): prepared is TurnKernelStoppedResponse {
  return "stopped" in prepared && prepared.stopped === true;
}
