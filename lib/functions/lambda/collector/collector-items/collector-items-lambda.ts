import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { initTelemetryLogger } from '../../../../utils/telemetry-logger';
import {
  encodeNextToken,
  parseNextToken,
  requireAuthenticatedUserId,
  validateId,
  validateLimit,
} from '../../../../utils/collector-validation';

const COLLECTIONS_TABLE = process.env.COLLECTOR_COLLECTIONS_TABLE_NAME || '';
const COLLECTION_ITEMS_TABLE = process.env.COLLECTOR_COLLECTION_ITEMS_TABLE_NAME || '';
const SAVED_ITEMS_TABLE = process.env.COLLECTOR_SAVED_ITEMS_TABLE_NAME || '';
const WISHLISTS_TABLE = process.env.COLLECTOR_WISHLISTS_TABLE_NAME || '';
const FOLLOWS_TABLE = process.env.COLLECTOR_FOLLOWS_TABLE_NAME || '';

const COLLECTIONS_BY_USER_INDEX = 'GSI1-CollectorUserId-UpdatedAt';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

interface AppSyncEvent {
  identity?: unknown;
  info?: { fieldName?: string };
  arguments?: {
    limit?: unknown;
    nextToken?: unknown;
    collectionId?: unknown;
    input?: {
      shelfItemId?: unknown;
      notes?: unknown;
      collectionId?: unknown;
      makerUserId?: unknown;
      name?: unknown;
      description?: unknown;
    };
  };
}

function ensureConfigured() {
  const missing = [
    ['COLLECTOR_COLLECTIONS_TABLE_NAME', COLLECTIONS_TABLE],
    ['COLLECTOR_COLLECTION_ITEMS_TABLE_NAME', COLLECTION_ITEMS_TABLE],
    ['COLLECTOR_SAVED_ITEMS_TABLE_NAME', SAVED_ITEMS_TABLE],
    ['COLLECTOR_WISHLISTS_TABLE_NAME', WISHLISTS_TABLE],
    ['COLLECTOR_FOLLOWS_TABLE_NAME', FOLLOWS_TABLE],
  ].filter(([, value]) => !value);

  if (missing.length > 0) {
    console.error('Missing env vars:', missing.map(([name]) => name).join(', '));
    throw new Error('Internal server error');
  }
}

function sanitizeOptionalString(raw: unknown, max = 1000): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function normalizeCollectionName(name: string): string {
  return name.trim().toLocaleLowerCase();
}

async function loadCollectionOwnedByUser(collectionId: string, userId: string) {
  const result = await client.send(
    new GetCommand({
      TableName: COLLECTIONS_TABLE,
      Key: { collectionId },
    }),
  );

  if (!result.Item) throw new Error('Collection not found');
  if (result.Item.collectorUserId !== userId) throw new Error('Forbidden');
  return result.Item;
}

async function findCollectionByUserAndName(userId: string, name: string) {
  const normalizedTarget = normalizeCollectionName(name);
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await client.send(
      new QueryCommand({
        TableName: COLLECTIONS_TABLE,
        IndexName: COLLECTIONS_BY_USER_INDEX,
        KeyConditionExpression: 'collectorUserId = :collectorUserId',
        ExpressionAttributeValues: {
          ':collectorUserId': userId,
        },
        ExclusiveStartKey: exclusiveStartKey,
        ScanIndexForward: false,
      }),
    );

    const match = (result.Items ?? []).find((item) => {
      if (typeof item.name !== 'string') return false;
      return normalizeCollectionName(item.name) === normalizedTarget;
    });
    if (match) return match;

    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);

  return null;
}

export const handler = async (event: AppSyncEvent) => {
  initTelemetryLogger(event, { domain: 'collector-domain', service: 'collector-items' });

  ensureConfigured();

  const userId = requireAuthenticatedUserId(event);
  if (!userId) {
    throw new Error('Not authenticated');
  }

  const fieldName = event.info?.fieldName;

  switch (fieldName) {
    case 'saveItem':
      return saveItem(event, userId);
    case 'unsaveItem':
      return unsaveItem(event, userId);
    case 'listSavedItems':
      return listSavedItems(event, userId);

    case 'createCollection':
      return createCollection(event, userId);
    case 'updateCollection':
      return updateCollection(event, userId);
    case 'deleteCollection':
      return deleteCollection(event, userId);
    case 'getCollection':
      return getCollection(event, userId);
    case 'listCollections':
      return listCollections(event, userId);

    case 'addItemToCollection':
      return addItemToCollection(event, userId);
    case 'removeItemFromCollection':
      return removeItemFromCollection(event, userId);
    case 'listCollectionItems':
      return listCollectionItems(event, userId);

    case 'followMaker':
      return followMaker(event, userId);
    case 'unfollowMaker':
      return unfollowMaker(event, userId);
    case 'listFollows':
      return listFollows(event, userId);

    case 'addToWishlist':
      return addToWishlist(event, userId);
    case 'removeFromWishlist':
      return removeFromWishlist(event, userId);
    case 'listWishlists':
      return listWishlists(event, userId);

    default:
      throw new Error('Unsupported operation');
  }
};

async function saveItem(event: AppSyncEvent, userId: string) {
  const shelfItemId = validateId(event.arguments?.input?.shelfItemId);
  if (!shelfItemId) throw new Error('Invalid shelfItemId');

  const now = new Date().toISOString();
  const item = {
    collectorUserId: userId,
    shelfItemId,
    savedAt: now,
    notes: sanitizeOptionalString(event.arguments?.input?.notes),
  };

  await client.send(
    new PutCommand({
      TableName: SAVED_ITEMS_TABLE,
      Item: item,
    }),
  );

  return item;
}

async function unsaveItem(event: AppSyncEvent, userId: string) {
  const shelfItemId = validateId(event.arguments?.input?.shelfItemId);
  if (!shelfItemId) throw new Error('Invalid shelfItemId');

  await client.send(
    new DeleteCommand({
      TableName: SAVED_ITEMS_TABLE,
      Key: {
        collectorUserId: userId,
        shelfItemId,
      },
    }),
  );

  return true;
}

async function listSavedItems(event: AppSyncEvent, userId: string) {
  const limit = validateLimit(event.arguments?.limit, 20, 100);
  const exclusiveStartKey = parseNextToken(event.arguments?.nextToken);

  const result = await client.send(
    new QueryCommand({
      TableName: SAVED_ITEMS_TABLE,
      KeyConditionExpression: 'collectorUserId = :collectorUserId',
      ExpressionAttributeValues: {
        ':collectorUserId': userId,
      },
      Limit: limit,
      ExclusiveStartKey: exclusiveStartKey,
      ScanIndexForward: false,
    }),
  );

  return {
    items: result.Items ?? [],
    nextToken: encodeNextToken(result.LastEvaluatedKey as Record<string, unknown> | null),
  };
}

async function createCollection(event: AppSyncEvent, userId: string) {
  const name = sanitizeOptionalString(event.arguments?.input?.name, 200);
  if (!name) throw new Error('Collection name is required');

  const existing = await findCollectionByUserAndName(userId, name);
  if (existing) {
    return existing;
  }

  const now = new Date().toISOString();
  const collection = {
    collectionId: `col-${randomUUID()}`,
    collectorUserId: userId,
    name,
    description: sanitizeOptionalString(event.arguments?.input?.description, 2000),
    createdAt: now,
    updatedAt: now,
  };

  await client.send(
    new PutCommand({
      TableName: COLLECTIONS_TABLE,
      Item: collection,
      ConditionExpression: 'attribute_not_exists(collectionId)',
    }),
  );

  return collection;
}

async function updateCollection(event: AppSyncEvent, userId: string) {
  const collectionId = validateId(event.arguments?.input?.collectionId);
  if (!collectionId) throw new Error('Invalid collectionId');

  await loadCollectionOwnedByUser(collectionId, userId);

  const updateParts: string[] = ['updatedAt = :updatedAt'];
  const values: Record<string, unknown> = {
    ':updatedAt': new Date().toISOString(),
  };

  const name = sanitizeOptionalString(event.arguments?.input?.name, 200);
  if (name) {
    updateParts.push('#name = :name');
    values[':name'] = name;
  }

  if (typeof event.arguments?.input?.description === 'string') {
    updateParts.push('description = :description');
    values[':description'] = sanitizeOptionalString(event.arguments?.input?.description, 2000) ?? null;
  }

  const result = await client.send(
    new UpdateCommand({
      TableName: COLLECTIONS_TABLE,
      Key: { collectionId },
      UpdateExpression: `SET ${updateParts.join(', ')}`,
      ConditionExpression: 'collectorUserId = :collectorUserId',
      ExpressionAttributeNames: name ? { '#name': 'name' } : undefined,
      ExpressionAttributeValues: {
        ...values,
        ':collectorUserId': userId,
      },
      ReturnValues: 'ALL_NEW',
    }),
  );

  return result.Attributes;
}

async function deleteCollection(event: AppSyncEvent, userId: string) {
  const collectionId = validateId(event.arguments?.collectionId);
  if (!collectionId) throw new Error('Invalid collectionId');

  await loadCollectionOwnedByUser(collectionId, userId);

  await client.send(
    new DeleteCommand({
      TableName: COLLECTIONS_TABLE,
      Key: { collectionId },
    }),
  );

  return true;
}

async function getCollection(event: AppSyncEvent, userId: string) {
  const collectionId = validateId(event.arguments?.collectionId);
  if (!collectionId) throw new Error('Invalid collectionId');

  const item = await loadCollectionOwnedByUser(collectionId, userId);
  return item;
}

async function listCollections(event: AppSyncEvent, userId: string) {
  const limit = validateLimit(event.arguments?.limit, 20, 100);
  const exclusiveStartKey = parseNextToken(event.arguments?.nextToken);

  const result = await client.send(
    new QueryCommand({
      TableName: COLLECTIONS_TABLE,
      IndexName: COLLECTIONS_BY_USER_INDEX,
      KeyConditionExpression: 'collectorUserId = :collectorUserId',
      ExpressionAttributeValues: {
        ':collectorUserId': userId,
      },
      Limit: limit,
      ExclusiveStartKey: exclusiveStartKey,
      ScanIndexForward: false,
    }),
  );

  return {
    items: result.Items ?? [],
    nextToken: encodeNextToken(result.LastEvaluatedKey as Record<string, unknown> | null),
  };
}

async function addItemToCollection(event: AppSyncEvent, userId: string) {
  const collectionId = validateId(event.arguments?.input?.collectionId);
  if (!collectionId) throw new Error('Invalid collectionId');

  const shelfItemId = validateId(event.arguments?.input?.shelfItemId);
  if (!shelfItemId) throw new Error('Invalid shelfItemId');

  await loadCollectionOwnedByUser(collectionId, userId);

  const now = new Date().toISOString();
  const item = {
    collectionId,
    shelfItemId,
    addedAt: now,
    notes: sanitizeOptionalString(event.arguments?.input?.notes),
  };

  await client.send(
    new PutCommand({
      TableName: COLLECTION_ITEMS_TABLE,
      Item: item,
    }),
  );

  return item;
}

async function removeItemFromCollection(event: AppSyncEvent, userId: string) {
  const collectionId = validateId(event.arguments?.input?.collectionId);
  if (!collectionId) throw new Error('Invalid collectionId');

  const shelfItemId = validateId(event.arguments?.input?.shelfItemId);
  if (!shelfItemId) throw new Error('Invalid shelfItemId');

  await loadCollectionOwnedByUser(collectionId, userId);

  await client.send(
    new DeleteCommand({
      TableName: COLLECTION_ITEMS_TABLE,
      Key: {
        collectionId,
        shelfItemId,
      },
    }),
  );

  return true;
}

async function listCollectionItems(event: AppSyncEvent, userId: string) {
  const collectionId = validateId(event.arguments?.collectionId);
  if (!collectionId) throw new Error('Invalid collectionId');

  await loadCollectionOwnedByUser(collectionId, userId);

  const limit = validateLimit(event.arguments?.limit, 20, 100);
  const exclusiveStartKey = parseNextToken(event.arguments?.nextToken);

  const result = await client.send(
    new QueryCommand({
      TableName: COLLECTION_ITEMS_TABLE,
      KeyConditionExpression: 'collectionId = :collectionId',
      ExpressionAttributeValues: {
        ':collectionId': collectionId,
      },
      Limit: limit,
      ExclusiveStartKey: exclusiveStartKey,
      ScanIndexForward: false,
    }),
  );

  return {
    items: result.Items ?? [],
    nextToken: encodeNextToken(result.LastEvaluatedKey as Record<string, unknown> | null),
  };
}

async function followMaker(event: AppSyncEvent, userId: string) {
  const makerUserId = validateId(event.arguments?.input?.makerUserId);
  if (!makerUserId) throw new Error('Invalid makerUserId');

  const item = {
    collectorUserId: userId,
    makerUserId,
    followedAt: new Date().toISOString(),
  };

  await client.send(
    new PutCommand({
      TableName: FOLLOWS_TABLE,
      Item: item,
    }),
  );

  return item;
}

async function unfollowMaker(event: AppSyncEvent, userId: string) {
  const makerUserId = validateId(event.arguments?.input?.makerUserId);
  if (!makerUserId) throw new Error('Invalid makerUserId');

  await client.send(
    new DeleteCommand({
      TableName: FOLLOWS_TABLE,
      Key: {
        collectorUserId: userId,
        makerUserId,
      },
    }),
  );

  return true;
}

async function listFollows(event: AppSyncEvent, userId: string) {
  const limit = validateLimit(event.arguments?.limit, 20, 100);
  const exclusiveStartKey = parseNextToken(event.arguments?.nextToken);

  const result = await client.send(
    new QueryCommand({
      TableName: FOLLOWS_TABLE,
      KeyConditionExpression: 'collectorUserId = :collectorUserId',
      ExpressionAttributeValues: {
        ':collectorUserId': userId,
      },
      Limit: limit,
      ExclusiveStartKey: exclusiveStartKey,
      ScanIndexForward: false,
    }),
  );

  return {
    items: result.Items ?? [],
    nextToken: encodeNextToken(result.LastEvaluatedKey as Record<string, unknown> | null),
  };
}

async function addToWishlist(event: AppSyncEvent, userId: string) {
  const shelfItemId = validateId(event.arguments?.input?.shelfItemId);
  if (!shelfItemId) throw new Error('Invalid shelfItemId');

  const item = {
    collectorUserId: userId,
    shelfItemId,
    addedAt: new Date().toISOString(),
    notes: sanitizeOptionalString(event.arguments?.input?.notes),
  };

  await client.send(
    new PutCommand({
      TableName: WISHLISTS_TABLE,
      Item: item,
    }),
  );

  return item;
}

async function removeFromWishlist(event: AppSyncEvent, userId: string) {
  const shelfItemId = validateId(event.arguments?.input?.shelfItemId);
  if (!shelfItemId) throw new Error('Invalid shelfItemId');

  await client.send(
    new DeleteCommand({
      TableName: WISHLISTS_TABLE,
      Key: {
        collectorUserId: userId,
        shelfItemId,
      },
    }),
  );

  return true;
}

async function listWishlists(event: AppSyncEvent, userId: string) {
  const limit = validateLimit(event.arguments?.limit, 20, 100);
  const exclusiveStartKey = parseNextToken(event.arguments?.nextToken);

  const result = await client.send(
    new QueryCommand({
      TableName: WISHLISTS_TABLE,
      KeyConditionExpression: 'collectorUserId = :collectorUserId',
      ExpressionAttributeValues: {
        ':collectorUserId': userId,
      },
      Limit: limit,
      ExclusiveStartKey: exclusiveStartKey,
      ScanIndexForward: false,
    }),
  );

  return {
    items: result.Items ?? [],
    nextToken: encodeNextToken(result.LastEvaluatedKey as Record<string, unknown> | null),
  };
}
