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
  }
}
