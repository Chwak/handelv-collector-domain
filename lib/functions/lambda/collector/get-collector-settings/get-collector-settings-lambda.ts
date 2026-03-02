import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { initTelemetryLogger } from '../../../../utils/telemetry-logger';
import {
  requireAuthenticatedUser,
} from '../../../../utils/collector-validation';

const COLLECTOR_SETTINGS_TABLE_NAME = process.env.COLLECTOR_SETTINGS_TABLE_NAME;

interface AppSyncEvent {
  identity?: any;
}

export const handler = async (event: AppSyncEvent) => {
  initTelemetryLogger(event, { domain: "collector-domain", service: "get-collector-settings" });

  if (!COLLECTOR_SETTINGS_TABLE_NAME) {
    console.error('COLLECTOR_SETTINGS_TABLE_NAME is not configured');
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
        TableName: COLLECTOR_SETTINGS_TABLE_NAME,
        Key: { 
          userId: userId,
        },
      }),
    );

    if (!result.Item) {

      const defaultSettings = {
        userId: userId,
        notifications: {
          orderConfirmation: true,
          orderShipped: true,
          orderDelivered: true,
          newShelfItemsFromFavoriteMakers: true,
          priceDrops: true,
          backInStock: true,
          makerMessages: true,
          customOrderUpdates: true,
          weeklyNewsletter: true,
          promotionalOffers: true,
          accountSecurity: true,
          policyUpdates: true,
        },
        privacy: {
          showProfilePublicly: true,
          showPurchaseHistory: false,
          showCollections: true,
          showWishlist: true,
          allowMakerContact: true,
        },
        display: {
          language: 'en',
          currency: 'USD',
          measurementSystem: 'imperial',
          timezone: 'America/New_York',
        },
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
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await client.send(
        new PutCommand({
          TableName: COLLECTOR_SETTINGS_TABLE_NAME,
          Item: defaultSettings,
          ConditionExpression: 'attribute_not_exists(userId)', // ✅ CRITICAL FIX: Prevent concurrent default creation
        }),
      );

      return defaultSettings;
    }
    return result.Item;
  } catch (err) {
    console.error('getCollectorSettings error:', err);
    throw new Error('Failed to get collector settings');
  }
};