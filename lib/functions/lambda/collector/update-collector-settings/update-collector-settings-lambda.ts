import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { initTelemetryLogger } from '../../../../utils/telemetry-logger';
import {
  requireAuthenticatedUser,
} from '../../../../utils/collector-validation';

const COLLECTOR_SETTINGS_TABLE_NAME = process.env.COLLECTOR_SETTINGS_TABLE_NAME;
const IDEMPOTENCY_TABLE_NAME = process.env.IDEMPOTENCY_TABLE_NAME;
const AUDIT_TABLE_NAME = process.env.AUDIT_TABLE_NAME;
const FEATURE_FLAGS = process.env.FEATURE_FLAGS;
const RATE_LIMIT_PER_MINUTE = Number(process.env.RATE_LIMIT_PER_MINUTE || '10');
const MAX_SETTINGS_SECTION_BYTES = Number(process.env.MAX_SETTINGS_SECTION_BYTES || '20000');

interface UpdateCollectorSettingsInput {
  notifications?: any;
  notificationChannels?: any;
  privacy?: any;
  display?: any;
  shopping?: any;
}

interface AppSyncEvent {
  arguments?: {
    input: UpdateCollectorSettingsInput;
  };
  identity?: any;
  request?: {
    headers?: Record<string, string>;
  };
}

type FeatureFlags = {
  auditTrail: boolean;
  rateLimit: boolean;
  idempotency: boolean;
};

const parseFeatureFlags = (raw?: string | null): FeatureFlags => {
  const defaults: FeatureFlags = { auditTrail: true, rateLimit: true, idempotency: true };
  if (!raw) return defaults;
  const entries = raw.split(',').map((part) => part.trim()).filter(Boolean);
  const overrides: Partial<FeatureFlags> = {};
  for (const entry of entries) {
    const [key, value] = entry.split('=').map((part) => part.trim());
    if (!key) continue;
    const enabled = value === undefined ? true : value.toLowerCase() === 'true';
    if (key in defaults) {
      (overrides as Record<string, boolean>)[key] = enabled;
    }
  }
  return { ...defaults, ...overrides };
};

const getHeader = (headers: Record<string, string> | undefined, name: string): string | null => {
  if (!headers) return null;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return null;
};

const getIdempotencyId = (userId: string, action: string, key: string) => {
  return `${action}#${userId}#${key}`;
};

const getRateLimitId = (userId: string, action: string, window: string) => {
  return `rate#${action}#${userId}#${window}`;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return !!value && typeof value === 'object' && !Array.isArray(value);
};

const validateSettingsSection = (value: unknown): Record<string, unknown> => {
  if (!isPlainObject(value)) throw new Error('Invalid input format');
  const size = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (size > MAX_SETTINGS_SECTION_BYTES) throw new Error('Invalid input format');
  return value;
};

export const handler = async (event: AppSyncEvent) => {
  initTelemetryLogger(event, { domain: "collector-domain", service: "update-collector-settings" });

  if (!COLLECTOR_SETTINGS_TABLE_NAME) {
    console.error('COLLECTOR_SETTINGS_TABLE_NAME is not configured');
    throw new Error('Internal server error');
  }
  if (!IDEMPOTENCY_TABLE_NAME || !AUDIT_TABLE_NAME) {
    console.error('IDEMPOTENCY_TABLE_NAME or AUDIT_TABLE_NAME is not configured');
    throw new Error('Internal server error');
  }

  // Get authenticated user
  const userId = requireAuthenticatedUser(event);
  if (!userId) {
    console.error('User not authenticated');
    throw new Error('Not authenticated');
  }

  const input = event.arguments?.input;
  if (!input) {
    throw new Error('Invalid input');
  }

  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const featureFlags = parseFeatureFlags(FEATURE_FLAGS);
  const headers = event.request?.headers;
  const idempotencyKey = getHeader(headers, 'x-idempotency-key');

  if (featureFlags.rateLimit) {
    const window = new Date().toISOString().slice(0, 16);
    const rateId = getRateLimitId(userId, 'collector.update.settings', window);
    const rateResult = await client.send(
      new UpdateCommand({
        TableName: IDEMPOTENCY_TABLE_NAME,
        Key: { id: rateId },
        UpdateExpression: 'ADD #count :inc SET expires_at = :ttl',
        ExpressionAttributeNames: { '#count': 'count' },
        ExpressionAttributeValues: {
          ':inc': 1,
          ':ttl': Math.floor(Date.now() / 1000) + 90,
        },
        ReturnValues: 'UPDATED_NEW',
      })
    );

    const rateCount = Number(rateResult.Attributes?.count ?? 0);
    if (rateCount > RATE_LIMIT_PER_MINUTE) {
      throw new Error('Rate limit exceeded. Please try again shortly.');
    }
  }

  if (featureFlags.idempotency && idempotencyKey) {
    const idemId = getIdempotencyId(userId, 'collector.update.settings', idempotencyKey);
    const existing = await client.send(
      new GetCommand({
        TableName: IDEMPOTENCY_TABLE_NAME,
        Key: { id: idemId },
      })
    );
    if (existing.Item?.response) {
      return JSON.parse(existing.Item.response as string);
    }
  }

  try {
    // Build update expression dynamically
    const updateParts: string[] = [];
    const expressionAttributeNames: Record<string, string> = {};
    const expressionAttributeValues: Record<string, any> = {};

    let index = 0;

    if (input.notifications !== undefined) {
      const section = validateSettingsSection(input.notifications);
      updateParts.push(`notifications = :notifications`);
      expressionAttributeValues[':notifications'] = section;
    }
    if (input.notificationChannels !== undefined) {
      const section = validateSettingsSection(input.notificationChannels);
      updateParts.push(`notificationChannels = :notificationChannels`);
      expressionAttributeValues[':notificationChannels'] = section;
    }
    if (input.privacy !== undefined) {
      const section = validateSettingsSection(input.privacy);
      updateParts.push(`privacy = :privacy`);
      expressionAttributeValues[':privacy'] = section;
    }
    if (input.display !== undefined) {
      const section = validateSettingsSection(input.display);
      updateParts.push(`#display = :display`);
      expressionAttributeNames['#display'] = 'display';
      expressionAttributeValues[':display'] = section;
    }
    if (input.shopping !== undefined) {
      const section = validateSettingsSection(input.shopping);
      updateParts.push(`shopping = :shopping`);
      expressionAttributeValues[':shopping'] = section;
    }

    // Always update the updatedAt timestamp
    updateParts.push(`updatedAt = :updatedAt`);
    expressionAttributeValues[':updatedAt'] = new Date().toISOString();

    const updateExpression = `SET ${updateParts.join(', ')}`;

    const result = await client.send(
      new UpdateCommand({
        TableName: COLLECTOR_SETTINGS_TABLE_NAME,
        Key: { userId },
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: Object.keys(expressionAttributeNames).length > 0 ? expressionAttributeNames : undefined,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'ALL_NEW',
      }),
    );

    const response = result.Attributes;

    if (featureFlags.auditTrail && response) {
      const changedFields = Object.keys(input);
      await client.send(
        new PutCommand({
          TableName: AUDIT_TABLE_NAME,
          Item: {
            userId,
            eventKey: `${new Date().toISOString()}#collector.update.settings`,
            action: 'collector.update.settings',
            changedFields,
            createdAt: new Date().toISOString(),
            source: 'appsync',
            expires_at: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90,
          },
        })
      );
    }

    if (featureFlags.idempotency && idempotencyKey && response) {
      const idemId = getIdempotencyId(userId, 'collector.update.settings', idempotencyKey);
      await client.send(
        new PutCommand({
          TableName: IDEMPOTENCY_TABLE_NAME,
          Item: {
            id: idemId,
            response: JSON.stringify(response),
            createdAt: new Date().toISOString(),
            expires_at: Math.floor(Date.now() / 1000) + 60 * 15,
          },
          ConditionExpression: 'attribute_not_exists(id)',
        })
      );
    }
    return response;
  } catch (err) {
    console.error('updateCollectorSettings error:', err);
    throw new Error('Failed to update collector settings');
  }
};