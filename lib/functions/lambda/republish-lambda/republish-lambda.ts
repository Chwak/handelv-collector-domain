import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand, QueryCommandInput } from "@aws-sdk/lib-dynamodb";
import { EventBridgeClient, PutEventsCommand, PutEventsRequestEntry } from "@aws-sdk/client-eventbridge";
import { GlueClient, GetSchemaVersionCommand } from "@aws-sdk/client-glue";
import * as crypto from "crypto";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { initTelemetryLogger } from "../../../utils/telemetry-logger";

const dynamoDb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const eventBridge = new EventBridgeClient({});
const glueClient = new GlueClient({});

const OUTBOX_TABLE_NAME = process.env.OUTBOX_TABLE_NAME || "";
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME || "";
const DOMAIN_NAME = process.env.DOMAIN_NAME || "";
const EVENT_SOURCE = process.env.EVENT_SOURCE || "";
const METRIC_NAMESPACE = process.env.METRIC_NAMESPACE || "";
const SCHEMA_REGISTRY_NAME = process.env.SCHEMA_REGISTRY_NAME || "";
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || "5", 10);
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "50", 10);
const PENDING_THRESHOLD_MINUTES = parseInt(process.env.PENDING_THRESHOLD_MINUTES || "2", 10);

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const schemaValidators = new Map<string, ValidateFunction>();

type TraceContext = {
  traceparent: string;
  trace_id: string;
  span_id: string;
};

interface OutboxEvent {
  eventId: string;
  status: string;
  createdAt: string;
  eventType: string;
  payload: string;
  retries: number;
  eventVersion?: number;
  correlationId?: string;
  traceparent?: string;
  trace_id?: string;
  span_id?: string;
}

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

function resolveTraceContext(outboxEvent: OutboxEvent): TraceContext {
  const parsed = outboxEvent.traceparent ? parseTraceparent(outboxEvent.traceparent) : null;
  const trace_id = outboxEvent.trace_id || parsed?.trace_id || generateTraceId();
  const span_id = outboxEvent.span_id || parsed?.span_id || generateSpanId();
  const traceparent = outboxEvent.traceparent || buildTraceparent(trace_id, span_id);
  return { traceparent, trace_id, span_id };
}

/**
 * Republish Lambda Handler - Transactional Outbox Pattern
 *
 * This Lambda is triggered every 10 minutes by EventBridge.
 * It implements the "Safety Net" for the Atomic Outbox pattern:
 * 1. Query GSI-StatusCreatedAt for PENDING events older than 2 minutes
 * 2. Send each event to EventBridge (PutEvents)
 * 3. Mark event as SENT in DynamoDB
 * 4. If retries exceed MAX, mark as FAILED (requires human intervention)
 * 5. DynamoDB TTL automatically deletes SENT events after 24 hours
 */
export const handler = async (...args: unknown[]): Promise<void> => {
  const event = args[0] as unknown;
  initTelemetryLogger(event, { domain: "collector-domain", service: "republish" });
  console.log("========== REPUBLISH LAMBDA START ==========");
  console.log(`Domain: ${DOMAIN_NAME}, EventBus: ${EVENT_BUS_NAME}`);

  if (!OUTBOX_TABLE_NAME || !EVENT_BUS_NAME || !DOMAIN_NAME) {
    console.error("Missing required environment variables");
    throw new Error("Internal server error");
  }
  if (!SCHEMA_REGISTRY_NAME) {
    console.error("SCHEMA_REGISTRY_NAME not set");
    throw new Error("Schema registry not configured");
  }

  try {
    // Calculate the threshold time: now - PENDING_THRESHOLD_MINUTES
    const thresholdTime = new Date(Date.now() - PENDING_THRESHOLD_MINUTES * 60 * 1000);
    const thresholdISO = thresholdTime.toISOString();

    console.log(`Querying for PENDING events older than ${thresholdISO}`);

    // Query GSI-StatusCreatedAt for PENDING events older than threshold
    const params: QueryCommandInput = {
      TableName: OUTBOX_TABLE_NAME,
      IndexName: "GSI-StatusCreatedAt",
      KeyConditionExpression: "#status = :pendingStatus AND #createdAt < :thresholdTime",
      ExpressionAttributeNames: {
        "#status": "status",
        "#createdAt": "createdAt",
      },
      ExpressionAttributeValues: {
        ":pendingStatus": "PENDING",
        ":thresholdTime": thresholdISO,
      },
      Limit: BATCH_SIZE,
    };

    const queryResult = await dynamoDb.send(new QueryCommand(params));
    const events = (queryResult.Items || []) as OutboxEvent[];

    console.log(`Found ${events.length} PENDING events to republish`);

    if (events.length === 0) {
      console.log("No PENDING events found. Exiting.");
      return;
    }

    // Prepare EventBridge PutEvents calls
    const putEventsRequests: PutEventsRequestEntry[] = [];
    const eventIds: string[] = [];

    for (const outboxEvent of events) {
      try {
        const payload = typeof outboxEvent.payload === "string" 
          ? JSON.parse(outboxEvent.payload) 
          : outboxEvent.payload;

        const traceContext = resolveTraceContext(outboxEvent);

        const eventDetail = {
          eventId: outboxEvent.eventId,
          eventType: outboxEvent.eventType,
          eventVersion: outboxEvent.eventVersion ?? 1,
          correlationId: outboxEvent.correlationId,
          payload,
          metadata: {
            traceparent: traceContext.traceparent,
            trace_id: traceContext.trace_id,
            span_id: traceContext.span_id,
          },
        };

        await validateEventDetail(outboxEvent.eventType, eventDetail);

        putEventsRequests.push({
          Source: EVENT_SOURCE,
          DetailType: outboxEvent.eventType,
          Detail: JSON.stringify(eventDetail),
          EventBusName: EVENT_BUS_NAME,
          TraceHeader: traceContext.traceparent,
        });

        eventIds.push(outboxEvent.eventId);
      } catch (err) {
        console.error(`Failed to prepare event for republish: ${outboxEvent.eventId}`, err);
        await incrementRetry(outboxEvent.eventId, 'PrepareFailed');
      }
    }

    // Send events to EventBridge in batches of 10 (AWS limit)
    const ebBatchSize = 10;
    let successCount = 0;
    let failureCount = 0;

    for (let i = 0; i < putEventsRequests.length; i += ebBatchSize) {
      const batch = putEventsRequests.slice(i, i + ebBatchSize);
      const correspondingEventIds = eventIds.slice(i, i + ebBatchSize);

      try {
        const ebResponse = await eventBridge.send(
          new PutEventsCommand({
            Entries: batch,
          })
        );

        console.log(`EventBridge PutEvents response: FailedEntryCount=${ebResponse.FailedEntryCount}`);

        // Update outbox table for successfully sent events
        for (let j = 0; j < correspondingEventIds.length; j++) {
          const eventId = correspondingEventIds[j];
          const failedEntry = ebResponse.Entries?.[j];

          if (!failedEntry || !failedEntry.ErrorCode) {
            // Success: mark as SENT
            await markEventAsSent(eventId);
            successCount++;
            console.log(`Event ${eventId} marked as SENT`);
          } else {
            // Failure: increment retry count
            await incrementRetry(eventId, failedEntry.ErrorCode || "Unknown");
            failureCount++;
            console.log(`Event ${eventId} retry incremented. Error: ${failedEntry.ErrorCode}`);
          }
        }
      } catch (err) {
        console.error(`Error sending batch to EventBridge`, err);
        failureCount += correspondingEventIds.length;
      }
    }

    console.log(`Republish complete. Success: ${successCount}, Failure: ${failureCount}`);
    console.log("========== REPUBLISH LAMBDA END ==========");
  } catch (err) {
    console.error("Fatal error in republish lambda", err);
    throw err;
  }
};

/**
 * Mark event as SENT in DynamoDB
 * This will trigger TTL cleanup after 24 hours
 */
async function markEventAsSent(eventId: string): Promise<void> {
  const expiresAt = Math.floor(Date.now() / 1000) + 24 * 60 * 60; // 24 hours

  await dynamoDb.send(new UpdateCommand({
    TableName: OUTBOX_TABLE_NAME,
    Key: { eventId },
    UpdateExpression: "SET #status = :sent, #expiresAt = :expiresAt",
    ExpressionAttributeNames: {
      "#status": "status",
      "#expiresAt": "expiresAt",
    },
    ExpressionAttributeValues: {
      ":sent": "SENT",
      ":expiresAt": expiresAt,
    },
  }));
}

/**
 * Increment retry count and potentially mark as FAILED if max retries exceeded
 */
async function incrementRetry(eventId: string, errorCode: string): Promise<void> {
  try {
    const expiresAt = Math.floor(Date.now() / 1000) + 24 * 60 * 60; // Keep 24h for investigation

    // Increment retry count; if it exceeds MAX, also mark as FAILED
    await dynamoDb.send(new UpdateCommand({
      TableName: OUTBOX_TABLE_NAME,
      Key: { eventId },
      UpdateExpression:
        "SET #retries = if_not_exists(#retries, :zero) + :one, #lastError = :error, #expiresAt = :expiresAt, #status = if(#retries >= :maxRetries, :failed, #status)",
      ExpressionAttributeNames: {
        "#retries": "retries",
        "#lastError": "lastError",
        "#expiresAt": "expiresAt",
        "#status": "status",
      },
      ExpressionAttributeValues: {
        ":zero": 0,
        ":one": 1,
        ":error": `${errorCode} at ${new Date().toISOString()}`,
        ":expiresAt": expiresAt,
        ":maxRetries": MAX_RETRIES,
        ":failed": "FAILED",
      },
    }));
  } catch (err) {
    console.error(`Failed to increment retry for ${eventId}`, err);
    // Don't throw; we want to continue processing other events
  }
}

async function getSchemaValidator(eventType: string): Promise<ValidateFunction> {
  const cached = schemaValidators.get(eventType);
  if (cached) return cached;

  const schemaVersion = await glueClient.send(
    new GetSchemaVersionCommand({
      SchemaId: {
        RegistryName: SCHEMA_REGISTRY_NAME,
        SchemaName: eventType,
      },
      SchemaVersionNumber: { LatestVersion: true },
    }),
  );

  if (!schemaVersion.SchemaDefinition) {
    throw new Error(`No schema definition found for ${eventType}`);
  }

  const schema = JSON.parse(schemaVersion.SchemaDefinition);
  const validate = ajv.compile(schema);
  schemaValidators.set(eventType, validate);
  return validate;
}

async function validateEventDetail(eventType: string, detail: unknown): Promise<void> {
  const validate = await getSchemaValidator(eventType);
  const valid = validate(detail);
  if (!valid) {
    const errors = validate.errors?.map((err: { instancePath?: string; message?: string }) => `${err.instancePath} ${err.message}`) || [];
    throw new Error(`Schema validation failed for ${eventType}: ${errors.join('; ')}`);
  }
}