import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GlueClient, GetSchemaVersionCommand } from '@aws-sdk/client-glue';
import { DynamoDBDocumentClient, GetCommand, PutCommand, TransactWriteCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import * as crypto from 'crypto';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { initTelemetryLogger } from "../../../../utils/telemetry-logger";

const COLLECTOR_PROFILES_TABLE_NAME = process.env.COLLECTOR_PROFILES_TABLE_NAME || '';
const COLLECTOR_SETTINGS_TABLE_NAME = process.env.COLLECTOR_SETTINGS_TABLE_NAME || '';
const IDEMPOTENCY_TABLE_NAME = process.env.IDEMPOTENCY_TABLE_NAME || '';
const OUTBOX_TABLE_NAME = process.env.OUTBOX_TABLE_NAME || '';
const SCHEMA_REGISTRY_NAME = process.env.SCHEMA_REGISTRY_NAME || '';
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

const glueClient = new GlueClient({});
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const schemaValidators = new Map<string, ValidateFunction>();

interface SqsRecord {
  body?: string;
  messageId?: string;
  messageAttributes?: Record<string, { stringValue?: string } | undefined>;
}

interface SnsMessage {
  Message?: string;
}

interface EventBridgeEnvelope {
  detail?: {
    eventId?: string;
    correlationId?: string;
    eventType?: string;
    eventVersion?: number;
    payload?: string | UserRegistrationPayload;
    metadata?: {
      traceparent?: string;
      trace_id?: string;
      span_id?: string;
    };
  };
}

interface UserRegistrationPayload {
  event?: string;
  userId?: string;
  email?: string;
  verifiedAt?: string;
  makerEnabled?: boolean;
  collectorEnabled?: boolean;
  name?: string;
  givenName?: string;
  familyName?: string;
  phoneNumber?: string;
  username?: string;
}

type TraceContext = {
  traceparent: string;
  trace_id: string;
  span_id: string;
};

function generateTraceId(): string {
  return crypto.randomBytes(16).toString('hex');
}

function generateSpanId(): string {
  return crypto.randomBytes(8).toString('hex');
}

function buildTraceparent(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
}

function parseTraceparent(traceparent: string): { trace_id: string; span_id: string } | null {
  const match = /^\d{2}-([0-9a-f]{32})-([0-9a-f]{16})-\d{2}$/i.exec(traceparent);
  if (!match) return null;
  return { trace_id: match[1], span_id: match[2] };
}

function resolveTraceContext(traceparent?: string): TraceContext {
  const parsed = traceparent ? parseTraceparent(traceparent) : null;
  const trace_id = parsed?.trace_id || generateTraceId();
  const span_id = parsed?.span_id || generateSpanId();
  return { traceparent: traceparent || buildTraceparent(trace_id, span_id), trace_id, span_id };
}

export const handler = async (
  event: { Records?: SqsRecord[] }
): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> => {
  initTelemetryLogger(event, { domain: "collector-domain", service: "new-collector-from-auth" });
  console.log('========== NEW COLLECTOR FROM AUTH LAMBDA START ==========');

  if (!COLLECTOR_PROFILES_TABLE_NAME) {
    console.error('COLLECTOR_PROFILES_TABLE_NAME not set');
    throw new Error('Internal server error');
  }

  if (!COLLECTOR_SETTINGS_TABLE_NAME) {
    console.error('COLLECTOR_SETTINGS_TABLE_NAME not set');
    throw new Error('Internal server error');
  }

  if (!IDEMPOTENCY_TABLE_NAME) {
    console.error('IDEMPOTENCY_TABLE_NAME not set');
    throw new Error('Internal server error');
  }
  if (!SCHEMA_REGISTRY_NAME) {
    console.error('SCHEMA_REGISTRY_NAME not set');
    throw new Error('Schema registry not configured');
  }

  const recordCount = event.Records?.length ?? 0;
  console.log('New collector from auth invoked', { recordCount });

  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  const batchItemFailures: Array<{ itemIdentifier: string }> = [];

  for (const record of event.Records || []) {
    const recordId = record.messageId || 'unknown';
    try {
    console.log('---------- Processing Record ----------');

    const body = record.body;
    
    if (!body) {
      console.log('No body found in record, skipping');
      continue;
    }

    let payload: UserRegistrationPayload;
    let eventId: string | undefined;
    let traceparent: string | undefined;
    try {
      const parsed = JSON.parse(body) as SnsMessage & UserRegistrationPayload & EventBridgeEnvelope;
      const message = parsed.Message;
      
      if (message && typeof message === 'string') {
        payload = JSON.parse(message) as UserRegistrationPayload;
        const bodyTraceparent = (parsed as { MessageAttributes?: Record<string, { Value?: string } | undefined> })
          .MessageAttributes?.traceparent?.Value;
        traceparent = traceparent || record.messageAttributes?.traceparent?.stringValue || bodyTraceparent;
      } else if (parsed.detail && typeof parsed.detail === 'object') {
        if (parsed.detail.eventType) {
          await validateEventDetail(parsed.detail.eventType, parsed.detail);
        }
        const detailPayload = parsed.detail.payload;
        if (typeof detailPayload === 'string') {
          payload = JSON.parse(detailPayload) as UserRegistrationPayload;
        } else if (detailPayload && typeof detailPayload === 'object') {
          payload = detailPayload as UserRegistrationPayload;
        } else if (parsed.userId && typeof parsed.userId === 'string') {
          payload = parsed as UserRegistrationPayload;
        } else {
          throw new Error('Invalid EventBridge detail payload');
        }
        eventId = parsed.detail.eventId || parsed.detail.correlationId;
        traceparent = traceparent || parsed.detail.metadata?.traceparent;
      } else if (parsed.userId && typeof parsed.userId === 'string') {
        payload = parsed as UserRegistrationPayload;
      } else {
        console.error('SNS Message missing in SQS body; throwing so message goes to DLQ');
        throw new Error('Invalid message: SNS Message missing');
      }
    } catch (e) {
      console.error('Failed to parse SQS/SNS message body; throwing so message goes to DLQ', { err: e });
      throw e;
    }

    const userId = payload.userId && typeof payload.userId === 'string' ? payload.userId.trim() : null;
    const email = payload.email && typeof payload.email === 'string' ? payload.email.trim() : null;
    const verifiedAt = payload.verifiedAt && typeof payload.verifiedAt === 'string' ? payload.verifiedAt : null;
    const name = payload.name && typeof payload.name === 'string' ? payload.name.trim() : null;
    const givenName = payload.givenName && typeof payload.givenName === 'string' ? payload.givenName.trim() : null;
    const familyName = payload.familyName && typeof payload.familyName === 'string' ? payload.familyName.trim() : null;
    const phoneNumber = payload.phoneNumber && typeof payload.phoneNumber === 'string' ? payload.phoneNumber.trim() : null;
    const username = payload.username && typeof payload.username === 'string' ? payload.username.trim() : null;

    const parsedTrace = traceparent ? parseTraceparent(traceparent) : null;
    const traceContext = resolveTraceContext(traceparent);
    
    if (!userId) {
      console.error('Missing userId in payload; throwing so message goes to DLQ', { payload });
      throw new Error('Invalid payload: userId required');
    }

    // For UserModeEnabled events, we don't have email; for UserRegistrationComplete, we require it
    const isUserModeEnabledEvent = payload.event === 'UserModeEnabled';
    if (!isUserModeEnabledEvent && !email) {
      console.error('Missing email in payload for non-mode-enabled event; throwing so message goes to DLQ', { payload });
      throw new Error('Invalid payload: email required for registration events');
    }

    const idempotencyKey = eventId || parsedTrace?.trace_id || `${userId}:${payload.event || 'UserRegistrationComplete'}`;
    if (!(await acquireIdempotencyLock(client, idempotencyKey))) {
      console.log('Duplicate event detected; skipping', { idempotencyKey, userId });
      continue;
    }

    // Check if a profile with this email already exists (prevent duplicate emails)
    const finalEmail = email || `user+${userId}@mode-enabled.local`;
    const existingProfileByEmail = email ? await checkEmailExists(client, finalEmail) : null;
    if (existingProfileByEmail && existingProfileByEmail.userId !== userId) {
      console.log('Profile with this email already exists; skipping to prevent duplicate', {
        existingUserId: existingProfileByEmail.userId,
        newUserId: userId,
      });
      await markIdempotencyComplete(client, idempotencyKey);
      continue;
    }

    const existingProfileByUserId = await getProfileByUserId(client, userId);
    const now = new Date().toISOString();
    if (existingProfileByUserId) {
      if (email) {
        const isPlaceholderEmail = !existingProfileByUserId.email || existingProfileByUserId.email.endsWith('@mode-enabled.local');
        if (existingProfileByUserId.email && existingProfileByUserId.email !== email && !isPlaceholderEmail) {
          console.warn('Existing profile has a different email; skipping update', {
            userId,
            existingEmail: existingProfileByUserId.email,
            incomingEmail: email,
          });
          await markIdempotencyComplete(client, idempotencyKey);
          continue;
        }

        const updateExpressions: string[] = [];
        const expressionValues: Record<string, unknown> = {
          ':updatedAt': now,
        };

        if (isPlaceholderEmail && existingProfileByUserId.email !== email) {
          updateExpressions.push('email = :email');
          expressionValues[':email'] = email;
        }

        if (verifiedAt && existingProfileByUserId.emailVerified !== true) {
          updateExpressions.push('emailVerified = :emailVerified');
          updateExpressions.push('emailVerifiedAt = :emailVerifiedAt');
          expressionValues[':emailVerified'] = true;
          expressionValues[':emailVerifiedAt'] = verifiedAt;
        }

        if (name && !existingProfileByUserId.fullName) {
          updateExpressions.push('fullName = :fullName');
          expressionValues[':fullName'] = name;
        }

        if (givenName && !existingProfileByUserId.givenName) {
          updateExpressions.push('givenName = :givenName');
          expressionValues[':givenName'] = givenName;
        }

        if (familyName && !existingProfileByUserId.familyName) {
          updateExpressions.push('familyName = :familyName');
          expressionValues[':familyName'] = familyName;
        }

        if (phoneNumber && !existingProfileByUserId.phoneNumber) {
          updateExpressions.push('phoneNumber = :phoneNumber');
          expressionValues[':phoneNumber'] = phoneNumber;
        }

        if (username && !existingProfileByUserId.username) {
          updateExpressions.push('username = :username');
          expressionValues[':username'] = username;
        }

        const inferredDisplayName = username || name || null;
        if (inferredDisplayName && !existingProfileByUserId.displayName) {
          updateExpressions.push('displayName = :displayName');
          expressionValues[':displayName'] = inferredDisplayName;
        }

        if (updateExpressions.length > 0) {
          updateExpressions.push('updatedAt = :updatedAt');
          await client.send(
            new UpdateCommand({
              TableName: COLLECTOR_PROFILES_TABLE_NAME,
              Key: { userId },
              UpdateExpression: `SET ${updateExpressions.join(', ')}`,
              ExpressionAttributeValues: expressionValues,
            }),
          );
          console.log('Updated existing collector profile from auth data', { userId });
        }
      }

      await markIdempotencyComplete(client, idempotencyKey);
      continue;
    }

    console.log('Creating collector profile and settings', { userId, event: payload.event });

    // For mode-enabled events, use userId@mode-enabled as a placeholder email
    // The actual email should already exist on the user from their UserRegistrationComplete event

    const collectorProfileData = {
      // Primary Key
      userId,
      
      // Identity (from auth)
      email: finalEmail,
      username: username || null,
      fullName: name || null,
      givenName: givenName || null,
      familyName: familyName || null,
      phoneNumber: phoneNumber || null,
      publicProfileEnabled: true,
      phoneVerified: false,
      phoneVerifiedAt: null,
      
      // Verification
      emailVerified: !!verifiedAt,
      emailVerifiedAt: verifiedAt || null,

      // Media
      profileImageStatus: null,
      profileImageUpdatedAt: null,
      
      // Collector-specific fields
      displayName: username || name || null,
      profileImageUrl: null,
      bio: null,
      location: null,
      
      // Preferences
      favoriteCategories: [],
      notificationPreferences: {
        newShelfItems: true,
        priceDrops: true,
        orderUpdates: true,
        makerMessages: true,
      },

      // Account status
      onboardingComplete: false,
      lastLoginAt: null,
      marketingOptInAt: null,
      termsAcceptedAt: null,
      privacyPolicyAcceptedAt: null,
      
      // Shopping stats
      totalOrders: 0,
      totalSpent: 0,
      
      // Collections and favorites
      favoriteShelfItems: [],
      favoriteMakers: [],
      
      // Status flags
      isActive: true,
      isSuspended: false,
      suspendedReason: null,

      // Size preferences
      sizePreferences: {
        ringSize: null,
        shirtSize: null,
        shoeSize: null,
        hatSize: null,
        dressSize: null,
        waistSize: null,
        inseamLength: null,
        materialAllergies: [],
      },
      
      // Payment methods
      defaultPaymentMethodId: null,
      savedPaymentMethods: [],
      
      // Shipping addresses
      defaultShippingAddressId: null,
      savedShippingAddresses: [],
      
      // Timestamps
      createdAt: now,
      updatedAt: now,
    };

    // Default settings for new collectors (see DEFAULT_SETTINGS_SPEC.md)
    const collectorSettingsData = {
      userId,
      
      // Notification preferences
      notifications: {
        orderConfirmation: true,
        orderShipped: true,
        orderDelivered: true,
        newShelfItemsFromFavoriteMakers: true,
        priceDrops: true,
        backInStock: true,
        makerMessages: true,
        customOrderUpdates: true,
        weeklyNewsletter: false,
        promotionalOffers: false,
        accountSecurity: true,
        policyUpdates: true,
      },
      notificationChannels: {
        orderConfirmation: { email: true, push: true, sms: false },
        orderShipped: { email: true, push: true, sms: false },
        orderDelivered: { email: true, push: true, sms: false },
        newShelfItemsFromFavoriteMakers: { email: true, push: true, sms: false },
        priceDrops: { email: true, push: true, sms: false },
        backInStock: { email: true, push: true, sms: false },
        makerMessages: { email: true, push: true, sms: false },
        customOrderUpdates: { email: true, push: true, sms: false },
        weeklyNewsletter: { email: true, push: false, sms: false },
        promotionalOffers: { email: true, push: false, sms: false },
        accountSecurity: { email: true, push: true, sms: false },
        policyUpdates: { email: true, push: true, sms: false },
      },
      
      // Privacy settings
      privacy: {
        showProfilePublicly: true,
        showPurchaseHistory: false,
        showCollections: true,
        showWishlist: false,
        allowMakerContact: true,
        allowMessagesFromFollowedMakersOnly: false,
        allowMessagesAfterPurchaseOnly: false,
        allowMessagesFromVerifiedMakersOnly: false,
        blockedUserIds: [],
      },
      
      // Display preferences
      display: {
        language: 'en',
        currency: 'USD',
        measurementSystem: 'imperial',
        timezone: 'America/New_York',
        dateFormat: 'MM/DD/YYYY',
        timeFormat: '12h',
      },
      
      // Shopping preferences
      shopping: {
        defaultShippingAddressId: null,
        defaultPaymentMethodId: null,
        autoApplyCoupons: true,
        saveCardForFutureUse: false,
        autoGroupByMaker: false,
        defaultCollection: null,
        autoFollowOnPurchase: false,
        collectionPrivacyDefault: 'private',
      },
      
      // Timestamps
      createdAt: now,
      updatedAt: now,
    };
    
    // Prepare outbox event for collector profile creation
    const outboxEventId = randomUUID();
    const outboxPayload = {
      event: 'CollectorProfileCreated',
      userId,
      email,
      displayName: collectorProfileData.displayName,
      createdAt: now,
    };
    const expiresAtEpoch = Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60); // ✅ CRITICAL FIX: 7 days TTL (was 24h)
    
    try {
      // Create profile, settings, and outbox event atomically
      await client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: COLLECTOR_PROFILES_TABLE_NAME,
              Item: collectorProfileData,
              ConditionExpression: 'attribute_not_exists(userId)',
            },
          },
          {
            Put: {
              TableName: COLLECTOR_SETTINGS_TABLE_NAME,
              Item: collectorSettingsData,
              ConditionExpression: 'attribute_not_exists(userId)',
            },
          },
          {
            Put: {
              TableName: OUTBOX_TABLE_NAME,
              Item: {
                eventId: outboxEventId,
                eventType: 'collector.profile.created.v1',
                eventVersion: 1,
                eventSource: 'hand-made.collector-domain',
                payload: JSON.stringify(outboxPayload),
                correlationId: eventId || idempotencyKey,
                traceparent: traceContext.traceparent,
                trace_id: traceContext.trace_id,
                span_id: traceContext.span_id,
                status: 'PENDING',
                createdAt: now,
                expiresAt: expiresAtEpoch,
                retryCount: 0,
              },
            },
          },
        ],
      }));
      await markIdempotencyComplete(client, idempotencyKey);
      console.log('Collector profile and settings created successfully', { userId, emailVerified: collectorProfileData.emailVerified });
    } catch (e: unknown) {
      if (e && typeof e === 'object' && 'name' in e && (e as { name: string }).name === 'TransactionCanceledException') {
        console.log('Collector profile or settings already exist, skipping', { userId });
        await markIdempotencyComplete(client, idempotencyKey);
        continue;
      }
      console.error('Failed to create collector profile and settings for userId:', userId, e);
      throw e;
    }
    } catch (err) {
      console.error('Failed to process record', { recordId, err });
      if (record.messageId) {
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
  }

  return { batchItemFailures };
};

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

async function checkEmailExists(
  db: DynamoDBDocumentClient,
  email: string,
): Promise<{ userId: string } | null> {
  try {
    const result = await db.send(
      new QueryCommand({
        TableName: COLLECTOR_PROFILES_TABLE_NAME,
        IndexName: 'GSI2-Email',
        KeyConditionExpression: 'email = :email',
        ExpressionAttributeValues: {
          ':email': email,
        },
        Limit: 1,
        ProjectionExpression: 'userId',
      }),
    );
    if (result.Items && result.Items.length > 0) {
      return { userId: result.Items[0].userId as string };
    }
    return null;
  } catch (err) {
    console.error('Error checking email existence:', err);
    throw err;
  }
}

async function getProfileByUserId(
  db: DynamoDBDocumentClient,
  userId: string,
): Promise<{
  email?: string;
  emailVerified?: boolean;
  username?: string | null;
  fullName?: string | null;
  givenName?: string | null;
  familyName?: string | null;
  phoneNumber?: string | null;
  displayName?: string | null;
} | null> {
  try {
    const result = await db.send(
      new GetCommand({
        TableName: COLLECTOR_PROFILES_TABLE_NAME,
        Key: { userId },
        ProjectionExpression: 'email, emailVerified, username, fullName, givenName, familyName, phoneNumber, displayName',
      }),
    );
    if (result.Item) {
      return {
        email: result.Item.email as string | undefined,
        emailVerified: result.Item.emailVerified as boolean | undefined,
        username: (result.Item.username as string | null | undefined) ?? null,
        fullName: (result.Item.fullName as string | null | undefined) ?? null,
        givenName: (result.Item.givenName as string | null | undefined) ?? null,
        familyName: (result.Item.familyName as string | null | undefined) ?? null,
        phoneNumber: (result.Item.phoneNumber as string | null | undefined) ?? null,
        displayName: (result.Item.displayName as string | null | undefined) ?? null,
      };
    }
    return null;
  } catch (err) {
    console.error('Error checking userId existence:', err);
    throw err;
  }
}

async function acquireIdempotencyLock(
  db: DynamoDBDocumentClient,
  idempotencyKey: string,
): Promise<boolean> {
  const expiresAt = Math.floor(Date.now() / 1000) + IDEMPOTENCY_TTL_SECONDS;
  try {
    await db.send(
      new PutCommand({
        TableName: IDEMPOTENCY_TABLE_NAME,
        Item: {
          id: idempotencyKey,
          status: 'IN_PROGRESS',
          expires_at: expiresAt,
        },
        ConditionExpression: 'attribute_not_exists(id)',
      }),
    );
    return true;
  } catch (err) {
    const name = err && typeof err === 'object' && 'name' in err ? (err as { name?: string }).name : '';
    if (name === 'ConditionalCheckFailedException') {
      return false;
    }
    throw err;
  }
}

async function markIdempotencyComplete(
  db: DynamoDBDocumentClient,
  idempotencyKey: string,
): Promise<void> {
  const expiresAt = Math.floor(Date.now() / 1000) + IDEMPOTENCY_TTL_SECONDS;
  await db.send(
    new UpdateCommand({
      TableName: IDEMPOTENCY_TABLE_NAME,
      Key: { id: idempotencyKey },
      UpdateExpression: 'SET #s = :done, expires_at = :exp',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':done': 'COMPLETED',
        ':exp': expiresAt,
      },
    }),
  );
}