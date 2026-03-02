import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { initTelemetryLogger } from '../../../../utils/telemetry-logger';
import {
  requireAuthenticatedUser,
} from '../../../../utils/collector-validation';

const PROFILES_TABLE_NAME = process.env.COLLECTOR_PROFILES_TABLE_NAME;
const IDEMPOTENCY_TABLE_NAME = process.env.IDEMPOTENCY_TABLE_NAME;
const AUDIT_TABLE_NAME = process.env.AUDIT_TABLE_NAME;
const FEATURE_FLAGS = process.env.FEATURE_FLAGS;
const RATE_LIMIT_PER_MINUTE = Number(process.env.RATE_LIMIT_PER_MINUTE || '10');

interface ShippingAddressInput {
  street?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
}

interface CollectorPreferencesInput {
  emailNotifications?: boolean | null;
  marketingEmails?: boolean | null;
  defaultSort?: string | null;
}

interface SizePreferencesInput {
  ringSize?: string | null;
  shirtSize?: string | null;
  shoeSize?: string | null;
  hatSize?: string | null;
  dressSize?: string | null;
  waistSize?: string | null;
  inseamLength?: string | null;
  materialAllergies?: string[] | null;
}

interface UpdateCollectorProfileArgs {
  userId?: unknown;
  defaultShippingAddress?: ShippingAddressInput | null;
  preferences?: CollectorPreferencesInput | null;
  displayName?: unknown;
  publicProfileEnabled?: unknown;
  sizePreferences?: SizePreferencesInput | null;
}

interface AppSyncEvent {
  arguments?: {
    input?: UpdateCollectorProfileArgs;
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

function validateShippingAddress(addr: ShippingAddressInput | null | undefined): ShippingAddressInput | null {
  if (!addr) return null;
  const { street, city, state, zip, country } = addr;
  if (!street || street.trim().length < 5 || street.trim().length > 200) {
    throw new Error('Invalid input format');
  }
  if (!city || city.trim().length < 2 || city.trim().length > 100) {
    throw new Error('Invalid input format');
  }
  if (!state || state.trim().length < 2 || state.trim().length > 100) {
    throw new Error('Invalid input format');
  }
  if (!zip || zip.trim().length < 3 || zip.trim().length > 20) {
    throw new Error('Invalid input format');
  }
  if (!country || country.trim().length !== 2 || country.toUpperCase() !== country) {
    throw new Error('Invalid input format');
  }
  return {
    street: street.trim(),
    city: city.trim(),
    state: state.trim(),
    zip: zip.trim(),
    country: country.trim(),
  };
}

function validatePreferences(prefs: CollectorPreferencesInput | null | undefined): CollectorPreferencesInput | null {
  if (!prefs) return null;
  const out: CollectorPreferencesInput = {};
  if (typeof prefs.emailNotifications === 'boolean') {
    out.emailNotifications = prefs.emailNotifications;
  }
  if (typeof prefs.marketingEmails === 'boolean') {
    out.marketingEmails = prefs.marketingEmails;
  }
  if (typeof prefs.defaultSort === 'string') {
    const v = prefs.defaultSort.trim();
    if (!v) {
      // ignore empty
    } else if (
      v === 'newest' ||
      v === 'oldest' ||
      v === 'price_low' ||
      v === 'price_high' ||
      v === 'relevance'
    ) {
      out.defaultSort = v;
    } else {
      throw new Error('Validation failed');
    }
  }
  return Object.keys(out).length ? out : null;
}

type SizePreferenceStringField = Exclude<keyof SizePreferencesInput, "materialAllergies">;

function validateSizePreferences(input: SizePreferencesInput | null | undefined): SizePreferencesInput | null {
  if (!input) return null;
  const out: SizePreferencesInput = {};
  const stringFields: SizePreferenceStringField[] = [
    'ringSize',
    'shirtSize',
    'shoeSize',
    'hatSize',
    'dressSize',
    'waistSize',
    'inseamLength',
  ];
  for (const field of stringFields) {
    const value = input[field];
    if (value == null) continue;
    if (typeof value !== 'string') throw new Error('Validation failed');
    const trimmed = value.trim();
    out[field] = trimmed ? trimmed : null;
  }
  if (input.materialAllergies != null) {
    if (!Array.isArray(input.materialAllergies)) throw new Error('Validation failed');
    const allergies = input.materialAllergies
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
    out.materialAllergies = allergies;
  }
  return Object.keys(out).length ? out : null;
}

export const handler = async (event: AppSyncEvent) => {
  initTelemetryLogger(event, { domain: "collector-domain", service: "update-collector-profile" });

  if (!PROFILES_TABLE_NAME) {
    console.error('Table names not configured');
    throw new Error('Internal server error');
  }
  if (!IDEMPOTENCY_TABLE_NAME || !AUDIT_TABLE_NAME) {
    console.error('IDEMPOTENCY_TABLE_NAME or AUDIT_TABLE_NAME is not configured');
    throw new Error('Internal server error');
  }

  const args = event.arguments || {};
  const input = (args.input || {}) as UpdateCollectorProfileArgs;

  const authUserId = requireAuthenticatedUser(event);
  if (!authUserId) {
    throw new Error('Not authenticated');
  }

  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const featureFlags = parseFeatureFlags(FEATURE_FLAGS);
  const headers = event.request?.headers;
  const idempotencyKey = getHeader(headers, 'x-idempotency-key');

  if (featureFlags.rateLimit) {
    const window = new Date().toISOString().slice(0, 16);
    const rateId = getRateLimitId(authUserId, 'collector.update.profile', window);
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
    const idemId = getIdempotencyId(authUserId, 'collector.update.profile', idempotencyKey);
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

  const address = validateShippingAddress(input.defaultShippingAddress ?? null);
  const prefs = validatePreferences(input.preferences ?? null);
  const sizePrefs = validateSizePreferences(input.sizePreferences ?? null);
  const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : null;
  const publicProfileEnabled = typeof input.publicProfileEnabled === 'boolean' ? input.publicProfileEnabled : null;

  if (!address && !prefs && !sizePrefs && displayName == null && publicProfileEnabled == null) {
    throw new Error('Validation failed');
  }

  try {
    // Build UpdateExpression dynamically
    const updateExpressions: string[] = [];
    const expressionAttrValues: Record<string, any> = {};
    const expressionAttrNames: Record<string, string> = {};

    if (address) {
      updateExpressions.push('#addr = :addr');
      expressionAttrNames['#addr'] = 'defaultShippingAddress';
      expressionAttrValues[':addr'] = address;
    }

    if (prefs) {
      updateExpressions.push('#prefs = :prefs');
      expressionAttrNames['#prefs'] = 'preferences';
      expressionAttrValues[':prefs'] = prefs;
    }

    if (sizePrefs) {
      updateExpressions.push('#sizePrefs = :sizePrefs');
      expressionAttrNames['#sizePrefs'] = 'sizePreferences';
      expressionAttrValues[':sizePrefs'] = sizePrefs;
    }

    if (displayName != null) {
      updateExpressions.push('#displayName = :displayName');
      expressionAttrNames['#displayName'] = 'displayName';
      expressionAttrValues[':displayName'] = displayName || null;
    }

    if (publicProfileEnabled != null) {
      updateExpressions.push('#publicProfileEnabled = :publicProfileEnabled');
      expressionAttrNames['#publicProfileEnabled'] = 'publicProfileEnabled';
      expressionAttrValues[':publicProfileEnabled'] = publicProfileEnabled;
    }

    updateExpressions.push('#updated = :now');
    expressionAttrNames['#updated'] = 'updatedAt';
    expressionAttrValues[':now'] = new Date().toISOString();

    // Update the profile
    const result = await client.send(
      new UpdateCommand({
        TableName: PROFILES_TABLE_NAME,
        Key: { userId: authUserId },
        UpdateExpression: 'SET ' + updateExpressions.join(', '),
        ExpressionAttributeNames: expressionAttrNames,
        ExpressionAttributeValues: expressionAttrValues,
        ReturnValues: 'ALL_NEW',
      })
    );

    const response = result.Attributes;

    if (featureFlags.auditTrail && response) {
      const changedFields = Object.keys(input).filter((key) => (input as Record<string, unknown>)[key] !== undefined);
      await client.send(
        new PutCommand({
          TableName: AUDIT_TABLE_NAME,
          Item: {
            userId: authUserId,
            eventKey: `${new Date().toISOString()}#collector.update.profile`,
            action: 'collector.update.profile',
            changedFields,
            createdAt: new Date().toISOString(),
            source: 'appsync',
            expires_at: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90,
          },
        })
      );
    }

    if (featureFlags.idempotency && idempotencyKey && response) {
      const idemId = getIdempotencyId(authUserId, 'collector.update.profile', idempotencyKey);
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
    console.error('updateCollectorProfile error:', err);
    throw new Error('Failed to update collector profile');
  }
};