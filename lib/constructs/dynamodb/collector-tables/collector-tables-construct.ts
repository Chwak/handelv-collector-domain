import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface CollectorTablesConstructProps {
  environment: string;
  regionCode: string;
  removalPolicy?: cdk.RemovalPolicy;
}

export class CollectorTablesConstruct extends Construct {
  public readonly collectorProfiles: dynamodb.Table;
  public readonly collectorSettings: dynamodb.Table;
  public readonly collectorAuditLogs: dynamodb.Table;
  public readonly collectorSavedItems: dynamodb.Table;
  public readonly collectorCollections: dynamodb.Table;
  public readonly collectorCollectionItems: dynamodb.Table;
  public readonly collectorWishlists: dynamodb.Table;
  public readonly collectorFollows: dynamodb.Table;

  constructor(scope: Construct, id: string, props: CollectorTablesConstructProps) {
    super(scope, id);

    const removalPolicy = props.removalPolicy ?? cdk.RemovalPolicy.DESTROY;

    // =====================================================
    // Collector Profiles Table
    // Domain Responsibility: COLLECTOR DOMAIN ONLY
    // Purpose: Source of truth for collector profile data
    // Key Structure: PK=userId | No sort key (one profile per user)
    // =====================================================
    this.collectorProfiles = new dynamodb.Table(this, 'CollectorProfilesTable', {
      tableName: `${props.environment}-${props.regionCode}-collector-domain-profiles-table`,
      partitionKey: {
        name: 'userId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: removalPolicy,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: props.environment === 'prod' },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });

    this.collectorProfiles.addGlobalSecondaryIndex({
      indexName: 'GSI1-CreatedAt',
      partitionKey: {
        name: 'createdAt',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'userId',
        type: dynamodb.AttributeType.STRING,
      },
    });

    // GSI for email uniqueness checking
    this.collectorProfiles.addGlobalSecondaryIndex({
      indexName: 'GSI2-Email',
      partitionKey: {
        name: 'email',
        type: dynamodb.AttributeType.STRING,
      },
    });

    // =====================================================
    // Collector Settings/Preferences Table
    // Domain Responsibility: COLLECTOR DOMAIN ONLY
    // Purpose: Store collector preferences, notification settings, display options
    // Key Structure: PK=userId | No sort key (one settings doc per user)
    // =====================================================
    this.collectorSettings = new dynamodb.Table(this, 'CollectorSettingsTable', {
      tableName: `${props.environment}-${props.regionCode}-collector-domain-settings-table`,
      partitionKey: {
        name: 'userId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: removalPolicy,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: props.environment === 'prod' },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    // =====================================================
    // Collector Audit Log Table
    // Domain Responsibility: COLLECTOR DOMAIN ONLY
    // Purpose: Audit trail for settings/profile changes
    // Key Structure: PK=userId | SK=timestamp#action
    // =====================================================
    this.collectorAuditLogs = new dynamodb.Table(this, 'CollectorAuditLogsTable', {
      tableName: `${props.environment}-${props.regionCode}-collector-domain-audit-table`,
      partitionKey: {
        name: 'userId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'eventKey',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: removalPolicy,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: props.environment === 'prod' },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: 'expires_at',
    });

    // =====================================================
    // Collector Saved Items Table
    // Key Structure: PK=collectorUserId | SK=shelfItemId
    // =====================================================
    this.collectorSavedItems = new dynamodb.Table(this, 'CollectorSavedItemsTable', {
      tableName: `${props.environment}-${props.regionCode}-collector-domain-saved-items-table`,
      partitionKey: {
        name: 'collectorUserId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'shelfItemId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: removalPolicy,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: props.environment === 'prod' },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    // =====================================================
    // Collector Collections Table
    // Key Structure: PK=collectionId
    // GSI1: PK=collectorUserId | SK=updatedAt (list collections by collector)
    // =====================================================
    this.collectorCollections = new dynamodb.Table(this, 'CollectorCollectionsTable', {
      tableName: `${props.environment}-${props.regionCode}-collector-domain-collections-table`,
      partitionKey: {
        name: 'collectionId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: removalPolicy,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: props.environment === 'prod' },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    this.collectorCollections.addGlobalSecondaryIndex({
      indexName: 'GSI1-CollectorUserId-UpdatedAt',
      partitionKey: {
        name: 'collectorUserId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'updatedAt',
        type: dynamodb.AttributeType.STRING,
      },
    });

    // =====================================================
    // Collector Collection Items Table
    // Key Structure: PK=collectionId | SK=shelfItemId
    // =====================================================
    this.collectorCollectionItems = new dynamodb.Table(this, 'CollectorCollectionItemsTable', {
      tableName: `${props.environment}-${props.regionCode}-collector-domain-collection-items-table`,
      partitionKey: {
        name: 'collectionId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'shelfItemId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: removalPolicy,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: props.environment === 'prod' },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    // =====================================================
    // Collector Wishlist Table
    // Key Structure: PK=collectorUserId | SK=shelfItemId
    // =====================================================
    this.collectorWishlists = new dynamodb.Table(this, 'CollectorWishlistsTable', {
      tableName: `${props.environment}-${props.regionCode}-collector-domain-wishlists-table`,
      partitionKey: {
        name: 'collectorUserId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'shelfItemId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: removalPolicy,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: props.environment === 'prod' },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    // =====================================================
    // Collector Follows Table
    // Key Structure: PK=collectorUserId | SK=makerUserId
    // =====================================================
    this.collectorFollows = new dynamodb.Table(this, 'CollectorFollowsTable', {
      tableName: `${props.environment}-${props.regionCode}-collector-domain-follows-table`,
      partitionKey: {
        name: 'collectorUserId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'makerUserId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: removalPolicy,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: props.environment === 'prod' },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });
  }
}
