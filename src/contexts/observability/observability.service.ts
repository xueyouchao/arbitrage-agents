import { redactSensitiveData, redactSensitiveText } from "../../config/redaction";

export interface CapturedObservabilityEvent {
  level: "error" | "info";
  message: string;
  metadata: Record<string, unknown>;
}

export interface ObservabilitySink {
  capture(event: CapturedObservabilityEvent): void | Promise<void>;
}

export class ObservabilityService {
  readonly capturedEvents: CapturedObservabilityEvent[] = [];

  constructor(private readonly sink?: ObservabilitySink) {}

  captureError(error: Error, metadata: Record<string, unknown> = {}): void {
    this.capture({ level: "error", message: error.message, metadata });
  }

  captureInfo(message: string, metadata: Record<string, unknown> = {}): void {
    this.capture({ level: "info", message, metadata });
  }

  private capture(event: CapturedObservabilityEvent): void {
    const redactedEvent = { ...event, message: redactSensitiveText(event.message), metadata: redactSensitiveData(event.metadata) };
    this.capturedEvents.push(redactedEvent);
    void Promise.resolve(this.sink?.capture(redactedEvent)).catch(() => undefined);
  }
}
