import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { initTelemetryLogger } from '../../../../utils/telemetry-logger';
import {
  requireAuthenticatedUser,
} from '../../../../utils/collector-validation';

const COLLECTOR_PROFILES_TABLE_NAME = process.env.COLLECTOR_PROFILES_TABLE_NAME;

interface AppSyncEvent {
  identity?: any;
}

export const handler = async (event: AppSyncEvent) => {
  initTelemetryLogger(event, { domain: "collector-domain", service: "get-collector-profile" });

  if (!COLLECTOR_PROFILES_TABLE_NAME) {
    console.error('COLLECTOR_PROFILES_TABLE_NAME is not configured');
    throw new Error('Internal server error');
  }

  // Get authenticated user
  const userId = requireAuthenticatedUser(event);
  if (!userId) {
    console.error('User not authenticated');
    throw new Error('Not authenticated');
  }

  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  try {
    const result = await client.send(
      new GetCommand({
        TableName: COLLECTOR_PROFILES_TABLE_NAME,
        Key: { 
          userId: userId,
        },
      }),
    );

    if (!result.Item) {
      return null;
    }
    return result.Item;
  } catch (err) {
    console.error('getCollectorProfile error:', err);
    throw new Error('Failed to get collector profile');
  }
};