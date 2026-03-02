import * as crypto from "crypto";

type TraceContext = {
  traceparent: string;
  trace_id: string;
  span_id: string;
};

type LoggerConfig = {
  domain: string;
  service: string;
};

const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

let initialized = false;
let context: TraceContext & LoggerConfig = {
  traceparent: "",
  trace_id: "",
  span_id: "",
  domain: "",
  service: "",
};

function generateTraceId(): string {
  return crypto.randomBytes(16).toString("hex");
}

function generateSpanId(): string {
  return crypto.randomBytes(8).toString("hex");
}

function buildTraceparent(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
}

function parseTraceparent(traceparent: string): { trace_id: string; span_id: string } | null {
  const match = /^\d{2}-([0-9a-f]{32})-([0-9a-f]{16})-\d{2}$/i.exec(traceparent);
  if (!match) return null;
  return { trace_id: match[1], span_id: match[2] };
}

function resolveTraceContext(traceparent?: string, input?: Partial<TraceContext>): TraceContext {
  const parsed = traceparent ? parseTraceparent(traceparent) : null;
  const trace_id = input?.trace_id || parsed?.trace_id || generateTraceId();
  const span_id = input?.span_id || parsed?.span_id || generateSpanId();
  return { traceparent: traceparent || buildTraceparent(trace_id, span_id), trace_id, span_id };
}

function extractTraceparent(event: unknown): { traceparent?: string; traceContext?: Partial<TraceContext> } {
  if (!event || typeof event != "object") return {};
  const any_event = event as {
    headers?: Record<string, string | undefined>;
    detail?: { metadata?: { traceparent?: string; trace_id?: string; span_id?: string } };
    Records?: Array<{
      messageAttributes?: Record<string, { stringValue?: string } | undefined>;
      body?: string;
    }>;
  };

  const header_trace = any_event.headers?.traceparent || any_event.headers?.Traceparent;
  if (header_trace) return { traceparent: header_trace };

  const detail_trace = any_event.detail?.metadata?.traceparent;
  if (detail_trace) {
    return { 
      traceparent: detail_trace, 
      traceContext: {
        traceparent: any_event.detail?.metadata?.traceparent,
        trace_id: any_event.detail?.metadata?.trace_id,
        span_id: any_event.detail?.metadata?.span_id
      }
    };
  }

  const record = any_event.Records?.[0];
  const attr_trace = record?.messageAttributes?.traceparent?.stringValue;
  if (attr_trace) return { traceparent: attr_trace };

  const body = record?.body;
  if (body) {
    try {
      const parsed = JSON.parse(body) as {
        MessageAttributes?: Record<string, { Value?: string } | undefined>;
        Message?: string;
        detail?: { metadata?: { traceparent?: string; trace_id?: string; span_id?: string } };
      };
      const body_trace = parsed.MessageAttributes?.traceparent?.Value;
      if (body_trace) return { traceparent: body_trace };
      const detail_trace_body = parsed.detail?.metadata?.traceparent;
      if (detail_trace_body) return { 
        traceparent: detail_trace_body, 
        traceContext: {
          traceparent: parsed.detail?.metadata?.traceparent,
          trace_id: parsed.detail?.metadata?.trace_id,
          span_id: parsed.detail?.metadata?.span_id
        }
      };
      if (parsed.Message) {
        const inner = JSON.parse(parsed.Message) as { detail?: { metadata?: { traceparent?: string; trace_id?: string; span_id?: string } } };
        const inner_trace = inner.detail?.metadata?.traceparent;
        if (inner_trace) return { 
          traceparent: inner_trace, 
          traceContext: {
            traceparent: inner.detail?.metadata?.traceparent,
            trace_id: inner.detail?.metadata?.trace_id,
            span_id: inner.detail?.metadata?.span_id
          }
        };
      }
    } catch {
      return {};
    }
  }

  return {};
}

function emit(level: string, args: unknown[]): void {
  const [first, ...rest] = args;
  const message = typeof first == "string" ? first : "log";
  const payload: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    message,
    domain: context.domain,
    service: context.service,
    trace_id: context.trace_id,
    span_id: context.span_id,
    traceparent: context.traceparent,
  };
  if (rest.length > 0) {
    payload.data = rest.length == 1 ? rest[0] : rest;
  } else if (typeof first == "object" && first != null) {
    payload.data = first;
  }
  originalConsole.log(JSON.stringify(payload));
}

export function initTelemetryLogger(event: unknown, config: LoggerConfig): void {
  if (initialized) return;
  const extracted = extractTraceparent(event);
  const traceContext = resolveTraceContext(extracted.traceparent, extracted.traceContext);
  context = {
    ...traceContext,
    domain: config.domain,
    service: config.service,
  };
  console.log = (...args: unknown[]) => emit("INFO", args);
  console.info = (...args: unknown[]) => emit("INFO", args);
  console.warn = (...args: unknown[]) => emit("WARN", args);
  console.error = (...args: unknown[]) => emit("ERROR", args);
  initialized = true;
}
