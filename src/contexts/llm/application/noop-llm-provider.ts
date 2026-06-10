import { LlmProvider } from "./persisted-llm-gateway";

export const noopLlmProvider: LlmProvider = async (request) => {
  throw new Error(`No LLM provider configured for ${request.taskType}`);
};
